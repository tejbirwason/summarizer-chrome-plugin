function createSummaryButton() {
  const menu = document.querySelector('#top-level-buttons-computed');
  if (!menu || document.querySelector('#yt-summarize-btn')) return;

  const button = document.createElement('button');
  button.id = 'yt-summarize-btn';
  button.innerHTML = '✨';
  button.style.cssText = `
    margin-left: 8px;
    padding: 8px 16px;
    background: #5C5CFF;
    color: white;
    border: none;
    border-radius: 18px;
    cursor: pointer;
  `;

  const spinner = document.createElement('div');
  spinner.style.cssText = `
    display: none;
    width: 12px;
    height: 12px;
    border: 2px solid #ffffff;
    border-top: 2px solid transparent;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-right: 6px;
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  button.prepend(spinner);

  button.onclick = () => {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;

    spinner.style.display = 'inline-block';
    button.disabled = true;

    chrome.runtime.sendMessage({
      action: 'summarizeVideo',
      videoId: videoId,
    });
  };

  menu.appendChild(button);

  // Listen for summary completion
  chrome.runtime.onMessage.addListener((request) => {
    if (
      request.action === 'displaySummary' ||
      request.action === 'updateSummary'
    ) {
      spinner.style.display = 'none';
      button.disabled = false;
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
window.addEventListener('popstate', () => {
  if (window.location.pathname === '/watch') {
    createSummaryButton();
  }
});
