// Reloading the extension orphans content scripts already injected into open tabs: chrome.runtime.id
// goes undefined and sendMessage throws "Extension context invalidated". Every send below used to
// fail silently (refreshSummaryStatus even swallowed it in a bare catch), leaving buttons spinning
// forever with nothing in any log. Detect it, stop the spinners, and tell the user to refresh.
let ytContextDead = false;

function ytExtensionAlive() {
  try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

// Shares an element id with content-dual.js's banner, so only one ever appears on a YouTube page.
function ytHandleDeadContext() {
  ytContextDead = true;
  document.querySelectorAll('#yt-btn-container button, .yt-sum-tile-btn').forEach(b => {
    if (b.setLoading) b.setLoading(false);
  });
  if (document.getElementById('claude-stale-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'claude-stale-banner';
  banner.textContent = '⚠️ Extension was reloaded — refresh this page to use the summarizer.';
  banner.style.cssText = `
    position: fixed; top: 70px; left: 50%; transform: translateX(-50%); z-index: 100000;
    background: #4a2c2c; color: #ffd7d7; border: 1px solid #a33; border-radius: 6px;
    padding: 10px 16px; font-size: 13px; font-family: -apple-system, sans-serif;
    box-shadow: 0 2px 10px rgba(0,0,0,0.4); cursor: pointer;
  `;
  banner.onclick = () => location.reload();
  document.body.appendChild(banner);
}

// Only an actually-severed context counts as dead. Every other failure (a sleeping service
// worker, a bad argument) must surface as itself — flagging those as "extension reloaded" would
// permanently disable the page's buttons and point at the wrong cause.
function ytIsContextGone(err) {
  return !ytExtensionAlive() || /context invalidated/i.test(err?.message || '');
}

function ytSend(msg, callback) {
  if (!ytExtensionAlive()) { ytHandleDeadContext(); return false; }
  try {
    // Never pass an explicit `undefined` callback: Chrome matches sendMessage by arity and
    // rejects the 2-arg form with "No matching signature".
    const maybePromise = callback
      ? chrome.runtime.sendMessage(msg, callback)
      : chrome.runtime.sendMessage(msg);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((err) => {
        if (ytIsContextGone(err)) ytHandleDeadContext();
        else console.error('[yt-summarizer] sendMessage failed:', err);
      });
    }
    return true;
  } catch (e) {
    if (ytIsContextGone(e)) { ytHandleDeadContext(); return false; }
    console.error('[yt-summarizer] sendMessage failed:', e);
    return false;
  }
}

function createSummaryButton() {
  // Anchor inside the player itself (position:relative, and the fullscreen element)
  // so the buttons ride the video in default/theater/fullscreen/miniplayer instead
  // of floating over whatever page content happens to be underneath.
  const player = document.querySelector('#movie_player') ||
                 document.querySelector('.html5-video-player');

  // No player yet on this SPA nav — the MutationObserver calls us again.
  if (!player || document.querySelector('#yt-btn-container')) return;

  // Spinner keyframe
  const style = document.createElement('style');
  style.textContent = `
    @keyframes yt-btn-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  // Container for watch-page action buttons: top-right corner of the player.
  // z-index 2019 clears YouTube's own chrome-top row (share / watch-later, ~60) but
  // stays under the sticky masthead (2020) — #movie_player is position:relative with
  // z-index:auto, so it makes no stacking context and we compete at the root level.
  const container = document.createElement('div');
  container.id = 'yt-btn-container';
  container.style.cssText = `
    position: absolute; top: 12px; right: 12px; z-index: 2019;
    display: flex; gap: 8px; flex-direction: row; align-items: center;
  `;
  // Anything inside the player bubbles up to YouTube's play/pause click handler.
  ['click', 'dblclick', 'mousedown'].forEach(type =>
    container.addEventListener(type, e => e.stopPropagation()));

  function makeButton(id, emoji, bg, hoverBg) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.innerHTML = emoji;
    btn.style.cssText = `
      width: 44px; height: 44px; border-radius: 50%; background: ${bg}; color: white;
      border: none; cursor: pointer; font-size: 20px; display: flex; align-items: center;
      justify-content: center; transition: background-color 0.2s, opacity 0.2s;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); position: relative;
    `;
    btn.onmouseover = () => { if (!btn.disabled) btn.style.background = hoverBg; };
    btn.onmouseout = () => { if (!btn.disabled) btn.style.background = bg; };

    btn._emoji = emoji;
    btn._bg = bg;
    btn.setLoading = (loading) => {
      btn.disabled = loading;
      btn.style.opacity = loading ? '0.7' : '1';
      btn.innerHTML = loading ? '<div style="width:18px;height:18px;border:2px solid #fff;border-top:2px solid transparent;border-radius:50%;animation:yt-btn-spin 1s linear infinite;"></div>' : btn._emoji;
    };
    return btn;
  }

  // TWO buttons again. ✨ is the full run (summary + explain-viz infographic poster). ⚡ is a
  // "quick summary": same summary, but it tells the Worker to skip the infographic — faster,
  // and no fal cost. Both scrape the transcript here in the page (the Worker can't — YouTube
  // blocks the whole cloud ASN) and hand it to the background; only the noPoster flag differs.
  const summarizeBtn = makeButton('yt-summarize-btn', '✨', '#5C5CFF', '#4A4AD9');
  summarizeBtn.title = 'Summarize + infographic (cloud)';
  const quickBtn = makeButton('yt-quick-btn', '⚡', '#2f8f7f', '#26766a');
  quickBtn.title = 'Quick summary — no infographic';

  const runVideoSummary = async (btn, noPoster) => {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;
    btn.setLoading(true);
    // Pass the real video title (+ canonical url) so the summary/history isn't labelled "YouTube".
    // Prefer the on-page title element — document.title can still read "YouTube" on SPA nav.
    const title =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1, ytd-watch-metadata h1')?.textContent?.trim() ||
      document.title.replace(/^\(\d+\)\s+/, '').replace(/ - YouTube$/, '');

    // No pre-scraping here. The background fetches the transcript itself: native host
    // (yt-summary.py, ~2s, touches nothing on this page) first, and only if that fails does it
    // message back into this tab for the DOM-panel scrape (yt-transcript.js). Failures surface
    // through the normal summaryError path in the panel, not an alert.
    ytSend({ action: 'summarizeVideo', videoId, title, url: window.location.href, noPoster });
  };

  summarizeBtn.onclick = () => runVideoSummary(summarizeBtn, false);
  quickBtn.onclick = () => runVideoSummary(quickBtn, true);

  container.appendChild(quickBtn);
  container.appendChild(summarizeBtn);
  player.appendChild(container);

  chrome.runtime.onMessage.addListener((request) => {
    // Clear spinners once streaming starts or fails — initSummary fires before any
    // tokens, so keep them until the first real content/error event.
    if (['updateSummary', 'summaryComplete', 'summaryError', 'displaySummary'].includes(request.action)) {
      summarizeBtn.setLoading(false);
      quickBtn.setLoading(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Feed-tile action buttons
// Hover-revealed ✨ (cloud summarize) on every
// regular-video thumbnail in the feed / search results / watch-page sidebar.
// Reuses the existing summarizeVideo flow —
// no background.js or native-host changes needed.
// ---------------------------------------------------------------------------

let activeSumTileBtn = null;

// ---------------------------------------------------------------------------
// Summary status cache — which videos already have a transcript ("summarized")
// and which have a generated graphic. Populated from the native host via
// background.js (the filesystem there is the source of truth). Lets tiles show
// a persistent marker and open the graphic directly instead of re-summarizing.
// ---------------------------------------------------------------------------
const summaryStatus = { summarized: new Set(), graphics: new Map() };

function videoIdOf(anchor) {
  try { return new URL(anchor.href, location.origin).searchParams.get('v') || ''; }
  catch (_) { return ''; }
}

function applyStatusToTileBtn(btn) {
  if (!btn || !btn.applyState) return;
  const id = btn._anchor ? videoIdOf(btn._anchor) : '';
  if (id && summaryStatus.graphics.has(id)) btn.applyState('graphic', summaryStatus.graphics.get(id));
  else if (id && summaryStatus.summarized.has(id)) btn.applyState('summarized');
  else btn.applyState('default');
}

function applyStatusToTile(container) {
  if (!container) return;
  container.querySelectorAll(':scope > .yt-sum-tile-btn, :scope > .yt-cc-tile-btn').forEach(applyStatusToTileBtn);
}

let statusInFlight = false;
let lastStatusAt = 0;
function refreshSummaryStatus(force) {
  if (ytContextDead) return;  // stop polling a background that can no longer hear us
  const now = Date.now();
  if (!force && now - lastStatusAt < 15000) return;  // throttle native-host spawns
  if (statusInFlight) return;
  statusInFlight = true;
  lastStatusAt = now;
  const sent = ytSend({ action: 'getSummaryStatus' }, (resp) => {
    statusInFlight = false;
    if (chrome.runtime.lastError || !resp) return;
    summaryStatus.summarized = new Set(resp.summarized || []);
    summaryStatus.graphics = new Map(Object.entries(resp.graphics || {}));
    document.querySelectorAll('.yt-sum-tile-btn').forEach(applyStatusToTileBtn);
    updateWatchGraphicButton();
  });
  if (!sent) statusInFlight = false;
}

function updateWatchGraphicButton() {
  const gb = document.getElementById('yt-graphic-btn');
  if (!gb) return;
  const videoId = new URLSearchParams(window.location.search).get('v');
  gb.style.display = (videoId && summaryStatus.graphics.has(videoId)) ? 'flex' : 'none';
}

function ensureTileStyles() {
  if (document.getElementById('yt-tile-styles')) return;
  const style = document.createElement('style');
  style.id = 'yt-tile-styles';
  // Only the spinner keyframe lives in CSS. The hover reveal is driven by JS
  // (see the pointer tracker below) — CSS :hover can't be used because YouTube's
  // inline preview floats over the thumbnail and steals the tile's :hover state.
  style.textContent = `
    @keyframes yt-btn-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function tileBtnBaseStyle(rightPx) {
  return `
    position: absolute; bottom: 8px; right: ${rightPx}px; z-index: 2019;
    width: 32px; height: 32px; border-radius: 50%;
    color: #fff; border: none; cursor: pointer;
    font-size: 15px; line-height: 1; display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 0.15s, filter 0.15s, background-color 0.2s;
    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
  `;
}

function tileIsHovered(btn) {
  return Boolean(hoveredTileCard && btn && hoveredTileCard.contains(btn));
}

function wireTileBtnChrome(btn) {
  // Hover via brightness filter so the base colour (which encodes state) is preserved.
  btn.onmouseover = () => { if (!btn.disabled) btn.style.filter = 'brightness(1.3)'; };
  btn.onmouseout = () => { if (!btn.disabled) btn.style.filter = 'none'; };
  btn.setLoading = (loading) => {
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<div style="width:14px;height:14px;border:2px solid #fff;border-top:2px solid transparent;border-radius:50%;animation:yt-btn-spin 1s linear infinite;"></div>'
      : btn._emoji;
    // Keep spinner visible while in-flight; otherwise restore hover/persistent visibility.
    setTileBtnShown(btn, loading || btn._persistent || tileIsHovered(btn));
  };
}

function makeTileSumButton() {
  const btn = document.createElement('button');
  btn.className = 'yt-sum-tile-btn';
  btn.title = 'Summarize inline';
  btn._defaultEmoji = '✨';
  btn._emoji = btn._defaultEmoji;
  btn._baseBg = 'rgba(92,92,255,0.92)';
  btn._persistent = false;
  btn._state = 'default';
  btn.innerHTML = btn._emoji;
  // Now the only tile button, so it takes the corner slot the 🖥️ button used to hold.
  btn.style.cssText = tileBtnBaseStyle(8) + `background: ${btn._baseBg};`;
  wireTileBtnChrome(btn);
  // summarized/graphic tiles: stay visible without hover so you can re-open.
  btn.applyState = (state) => {
    btn._state = state;
    if (state === 'summarized' || state === 'graphic') {
      btn._emoji = '✨'; btn._baseBg = 'rgba(92,92,255,0.92)';
      btn.title = 'Re-summarize inline'; btn._persistent = true;
    } else {
      btn._emoji = btn._defaultEmoji; btn._baseBg = 'rgba(92,92,255,0.92)';
      btn.title = 'Summarize inline'; btn._persistent = false;
    }
    if (!btn.disabled) btn.innerHTML = btn._emoji;
    btn.style.background = btn._baseBg;
    setTileBtnShown(btn, btn._persistent || tileIsHovered(btn));
  };
  return btn;
}

function tileMeta(anchor) {
  // Best-effort title/channel for naming Claude Code sessions; both are optional
  // downstream. Selectors cover old Polymer markup and new view-model lockups.
  const tile = anchor.closest(
    'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model'
  );
  const title =
    tile?.querySelector('#video-title, h3 a, .yt-lockup-metadata-view-model-wiz__title')?.textContent?.trim() ||
    anchor.getAttribute('title')?.trim() ||
    anchor.getAttribute('aria-label')?.trim() || '';
  const channel =
    tile?.querySelector('ytd-channel-name a, #channel-name a, .ytd-channel-name, .yt-content-metadata-view-model-wiz__metadata-text')?.textContent?.trim() || '';
  return { title, channel };
}

function injectTileButtons() {
  // YouTube ships TWO thumbnail layouts simultaneously:
  //  - old Polymer (search results, watch sidebar): a#thumbnail inside ytd-thumbnail
  //  - new view-model (home + channel grids): a.ytLockupViewModelContentImage
  //    inside div.ytLockupViewModelHost — NO id, so the old selector missed it
  //    entirely (that's why buttons never appeared on the home feed).
  // Both are watch links wrapping a thumbnail image; we anchor the buttons to the
  // thumbnail box (old) / lockup host (new), which are the position:relative
  // containers whose top-left coincides with the thumbnail in every layout.
  document.querySelectorAll(
    'a#thumbnail[href*="watch?v="], a.ytLockupViewModelContentImage[href*="watch?v="]'
  ).forEach((anchor) => {
    const container =
      anchor.closest('ytd-thumbnail') ||          // old Polymer layout
      anchor.closest('.ytLockupViewModelHost') ||  // new view-model layout
      anchor.parentElement;
    if (!container) return;

    // Idempotent re-attach: recycled tiles wipe children during infinite scroll.
    // Check each button independently so a partial inject (e.g. only CC from an
    // older build) still gets the new ✨ button.
    if (!container.querySelector(':scope > .yt-sum-tile-btn')) {
      const sumBtn = makeTileSumButton();
      sumBtn._anchor = anchor;
      sumBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const videoId = videoIdOf(anchor);
        if (!videoId) return;
        activeSumTileBtn = sumBtn;
        sumBtn.setLoading(true);
        // Pass the tile's title so the history entry names the video, not the feed page.
        const { title } = tileMeta(anchor);
        ytSend({ action: 'summarizeVideo', videoId, title });
      });
      container.appendChild(sumBtn);
      applyStatusToTileBtn(sumBtn);
    }
  });
}

