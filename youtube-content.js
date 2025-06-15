function createSummaryButton() {
  // Look for the top bar actions container (search bar area)
  const topBar = document.querySelector('#container.ytd-searchbox') || 
                 document.querySelector('#center.ytd-masthead') ||
                 document.querySelector('ytd-masthead #end');
  
  if (!topBar || document.querySelector('#yt-summarize-btn')) return;

  const button = document.createElement('button');
  button.id = 'yt-summarize-btn';
  button.innerHTML = '✨ Summarize';
  button.style.cssText = `
    position: fixed;
    top: 70px;
    right: 20px;
    z-index: 9999;
    padding: 10px 20px;
    background: #5C5CFF;
    color: white;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    font-family: Roboto, Arial, sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    display: inline-flex;
    align-items: center;
    transition: background-color 0.2s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  
  button.onmouseover = () => {
    button.style.background = '#4A4AD9';
  };
  
  button.onmouseout = () => {
    button.style.background = '#5C5CFF';
  };

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
    button.style.opacity = '0.7';
    
    // Update button text while loading
    const textNode = button.childNodes[1];
    if (textNode) textNode.textContent = ' Summarizing Video...';

    chrome.runtime.sendMessage({
      action: 'summarizeVideo',
      videoId: videoId,
    });
  };

  // Add button to the page body (since it's fixed position)
  document.body.appendChild(button);

  // Listen for summary completion
  chrome.runtime.onMessage.addListener((request) => {
    if (
      request.action === 'displaySummary' ||
      request.action === 'updateSummary'
    ) {
      spinner.style.display = 'none';
      button.disabled = false;
      button.style.opacity = '1';
      
      // Reset button text
      const textNode = button.childNodes[1];
      if (textNode) textNode.textContent = ' Summarize';
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
      setTimeout(createSummaryButton, 500); // Small delay to ensure DOM is ready
    }
  }
}).observe(document, {subtree: true, childList: true});

// Handle browser back/forward navigation
window.addEventListener('popstate', () => {
  if (window.location.pathname === '/watch') {
    createSummaryButton();
  }
});

// Initial check on load
if (window.location.pathname === '/watch') {
  createSummaryButton();
}
