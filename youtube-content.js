function createSummaryButton() {
  const topBar = document.querySelector('#container.ytd-searchbox') ||
                 document.querySelector('#center.ytd-masthead') ||
                 document.querySelector('ytd-masthead #end');

  if (!topBar || document.querySelector('#yt-btn-container')) return;

  // Spinner keyframe
  const style = document.createElement('style');
  style.textContent = `
    @keyframes yt-btn-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  // Container for both buttons
  const container = document.createElement('div');
  container.id = 'yt-btn-container';
  container.style.cssText = `
    position: fixed; top: 70px; right: 20px; z-index: 9999;
    display: flex; gap: 8px;
  `;

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

  const summarizeBtn = makeButton('yt-summarize-btn', '✨', '#5C5CFF', '#4A4AD9');
  const ccBtn = makeButton('yt-cc-btn', '🖥️', '#333', '#444');

  summarizeBtn.title = 'Summarize';
  ccBtn.title = 'Open in Claude Code';

  summarizeBtn.onclick = () => {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;
    summarizeBtn.setLoading(true);
    chrome.runtime.sendMessage({ action: 'summarizeVideo', videoId });
  };

  ccBtn.onclick = () => {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;
    ccBtn.setLoading(true);
    const title = document.title.replace(/^\(\d+\)\s+/, '').replace(/ - YouTube$/, '');
    const channel =
      document.querySelector('ytd-channel-name#channel-name a')?.textContent?.trim() ||
      document.querySelector('#owner #channel-name a')?.textContent?.trim() ||
      document.querySelector('span[itemprop="author"] [itemprop="name"]')?.getAttribute('content') ||
      '';
    chrome.runtime.sendMessage({ action: 'openVideoInCC', videoId, title, channel, url: window.location.href });
  };

  container.appendChild(summarizeBtn);
  container.appendChild(ccBtn);
  document.body.appendChild(container);

  chrome.runtime.onMessage.addListener((request) => {
    if (['displaySummary', 'updateSummary', 'updateFastSummary', 'updateDeepSummary', 'summaryError'].includes(request.action)) {
      summarizeBtn.setLoading(false);
    }
    if (request.action === 'openInCCComplete' || request.action === 'openInCCError') {
      ccBtn.setLoading(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Feed-tile "Open in Claude Code" buttons
// Adds a hover-revealed 🖥️ button to every regular-video thumbnail in the
// feed / search results / watch-page sidebar, so a transcript can be opened in
// Claude Code without navigating into the video. Reuses the existing
// openVideoInCC message flow — no background.js or native-host changes needed.
// ---------------------------------------------------------------------------

let activeCCTileBtn = null;

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

function makeTileCCButton() {
  const btn = document.createElement('button');
  btn.className = 'yt-cc-tile-btn';
  btn.title = 'Open in Claude Code';
  btn._emoji = '🖥️';
  btn.innerHTML = btn._emoji;
  btn.style.cssText = `
    position: absolute; top: 8px; left: 8px; z-index: 2019;
    width: 32px; height: 32px; border-radius: 50%;
    background: rgba(0,0,0,0.75); color: #fff; border: none; cursor: pointer;
    font-size: 15px; line-height: 1; display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 0.15s, background-color 0.2s;
    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
  `;
  btn.onmouseover = () => { if (!btn.disabled) btn.style.background = 'rgba(40,40,40,0.95)'; };
  btn.onmouseout = () => { if (!btn.disabled) btn.style.background = 'rgba(0,0,0,0.75)'; };
  btn.setLoading = (loading) => {
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<div style="width:14px;height:14px;border:2px solid #fff;border-top:2px solid transparent;border-radius:50%;animation:yt-btn-spin 1s linear infinite;"></div>'
      : btn._emoji;
  };
  return btn;
}

function injectTileButtons() {
  // YouTube ships TWO thumbnail layouts simultaneously:
  //  - old Polymer (search results, watch sidebar): a#thumbnail inside ytd-thumbnail
  //  - new view-model (home + channel grids): a.ytLockupViewModelContentImage
  //    inside div.ytLockupViewModelHost — NO id, so the old selector missed it
  //    entirely (that's why buttons never appeared on the home feed).
  // Both are watch links wrapping a thumbnail image; we anchor the button to the
  // thumbnail box (old) / lockup host (new), which are the position:relative
  // containers whose top-left coincides with the thumbnail in every layout.
  document.querySelectorAll(
    'a#thumbnail[href*="watch?v="], a.ytLockupViewModelContentImage[href*="watch?v="]'
  ).forEach((anchor) => {
    const container =
      anchor.closest('ytd-thumbnail') ||          // old Polymer layout
      anchor.closest('.ytLockupViewModelHost') ||  // new view-model layout
      anchor.parentElement;
    // Re-check by button presence (not a flag) so recycled tiles that get their
    // children wiped during infinite scroll get a fresh button re-attached.
    if (!container || container.querySelector(':scope > .yt-cc-tile-btn')) return;

    const btn = makeTileCCButton();
    btn.addEventListener('click', (e) => {
      // Stop the click from triggering YouTube's SPA navigation on the anchor.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      let videoId = '';
      try {
        videoId = new URL(anchor.href, location.origin).searchParams.get('v') || '';
      } catch (_) {}
      if (!videoId) return;

      // Best-effort title/channel for naming the Claude Code session; both are
      // optional downstream (background.js defaults them to ''). Selectors cover
      // both the old Polymer markup and the new view-model lockup markup.
      const tile = anchor.closest(
        'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model'
      );
      const title =
        tile?.querySelector('#video-title, h3 a, .yt-lockup-metadata-view-model-wiz__title')?.textContent?.trim() ||
        anchor.getAttribute('title')?.trim() ||
        anchor.getAttribute('aria-label')?.trim() || '';
      const channel =
        tile?.querySelector('ytd-channel-name a, #channel-name a, .ytd-channel-name, .yt-content-metadata-view-model-wiz__metadata-text')?.textContent?.trim() || '';
      const url = `https://www.youtube.com/watch?v=${videoId}`;

      activeCCTileBtn = btn;
      btn.setLoading(true);
      chrome.runtime.sendMessage({ action: 'openVideoInCC', videoId, title, channel, url });
    });

    container.appendChild(btn);
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

