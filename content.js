// content.js

// Check if already initialized to prevent duplicate injection
if (typeof window.claudeSummarizerInitialized === 'undefined') {
  window.claudeSummarizerInitialized = true;
  
  let currentConversationId = null;
  let conversationHistory = [];
  let isInitialSummaryCreated = false;
  let currentTranscript = null;

function displaySummary(summary, conversationId = null, isDraft = false, transcript = null) {
  let container = document.getElementById('claude-summary-container');
  
  // Store transcript if provided
  if (transcript) {
    currentTranscript = transcript;
    // Show copy transcript button when we have a transcript
    const copyBtn = document.getElementById('copy-transcript-btn');
    if (copyBtn) {
      copyBtn.style.display = 'flex';
    }
  }

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
      padding: 0;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      z-index: 10000;
      font-size: 16px;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, Oxygen-Sans,
        Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
    `;

    // Create a drag handle (top bar)
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
    `;

    // Make container draggable via the drag handle
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let elementStartX = 0;
    let elementStartY = 0;

    dragHandle.addEventListener('mousedown', (e) => {
      // Don't start drag if clicking on the close button
      if (e.target.tagName === 'BUTTON') {
        return;
      }
      
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

    // Add title to drag handle
    const titleLabel = document.createElement('span');
    titleLabel.textContent = 'AI Summary';
    titleLabel.style.cssText = `
      color: #e0e0e0;
      font-size: 14px;
      font-weight: 500;
    `;
    dragHandle.appendChild(titleLabel);

    // Add button container for header buttons
    const headerButtons = document.createElement('div');
    headerButtons.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    `;

    // Add copy transcript button (initially hidden)
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
      display: none;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.2s;
    `;
    copyTranscriptButton.onmouseover = () => {
      copyTranscriptButton.style.background = 'rgba(255, 255, 255, 0.1)';
    };
    copyTranscriptButton.onmouseout = () => {
      copyTranscriptButton.style.background = 'none';
    };
    copyTranscriptButton.onclick = () => {
      if (currentTranscript) {
        navigator.clipboard.writeText(currentTranscript).then(() => {
          // Show feedback
          const originalText = copyTranscriptButton.innerHTML;
          copyTranscriptButton.innerHTML = '✓';
          copyTranscriptButton.style.color = '#50C550';
          setTimeout(() => {
            copyTranscriptButton.innerHTML = originalText;
            copyTranscriptButton.style.color = '#e0e0e0';
          }, 1500);
        }).catch(err => {
          console.error('Failed to copy transcript:', err);
        });
      }
    };

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
    closeButton.onmouseover = () => {
      closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
    };
    closeButton.onmouseout = () => {
      closeButton.style.background = 'none';
    };
    closeButton.onclick = () => {
      container.remove();
      currentConversationId = null;
      conversationHistory = [];
      isInitialSummaryCreated = false;
      currentTranscript = null;
    };

    const contentWrapper = document.createElement('div');
    contentWrapper.style.cssText = `
      padding: 15px;
    `;

    const chatContainer = document.createElement('div');
    chatContainer.id = 'chat-container';
    chatContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      height: calc(80vh - 65px);
    `;

    const messagesArea = document.createElement('div');
    messagesArea.id = 'messages-area';
    messagesArea.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding-bottom: 10px;
    `;

    const inputContainer = document.createElement('div');
    inputContainer.id = 'input-container';
    inputContainer.style.cssText = `
      position: relative;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #444;
    `;

    const chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.id = 'chat-input';
    chatInput.placeholder = 'Ask a follow-up question...';
    chatInput.style.cssText = `
      width: 100%;
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 8px 40px 8px 8px;
      font-size: 16px;
      font-family: inherit;
      height: 36px;
      box-sizing: border-box;
    `;

    const sendButton = document.createElement('button');
    sendButton.innerHTML = '➤';
    sendButton.style.cssText = `
      position: absolute;
      right: 2px;
      top: 12px;
      background: transparent;
      color: #5C5CFF;
      border: none;
      cursor: pointer;
      font-size: 20px;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.2s;
    `;
    sendButton.onmouseover = () => {
      sendButton.style.background = 'rgba(92, 92, 255, 0.1)';
    };
    sendButton.onmouseout = () => {
      sendButton.style.background = 'transparent';
    };

    // Handle send functionality
    const sendMessage = () => {
      const message = chatInput.value.trim();
      if (!message || !currentConversationId) return;

      // Add user message to UI
      addMessageToUI('user', message);
      
      // Clear input and disable while sending
      chatInput.value = '';
      chatInput.disabled = true;
      sendButton.disabled = true;

      // Send to background script with error handling
      try {
        // Check if this is a draft conversation
        if (currentConversationId && currentConversationId.startsWith('draft-')) {
          chrome.runtime.sendMessage({
            action: 'continueDraftConversation',
            conversationId: currentConversationId,
            message: message,
            history: conversationHistory,
            originalThread: window.lastDraftThread || ''
          });
        } else {
          chrome.runtime.sendMessage({
            action: 'continueConversation',
            conversationId: currentConversationId,
            message: message
          });
        }
      } catch (error) {
        console.error('Failed to send message:', error);
        // Re-enable input on error
        chatInput.disabled = false;
        sendButton.disabled = false;
      }
    };

    sendButton.onclick = sendMessage;
    
    // Handle Enter key (without Shift)
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    inputContainer.appendChild(chatInput);
    inputContainer.appendChild(sendButton);
    chatContainer.appendChild(messagesArea);
    chatContainer.appendChild(inputContainer);

    headerButtons.appendChild(copyTranscriptButton);
    headerButtons.appendChild(closeButton);
    dragHandle.appendChild(headerButtons);
    container.appendChild(dragHandle);
    contentWrapper.appendChild(chatContainer);
    container.appendChild(contentWrapper);
    document.body.appendChild(container);
  }

  // If this is a draft response, treat it like a conversation
  if (isDraft) {
    // Generate a conversation ID for drafts
    if (!currentConversationId) {
      currentConversationId = 'draft-' + Date.now();
      conversationHistory = [];
      isInitialSummaryCreated = false;
    }
    
    if (!isInitialSummaryCreated) {
      // First chunk - create the assistant message  
      addMessageToUI('assistant', summary);
      isInitialSummaryCreated = true;
    } else {
      // Subsequent chunks - update the existing message
      updateLastMessage(summary);
    }
    
    // Make sure input is visible for drafts
    const inputContainer = document.getElementById('input-container');
    if (inputContainer) {
      inputContainer.style.display = 'block';
    }
  } else if (conversationId) {
    // Regular summary with conversation
    if (currentConversationId !== conversationId) {
      // New conversation starting
      currentConversationId = conversationId;
      conversationHistory = [];
      isInitialSummaryCreated = false;
    }
    
    if (!isInitialSummaryCreated) {
      // First chunk - create the assistant message
      addMessageToUI('assistant', summary);
      isInitialSummaryCreated = true;
    } else {
      // Subsequent chunks - update the existing message
      updateLastMessage(summary);
    }
  } else {
    // No conversation ID - just update the last message
    updateLastMessage(summary);
  }
}

function addMessageToUI(role, content, skipHistory = false) {
  const messagesArea = document.getElementById('messages-area');
  if (!messagesArea) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;
  messageDiv.style.cssText = `
    margin-bottom: 15px;
    padding: 10px;
    border-radius: 6px;
    background: ${role === 'user' ? '#3a3a3a' : '#2a2a2a'};
    position: relative;
  `;

  const headerDiv = document.createElement('div');
  headerDiv.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 5px;
  `;

  const roleLabel = document.createElement('div');
  roleLabel.style.cssText = `
    font-weight: bold;
    color: ${role === 'user' ? '#8B8BFF' : '#50C550'};
    font-size: 14px;
    text-transform: uppercase;
  `;
  roleLabel.textContent = role === 'user' ? 'You' : 'Assistant';

  headerDiv.appendChild(roleLabel);

  // Add copy button for assistant messages
  if (role === 'assistant') {
    const copyButton = document.createElement('button');
    copyButton.innerHTML = '📋';
    copyButton.title = 'Copy to clipboard';
    copyButton.style.cssText = `
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: background 0.2s;
    `;
    copyButton.onmouseover = () => {
      copyButton.style.background = 'rgba(255, 255, 255, 0.1)';
    };
    copyButton.onmouseout = () => {
      copyButton.style.background = 'transparent';
    };
    copyButton.onclick = () => {
      navigator.clipboard.writeText(content).then(() => {
        // Show feedback
        const originalText = copyButton.innerHTML;
        copyButton.innerHTML = '✓';
        copyButton.style.color = '#50C550';
        setTimeout(() => {
          copyButton.innerHTML = originalText;
          copyButton.style.color = '';
        }, 1500);
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    };
    headerDiv.appendChild(copyButton);
  }

  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = `
    white-space: pre-wrap;
    font-size: 16px;
  `;
  contentDiv.textContent = content;

  messageDiv.appendChild(headerDiv);
  messageDiv.appendChild(contentDiv);
  messagesArea.appendChild(messageDiv);

  // Store in history only if not skipping (for streaming updates)
  if (!skipHistory) {
    conversationHistory.push({ role, content });
  }

  // Scroll to bottom
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

function updateLastMessage(content) {
  const messagesArea = document.getElementById('messages-area');
  if (!messagesArea) return;

  const messages = messagesArea.querySelectorAll('.message');
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    const contentDiv = lastMessage.querySelector('div:last-child');
    if (contentDiv) {
      contentDiv.textContent = content;
      
      // Update the copy button's onclick to use the new content
      const copyButton = lastMessage.querySelector('button[title="Copy to clipboard"]');
      if (copyButton) {
        copyButton.onclick = () => {
          navigator.clipboard.writeText(content).then(() => {
            const originalText = copyButton.innerHTML;
            copyButton.innerHTML = '✓';
            copyButton.style.color = '#50C550';
            setTimeout(() => {
              copyButton.innerHTML = originalText;
              copyButton.style.color = '';
            }, 1500);
          }).catch(err => {
            console.error('Failed to copy:', err);
          });
        };
      }
    }
  }
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
    
    try {
      chrome.runtime.sendMessage({
        action: 'summarize',
        text: selectedText,
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      // Reset button state on error
      summarizeFab.disabled = false;
      summarizeFab.innerHTML = '✨';
      summarizeFab.style.cursor = 'pointer';
    }
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

    // Show loading state
    draftFab.disabled = true;
    draftFab.innerHTML = '⏳';
    draftFab.style.cursor = 'wait';

    // Save the original thread for conversation context
    window.lastDraftThread = selectedText;
    
    // Open the summary box with the selected text as initial message
    displaySummary('', 'draft-' + Date.now(), true);
    
    // Add the selected text as the initial user message
    setTimeout(() => {
      const chatInput = document.getElementById('chat-input');
      if (chatInput) {
        chatInput.value = selectedText;
        chatInput.focus();
      }
      
      // Reset draft button state
      draftFab.disabled = false;
      draftFab.innerHTML = '✒️';
      draftFab.style.cursor = 'pointer';
    }, 100);
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
chrome.runtime.onMessage.addListener((request) => {
  if (
    request.action === 'displaySummary' ||
    request.action === 'updateSummary'
  ) {
    displaySummary(request.summary, request.conversationId, false, request.transcript);
  }
  
  if (request.action === 'displayDraft' || request.action === 'updateDraft') {
    displaySummary(request.draft || request.summary, null, true);
  }
  
  if (request.action === 'draftConversationUpdate') {
    const messagesArea = document.getElementById('messages-area');
    if (!messagesArea) return;
    
    // Check if we need to create a new assistant message bubble
    const messages = messagesArea.querySelectorAll('.message');
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage || lastMessage.classList.contains('user')) {
      // Last message is from user or no messages, create new assistant message
      addMessageToUI('assistant', request.response, true);
    } else if (lastMessage.classList.contains('assistant')) {
      // Update existing assistant message
      updateLastMessage(request.response);
    }
    
    // Re-enable input when done
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.querySelector('#input-container button');
    if (chatInput) chatInput.disabled = false;
    if (sendButton) sendButton.disabled = false;
  }
  
  if (request.action === 'draftConversationComplete') {
    // Update conversation history with the final response
    const lastHistoryEntry = conversationHistory[conversationHistory.length - 1];
    if (!lastHistoryEntry || lastHistoryEntry.role !== 'assistant') {
      conversationHistory.push({ role: 'assistant', content: request.response });
    }
    
    // Reset summarize button state when we start getting responses
    const summarizeFab = document.querySelector('.fab[title="Summarize selection"]');
    if (summarizeFab && summarizeFab.disabled) {
      summarizeFab.disabled = false;
      summarizeFab.innerHTML = '✨';
      summarizeFab.style.cursor = 'pointer';
    }
  }
  
  if (request.action === 'updateConversation') {
    const messagesArea = document.getElementById('messages-area');
    if (!messagesArea) return;
    
    // Check if we need to create a new assistant message bubble
    const messages = messagesArea.querySelectorAll('.message');
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage || lastMessage.classList.contains('user')) {
      // Last message is from user or no messages, create new assistant message
      // Use skipHistory=true since we'll update the history when streaming is complete
      addMessageToUI('assistant', request.response, true);
    } else if (lastMessage.classList.contains('assistant')) {
      // Update existing assistant message
      updateLastMessage(request.response);
    }
    
    // Re-enable input when done (we'll know it's done when there's no more streaming)
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.querySelector('#input-container button');
    if (chatInput) chatInput.disabled = false;
    if (sendButton) sendButton.disabled = false;
  }
  
  if (request.action === 'conversationComplete') {
    // Update conversation history with the final response
    const lastHistoryEntry = conversationHistory[conversationHistory.length - 1];
    if (!lastHistoryEntry || lastHistoryEntry.role !== 'assistant') {
      conversationHistory.push({ role: 'assistant', content: request.response });
    }
  }
  
  if (request.action === 'conversationError') {
    console.error('Conversation error:', request.error);
    // Re-enable input
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.querySelector('#input-container button');
    if (chatInput) chatInput.disabled = false;
    if (sendButton) sendButton.disabled = false;
  }
  
  if (request.action === 'summaryComplete') {
    // Reset summarize button state when summary is complete
    const summarizeFab = document.querySelector('.fab[title="Summarize selection"]');
    if (summarizeFab && summarizeFab.disabled) {
      summarizeFab.disabled = false;
      summarizeFab.innerHTML = '✨';
      summarizeFab.style.cursor = 'pointer';
    }
  }
});


} // End of initialization check
