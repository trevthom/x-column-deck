// ==UserScript==
// @name         X Column Deck — multi-user reader
// @namespace    https://local/x-column-deck
// @version      1.7.0
// @description  TweetDeck-style columns of selected X users' posts & replies, grouped into your own lists (separate from X's lists) and filtered from a collapsible sidebar. Inline media + quoted posts, newest on top, capped at 20, click to open the thread, drag to reorder columns. Rides your logged-in session. CSP-safe sandbox build.
// @author       you
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      abs.twimg.com
// @connect      x.com
// @connect      twitter.com
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * X Column Deck v1.5
   *   v1.1 runs in the userscript-manager SANDBOX (because of the @grant lines
   *   above) so X's Content Security Policy can't block it, then reaches into
   *   the real page via `unsafeWindow` to watch network traffic and learn X's
   *   current GraphQL format from YOUR logged-in session. Visit any profile
   *   once to teach it; after that it can fetch any user's column itself.
   *   v1.5 adds private lists kept by the script itself (not X's lists) plus a
   *   left sidebar to filter columns by those lists.
   *   v1.6 fixes initialization: X sends some GraphQL calls as POST with the
   *   variables in the body (the old capture only read the URL, so it never
   *   learned anything and Refresh did nothing), replays the same method it
   *   saw, and can also learn the current query IDs straight from X's own
   *   loaded client bundle, so the deck comes up without a profile visit.
   *   v1.7 lets the list sidebar collapse to a thin rail (the choice is
   *   remembered in prefs), so the columns can use the full width.
   * ========================================================================= */

  // The real page window (sandbox shares the same `document`, but globals like
  // fetch / XMLHttpRequest live on the page window -> unsafeWindow).
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  console.log('[X Column Deck] v1.7 loaded on', location.host);

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
  const LS = {
    users: 'xdeck_users', cap: 'xdeck_captured', cache: 'xdeck_cache', prefs: 'xdeck_prefs',
    profiles: 'xdeck_profiles', lists: 'xdeck_lists', assign: 'xdeck_assign',
  };

  let users    = store.get(LS.users, []);
  let captured = store.get(LS.cap, { apiBase: '', headers: {}, byScreenName: null, userTweets: null });
  let cache    = store.get(LS.cache, {});
  let prefs    = store.get(LS.prefs, { showReplies: true, showRetweets: true, autoMin: 0, activeLists: [], addList: '', sideCollapsed: false });
  let profiles = store.get(LS.profiles, {}); // handle -> { id, name, screen, avatar }

  // The deck's OWN lists. Not X.com lists — these never touch your account.
  let lists  = store.get(LS.lists, []);  // [{ id, name }]
  let assign = store.get(LS.assign, {}); // handle -> list id ('' / missing = unsorted)
  const UNSORTED = '__none__';
  prefs.activeLists = Array.isArray(prefs.activeLists) ? prefs.activeLists : [];
  if (typeof prefs.addList !== 'string') prefs.addList = '';
  prefs.sideCollapsed = !!prefs.sideCollapsed;

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

  function learnFrom(url, hdrs, body, method) {
    try {
      if (!url || url.indexOf('/graphql/') === -1) return;
      const u = new URL(url, location.origin);
      const m = u.pathname.match(/\/graphql\/([^/]+)\/([^/?]+)/);
      if (!m) return;
      const [, queryId, opName] = m;
      const apiBase = u.origin + u.pathname.slice(0, u.pathname.indexOf('/graphql/') + '/graphql/'.length);
      const fromQuery = (n) => { try { return JSON.parse(u.searchParams.get(n)); } catch { return null; } };
      let variables = fromQuery('variables');
      let features = fromQuery('features');
      let fieldToggles = fromQuery('fieldToggles');

      // X also issues some operations as POST with the JSON payload in the body.
      // Reading only the URL is why older builds never became "ready".
      if (variables == null && typeof body === 'string' && body) {
        try {
          const j = JSON.parse(body);
          if (j && typeof j === 'object') {
            if (j.variables != null) variables = j.variables;
            if (j.features != null) features = j.features;
            if (j.fieldToggles != null) fieldToggles = j.fieldToggles;
          }
        } catch {}
      }

      if (hdrs && Object.keys(hdrs).length) rememberHeaders(hdrs);
      if (apiBase) captured.apiBase = apiBase;

      const verb = String(method || 'GET').toUpperCase();
      if (opName === 'UserByScreenName' && variables) {
        captured.byScreenName = { queryId, opName, variables, features, fieldToggles, method: verb };
        store.set(LS.cap, captured); markReady();
      } else if ((opName === 'UserTweetsAndReplies' || opName === 'UserTweets') && variables) {
        if (opName === 'UserTweetsAndReplies' || !captured.userTweets) {
          captured.userTweets = { queryId, opName, variables, features, fieldToggles, method: verb };
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
      learnFrom(url, hdrs, (init && typeof init.body === 'string') ? init.body : '', (init && init.method) || (input && input.method) || 'GET');
    } catch {}
    return origFetch.apply(this, arguments);
  };

  try {
    const XP = W.XMLHttpRequest.prototype;
    const xOpen = XP.open, xSet = XP.setRequestHeader, xSend = XP.send;
    XP.open = function (m, url) { this.__xd_url = url; this.__xd_m = m; this.__xd_h = {}; return xOpen.apply(this, arguments); };
    XP.setRequestHeader = function (k, v) { try { (this.__xd_h ||= {})[k] = v; } catch {} return xSet.apply(this, arguments); };
    XP.send = function (body) { try { learnFrom(this.__xd_url, this.__xd_h, typeof body === 'string' ? body : '', this.__xd_m); } catch {} return xSend.apply(this, arguments); };
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
    if (!op || !op.queryId) throw new Error('not initialized');
    const variables = { ...(op.variables || {}), ...overrideVars };
    const method = String(op.method || 'GET').toUpperCase();
    const base = captured.apiBase + op.queryId + '/' + op.opName;
    const headers = { ...captured.headers, 'x-csrf-token': getCookie('ct0') };
    let url = base;
    let init = { method, headers, credentials: 'include' };

    if (method === 'POST') {
      // Replay the same shape we saw X use: JSON body instead of a query string.
      headers['content-type'] = 'application/json';
      const payload = { variables };
      if (op.features) payload.features = op.features;
      if (op.fieldToggles) payload.fieldToggles = op.fieldToggles;
      init = { ...init, headers, body: JSON.stringify(payload) };
    } else {
      const qs = new URLSearchParams();
      qs.set('variables', JSON.stringify(variables));
      if (op.features) qs.set('features', JSON.stringify(op.features));
      if (op.fieldToggles) qs.set('fieldToggles', JSON.stringify(op.fieldToggles));
      url = base + '?' + qs.toString();
    }

    const res = await origFetch.call(W, url, init);
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ' on ' + op.opName);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // ---- bootstrapping X's API without waiting for a profile visit -----------
  // Query IDs rotate with every X deploy, but the ones this page is already
  // using live in its own client bundle. Scanning that bundle means the deck
  // can come up on its own instead of sitting on "open a profile once" forever.
  const PUBLIC_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const BOOT_OPS = ['UserByScreenName', 'UserTweets', 'UserTweetsAndReplies'];
  const QID_RE = /queryId\s*:\s*"([\w-]{10,40})"\s*,\s*operationName\s*:\s*"(\w+)"/g;
  const QID_RE_REV = /operationName\s*:\s*"(\w+)"\s*,\s*queryId\s*:\s*"([\w-]{10,40})"/g;
  let booting = null;

  function gmText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('unavailable'));
      try {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 25000,
          onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
        });
      } catch (e) { reject(e); }
    });
  }
  async function textFrom(url) {
    try { return await gmText(url); } catch {}
    const res = await origFetch.call(W, url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  // The client bundles this page has already loaded.
  function clientBundleUrls() {
    const out = [];
    for (const s of document.querySelectorAll('script[src]')) {
      try {
        const u = new URL(s.src, location.href);
        if (!/\.js$/.test(u.pathname)) continue;
        if (!/(abs\.)?twimg\.com$|(^|\.)(x|twitter)\.com$/.test(u.hostname)) continue;
        if (!/client-web|responsive-web|x-web/.test(u.href)) continue;
        if (!out.includes(u.href)) out.push(u.href);
      } catch {}
    }
    return out;
  }

  // Learn from what the page itself loaded. force=true replaces IDs learned
  // earlier, which is what to do when X has rotated them (400/404 answers).
  async function bootstrap(opts = {}) {
    const { manual = false, force = false } = opts;
    if (booting) return booting;
    booting = (async () => {
      if (!captured.headers || typeof captured.headers !== 'object') captured.headers = {};
      const urls = clientBundleUrls();
      const found = {};
      let bearer = '';
      for (const url of urls) {
        let txt;
        try { txt = await textFrom(url); } catch { continue; }
        if (!txt) continue;
        if (!bearer) { const b = txt.match(/AAAAAAAAAAAAAAAAAAAAA[\w%+.-]{35,}/); if (b) bearer = b[0]; }
        let m;
        QID_RE.lastIndex = 0;
        while ((m = QID_RE.exec(txt))) if (BOOT_OPS.includes(m[2]) && !found[m[2]]) found[m[2]] = m[1];
        QID_RE_REV.lastIndex = 0;
        while ((m = QID_RE_REV.exec(txt))) if (BOOT_OPS.includes(m[1]) && !found[m[1]]) found[m[1]] = m[2];
        if (bearer && found.UserByScreenName && (found.UserTweets || found.UserTweetsAndReplies)) break;
      }

      const twOp = found.UserTweets || found.UserTweetsAndReplies;
      if (bearer || found.UserByScreenName || twOp) {
        if (!captured.apiBase) captured.apiBase = location.origin + '/i/api/graphql/';
        if (!captured.headers.authorization) captured.headers.authorization = 'Bearer ' + (bearer || PUBLIC_BEARER);
        // When we already learned an op from real traffic, only refresh its
        // rotated ID/name: its variables and feature flags are known-good.
        if (found.UserByScreenName && (force || !captured.byScreenName)) {
          const prev = captured.byScreenName || {};
          captured.byScreenName = {
            ...prev,
            queryId: found.UserByScreenName, opName: 'UserByScreenName',
            variables: prev.variables || { withSafetyModeUserFields: true },
            features: prev.features || {},
            fieldToggles: prev.fieldToggles ?? null,
            method: prev.method || 'GET',
          };
        }
        if (twOp && (force || !captured.userTweets)) {
          const prev = captured.userTweets || {};
          captured.userTweets = {
            ...prev,
            queryId: twOp, opName: 'UserTweets',
            variables: prev.variables || { count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: false },
            features: prev.features || {},
            fieldToggles: prev.fieldToggles ?? { withArticlePlainText: false },
            method: prev.method || 'GET',
          };
        }
        store.set(LS.cap, captured);
      }

      const ok = isReady();
      if (manual) {
        if (ok) updateStatus();
        else if (!urls.length) updateStatus("⚠ couldn't find X's scripts — reload x.com once", true);
        else updateStatus('⚠ could not learn the API — reload x.com, then press initialize', true);
      }
      markReady();
      return ok;
    })();
    try { return await booting; } finally { booting = null; }
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

  // ---- the deck's own lists ------------------------------------------------
  function saveLists() { store.set(LS.lists, lists); }
  function saveAssign() { store.set(LS.assign, assign); }
  function savePrefs() { store.set(LS.prefs, prefs); }

  function createList(name) {
    const clean = (name || '').trim().slice(0, 40);
    if (!clean) return null;
    if (lists.some((l) => l.name.toLowerCase() === clean.toLowerCase())) return lists.find((l) => l.name.toLowerCase() === clean.toLowerCase());
    const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    lists.push({ id, name: clean });
    saveLists();
    return id;
  }

  function deleteList(id) {
    lists = lists.filter((l) => l.id !== id);
    for (const h of Object.keys(assign)) if (assign[h] === id) delete assign[h];
    prefs.activeLists = prefs.activeLists.filter((x) => x !== id);
    if (prefs.addList === id) prefs.addList = '';
    saveLists(); saveAssign(); savePrefs();
  }

  function setUserList(handle, id) {
    if (id) assign[handle] = id; else delete assign[handle];
    saveAssign();
  }

  // Handles whose columns should currently be on screen.
  function visibleHandles() {
    const chosen = prefs.activeLists.filter((id) => id === UNSORTED || lists.some((l) => l.id === id));
    if (!chosen.length) return [...users];            // nothing ticked -> show every list
    return users.filter((h) => {
      const lid = assign[h] || '';
      if (!lid) return chosen.includes(UNSORTED);
      return chosen.includes(lid);
    });
  }

  // ---- UI ------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('xdeck-style')) return;
    const css = `
    #xdeck-fab{position:fixed;right:18px;top:64px;z-index:2147483646;background:#1d9bf0;color:#fff;border:none;border-radius:999px;padding:11px 16px;font:600 14px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
    #xdeck-fab:hover{background:#1a8cd8}
    #xdeck-overlay{position:fixed;inset:0;z-index:2147483647;background:#000;color:#e7e9ea;display:none;flex-direction:column;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
    #xdeck-overlay.open{display:flex}
    #xdeck-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2f3336;flex:0 0 auto;flex-wrap:wrap}
    #xdeck-bar h1{font-size:15px;margin:0 8px 0 2px;font-weight:800}
    #xdeck-bar input[type=text]{background:#16181c;border:1px solid #333639;color:#e7e9ea;border-radius:8px;padding:7px 10px;font-size:13px;width:170px}
    #xdeck-bar select{background:#16181c;border:1px solid #333639;color:#e7e9ea;border-radius:8px;padding:6px 8px;font-size:12px;max-width:150px}
    .xdeck-btn{background:#16181c;border:1px solid #333639;color:#e7e9ea;border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer}
    .xdeck-btn:hover{background:#1d1f23}
    .xdeck-btn.primary{background:#1d9bf0;border-color:#1d9bf0;color:#fff;font-weight:600}
    .xdeck-btn.small{padding:3px 8px;font-size:11px}
    .xdeck-btn.active{background:#1d9bf0;border-color:#1d9bf0;color:#fff}
    .xdeck-toggle{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#8b98a5;cursor:pointer}
    #xdeck-status{font-size:12px;color:#8b98a5;margin-left:auto}
    #xdeck-status.warn{color:#ffd166}
    #xdeck-main{flex:1 1 auto;display:flex;min-height:0}
    #xdeck-side{flex:0 0 190px;display:flex;flex-direction:column;gap:4px;padding:10px;border-right:1px solid #2f3336;background:#08090a;overflow-y:auto;transition:flex-basis .15s ease}
    .xdeck-side-h{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8b98a5;margin:0 2px 4px}
    .xdeck-side-h .xdeck-side-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .xdeck-side-h .xdeck-btn{text-transform:none;letter-spacing:0;font-weight:600}
    .xdeck-side-h #xdeck-side-toggle{padding:3px 6px;font-size:11px;line-height:1}
    /* collapsed: a thin rail with just the reopen button */
    #xdeck-side.collapsed{flex:0 0 36px;padding:10px 5px;overflow:hidden}
    #xdeck-side.collapsed .xdeck-side-h{justify-content:center;margin:0}
    #xdeck-side.collapsed .xdeck-side-title,
    #xdeck-side.collapsed #xdeck-all,
    #xdeck-side.collapsed #xdeck-listbox,
    #xdeck-side.collapsed .xdeck-newlist{display:none}
    .xdeck-listrow{display:flex;align-items:center;gap:6px;font-size:13px;color:#e7e9ea;padding:4px 4px;border-radius:6px;cursor:pointer;user-select:none}
    .xdeck-listrow:hover{background:#131518}
    .xdeck-listrow input{margin:0;accent-color:#1d9bf0;cursor:pointer}
    .xdeck-listrow .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .xdeck-listrow .ct{font-size:11px;color:#5b6571}
    .xdeck-listrow .del{border:none;background:none;color:#5b6571;font-size:12px;cursor:pointer;padding:0 2px;line-height:1}
    .xdeck-listrow .del:hover{color:#f4212e}
    .xdeck-side-empty{font-size:12px;color:#5b6571;padding:4px 2px}
    .xdeck-newlist{display:flex;gap:4px;margin-top:8px}
    .xdeck-newlist input{flex:1 1 auto;min-width:0;background:#16181c;border:1px solid #333639;color:#e7e9ea;border-radius:8px;padding:5px 8px;font-size:12px}
    #xdeck-cols{flex:1 1 auto;display:flex;gap:10px;overflow-x:auto;overflow-y:hidden;padding:10px}
    .xdeck-col{flex:0 0 340px;display:flex;flex-direction:column;background:#0a0a0a;border:1px solid #2f3336;border-radius:12px;overflow:hidden;height:100%}
    .xdeck-col.dragover{outline:2px dashed #1d9bf0;outline-offset:-2px}
    .xdeck-colhead{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid #2f3336;flex:0 0 auto;cursor:grab;background:#101012}
    .xdeck-colhead:active{cursor:grabbing}
    .xdeck-colhead img{width:30px;height:30px;border-radius:50%}
    .xdeck-colhead .h{font-weight:700;font-size:14px}
    .xdeck-colhead .sub{font-size:11px;color:#8b98a5}
    .xdeck-colhead .grip{color:#5b6571;font-size:14px;margin-right:2px}
    .xdeck-colhead select{background:#16181c;border:1px solid #333639;color:#8b98a5;border-radius:6px;font-size:10px;padding:2px 3px;max-width:96px;margin-left:auto;cursor:pointer}
    .xdeck-colhead .x{color:#8b98a5;cursor:pointer;border:none;background:none;font-size:16px;padding:2px 6px;flex:0 0 auto}
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
  // Only a deck that is actually in the document counts as open: X can drop the
  // overlay from the page, leaving us a detached copy that would swallow clicks.
  const isOpen = () => !!(overlay && overlay.isConnected && overlay.classList.contains('open'));

  function buildOverlay() {
    injectStyles();
    const el = document.createElement('div');
    el.id = 'xdeck-overlay';
    el.innerHTML = `
      <div id="xdeck-bar">
        <h1>X Column Deck</h1>
        <input id="xdeck-add" type="text" placeholder="add @username + Enter">
        <select id="xdeck-addlist" title="add the new column to this list"></select>
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
        <button class="xdeck-btn small" id="xdeck-init" title="re-learn X's API from this page">initialize</button>
        <button class="xdeck-btn" id="xdeck-close" style="margin-left:8px">✕ close</button>
      </div>
      <div id="xdeck-main">
        <div id="xdeck-side">
          <div class="xdeck-side-h">
            <span class="xdeck-side-title">Lists</span>
            <button class="xdeck-btn small" id="xdeck-all" title="show every list">All</button>
            <button class="xdeck-btn small" id="xdeck-side-toggle" title="collapse the list sidebar" aria-expanded="true">‹</button>
          </div>
          <div id="xdeck-listbox"></div>
          <div class="xdeck-newlist">
            <input id="xdeck-newlist" type="text" placeholder="new list" maxlength="40">
            <button class="xdeck-btn small" id="xdeck-newlistbtn" title="create list">＋</button>
          </div>
        </div>
        <div id="xdeck-cols"></div>
      </div>`;
    document.body.appendChild(el);
    overlay = el;

    const $ = (id) => overlay.querySelector(id);
    $('#xdeck-rep').checked = prefs.showReplies;
    $('#xdeck-rt').checked = prefs.showRetweets;
    $('#xdeck-auto').value = String(prefs.autoMin || 0);

    const addNow = () => {
      const v = $('#xdeck-add').value.trim().replace(/^@/, '').toLowerCase();
      $('#xdeck-add').value = '';
      if (!v) return;
      const lid = $('#xdeck-addlist').value;
      prefs.addList = lid; savePrefs();
      if (!users.includes(v)) {
        users.push(v); store.set(LS.users, users);
        setUserList(v, lid);
        renderSidebar(); renderColumns(); refreshOne(v);
      } else {
        setUserList(v, lid);
        renderSidebar(); renderColumns();
      }
    };
    $('#xdeck-addbtn').onclick = addNow;
    $('#xdeck-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNow(); });
    $('#xdeck-addlist').addEventListener('change', (e) => { prefs.addList = e.target.value; savePrefs(); });
    $('#xdeck-refresh').onclick = () => refreshAll();
    $('#xdeck-init').onclick = async () => {
      updateStatus("⏳ learning X's API…", true);
      if (!(await bootstrap({ manual: true, force: true }))) updateStatus('⚠ still not ready — reload x.com, then press initialize', true);
    };
    $('#xdeck-close').onclick = () => closeDeck();
    $('#xdeck-rep').onchange = (e) => { prefs.showReplies = e.target.checked; savePrefs(); renderColumns(); };
    $('#xdeck-rt').onchange = (e) => { prefs.showRetweets = e.target.checked; savePrefs(); renderColumns(); };
    $('#xdeck-auto').onchange = (e) => { prefs.autoMin = +e.target.value; savePrefs(); scheduleAuto(); };

    // sidebar: "All", checkbox toggles, list deletion, new list
    $('#xdeck-all').onclick = () => {
      prefs.activeLists = []; savePrefs(); renderSidebar(); renderColumns();
    };
    // collapse / expand the list sidebar; remembered between sessions
    const setSide = (collapsed) => {
      const side = $('#xdeck-side');
      const btn = $('#xdeck-side-toggle');
      side.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '›' : '‹';
      btn.title = collapsed ? 'show the list sidebar' : 'collapse the list sidebar';
      btn.setAttribute('aria-expanded', String(!collapsed));
    };
    $('#xdeck-side-toggle').onclick = () => {
      prefs.sideCollapsed = !prefs.sideCollapsed; savePrefs();
      setSide(prefs.sideCollapsed);
    };
    setSide(prefs.sideCollapsed);
    $('#xdeck-listbox').addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-list]');
      if (!cb) return;
      const id = cb.dataset.list;
      const set = new Set(prefs.activeLists);
      if (cb.checked) set.add(id); else set.delete(id);
      prefs.activeLists = [...set]; savePrefs();
      renderSidebar(); renderColumns();
    });
    $('#xdeck-listbox').addEventListener('click', (e) => {
      const del = e.target.closest('button[data-del]');
      if (!del) return;
      e.preventDefault(); e.stopPropagation();
      deleteList(del.dataset.del);
      renderSidebar(); renderColumns();
    });
    const newList = () => {
      const inp = $('#xdeck-newlist');
      const id = createList(inp.value);
      inp.value = '';
      if (id) { renderSidebar(); renderColumns(); }
    };
    $('#xdeck-newlistbtn').onclick = newList;
    $('#xdeck-newlist').addEventListener('keydown', (e) => { if (e.key === 'Enter') newList(); });

    // column header list pickers
    $('#xdeck-cols').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-handle]');
      if (!sel) return;
      setUserList(sel.dataset.handle, sel.value);
      renderSidebar(); renderColumns();
    });

    updateStatus();
    renderSidebar();
    renderColumns();
  }

  function missingParts() {
    const miss = [];
    if (!captured.apiBase) miss.push('api base');
    if (!(captured.headers && captured.headers.authorization)) miss.push('session token');
    if (!captured.byScreenName) miss.push('profile lookup');
    if (!captured.userTweets) miss.push('timeline');
    return miss;
  }

  // msg=null shows the normal ready / initializing text.
  function updateStatus(msg, warn) {
    const el = overlay?.querySelector('#xdeck-status');
    if (!el) return;
    if (msg) { el.textContent = msg; el.classList.toggle('warn', !!warn); return; }
    if (isReady()) { el.textContent = '✓ ready'; el.classList.remove('warn'); }
    else { el.textContent = '⏳ initializing… (' + missingParts().join(', ') + ')'; el.classList.add('warn'); }
  }

  // ---- sidebar: the deck's lists + which ones are showing -------------------
  function renderSidebar() {
    const box = overlay?.querySelector('#xdeck-listbox');
    if (!box) return;

    const rows = lists.map((l) => ({ id: l.id, name: l.name, count: users.filter((h) => assign[h] === l.id).length, del: true }));
    const unsorted = users.filter((h) => !assign[h]).length;
    if (unsorted) rows.push({ id: UNSORTED, name: 'Unsorted', count: unsorted, del: false });

    if (!rows.length) {
      box.innerHTML = `<div class="xdeck-side-empty">No lists yet — create one below, then pick it on a column.</div>`;
    } else {
      box.innerHTML = rows.map((r) => `
        <label class="xdeck-listrow">
          <input type="checkbox" data-list="${esc(r.id)}"${prefs.activeLists.includes(r.id) ? ' checked' : ''}>
          <span class="nm">${esc(r.name)}</span>
          <span class="ct">${r.count}</span>
          ${r.del ? `<button class="del" data-del="${esc(r.id)}" title="delete list">✕</button>` : ''}
        </label>`).join('');
    }

    // "All" is active when no particular list is chosen.
    overlay.querySelector('#xdeck-all').classList.toggle('active', !prefs.activeLists.length);

    // add-to-list picker in the toolbar
    const addSel = overlay.querySelector('#xdeck-addlist');
    const wanted = prefs.addList || '';
    addSel.innerHTML = `<option value="">no list</option>` +
      lists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
    addSel.value = lists.some((l) => l.id === wanted) ? wanted : '';
  }

  // ---- columns + drag reorder ----------------------------------------------
  let dragHandle = null;

  function renderColumns() {
    const wrap = overlay?.querySelector('#xdeck-cols');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!users.length) { wrap.innerHTML = `<div class="xdeck-empty" style="margin:auto">Add an @username above to create your first column.</div>`; return; }
    const shown = visibleHandles();
    if (!shown.length) {
      wrap.innerHTML = `<div class="xdeck-empty" style="margin:auto">No columns in the selected lists. Tick another list, or press All.</div>`;
      return;
    }
    shown.forEach((handle) => wrap.appendChild(makeColumn(handle)));
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

  function listOptions(handle) {
    const cur = assign[handle] || '';
    return `<option value="">— no list —</option>` +
      lists.map((l) => `<option value="${esc(l.id)}"${l.id === cur ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
  }

  function makeColumn(handle) {
    const col = document.createElement('div');
    col.className = 'xdeck-col';
    col.dataset.handle = handle;

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
        <select class="xdeck-listpick" data-handle="${esc(handle)}" title="put this column in a list">${listOptions(handle)}</select>
        <button class="x" title="remove">✕</button>
      </div>
      <div class="xdeck-body"></div>`;

    const body = col.querySelector('.xdeck-body');
    if (!posts.length) {
      body.innerHTML = `<div class="xdeck-empty">${isReady() ? 'No posts cached yet — hit Refresh all.' : 'Still initializing — press “initialize” in the header, then Refresh all.'}</div>`;
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
      setUserList(handle, '');
      store.set(LS.cache, cache); renderSidebar(); renderColumns();
    };

    const head = col.querySelector('.xdeck-colhead');
    head.addEventListener('dragstart', (e) => { dragHandle = handle; e.dataTransfer.effectAllowed = 'move'; });
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('dragover');
      const to = col.dataset.handle;
      if (!dragHandle || dragHandle === to) return;
      const from = users.indexOf(dragHandle); const at = users.indexOf(to);
      if (from < 0 || at < 0) return;
      const [moved] = users.splice(from, 1);
      users.splice(at, 0, moved);
      store.set(LS.users, users); dragHandle = null; renderColumns();
    });

    return col;
  }

  // ---- refresh -------------------------------------------------------------
  async function refreshOne(handle, canRelearn = true) {
    if (!isReady()) {
      updateStatus('⏳ initializing…', true);
      await bootstrap();
      if (!isReady()) { renderColumns(); return; }
    }
    const col = overlay?.querySelector(`.xdeck-col[data-handle="${handle}"]`);
    col?.classList.add('loading');
    try {
      const { posts, cursor } = await fetchUser(handle);
      cache[handle] = posts.slice(0, PAGE); store.set(LS.cache, cache); // persist the most-recent page
      view[handle] = [...posts];                                        // fresh view starts here
      cursors[handle] = cursor; ended.delete(handle);                   // reset pagination
      updateStatus();
    } catch (e) {
      console.warn('[X Column Deck] refresh failed for', handle, e);
      // A rotated query ID or stale token comes back as 400/404 — relearn and retry once.
      if (canRelearn && (e.status === 400 || e.status === 404 || !e.status)) {
        if (await bootstrap({ manual: true, force: true })) return refreshOne(handle, false);
      }
      updateStatus('⚠ ' + (e.message || e) + ' — press initialize', true);
    } finally { renderColumns(); }
  }

  async function refreshAll() {
    updateStatus();
    if (!isReady()) return;
    for (const h of visibleHandles()) { await refreshOne(h); await new Promise((r) => setTimeout(r, 1200)); }
  }

  let autoTimer = null;
  function scheduleAuto() {
    if (autoTimer) clearInterval(autoTimer);
    if (prefs.autoMin > 0) autoTimer = setInterval(() => { if (isOpen()) refreshAll(); }, prefs.autoMin * 60000);
  }

  // ---- boot ----------------------------------------------------------------
  let lastReady = null;
  function markReady() {
    const ready = isReady();
    if (overlay) updateStatus();
    if (ready !== lastReady) {
      lastReady = ready;
      if (ready && isOpen()) renderColumns(); // drop the "initializing" placeholders
    }
  }

  // Opening the deck. The overlay is rebuilt whenever X has thrown it away, so
  // the launcher button can never end up toggling a detached copy of the deck
  // (which is what made clicking the button look like it did nothing).
  function ensureOverlay() {
    if (!overlay || !overlay.isConnected) { overlay = null; buildOverlay(); return overlay; }
    if (overlay.parentNode !== document.body) document.body.appendChild(overlay);
    return overlay;
  }
  function openDeck() {
    if (!document.body) return;
    ensureOverlay();
    overlay.classList.add('open');
    updateStatus(); renderSidebar(); renderColumns(); scheduleAuto();
    if (!isReady()) bootstrap();
  }
  function closeDeck() { if (overlay) overlay.classList.remove('open'); }
  function toggleDeck() { if (!document.body) return; isOpen() ? closeDeck() : openDeck(); }

  function addFab() {
    if (document.getElementById('xdeck-fab')) return;
    if (!document.body) return;
    injectStyles();
    const fab = document.createElement('button');
    fab.id = 'xdeck-fab';
    fab.type = 'button';
    fab.textContent = '▦ Deck';
    fab.title = 'Open X Column Deck';
    fab.onclick = toggleDeck;
    document.body.appendChild(fab);
    console.log('[X Column Deck] button added');
  }

  // Add the button now and keep it alive across X's SPA re-renders.
  function boot() {
    if (!document.body) return;
    addFab();
    if (!isReady()) setTimeout(() => { bootstrap(); }, 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(() => {
    addFab();
    // Re-attach an open deck if X wiped it out of the document.
    if (overlay && !overlay.isConnected && overlay.classList.contains('open') && document.body) {
      document.body.appendChild(overlay);
    }
  }, 2000); // self-heal if X ever removes it

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closeDeck(); }, true);

  // Also openable from Tampermonkey's own menu.
  try {
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Open X Column Deck', openDeck);
  } catch {}
})();
