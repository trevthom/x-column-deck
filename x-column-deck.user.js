// ==UserScript==
// @name         X Column Deck — multi-user reader
// @namespace    https://local/x-column-deck
// @version      1.4.0
// @description  TweetDeck-style columns of selected X users' posts & replies. Inline media + quoted posts, newest on top, capped at 20, click to open the thread, drag to reorder columns. Rides your logged-in session. CSP-safe sandbox build.
// @author       you
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * X Column Deck v1.1
   *   v1.1 runs in the userscript-manager SANDBOX (because of the @grant lines
   *   above) so X's Content Security Policy can't block it, then reaches into
   *   the real page via `unsafeWindow` to watch network traffic and learn X's
   *   current GraphQL format from YOUR logged-in session. Visit any profile
   *   once to teach it; after that it can fetch any user's column itself.
   * ========================================================================= */

  // The real page window (sandbox shares the same `document`, but globals like
  // fetch / XMLHttpRequest live on the page window -> unsafeWindow).
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  console.log('[X Column Deck] v1.4 loaded on', location.host);

  // ---- storage (GM with localStorage fallback) -----------------------------
  const GM_OK = (typeof GM_setValue === 'function' && typeof GM_getValue === 'function');
  const store = {
    get: (k, d) => {
      if (GM_OK) { const v = GM_getValue(k); return (v === undefined || v === null) ? d : v; }
      try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
    },
    set: (k, v) => {
      if (GM_OK) { try { GM_setValue(k, v); return; } catch {} }
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    },
  };
  const LS = { users: 'xdeck_users', cap: 'xdeck_captured', cache: 'xdeck_cache', prefs: 'xdeck_prefs', profiles: 'xdeck_profiles' };

  let users    = store.get(LS.users, []);
  let captured = store.get(LS.cap, { apiBase: '', headers: {}, byScreenName: null, userTweets: null });
  let cache    = store.get(LS.cache, {});
  let prefs    = store.get(LS.prefs, { showReplies: true, showRetweets: true, autoMin: 0 });
  let profiles = store.get(LS.profiles, {}); // handle -> { id, name, screen, avatar }

  // session-only pagination state (cache persists just the most-recent page)
  const cursors = {};       // handle -> bottom cursor for the next page
  const view = {};          // handle -> full list currently displayed (grows on scroll)
  const loadingMore = new Set();
  const ended = new Set();   // handles whose timeline has no more pages

  // ---- learning X's current API from your own traffic ----------------------
  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    try {
      if (h && typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => (o[k] = v)); // Headers
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
      else if (typeof h === 'object') Object.assign(o, h);
    } catch {}
    return o;
  }

  function rememberHeaders(hdrs) {
    const keep = ['authorization', 'x-twitter-active-user', 'x-twitter-auth-type', 'x-twitter-client-language', 'accept', 'accept-language'];
    const out = {};
    for (const k of Object.keys(hdrs)) if (keep.includes(k.toLowerCase())) out[k.toLowerCase()] = hdrs[k];
    if (Object.keys(out).length) captured.headers = { ...captured.headers, ...out };
  }

  function learnFrom(url, hdrs) {
    try {
      if (!url || url.indexOf('/graphql/') === -1) return;
      const u = new URL(url, location.origin);
      const m = u.pathname.match(/\/graphql\/([^/]+)\/([^/?]+)/);
      if (!m) return;
      const [, queryId, opName] = m;
      const apiBase = u.origin + u.pathname.slice(0, u.pathname.indexOf('/graphql/') + '/graphql/'.length);
      const parseParam = (n) => { try { return JSON.parse(u.searchParams.get(n)); } catch { return null; } };
      const variables = parseParam('variables');
      const features = parseParam('features');
      const fieldToggles = parseParam('fieldToggles');

      if (hdrs && Object.keys(hdrs).length) rememberHeaders(hdrs);
      if (apiBase) captured.apiBase = apiBase;

      if (opName === 'UserByScreenName' && variables) {
        captured.byScreenName = { queryId, opName, variables, features, fieldToggles };
        store.set(LS.cap, captured); markReady();
      } else if ((opName === 'UserTweetsAndReplies' || opName === 'UserTweets') && variables) {
        if (opName === 'UserTweetsAndReplies' || !captured.userTweets) {
          captured.userTweets = { queryId, opName, variables, features, fieldToggles };
          store.set(LS.cap, captured); markReady();
        }
      }
    } catch {}
  }

  // Patch the PAGE's fetch + XHR (via unsafeWindow) at document-start.
  const origFetch = W.fetch;
  W.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      let hdrs = headersToObj(init && init.headers);
      if (!Object.keys(hdrs).length && input && input.headers) hdrs = headersToObj(input.headers);
      learnFrom(url, hdrs);
    } catch {}
    return origFetch.apply(this, arguments);
  };

  try {
    const XP = W.XMLHttpRequest.prototype;
    const xOpen = XP.open, xSet = XP.setRequestHeader, xSend = XP.send;
    XP.open = function (m, url) { this.__xd_url = url; this.__xd_h = {}; return xOpen.apply(this, arguments); };
    XP.setRequestHeader = function (k, v) { try { (this.__xd_h ||= {})[k] = v; } catch {} return xSet.apply(this, arguments); };
    XP.send = function () { try { learnFrom(this.__xd_url, this.__xd_h); } catch {} return xSend.apply(this, arguments); };
  } catch {}

  // ---- helpers -------------------------------------------------------------
  const getCookie = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
  const esc = (s) => (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isReady = () => !!(captured.byScreenName && captured.userTweets && captured.headers.authorization && captured.apiBase);

  function relTime(created) {
    const t = new Date(created).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---- GraphQL calls (using your learned session) --------------------------
  async function gql(op, overrideVars) {
    const variables = { ...(op.variables || {}), ...overrideVars };
    const qs = new URLSearchParams();
    qs.set('variables', JSON.stringify(variables));
    if (op.features) qs.set('features', JSON.stringify(op.features));
    if (op.fieldToggles) qs.set('fieldToggles', JSON.stringify(op.fieldToggles));
    const url = captured.apiBase + op.queryId + '/' + op.opName + '?' + qs.toString();
    const headers = { ...captured.headers, 'x-csrf-token': getCookie('ct0') };
    const res = await origFetch.call(W, url, { method: 'GET', headers, credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function lookupUser(handle) {
    const json = await gql(captured.byScreenName, { screen_name: handle });
    const result = json?.data?.user?.result;
    const id = result?.rest_id;
    if (!id) throw new Error('no such user');
    const b = userBits(result);
    return { id, name: b.name || ('@' + handle), screen: b.screen || handle, avatar: b.avatar || '' };
  }

  const PAGE = 20; // cache / load-more page size

  async function fetchUser(handle) {
    const prof = await lookupUser(handle);
    profiles[handle] = prof; store.set(LS.profiles, profiles); // header uses this, not the posts
    const json = await gql(captured.userTweets, { userId: prof.id, count: PAGE });
    return parseTimeline(json); // { posts, cursor }
  }

  async function fetchMore(handle) {
    const prof = profiles[handle];
    const cursor = cursors[handle];
    if (!prof || !cursor) return { posts: [], cursor: null };
    const json = await gql(captured.userTweets, { userId: prof.id, count: PAGE, cursor });
    return parseTimeline(json);
  }

  // ---- response parser -----------------------------------------------------
  function userBits(coreResult) {
    const lg = coreResult?.legacy || {}, co = coreResult?.core || {};
    return {
      screen: lg.screen_name || co.screen_name || '',
      name: lg.name || co.name || '',
      avatar: lg.profile_image_url_https || coreResult?.avatar?.image_url || '',
    };
  }

  // Pull photos/gifs/videos out of a tweet's legacy block, and collect the
  // t.co short-urls they correspond to so we can strip them from the text.
  function extractMedia(lg) {
    const arr = (lg.extended_entities?.media || lg.entities?.media || []);
    const media = [], tcoUrls = [];
    for (const m of arr) {
      if (m.url) tcoUrls.push(m.url);
      if (m.type === 'photo') {
        media.push({ kind: 'photo', src: m.media_url_https });
      } else if (m.type === 'animated_gif' || m.type === 'video') {
        const variants = (m.video_info?.variants || []).filter((v) => v.content_type === 'video/mp4');
        variants.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0)); // low->high
        const pick = m.type === 'animated_gif' ? variants[0] : variants[variants.length - 1];
        if (pick?.url) media.push({ kind: m.type === 'animated_gif' ? 'gif' : 'video', src: pick.url, poster: m.media_url_https });
      }
    }
    return { media, tcoUrls };
  }

  // A link-preview card (the box X shows for an external link), if present.
  function parseCard(cardWrap, urls) {
    const legacy = cardWrap?.legacy || cardWrap;
    let bv = legacy?.binding_values;
    if (!bv) return null;
    const map = {};
    if (Array.isArray(bv)) for (const e of bv) map[e.key] = e.value; else Object.assign(map, bv);
    const str = (k) => map[k]?.string_value;
    const img = (k) => map[k]?.image_value?.url;
    const title = str('title');
    const domain = str('domain') || str('vanity_url');
    const image = img('photo_image_full_size_large') || img('summary_photo_image_large') ||
      img('thumbnail_image_large') || img('player_image_large') || img('thumbnail_image') || img('summary_photo_image');
    if (!title && !image) return null;
    const cardUrl = legacy?.url; // the t.co this card stands in for
    const match = (urls || []).find((u) => u.url === cardUrl);
    return { title, domain, image, cardUrl, dest: match?.expanded_url || cardUrl };
  }

  const anchor = (dest, label) => `<a class="xdeck-link" href="${esc(dest)}" target="_blank" rel="noopener">${esc(label)}</a>`;

  // Render the tweet body the way X does: strip t.co links that stand in for
  // attached media / the quoted tweet / the preview card, and turn any other
  // t.co into its readable display_url as a clickable link.
  function buildTextHtml(raw, urls, stripSet) {
    let html = esc(raw || '');
    for (const u of stripSet) if (u) html = html.split(esc(u)).join('');
    for (const u of urls) {
      if (!u.url || stripSet.has(u.url)) continue;
      html = html.split(esc(u.url)).join(anchor(u.expanded_url || u.url, u.display_url || u.expanded_url || u.url));
    }
    return html.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Parse a raw tweet result. allowQuote=false stops one level of nesting so a
  // quoted tweet doesn't render its own quote-of-a-quote.
  function parseTweetResult(r, allowRT, allowQuote) {
    if (!r) return null;
    if (r.__typename === 'TweetWithVisibilityResults') r = r.tweet;
    if (!r || !r.legacy) return null;

    let display = r, kind = 'post';
    const rtRes = allowRT ? r.legacy.retweeted_status_result?.result : null;
    if (rtRes) {
      let rt = rtRes; if (rt.__typename === 'TweetWithVisibilityResults') rt = rt.tweet;
      if (rt && rt.legacy) { display = rt; kind = 'retweet'; }
    }

    const usr = userBits(display.core?.user_results?.result);
    const lg = display.legacy || {};
    const tid = display.rest_id || lg.id_str;
    if (!tid || !usr.screen) return null;
    if (kind !== 'retweet' && lg.in_reply_to_screen_name) kind = 'reply';

    // text source (note_tweet = long-form) + all link entities
    const noteRes = display.note_tweet?.note_tweet_results?.result;
    const raw = noteRes?.text || lg.full_text || lg.text || '';
    const urls = [...(lg.entities?.urls || []), ...(noteRes?.entity_set?.urls || [])];

    const mm = extractMedia(lg);

    // quoted post (shown inline so you don't have to click through)
    let quoted = null;
    if (allowQuote) {
      const q = parseTweetResult(display.quoted_status_result?.result, false, false);
      if (q) quoted = q;
    }

    // link-preview card
    const card = parseCard(display.card, urls);

    // build the set of t.co links to remove from the text entirely
    const strip = new Set(mm.tcoUrls);
    if (lg.quoted_status_permalink?.url) strip.add(lg.quoted_status_permalink.url);
    if (card?.cardUrl) strip.add(card.cardUrl);
    if (quoted) for (const u of urls) if ((u.expanded_url || '').includes('/status/' + quoted.id)) strip.add(u.url);

    const textHtml = buildTextHtml(raw, urls, strip);

    return {
      id: tid, url: `https://x.com/${usr.screen}/status/${tid}`,
      screen: usr.screen, name: usr.name, avatar: usr.avatar,
      textHtml, media: mm.media, quoted, card,
      created: lg.created_at, kind, replyTo: lg.in_reply_to_screen_name || null,
    };
  }

  function extractTweet(ic) {
    if (!ic || ic.itemType !== 'TimelineTweet') return null;
    return parseTweetResult(ic.tweet_results?.result, true, true);
  }

  function parseTimeline(json) {
    const out = [];
    let cursor = null;
    const insts = json?.data?.user?.result?.timeline_v2?.timeline?.instructions || json?.data?.user?.result?.timeline?.timeline?.instructions || [];
    for (const inst of insts) {
      const entries = inst.entries || (inst.entry ? [inst.entry] : []);
      for (const e of entries) {
        const id = e.entryId || '';
        const c = e.content || {};
        if (id.startsWith('cursor-bottom') || c.cursorType === 'Bottom') { cursor = c.value || cursor; continue; }
        if (id.startsWith('cursor-') || id.startsWith('promoted')) continue;
        if (c.itemContent) { const t = extractTweet(c.itemContent); if (t) out.push(t); }
        else if (Array.isArray(c.items)) { for (const it of c.items) { const t = extractTweet(it.item?.itemContent); if (t) out.push(t); } }
      }
    }
    const seen = new Set();
    const posts = out.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    return { posts, cursor };
  }

  function applyFilters(posts) {
    return posts.filter((p) => {
      if (!prefs.showReplies && p.kind === 'reply') return false;
      if (!prefs.showRetweets && p.kind === 'retweet') return false;
      return true;
    });
  }

  // ---- UI ------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('xdeck-style')) return;
    const css = `
    #xdeck-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#1d9bf0;color:#fff;border:none;border-radius:999px;padding:11px 16px;font:600 14px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
    #xdeck-fab:hover{background:#1a8cd8}
    #xdeck-overlay{position:fixed;inset:0;z-index:2147483647;background:#000;color:#e7e9ea;display:none;flex-direction:column;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
    #xdeck-overlay.open{display:flex}
    #xdeck-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2f3336;flex:0 0 auto;flex-wrap:wrap}
    #xdeck-bar h1{font-size:15px;margin:0 8px 0 2px;font-weight:800}
    #xdeck-bar input[type=text]{background:#16181c;border:1px solid #333639;color:#e7e9ea;border-radius:8px;padding:7px 10px;font-size:13px;width:170px}
    .xdeck-btn{background:#16181c;border:1px solid #333639;color:#e7e9ea;border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer}
    .xdeck-btn:hover{background:#1d1f23}
    .xdeck-btn.primary{background:#1d9bf0;border-color:#1d9bf0;color:#fff;font-weight:600}
    .xdeck-toggle{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#8b98a5;cursor:pointer}
    #xdeck-status{font-size:12px;color:#8b98a5;margin-left:auto}
    #xdeck-status.warn{color:#ffd166}
    #xdeck-cols{flex:1 1 auto;display:flex;gap:10px;overflow-x:auto;overflow-y:hidden;padding:10px}
    .xdeck-col{flex:0 0 340px;display:flex;flex-direction:column;background:#0a0a0a;border:1px solid #2f3336;border-radius:12px;overflow:hidden;height:100%}
    .xdeck-col.dragover{outline:2px dashed #1d9bf0;outline-offset:-2px}
    .xdeck-colhead{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid #2f3336;flex:0 0 auto;cursor:grab;background:#101012}
    .xdeck-colhead:active{cursor:grabbing}
    .xdeck-colhead img{width:30px;height:30px;border-radius:50%}
    .xdeck-colhead .h{font-weight:700;font-size:14px}
    .xdeck-colhead .sub{font-size:11px;color:#8b98a5}
    .xdeck-colhead .grip{color:#5b6571;font-size:14px;margin-right:2px}
    .xdeck-colhead .x{margin-left:auto;color:#8b98a5;cursor:pointer;border:none;background:none;font-size:16px;padding:2px 6px}
    .xdeck-colhead .x:hover{color:#f4212e}
    .xdeck-body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden}
    .xdeck-post{padding:11px 12px;border-bottom:1px solid #1c1f22;cursor:pointer}
    .xdeck-post:hover{background:#0f1113}
    .xdeck-post .meta{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b98a5;margin-bottom:4px;flex-wrap:wrap}
    .xdeck-post .meta .nm{color:#e7e9ea;font-weight:700}
    .xdeck-tag{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid #333639}
    .xdeck-tag.reply{color:#1d9bf0;border-color:#1d9bf0}
    .xdeck-tag.rt{color:#00ba7c;border-color:#00ba7c}
    .xdeck-post .txt{white-space:pre-wrap;word-wrap:break-word;font-size:14px;color:#e7e9ea}
    .xdeck-media{margin-top:8px;display:grid;grid-template-columns:1fr;gap:4px}
    .xdeck-media.multi{grid-template-columns:1fr 1fr}
    .xdeck-media img,.xdeck-media video{width:100%;display:block;border-radius:12px;background:#000;max-height:430px;object-fit:contain}
    .xdeck-media.multi img,.xdeck-media.multi video{max-height:190px;object-fit:cover}
    .xdeck-q{margin-top:8px;border:1px solid #2f3336;border-radius:12px;padding:8px 10px;cursor:pointer}
    .xdeck-q:hover{background:#0d0f11}
    .xdeck-q .qmeta{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b98a5;margin-bottom:3px}
    .xdeck-q .qmeta img{width:18px;height:18px;border-radius:50%}
    .xdeck-q .qnm{color:#e7e9ea;font-weight:700}
    .xdeck-q .qh{color:#8b98a5}
    .xdeck-q .qtxt{font-size:13px;color:#d7d9da;white-space:pre-wrap;word-wrap:break-word}
    .xdeck-link{color:#1d9bf0;text-decoration:none;word-break:break-word}
    .xdeck-link:hover{text-decoration:underline}
    .xdeck-card{margin-top:8px;border:1px solid #2f3336;border-radius:14px;overflow:hidden;cursor:pointer}
    .xdeck-card:hover{background:#0d0f11}
    .xdeck-card img{width:100%;display:block;max-height:240px;object-fit:cover;background:#000}
    .xdeck-card-b{padding:8px 11px}
    .xdeck-card-d{font-size:12px;color:#8b98a5}
    .xdeck-card-t{font-size:14px;color:#e7e9ea;font-weight:600;line-height:1.3;margin-top:2px}
    .xdeck-empty{padding:18px;color:#8b98a5;font-size:13px;text-align:center}
    .xdeck-foot{padding:14px;color:#5b6571;font-size:12px;text-align:center;min-height:8px}
    .xdeck-col.loading .xdeck-body{opacity:.5}
    `;
    const s = document.createElement('style');
    s.id = 'xdeck-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  let overlay;
  function buildOverlay() {
    injectStyles();
    overlay = document.createElement('div');
    overlay.id = 'xdeck-overlay';
    overlay.innerHTML = `
      <div id="xdeck-bar">
        <h1>X Column Deck</h1>
        <input id="xdeck-add" type="text" placeholder="add @username + Enter">
        <button class="xdeck-btn" id="xdeck-addbtn">Add</button>
        <button class="xdeck-btn primary" id="xdeck-refresh">Refresh all</button>
        <label class="xdeck-toggle"><input type="checkbox" id="xdeck-rep"> replies</label>
        <label class="xdeck-toggle"><input type="checkbox" id="xdeck-rt"> retweets</label>
        <label class="xdeck-toggle">auto&nbsp;
          <select id="xdeck-auto" class="xdeck-btn" style="padding:4px 6px">
            <option value="0">off</option><option value="2">2m</option><option value="5">5m</option><option value="10">10m</option><option value="30">30m</option>
          </select>
        </label>
        <span id="xdeck-status"></span>
        <button class="xdeck-btn" id="xdeck-close" style="margin-left:8px">✕ close</button>
      </div>
      <div id="xdeck-cols"></div>`;
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector(id);
    $('#xdeck-rep').checked = prefs.showReplies;
    $('#xdeck-rt').checked = prefs.showRetweets;
    $('#xdeck-auto').value = String(prefs.autoMin || 0);

    const addNow = () => {
      const v = $('#xdeck-add').value.trim().replace(/^@/, '').toLowerCase();
      $('#xdeck-add').value = '';
      if (v && !users.includes(v)) { users.push(v); store.set(LS.users, users); renderColumns(); refreshOne(v); }
    };
    $('#xdeck-addbtn').onclick = addNow;
    $('#xdeck-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNow(); });
    $('#xdeck-refresh').onclick = () => refreshAll();
    $('#xdeck-close').onclick = () => overlay.classList.remove('open');
    $('#xdeck-rep').onchange = (e) => { prefs.showReplies = e.target.checked; store.set(LS.prefs, prefs); renderColumns(); };
    $('#xdeck-rt').onchange = (e) => { prefs.showRetweets = e.target.checked; store.set(LS.prefs, prefs); renderColumns(); };
    $('#xdeck-auto').onchange = (e) => { prefs.autoMin = +e.target.value; store.set(LS.prefs, prefs); scheduleAuto(); };

    updateStatus();
    renderColumns();
  }

  function updateStatus() {
    const el = overlay?.querySelector('#xdeck-status');
    if (!el) return;
    if (isReady()) { el.textContent = '✓ ready'; el.classList.remove('warn'); }
    else { el.textContent = '⏳ open any X profile once to initialize'; el.classList.add('warn'); }
  }

  // ---- columns + drag reorder ----------------------------------------------
  let dragIdx = null;

  function renderColumns() {
    const wrap = overlay?.querySelector('#xdeck-cols');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!users.length) { wrap.innerHTML = `<div class="xdeck-empty" style="margin:auto">Add an @username above to create your first column.</div>`; return; }
    users.forEach((handle, idx) => wrap.appendChild(makeColumn(handle, idx)));
  }

  function mediaHtml(media) {
    if (!media || !media.length) return '';
    const cls = media.length > 1 ? 'xdeck-media multi' : 'xdeck-media';
    let inner = '';
    for (const m of media) {
      if (m.kind === 'photo') inner += `<img loading="lazy" src="${esc(m.src)}">`;
      else if (m.kind === 'gif') inner += `<video src="${esc(m.src)}" autoplay loop muted playsinline preload="metadata"></video>`;
      else inner += `<video src="${esc(m.src)}" poster="${esc(m.poster || '')}" controls preload="none"></video>`;
    }
    return `<div class="${cls}">${inner}</div>`;
  }

  function cardHtml(c) {
    if (!c) return '';
    return `<div class="xdeck-card" data-url="${esc(c.dest || c.cardUrl || '')}">` +
      (c.image ? `<img loading="lazy" src="${esc(c.image)}">` : '') +
      `<div class="xdeck-card-b">` +
      (c.domain ? `<div class="xdeck-card-d">${esc(c.domain)}</div>` : '') +
      (c.title ? `<div class="xdeck-card-t">${esc(c.title)}</div>` : '') +
      `</div></div>`;
  }

  // Use the rich HTML text when present; fall back to plain text from any
  // posts cached by an older version so they never render blank.
  const bodyText = (o) => (o.textHtml != null ? o.textHtml : esc(o.text || ''));

  function quotedHtml(q) {
    if (!q) return '';
    const t = bodyText(q);
    return `<div class="xdeck-q" data-url="${esc(q.url)}">` +
      `<div class="qmeta">${q.avatar ? `<img src="${esc(q.avatar)}">` : ''}<span class="qnm">${esc(q.name || '@' + q.screen)}</span><span class="qh">@${esc(q.screen)}</span></div>` +
      (t ? `<div class="qtxt">${t}</div>` : '') +
      mediaHtml(q.media) +
      cardHtml(q.card) +
      `</div>`;
  }

  function makePostCard(p, handle) {
    const card = document.createElement('div');
    card.className = 'xdeck-post';
    const tag = p.kind === 'retweet' ? `<span class="xdeck-tag rt">🔁 RT</span>`
      : p.kind === 'reply' ? `<span class="xdeck-tag reply">↩ reply${p.replyTo ? ' @' + esc(p.replyTo) : ''}</span>` : '';
    const t = bodyText(p);
    card.innerHTML =
      `<div class="meta"><span class="nm">${esc(p.name || handle)}</span><span>· ${relTime(p.created)}</span>${tag}</div>` +
      (t ? `<div class="txt">${t}</div>` : '') +
      mediaHtml(p.media) +
      quotedHtml(p.quoted) +
      cardHtml(p.card);
    card.onclick = (e) => {
      if (e.target.closest('a')) { e.stopPropagation(); return; }   // readable link: let it open itself
      if (e.target.closest('video')) return;                        // let video controls work
      const cd = e.target.closest('.xdeck-card');                   // link-preview card -> its destination
      if (cd) { e.stopPropagation(); if (cd.dataset.url) W.open(cd.dataset.url, '_blank', 'noopener'); return; }
      const q = e.target.closest('.xdeck-q');                       // quoted post -> the quoted tweet
      if (q) { e.stopPropagation(); W.open(q.dataset.url, '_blank', 'noopener'); return; }
      W.open(p.url, '_blank', 'noopener');                          // otherwise -> this post
    };
    return card;
  }

  // Pull the next page when the user scrolls near the bottom of a column.
  async function loadMore(handle, body, footer) {
    if (loadingMore.has(handle) || ended.has(handle) || !cursors[handle]) return;
    loadingMore.add(handle);
    if (footer) footer.textContent = 'Loading more…';
    try {
      const { posts, cursor } = await fetchMore(handle);
      const have = new Set((view[handle] || []).map((p) => p.id));
      const fresh = posts.filter((p) => !have.has(p.id));
      cursors[handle] = cursor;
      if (!fresh.length || !cursor) ended.add(handle);
      if (fresh.length) {
        view[handle] = [...(view[handle] || []), ...fresh];
        for (const p of applyFilters(fresh)) body.insertBefore(makePostCard(p, handle), footer);
      }
    } catch (e) {
      console.warn('[X Column Deck] load more failed for', handle, e);
    } finally {
      loadingMore.delete(handle);
      if (footer) footer.textContent = ended.has(handle) ? '— end of timeline —' : '';
    }
  }

  function makeColumn(handle, idx) {
    const col = document.createElement('div');
    col.className = 'xdeck-col';
    col.dataset.idx = idx;

    if (!view[handle]) view[handle] = [...(cache[handle] || [])]; // seed from persisted page
    const posts = applyFilters(view[handle]);
    const prof = profiles[handle] || {};
    const avatar = (prof.avatar || '').replace('_normal', '_bigger');
    const name = prof.name || ('@' + handle);

    col.innerHTML = `
      <div class="xdeck-colhead" draggable="true">
        <span class="grip">⠿</span>
        ${avatar ? `<img src="${esc(avatar)}">` : ''}
        <div style="min-width:0">
          <div class="h" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
          <div class="sub">@${esc(handle)}</div>
        </div>
        <button class="x" title="remove">✕</button>
      </div>
      <div class="xdeck-body"></div>`;

    const body = col.querySelector('.xdeck-body');
    if (!posts.length) {
      body.innerHTML = `<div class="xdeck-empty">${isReady() ? 'No posts cached yet — hit Refresh all.' : 'Open any X profile once to initialize, then Refresh.'}</div>`;
    } else {
      for (const p of posts) body.appendChild(makePostCard(p, handle));
      const footer = document.createElement('div');
      footer.className = 'xdeck-foot';
      footer.textContent = ended.has(handle) ? '— end of timeline —' : '';
      body.appendChild(footer);
      body.addEventListener('scroll', () => {
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 250) loadMore(handle, body, footer);
      });
    }

    col.querySelector('.x').onclick = () => {
      users = users.filter((u) => u !== handle); store.set(LS.users, users);
      delete cache[handle]; delete view[handle]; delete cursors[handle]; ended.delete(handle);
      store.set(LS.cache, cache); renderColumns();
    };

    const head = col.querySelector('.xdeck-colhead');
    head.addEventListener('dragstart', (e) => { dragIdx = idx; e.dataTransfer.effectAllowed = 'move'; });
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('dragover');
      const to = +col.dataset.idx;
      if (dragIdx === null || dragIdx === to) return;
      const [moved] = users.splice(dragIdx, 1);
      users.splice(to, 0, moved);
      store.set(LS.users, users); dragIdx = null; renderColumns();
    });

    return col;
  }

  // ---- refresh -------------------------------------------------------------
  async function refreshOne(handle) {
    if (!isReady()) { updateStatus(); return; }
    const col = [...(overlay?.querySelectorAll('.xdeck-col') || [])].find((c) => users[+c.dataset.idx] === handle);
    col?.classList.add('loading');
    try {
      const { posts, cursor } = await fetchUser(handle);
      cache[handle] = posts.slice(0, PAGE); store.set(LS.cache, cache); // persist the most-recent page
      view[handle] = [...posts];                                        // fresh view starts here
      cursors[handle] = cursor; ended.delete(handle);                   // reset pagination
    } catch (e) { console.warn('[X Column Deck] refresh failed for', handle, e); }
    finally { renderColumns(); }
  }

  async function refreshAll() {
    updateStatus();
    if (!isReady()) return;
    for (const h of [...users]) { await refreshOne(h); await new Promise((r) => setTimeout(r, 1200)); }
  }

  let autoTimer = null;
  function scheduleAuto() {
    if (autoTimer) clearInterval(autoTimer);
    if (prefs.autoMin > 0) autoTimer = setInterval(() => { if (overlay?.classList.contains('open')) refreshAll(); }, prefs.autoMin * 60000);
  }

  // ---- boot ----------------------------------------------------------------
  function markReady() { if (overlay) updateStatus(); }

  function addFab() {
    if (document.getElementById('xdeck-fab')) return;
    if (!document.body) return;
    injectStyles();
    const fab = document.createElement('button');
    fab.id = 'xdeck-fab';
    fab.textContent = '▦ Deck';
    fab.onclick = () => {
      if (!overlay) buildOverlay();
      overlay.classList.toggle('open');
      if (overlay.classList.contains('open')) { updateStatus(); scheduleAuto(); }
    };
    document.body.appendChild(fab);
    console.log('[X Column Deck] button added');
  }

  // Add the button now and keep it alive across X's SPA re-renders.
  function boot() { if (document.body) addFab(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(addFab, 2000); // self-heal if X ever removes it
})();
