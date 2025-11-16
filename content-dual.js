// content-dual.js - Dual-mode (Fast/Deep) streaming UI

// Check if already initialized to prevent duplicate injection
if (typeof window.claudeSummarizerInitialized === 'undefined') {
  window.claudeSummarizerInitialized = true;

  // State management
  let activeTab = 'fast'; // 'fast' or 'deep'
  let fastSummary = '';
  let deepSummary = '';
  let deepInProgress = false;
  let deepComplete = false;
  let currentConversationId = null;
  let conversationHistory = [];
  let currentTranscript = null;
  let originalText = null; // Store original text for regeneration
  let waitingForFirstToken = false; // Track if we're waiting to show panel

  // Inject markdown CSS styles once
  function injectMarkdownStyles() {
    if (document.getElementById('claude-markdown-styles')) return;

    const style = document.createElement('style');
    style.id = 'claude-markdown-styles';
    style.textContent = `
      .markdown-content h1,
      .markdown-content h2,
      .markdown-content h3,
      .markdown-content h4,
      .markdown-content h5,
      .markdown-content h6 {
        margin-top: 16px;
        margin-bottom: 8px;
        font-weight: 600;
        line-height: 1.25;
        color: #e0e0e0;
      }

      .markdown-content h1 { font-size: 1.8em; border-bottom: 1px solid #444; padding-bottom: 4px; }
      .markdown-content h2 { font-size: 1.5em; border-bottom: 1px solid #444; padding-bottom: 4px; }
      .markdown-content h3 { font-size: 1.25em; }
      .markdown-content h4 { font-size: 1.1em; }

      .markdown-content p {
        margin-top: 0;
        margin-bottom: 12px;
      }

      .markdown-content ul,
      .markdown-content ol {
        margin-top: 0;
        margin-bottom: 12px;
        padding-left: 24px;
      }

      .markdown-content li {
        margin-bottom: 4px;
      }

      .markdown-content code {
        background: #3a3a3a;
        padding: 2px 6px;
        border-radius: 3px;
        font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
        font-size: 0.9em;
        color: #ff79c6;
      }

      .markdown-content pre {
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 6px;
        padding: 12px;
        overflow-x: auto;
        margin-bottom: 12px;
      }

      .markdown-content pre code {
        background: none;
        padding: 0;
        color: #e0e0e0;
      }

      .markdown-content blockquote {
        border-left: 3px solid #5C5CFF;
        margin: 12px 0;
        padding-left: 12px;
        color: #b0b0b0;
        font-style: italic;
      }

      .markdown-content a {
        color: #5C5CFF;
        text-decoration: none;
      }

      .markdown-content a:hover {
        text-decoration: underline;
      }

      .markdown-content strong {
        font-weight: 600;
        color: #f0f0f0;
      }

      .markdown-content em {
        font-style: italic;
      }

      .markdown-content hr {
        border: none;
        border-top: 1px solid #444;
        margin: 16px 0;
      }

      .markdown-content table {
        border-collapse: collapse;
        width: 100%;
        margin-bottom: 12px;
      }

      .markdown-content th,
      .markdown-content td {
        border: 1px solid #444;
        padding: 6px 10px;
        text-align: left;
      }

      .markdown-content th {
        background: #3a3a3a;
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);
  }

  // Markdown rendering with XSS protection
  function renderMarkdown(text) {
    if (!text) return '';

    // Inject styles on first render
    injectMarkdownStyles();

    // Check if marked and DOMPurify are available
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      console.warn('Markdown libraries not loaded, falling back to plain text');
      return text;
    }

    try {
      // Parse markdown to HTML
      const rawHtml = marked.parse(text);
      // Sanitize to prevent XSS
      return DOMPurify.sanitize(rawHtml);
    } catch (error) {
      console.error('Error rendering markdown:', error);
      return text;
    }
  }

  function createDualTabPanel() {
    let container = document.getElementById('claude-summary-container');
    if (container) {
      container.remove();
    }

    container = document.createElement('div');
    container.id = 'claude-summary-container';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      max-height: 85vh;
      background: #1e1e1e;
      color: #e0e0e0;
      padding: 0;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      z-index: 10000;
      font-size: 16px;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
    `;

    // Drag handle
    const dragHandle = document.createElement('div');
    dragHandle.id = 'drag-handle';
    dragHandle.style.cssText = `
      height: 35px;
      background: #2a2a2a;
      border-radius: 8px 8px 0 0;
      cursor: move;
      display: flex;
      align-items: center;
      padding: 0 15px;
      flex-shrink: 0;
    `;

    // Make draggable
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0, elementStartX = 0, elementStartY = 0;

    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = container.getBoundingClientRect();
      elementStartX = rect.left;
      elementStartY = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      container.style.left = `${elementStartX + deltaX}px`;
      container.style.top = `${elementStartY + deltaY}px`;
      container.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Title
    const titleLabel = document.createElement('span');
    titleLabel.textContent = 'AI Summary';
    titleLabel.style.cssText = `
      color: #e0e0e0;
      font-size: 14px;
      font-weight: 500;
    `;
    dragHandle.appendChild(titleLabel);

    // Header buttons
    const headerButtons = document.createElement('div');
    headerButtons.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    `;

    // Copy transcript button
    const copyTranscriptButton = document.createElement('button');
    copyTranscriptButton.id = 'copy-transcript-btn';
    copyTranscriptButton.innerHTML = '📄';
    copyTranscriptButton.title = 'Copy full transcript';
    copyTranscriptButton.style.cssText = `
      border: none;
      background: none;
      font-size: 16px;
      cursor: pointer;
      color: #e0e0e0;
      padding: 4px 8px;
      display: ${currentTranscript ? 'flex' : 'none'};
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.2s;
    `;
    copyTranscriptButton.onmouseover = () => copyTranscriptButton.style.background = 'rgba(255, 255, 255, 0.1)';
    copyTranscriptButton.onmouseout = () => copyTranscriptButton.style.background = 'none';
    copyTranscriptButton.onclick = () => {
      if (currentTranscript) {
        navigator.clipboard.writeText(currentTranscript).then(() => {
          copyTranscriptButton.innerHTML = '✓';
          copyTranscriptButton.style.color = '#50C550';
          setTimeout(() => {
            copyTranscriptButton.innerHTML = '📄';
            copyTranscriptButton.style.color = '#e0e0e0';
          }, 1500);
        });
      }
    };

    // Reset button (clears cache and re-triggers summary)
    const resetButton = document.createElement('button');
    resetButton.innerHTML = '🔄';
    resetButton.title = 'Reset and regenerate summary';
    resetButton.style.cssText = `
      border: none;
      background: none;
      font-size: 16px;
      cursor: pointer;
      color: #e0e0e0;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.2s;
    `;
    resetButton.onmouseover = () => resetButton.style.background = 'rgba(92, 92, 255, 0.2)';
    resetButton.onmouseout = () => resetButton.style.background = 'none';
    resetButton.onclick = () => {
      if (!originalText) {
        alert('No original text available to regenerate. Please select text and summarize again.');
        return;
      }

      // Show loading state
      resetButton.disabled = true;
      resetButton.innerHTML = '⏳';
      resetButton.style.cursor = 'wait';

      // Clear the content areas
      const fastContent = document.getElementById('fast-content');
      const deepContent = document.getElementById('deep-content');
      if (fastContent) {
        fastContent.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">Regenerating summary...</div>';
      }
      if (deepContent) {
        deepContent.innerHTML = '';
      }

      // Reset state and start fresh
      resetState();
      deepInProgress = true;

      // Re-trigger the summarization with the original text
      chrome.runtime.sendMessage({
        action: 'summarizeDual',
        text: originalText,
      });
    };

    // Close button
    const closeButton = document.createElement('button');
    closeButton.innerHTML = '×';
    closeButton.style.cssText = `
      border: none;
      background: none;
      font-size: 20px;
      cursor: pointer;
      color: #e0e0e0;
      padding: 0;
      width: 25px;
      height: 25px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.2s;
    `;
    closeButton.onmouseover = () => closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
    closeButton.onmouseout = () => closeButton.style.background = 'none';
    closeButton.onclick = () => {
      // Cancel any in-progress deep analysis
      if (deepInProgress) {
        chrome.runtime.sendMessage({ action: 'cancelDeepAnalysis' });
      }
      container.remove();
      resetState();
    };

    headerButtons.appendChild(copyTranscriptButton);
    headerButtons.appendChild(resetButton);
    headerButtons.appendChild(closeButton);
    dragHandle.appendChild(headerButtons);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    tabBar.style.cssText = `
      display: flex;
      gap: 0;
      padding: 10px 15px 0 15px;
      background: #1e1e1e;
      border-bottom: 1px solid #444;
      flex-shrink: 0;
    `;

    // Fast tab
    const fastTab = document.createElement('button');
    fastTab.id = 'fast-tab';
    fastTab.innerHTML = '⚡';
    fastTab.title = 'Fast (3-5s)';
    fastTab.style.cssText = `
      flex: 1;
      padding: 10px;
      background: ${activeTab === 'fast' ? '#2a2a2a' : 'transparent'};
      color: #e0e0e0;
      border: none;
      border-bottom: 2px solid ${activeTab === 'fast' ? '#5C5CFF' : 'transparent'};
      cursor: pointer;
      font-size: 20px;
      font-weight: 500;
      transition: all 0.2s;
      position: relative;
    `;
    fastTab.onclick = () => switchTab('fast');

    // Deep tab
    const deepTab = document.createElement('button');
    deepTab.id = 'deep-tab';
    deepTab.innerHTML = '🧠';
    deepTab.title = 'Deep (30-60s)';
    deepTab.style.cssText = `
      flex: 1;
      padding: 10px;
      background: ${activeTab === 'deep' ? '#2a2a2a' : 'transparent'};
      color: #e0e0e0;
      border: none;
      border-bottom: 2px solid ${activeTab === 'deep' ? '#5C5CFF' : 'transparent'};
      cursor: pointer;
      font-size: 20px;
      font-weight: 500;
      transition: all 0.2s;
      position: relative;
    `;
    deepTab.onclick = () => switchTab('deep');

    // Badge for deep tab status indicator
    const deepBadge = document.createElement('span');
    deepBadge.id = 'deep-badge';
    deepBadge.innerHTML = '•';
    deepBadge.style.cssText = `
      position: absolute;
      top: 5px;
      right: 5px;
      color: ${deepInProgress ? '#FFC107' : (deepComplete ? '#50C550' : '#FFC107')};
      font-size: 20px;
      display: ${deepInProgress || deepComplete ? 'block' : 'none'};
    `;
    deepTab.appendChild(deepBadge);

    tabBar.appendChild(fastTab);
    tabBar.appendChild(deepTab);

    // Content area
    const contentArea = document.createElement('div');
    contentArea.id = 'content-area';
    contentArea.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      min-height: 200px;
      scrollbar-width: thin;
      scrollbar-color: #3a3a3a #1e1e1e;
    `;

    // Add webkit scrollbar styles for Chrome/Safari
    const scrollbarStyle = document.createElement('style');
    if (!document.getElementById('dual-scrollbar-styles')) {
      scrollbarStyle.id = 'dual-scrollbar-styles';
      scrollbarStyle.textContent = `
        #content-area::-webkit-scrollbar {
          width: 8px;
        }
        #content-area::-webkit-scrollbar-track {
          background: #1e1e1e;
        }
        #content-area::-webkit-scrollbar-thumb {
          background: #3a3a3a;
          border-radius: 4px;
        }
        #content-area::-webkit-scrollbar-thumb:hover {
          background: #4a4a4a;
        }
      `;
      document.head.appendChild(scrollbarStyle);
    }

    // Fast content
    const fastContent = document.createElement('div');
    fastContent.id = 'fast-content';
    fastContent.style.cssText = `
      display: ${activeTab === 'fast' ? 'block' : 'none'};
      white-space: normal;
      line-height: 1.6;
      padding: 4px;
    `;
    // Add markdown styling
    fastContent.className = 'markdown-content';
    fastContent.innerHTML = renderMarkdown(fastSummary) || 'Loading...';

    // Deep content
    const deepContent = document.createElement('div');
    deepContent.id = 'deep-content';
    deepContent.style.cssText = `
      display: ${activeTab === 'deep' ? 'block' : 'none'};
      white-space: normal;
      line-height: 1.6;
      padding: 4px;
    `;
    // Add markdown styling
    deepContent.className = 'markdown-content';

    if (deepInProgress) {
      deepContent.innerHTML = '<div style="text-align: center; color: #888; padding: 40px 20px;"><div style="font-size: 24px; margin-bottom: 10px;">🤔</div><div>Thinking deeply... ~45s</div></div>';
    } else if (deepSummary) {
      deepContent.innerHTML = renderMarkdown(deepSummary);
    } else {
      deepContent.innerHTML = 'Starting deep analysis...';
    }

    contentArea.appendChild(fastContent);
    contentArea.appendChild(deepContent);

    // Assemble container
    container.appendChild(dragHandle);
    container.appendChild(tabBar);
    container.appendChild(contentArea);
    document.body.appendChild(container);

    return container;
  }

  function switchTab(tab) {
    activeTab = tab;

    // Update tab styles
    const fastTab = document.getElementById('fast-tab');
    const deepTab = document.getElementById('deep-tab');

    if (fastTab && deepTab) {
      fastTab.style.background = tab === 'fast' ? '#2a2a2a' : 'transparent';
      fastTab.style.borderBottom = `2px solid ${tab === 'fast' ? '#5C5CFF' : 'transparent'}`;

      deepTab.style.background = tab === 'deep' ? '#2a2a2a' : 'transparent';
      deepTab.style.borderBottom = `2px solid ${tab === 'deep' ? '#5C5CFF' : 'transparent'}`;
    }

    // Toggle content visibility
    const fastContent = document.getElementById('fast-content');
    const deepContent = document.getElementById('deep-content');

    if (fastContent && deepContent) {
      fastContent.style.display = tab === 'fast' ? 'block' : 'none';
      deepContent.style.display = tab === 'deep' ? 'block' : 'none';
    }

    // Hide badge when deep tab is viewed (only if complete, keep yellow dot visible if in progress)
    if (tab === 'deep') {
      const badge = document.getElementById('deep-badge');
      if (badge && deepComplete) {
        badge.style.display = 'none';
      }
    }

    // Show badge when switching back to fast tab (if deep is complete or in progress)
    if (tab === 'fast') {
      const badge = document.getElementById('deep-badge');
      if (badge && (deepInProgress || deepComplete)) {
        badge.style.display = 'block';
      }
    }
  }

  function updateFastSummary(text) {
    fastSummary = text;

    // Show panel on first token arrival
    if (waitingForFirstToken) {
      waitingForFirstToken = false;

      // Reset button state
      const summarizeFab = document.querySelector('.fab[title="Summarize selection"]');
      if (summarizeFab) {
        summarizeFab.disabled = false;
        summarizeFab.innerHTML = '✨';
        summarizeFab.style.cursor = 'pointer';
      }

      // Now create and show the panel
      createDualTabPanel();
    }

    // Ensure modal exists
    let container = document.getElementById('claude-summary-container');
    if (!container) {
      createDualTabPanel();
      container = document.getElementById('claude-summary-container');
    }

    const fastContent = document.getElementById('fast-content');
    if (fastContent) {
      fastContent.innerHTML = renderMarkdown(text);
    }
  }

  function updateDeepSummary(text) {
    deepSummary = text;

    // Ensure modal exists
    let container = document.getElementById('claude-summary-container');
    if (!container) {
      createDualTabPanel();
      container = document.getElementById('claude-summary-container');
    }

    const deepContent = document.getElementById('deep-content');
    if (deepContent) {
      deepContent.innerHTML = renderMarkdown(text);
    }

    // Show yellow dot when deep analysis starts (first update)
    if (deepInProgress) {
      const badge = document.getElementById('deep-badge');
      if (badge) {
        badge.style.color = '#FFC107';
        badge.style.display = 'block';
      }
    }
  }

  function playCompletionSound() {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create pleasant notification tone (two-note ascending)
      const playNote = (frequency, startTime, duration) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';

        gainNode.gain.setValueAtTime(0.3, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
      };

      const now = audioContext.currentTime;
      playNote(523.25, now, 0.15); // C5
      playNote(659.25, now + 0.15, 0.2); // E5
    } catch (e) {
      console.log('Could not play sound:', e);
    }
  }

  function markDeepComplete() {
    deepInProgress = false;
    deepComplete = true;

    // Update badge to green
    const badge = document.getElementById('deep-badge');
    if (badge) {
      badge.style.color = '#50C550';
      badge.style.display = 'block';
    }

    // Re-enable reset button if it's disabled
    const resetButton = document.querySelector('button[title="Reset and regenerate summary"]');
    if (resetButton && resetButton.disabled) {
      resetButton.disabled = false;
      resetButton.innerHTML = '🔄';
      resetButton.style.cursor = 'pointer';
    }

    // Play completion sound
    playCompletionSound();
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 30px;
      right: 30px;
      background: #2a2a2a;
      color: #e0e0e0;
      padding: 12px 20px;
      border-radius: 6px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      z-index: 10001;
      font-size: 14px;
      animation: slideIn 0.3s ease-out;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function resetState() {
    activeTab = 'fast';
    fastSummary = '';
    deepSummary = '';
    deepInProgress = false;
    deepComplete = false;
    currentConversationId = null;
    conversationHistory = [];
    currentTranscript = null;
  }

  // Inject FABs: "✨" for Summarize, "✒️" for Draft
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

      // Store original text for regeneration
      originalText = selectedText;

      // Reset state but don't show panel yet
      resetState();
      deepInProgress = true;
      waitingForFirstToken = true;

      // Show loading state on button
      summarizeFab.disabled = true;
      summarizeFab.innerHTML = '⏳';
      summarizeFab.style.cursor = 'wait';

      // Start both fast and deep requests
      chrome.runtime.sendMessage({
        action: 'summarizeDual',
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
    draftFab.onclick = () => {
      const selectedText = window.getSelection().toString();
      if (!selectedText) return;

      chrome.runtime.sendMessage({
        action: 'draft',
        text: selectedText,
      });
    };

    // Toggle FABs on selection
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection().toString().trim();
      if (selection) {
        summarizeFab.style.display = 'flex';
        draftFab.style.display = 'flex';
      } else {
        summarizeFab.style.display = 'none';
        draftFab.style.display = 'none';
      }
    });

    document.body.appendChild(summarizeFab);
    document.body.appendChild(draftFab);
  }

  injectFABs();

  // Listen for streaming updates
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'setTranscript') {
      // Store transcript and show copy button
      currentTranscript = request.transcript;
      const copyBtn = document.getElementById('copy-transcript-btn');
      if (copyBtn) {
        copyBtn.style.display = 'flex';
      }
    }

    if (request.action === 'updateFastSummary') {
      updateFastSummary(request.summary);
    }

    if (request.action === 'updateDeepSummary') {
      updateDeepSummary(request.summary);
    }

    if (request.action === 'deepSummaryComplete') {
      markDeepComplete();
    }

    if (request.action === 'summaryError') {
      if (request.mode === 'fast') {
        updateFastSummary('Error: ' + request.error);
      } else {
        updateDeepSummary('Error: ' + request.error);
        deepInProgress = false;
      }
    }
  });

} // End initialization check
