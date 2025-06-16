// content.js

// Check if already initialized to prevent duplicate injection
if (typeof window.claudeSummarizerInitialized === 'undefined') {
  window.claudeSummarizerInitialized = true;
  
  let currentConversationId = null;
  let conversationHistory = [];
  let isInitialSummaryCreated = false;

function displaySummary(summary, conversationId = null) {
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
      font-size: 13px;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, Oxygen-Sans,
        Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
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
    closeButton.onclick = () => {
      container.remove();
      currentConversationId = null;
      conversationHistory = [];
      isInitialSummaryCreated = false;
    };

    const chatContainer = document.createElement('div');
    chatContainer.id = 'chat-container';
    chatContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      height: calc(80vh - 45px);
      margin-top: 30px;
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
      display: flex;
      gap: 10px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #444;
    `;

    const chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.id = 'chat-input';
    chatInput.placeholder = 'Ask a follow-up question...';
    chatInput.style.cssText = `
      flex: 1;
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 8px;
      font-size: 12px;
      font-family: inherit;
      height: 32px;
    `;

    const sendButton = document.createElement('button');
    sendButton.textContent = 'Send';
    sendButton.style.cssText = `
      background: #5C5CFF;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 12px;
      height: 32px;
    `;

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
        chrome.runtime.sendMessage({
          action: 'continueConversation',
          conversationId: currentConversationId,
          message: message
        });
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

    container.appendChild(closeButton);
    container.appendChild(chatContainer);
    document.body.appendChild(container);
  }

  // If we have a conversation ID, handle streaming properly
  if (conversationId) {
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
  `;

  const roleLabel = document.createElement('div');
  roleLabel.style.cssText = `
    font-weight: bold;
    margin-bottom: 5px;
    color: ${role === 'user' ? '#8B8BFF' : '#50C550'};
    font-size: 12px;
    text-transform: uppercase;
  `;
  roleLabel.textContent = role === 'user' ? 'You' : 'Assistant';

  const contentDiv = document.createElement('div');
  contentDiv.style.whiteSpace = 'pre-wrap';
  contentDiv.textContent = content;

  messageDiv.appendChild(roleLabel);
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

    // Show prompt to gather extra instructions
    const userInstructions = await showDraftPrompt();
    if (userInstructions === null) {
      return; // user canceled
    }

    // Send both selected text & user instructions to background
    try {
      chrome.runtime.sendMessage({
        action: 'draft',
        text: selectedText,
        instructions: userInstructions,
      });
    } catch (error) {
      console.error('Failed to send message:', error);
    }
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
    displaySummary(request.summary, request.conversationId);
    
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

} // End of initialization check
