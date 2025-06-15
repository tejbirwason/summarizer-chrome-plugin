// content.js

function displaySummary(summary) {
  let container = document.getElementById('claude-summary-container');

  if (!container) {
    container = document.createElement('div');
    container.id = 'claude-summary-container';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      max-height: 80vh;
      background: #1e1e1e;
      color: #e0e0e0;
      padding: 15px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      z-index: 10000;
      overflow-y: auto;
      font-size: 15px;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, Oxygen-Sans,
        Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
      overscroll-behavior: contain;
    `;

    const closeButton = document.createElement('button');
    closeButton.innerHTML = '×';
    closeButton.style.cssText = `
      position: absolute;
      top: 5px;
      right: 5px;
      border: none;
      background: none;
      font-size: 20px;
      cursor: pointer;
      color: #e0e0e0;
    `;
    closeButton.onclick = () => container.remove();

    const content = document.createElement('div');
    content.id = 'summary-content';
    content.style.marginTop = '10px';
    content.style.whiteSpace = 'pre-wrap';

    container.appendChild(closeButton);
    container.appendChild(content);
    document.body.appendChild(container);
  }

  // Update text
  document.getElementById('summary-content').textContent = summary;
}

// Inject two FABs: "✨" for Summarize, "📝" for Draft
function injectFABs() {
  // Summarize FAB
  const summarizeFab = document.createElement('button');
  summarizeFab.className = 'fab';
  summarizeFab.innerHTML = '✨';
  summarizeFab.title = 'Summarize selection';
  summarizeFab.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-45px);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #5C5CFF;
    color: white;
    border: none;
    cursor: pointer;
    z-index: 10000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    transition: all 0.2s;
  `;
  summarizeFab.onmouseover = () => {
    summarizeFab.style.background = '#4646FF';
    summarizeFab.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  };
  summarizeFab.onmouseout = () => {
    summarizeFab.style.background = '#5C5CFF';
    summarizeFab.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
  };
  summarizeFab.onclick = () => {
    const selectedText = window.getSelection().toString();
    if (!selectedText) return;
    
    // Show loading state
    summarizeFab.disabled = true;
    summarizeFab.innerHTML = '⏳';
    summarizeFab.style.cursor = 'wait';
    
    chrome.runtime.sendMessage({
      action: 'summarize',
      text: selectedText,
    });
  };

  // Draft FAB
  const draftFab = document.createElement('button');
  draftFab.className = 'fab';
  draftFab.innerHTML = '✒️';
  draftFab.title = 'Draft a professional response';
  draftFab.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(5px);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #55BF55;
    color: white;
    border: none;
    cursor: pointer;
    z-index: 10000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    transition: all 0.2s;
  `;
  draftFab.onmouseover = () => {
    draftFab.style.background = '#33AA33';
    draftFab.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  };
  draftFab.onmouseout = () => {
    draftFab.style.background = '#55BF55';
    draftFab.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
  };
  draftFab.onclick = async () => {
    const selectedText = window.getSelection().toString();
    if (!selectedText) return;

    // Show prompt to gather extra instructions
    const userInstructions = await showDraftPrompt();
    if (userInstructions === null) {
      return; // user canceled
    }

    // Send both selected text & user instructions to background
    chrome.runtime.sendMessage({
      action: 'draft',
      text: selectedText,
      instructions: userInstructions,
    });
  };

  // Toggle both FABs if there's a selection
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection().toString().trim();
    // Show or hide both
    if (selection) {
      summarizeFab.style.display = 'flex';
      draftFab.style.display = 'flex';
    } else {
      summarizeFab.style.display = 'none';
      draftFab.style.display = 'none';
    }
  });

  // Add them to the DOM
  document.body.appendChild(summarizeFab);
  document.body.appendChild(draftFab);
}

injectFABs();

// Listen for streaming or final updates
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (
    request.action === 'displaySummary' ||
    request.action === 'updateSummary'
  ) {
    displaySummary(request.summary);
    
    // Reset summarize button state when we start getting responses
    const summarizeFab = document.querySelector('.fab[title="Summarize selection"]');
    if (summarizeFab && summarizeFab.disabled) {
      summarizeFab.disabled = false;
      summarizeFab.innerHTML = '✨';
      summarizeFab.style.cursor = 'pointer';
    }
  }
});

function showDraftPrompt() {
  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
    `;

    // Create modal
    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #1e1e1e;
      color: #e0e0e0;
      padding: 20px;
      border-radius: 8px;
      width: 400px;
    `;
    const label = document.createElement('label');
    label.innerText = 'Additional instructions:';
    label.style.display = 'block';
    label.style.marginBottom = '10px';

    const textArea = document.createElement('textarea');
    textArea.style.width = '100%';
    textArea.style.height = '80px';

    // Add keyboard event handlers
    textArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const instructions = textArea.value.trim();
        document.body.removeChild(overlay);
        resolve(instructions);
      } else if (e.key === 'Escape') {
        document.body.removeChild(overlay);
        resolve(null);
      }
    });

    const buttonBar = document.createElement('div');
    buttonBar.style.marginTop = '10px';
    buttonBar.style.textAlign = 'right';

    const okBtn = document.createElement('button');
    okBtn.innerText = 'OK';
    okBtn.onclick = () => {
      const instructions = textArea.value.trim();
      document.body.removeChild(overlay);
      resolve(instructions);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.innerText = 'Cancel';
    cancelBtn.style.marginLeft = '10px';
    cancelBtn.onclick = () => {
      document.body.removeChild(overlay);
      resolve(null);
    };

    buttonBar.appendChild(okBtn);
    buttonBar.appendChild(cancelBtn);
    modal.appendChild(label);
    modal.appendChild(textArea);
    modal.appendChild(buttonBar);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}
