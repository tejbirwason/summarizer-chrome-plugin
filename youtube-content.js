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
    chrome.runtime.sendMessage({ action: 'openVideoInCC', videoId });
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