// Completion/error feedback for tile-initiated "Open in Claude Code".
// Guarded by activeCCTileBtn so the watch-page fixed button's flow is untouched.
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'openInCCComplete' && activeCCTileBtn) {
    const btn = activeCCTileBtn;
    activeCCTileBtn = null;
    btn.disabled = false;
    btn.innerHTML = '✅';
    setTimeout(() => { if (!btn.disabled) btn.innerHTML = btn._emoji; }, 2000);
    showCCToast('✅ Opened in Claude Code', false);
  } else if (request.action === 'openInCCError' && activeCCTileBtn) {
    activeCCTileBtn.setLoading(false);
    activeCCTileBtn = null;
    showCCToast('⚠️ ' + (request.error || 'Failed to open in Claude Code'), true);
  }
});

// Reveal the tile button for whichever card the pointer is over.
// CSS :hover / mouseenter on the card don't work: when YouTube's inline preview
// activates it floats a shared #video-preview element (parented at ytd-app) OVER
// the thumbnail, so the pointer's hit-test target becomes the preview, not the
// card — the card loses :hover and a CSS-revealed button vanishes exactly when
// you're looking at the tile. elementsFromPoint() returns every element stacked
// at the point (in paint order), so it sees THROUGH the preview to the card.
const TILE_CARD_SEL =
  'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model';

let hoveredTileBtn = null;
function setTileBtnShown(btn, shown) {
  if (!btn) return;
  // Keep an in-flight (loading) button visible even when not hovered, so its
  // spinner / ✅ feedback isn't hidden if the pointer moves away mid-open.
  if (!shown && btn.disabled) return;
  btn.style.opacity = shown ? '1' : '0';
  btn.style.pointerEvents = shown ? 'auto' : 'none';
}

function revealTileBtnAt(x, y) {
  let btn = null;
  for (const el of document.elementsFromPoint(x, y)) {
    const card = el.closest && el.closest(TILE_CARD_SEL);
    if (card) { btn = card.querySelector('.yt-cc-tile-btn'); break; }
  }
  if (btn === hoveredTileBtn) return;
  setTileBtnShown(hoveredTileBtn, false);
  hoveredTileBtn = btn;
  setTileBtnShown(hoveredTileBtn, true);
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
