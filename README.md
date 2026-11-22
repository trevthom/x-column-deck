<p align="center">X Column Deck</p>

This script can be inserted into the Tampermonkey extension to turn your X.com UI into columns of people you particularly want to see updates from.

- drag & drop sorting
- auto-refresh times
- shows most recent posts
- your own lists for your columns (kept by the script, separate from X.com's lists)
- a sidebar to show only the lists you want to look at
- may prevent you from spending a ridiculous amount of time scrolling X

<p align="center">
    <img align="center" alt="screenshot of deck" src="x-column-deck.png">
</p>

## Installing it in Tampermonkey

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension for your browser
   (available for Chrome, Edge, Firefox, Safari and Opera) and pin it to the toolbar.
2. Click the Tampermonkey icon and choose **Create a new script…** (or open the
   Dashboard → **`+`** tab).
3. Select everything in the editor, delete it, and paste the entire contents of
   [`x-column-deck.user.js`](x-column-deck.user.js).
4. Save with **Ctrl/Cmd + S**. The script now appears in the **Installed
   Userscripts** list with its switch turned on (green).
5. Open <https://x.com> (or <https://twitter.com>) and reload the page once.
   A **▦ Deck** button appears in the bottom-right corner.

Notes on the first run and permissions:

- The script has to see X's own requests once so it can learn the current
  GraphQL IDs from your logged-in session. Visit any profile page, then open the
  deck: the status in its header changes from *"open any X profile once to
  initialize"* to **✓ ready**.
- If the **▦ Deck** button doesn't appear, check that the script is enabled for
  `x.com` in Tampermonkey (the icon shows a badge with the number of scripts that
  ran), and that your browser allows userscripts / developer mode (Chrome needs
  the extension's "Allow user scripts" toggle).
- You can also open the deck from Tampermonkey itself: click its icon →
  **Open X Column Deck** (registered as a userscript menu command), or use the
  **▦ Deck** button. **Esc** closes the deck.

## Using the deck

- **Add a column**: type `@somebody` in the header field and press Enter. Pick a
  list next to the field first if you want the new column filed there right away.
- **Lists are yours, not X's**: the sidebar on the left holds lists the script
  keeps for you (`reselling`, `bitcoin`, …). They are stored locally by
  Tampermonkey and never touch your X account or X's own Lists feature. Create
  one with the **new list** field, delete one with the ✕ next to it.
- **Filter columns**: tick the lists you want to see in the sidebar. Only columns
  filed under a ticked list are shown; **All** clears the ticks and shows every
  column. Columns with no list sit in **Unsorted** and stay hidden while a list
  filter is active.
- **Re-file a column**: use the small dropdown in the column header.
- **Reorder columns**: drag a column by its header. **Remove**: the ✕ in the header.
- **Refresh**: *Refresh all* reloads the visible columns (X is rate limited, so it
  pauses between users); *auto* refreshes on a timer while the deck is open.
  Scrolling to the bottom of a column loads older posts.

## Updating

Paste the new `x-column-deck.user.js` contents over the old script in the
Tampermonkey editor, save, and reload X. Your columns, lists and cached posts are
kept in Tampermonkey storage, so they survive the update.
