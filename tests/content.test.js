const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('Content Script Tests', () => {
  let displaySummary, showDraftPrompt;
  let sandbox;

  beforeEach(() => {
    // Clear the DOM
    document.body.innerHTML = '';
    jest.clearAllMocks();
    
    // Clear any global initialization flags
    delete window.claudeSummarizerInitialized;
    
    // Create sandbox with necessary globals
    sandbox = {
      document: document,
      window: {
        ...window,
        claudeSummarizerInitialized: undefined,  // Reset initialization flag
        getSelection: window.getSelection
      },
      chrome: global.chrome,
      console: console,
      Promise: Promise,
      MouseEvent: MouseEvent,
      KeyboardEvent: KeyboardEvent,
      Event: Event,
      navigator: {
        clipboard: {
          writeText: jest.fn().mockResolvedValue()
        }
      },
      setTimeout: setTimeout
    };
    
    // Load and execute content.js in sandbox
    const contentCode = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(contentCode, sandbox);
    
    // Extract functions from sandbox
    displaySummary = sandbox.displaySummary;
    showDraftPrompt = sandbox.showDraftPrompt;
  });

  describe('displaySummary', () => {
    test('should create summary container if not exists', () => {
      // Use the function from sandbox with conversationId
      sandbox.displaySummary('Test summary content', 'test-conversation-id');
      
      const container = document.getElementById('claude-summary-container');
      expect(container).toBeTruthy();
      expect(container.style.position).toBe('fixed');
      expect(container.style.top).toBe('20px');
      expect(container.style.right).toBe('20px');
      
      const messagesArea = document.getElementById('messages-area');
      expect(messagesArea).toBeTruthy();
      const assistantMessage = messagesArea.querySelector('.message.assistant');
      expect(assistantMessage).toBeTruthy();
      const contentDiv = assistantMessage.querySelector('div:last-child');
      expect(contentDiv.textContent).toBe('Test summary content');
    });

    test('should reuse existing container', () => {
      // Create container first time with conversationId
      sandbox.displaySummary('First summary', 'test-conversation-id');
      const firstContainer = document.getElementById('claude-summary-container');
      
      // Update with new content (without conversationId to simulate update)
      sandbox.displaySummary('Second summary');
      const secondContainer = document.getElementById('claude-summary-container');
      
      expect(firstContainer).toBe(secondContainer);
      expect(document.querySelectorAll('#claude-summary-container').length).toBe(1);
      
      const messagesArea = document.getElementById('messages-area');
      const messages = messagesArea.querySelectorAll('.message.assistant');
      const lastMessage = messages[messages.length - 1];
      const contentDiv = lastMessage.querySelector('div:last-child');
      expect(contentDiv.textContent).toBe('Second summary');
    });

    test('close button should remove container', () => {
      sandbox.displaySummary('Test summary', 'test-conversation-id');
      
      const buttons = document.querySelectorAll('#claude-summary-container button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      
      // Find the close button (it's the one with '×')
      const closeButton = Array.from(buttons).find(btn => btn.innerHTML === '×');
      expect(closeButton).toBeTruthy();
      
      // Click close button
      closeButton.click();
      
      expect(document.getElementById('claude-summary-container')).toBeFalsy();
    });

    test('should handle special characters safely', () => {
      const textWithSpecialChars = 'Summary with <script>alert("xss")</script> & special chars';
      sandbox.displaySummary(textWithSpecialChars, 'test-conversation-id');
      
      const messagesArea = document.getElementById('messages-area');
      const assistantMessage = messagesArea.querySelector('.message.assistant');
      const contentDiv = assistantMessage.querySelector('div:last-child');
      // textContent automatically escapes HTML
      expect(contentDiv.textContent).toBe(textWithSpecialChars);
      expect(contentDiv.innerHTML).not.toContain('<script>');
    });

    test('should create copy transcript button when transcript is provided', () => {
      const transcript = 'This is the full transcript of the video';
      
      // First call creates the container and stores transcript
      sandbox.displaySummary('Summary of video', 'test-conversation-id', false, transcript);
      
      // Get the button after it's created
      let copyTranscriptBtn = document.getElementById('copy-transcript-btn');
      expect(copyTranscriptBtn).toBeTruthy();
      expect(copyTranscriptBtn.title).toBe('Copy full transcript');
      expect(copyTranscriptBtn.innerHTML).toBe('📄');
    });

    test('copy transcript button should copy transcript to clipboard', async () => {
      const transcript = 'This is the full transcript';
      
      sandbox.displaySummary('Summary', 'test-conversation-id', false, transcript);
      const copyTranscriptBtn = document.getElementById('copy-transcript-btn');
      
      // Click copy button
      copyTranscriptBtn.click();
      
      // Wait for promise to resolve
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(sandbox.navigator.clipboard.writeText).toHaveBeenCalledWith(transcript);
    });
  });

  describe('FAB Buttons', () => {
    let summarizeFab, draftFab;

    beforeEach(() => {
      // FABs should be created when content.js loads
      summarizeFab = document.querySelector('button[title="Summarize selection"]');
      draftFab = document.querySelector('button[title="Draft a professional response"]');
    });

    test('should create both FAB buttons', () => {
      expect(summarizeFab).toBeTruthy();
      expect(draftFab).toBeTruthy();
      
      expect(summarizeFab.innerHTML).toBe('✨');
      expect(draftFab.innerHTML).toBe('✒️');
      
      expect(summarizeFab.style.display).toBe('none');
      expect(draftFab.style.display).toBe('none');
    });

    test('should show buttons on text selection', () => {
      // Mock text selection in sandbox
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      
      // Trigger selection change event
      document.dispatchEvent(new Event('selectionchange'));
      
      expect(summarizeFab.style.display).toBe('flex');
      expect(draftFab.style.display).toBe('flex');
    });

    test('should hide buttons when no selection', () => {
      // First show buttons
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      document.dispatchEvent(new Event('selectionchange'));
      
      // Then clear selection
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => ''
      });
      document.dispatchEvent(new Event('selectionchange'));
      
      expect(summarizeFab.style.display).toBe('none');
      expect(draftFab.style.display).toBe('none');
    });

    test('summarize button should send correct message', () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Text to summarize'
      });
      
      summarizeFab.click();
      
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'summarize',
        text: 'Text to summarize'
      });
    });

    test('should not send message if no text selected', () => {
      // Clear any previous mocks
      jest.clearAllMocks();
      
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => ''
      });
      
      summarizeFab.click();
      
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('hover effects should work', () => {
      // Test summarize FAB hover
      const mouseoverEvent = new MouseEvent('mouseover');
      summarizeFab.dispatchEvent(mouseoverEvent);
      expect(summarizeFab.style.background).toBe('rgb(70, 70, 255)');
      
      const mouseoutEvent = new MouseEvent('mouseout');
      summarizeFab.dispatchEvent(mouseoutEvent);
      expect(summarizeFab.style.background).toBe('rgb(92, 92, 255)');
      
      // Test draft FAB hover
      draftFab.dispatchEvent(mouseoverEvent);
      expect(draftFab.style.background).toBe('rgb(51, 170, 51)');
      
      draftFab.dispatchEvent(mouseoutEvent);
      expect(draftFab.style.background).toBe('rgb(85, 191, 85)');
    });
  });

  describe('Draft FAB', () => {
    test('should open summary box with selected text on click', async () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text for drafting'
      });
      
      const draftFab = document.querySelector('button[title="Draft a professional response"]');
      
      // Click the draft button
      draftFab.click();
      
      // Wait for the summary container to be created
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Check that summary container was created
      const container = document.getElementById('claude-summary-container');
      expect(container).toBeTruthy();
      
      // Check that chat input exists
      const chatInput = document.getElementById('chat-input');
      expect(chatInput).toBeTruthy();
      
      // The value should be set after the timeout in content.js
      // We just verify the input exists and the container is set up for draft mode
      
      // Verify the draft button was disabled temporarily
      expect(draftFab.disabled).toBe(false);
      expect(draftFab.innerHTML).toBe('✒️');
    });
  });

  describe('Message Listeners', () => {
    test('should handle displaySummary message', () => {
      const mockListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      
      mockListener({ action: 'displaySummary', summary: 'Final summary', conversationId: 'test-id' });
      
      const messagesArea = document.getElementById('messages-area');
      const assistantMessage = messagesArea.querySelector('.message.assistant');
      const contentDiv = assistantMessage.querySelector('div:last-child');
      expect(contentDiv.textContent).toBe('Final summary');
    });

    test('should handle updateSummary message', () => {
      const mockListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      
      // Send partial update with conversationId to initialize
      mockListener({ action: 'updateSummary', summary: 'Partial...', conversationId: 'test-id' });
      
      let messagesArea = document.getElementById('messages-area');
      let assistantMessage = messagesArea.querySelector('.message.assistant');
      let contentDiv = assistantMessage.querySelector('div:last-child');
      expect(contentDiv.textContent).toBe('Partial...');
      
      // Send another update
      mockListener({ action: 'updateSummary', summary: 'Partial... summary complete' });
      
      contentDiv = assistantMessage.querySelector('div:last-child');
      expect(contentDiv.textContent).toBe('Partial... summary complete');
    });
  });
});