let tileScanScheduled = false;
function scheduleTileScan() {
  if (tileScanScheduled) return;
  tileScanScheduled = true;
  setTimeout(() => {
    tileScanScheduled = false;
    ensureTileStyles();
    injectTileButtons();
    refreshSummaryStatus();  // throttled; re-marks tiles when status changes
  }, 250);
}

function showCCToast(message, isError) {
  let toast = document.getElementById('yt-cc-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'yt-cc-toast';
    document.body.appendChild(toast);
  }
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
    z-index: 100000; background: ${isError ? '#7f1d1d' : '#0f5132'}; color: #fff;
    padding: 12px 18px; border-radius: 10px; font-size: 14px;
    font-family: Roboto, Arial, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    opacity: 0; transition: opacity 0.25s, transform 0.25s; pointer-events: none;
  `;
  toast.textContent = message;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 2500);
}

// The background asks the page to scrape YouTube's transcript panel. This is the only place
// the transcript can legitimately be read — see yt-transcript.js for why.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'extractTranscript') {
    window.__ytTranscript
      .extractTranscript()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: 'threw', detail: String(e.message || e) }));
    return true; // async
  }
});

// Completion/error feedback for tile-initiated actions.
// Guarded by activeSumTileBtn so the watch-page button's flow stays untouched.
chrome.runtime.onMessage.addListener((request) => {
  // Inline summarize from a tile: clear spinner on first token / complete / error.
  // summaryComplete flips the tile into the persistent "summarized" state via status.
  if (activeSumTileBtn &&
      ['updateSummary', 'updateFastSummary', 'updateDeepSummary', 'summaryComplete', 'summaryError', 'displaySummary'].includes(request.action)) {
    const btn = activeSumTileBtn;
    // Keep spinner until stream actually starts or fails (initSummary alone is too early).
    if (request.action === 'summaryError') {
      btn.setLoading(false);
      activeSumTileBtn = null;
      showCCToast('⚠️ ' + (request.error || 'Summarize failed'), true);
    } else if (request.action === 'summaryComplete') {
      btn.setLoading(false);
      activeSumTileBtn = null;
      btn.innerHTML = '✅';
      setTimeout(() => { if (!btn.disabled) btn.innerHTML = btn._emoji; }, 2000);
      refreshSummaryStatus(true);
    } else if (btn.disabled) {
      // first delta — overlay is live, stop the spinner but keep tracking until complete
      // so summaryComplete can still refresh the summarized-state marker.
      btn.setLoading(false);
    }
  }
});

// Reveal the tile buttons for whichever card the pointer is over.
// CSS :hover / mouseenter on the card don't work: when YouTube's inline preview
// activates it floats a shared #video-preview element (parented at ytd-app) OVER
// the thumbnail, so the pointer's hit-test target becomes the preview, not the
// card — the card loses :hover and a CSS-revealed button vanishes exactly when
// you're looking at the tile. elementsFromPoint() returns every element stacked
// at the point (in paint order), so it sees THROUGH the preview to the card.
const TILE_CARD_SEL =
  'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model';

// The card under the pointer; both of its tile buttons are shown together.
let hoveredTileCard = null;
// Back-compat alias used by applyState to keep an in-flight button visible:
// set to either of the card's buttons when that card is hovered.
let hoveredTileBtn = null;

function setTileBtnShown(btn, shown) {
  if (!btn) return;
  // Keep an in-flight (loading) button — or a persistent summarized/graphic
  // marker — visible even when not hovered.
  if (!shown && (btn.disabled || btn._persistent)) return;
  btn.style.opacity = shown ? '1' : '0';
  btn.style.pointerEvents = shown ? 'auto' : 'none';
}

function tileButtonsOf(card) {
  if (!card) return [];
  return [...card.querySelectorAll('.yt-sum-tile-btn, .yt-cc-tile-btn')];
}

function revealTileBtnAt(x, y) {
  let card = null;
  for (const el of document.elementsFromPoint(x, y)) {
    card = el.closest && el.closest(TILE_CARD_SEL);
    if (card) break;
  }
  if (card === hoveredTileCard) return;
  // Hide previous card's non-persistent buttons
  tileButtonsOf(hoveredTileCard).forEach(b => setTileBtnShown(b, false));
  hoveredTileCard = card;
  const btns = tileButtonsOf(card);
  hoveredTileBtn = btns[0] || null;
  btns.forEach(b => setTileBtnShown(b, true));
}

let revealRaf = 0;
document.addEventListener('mousemove', (e) => {
  if (revealRaf) return; // throttle to one resolve per animation frame
  const x = e.clientX, y = e.clientY;
  revealRaf = requestAnimationFrame(() => { revealRaf = 0; revealTileBtnAt(x, y); });
}, { passive: true });

// Inject tile buttons across the feed and keep up with infinite scroll / SPA nav.
const tileObserver = new MutationObserver(scheduleTileScan);
tileObserver.observe(document.body, { childList: true, subtree: true });
scheduleTileScan();

// Watch for YouTube navigation
const observer = new MutationObserver(() => {
  if (window.location.pathname === '/watch') {
    createSummaryButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Also check on URL changes
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    updateWatchGraphicButton();  // instant from cache: reflect the newly-opened video
    if (window.location.pathname === '/watch') {
      setTimeout(createSummaryButton, 500);
    }
  }
}).observe(document, {subtree: true, childList: true});

window.addEventListener('popstate', () => {
  if (window.location.pathname === '/watch') {
    createSummaryButton();
  }
});

if (window.location.pathname === '/watch') {
  createSummaryButton();
}
