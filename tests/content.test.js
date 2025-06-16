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
      
      const closeButton = document.querySelector('#claude-summary-container button');
      expect(closeButton).toBeTruthy();
      expect(closeButton.innerHTML).toBe('×');
      
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

  describe('showDraftPrompt', () => {
    test('should create and display modal', async () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      
      const draftFab = document.querySelector('button[title="Draft a professional response"]');
      
      // Start the async onclick but don't await it yet
      draftFab.onclick();
      
      // Wait a bit for the modal to be created
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const overlays = Array.from(document.querySelectorAll('div')).filter(
        div => div.style.cssText && div.style.cssText.includes('position: fixed') && div.style.cssText.includes('z-index: 99999')
      );
      expect(overlays.length).toBeGreaterThan(0);
      
      const overlay = overlays[0];
      const modal = overlay.querySelector('div');
      expect(modal).toBeTruthy();
      
      const textarea = modal.querySelector('textarea');
      expect(textarea).toBeTruthy();
      
      const buttons = modal.querySelectorAll('button');
      expect(buttons.length).toBe(2);
      expect(buttons[0].innerText).toBe('OK');
      expect(buttons[1].innerText).toBe('Cancel');
    });

    test('should handle Enter key submission', async () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      
      const draftFab = document.querySelector('button[title="Draft a professional response"]');
      draftFab.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const textarea = document.querySelector('textarea');
      textarea.value = 'Additional instructions';
      
      // Simulate Enter key
      const enterEvent = new KeyboardEvent('keydown', { 
        key: 'Enter',
        shiftKey: false 
      });
      textarea.dispatchEvent(enterEvent);
      
      // Verify message was sent
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'draft',
        text: 'Selected text',
        instructions: 'Additional instructions'
      });
      
      // Modal should be removed
      expect(document.querySelector('div[style*="z-index: 99999"]')).toBeFalsy();
    });

    test('should handle Escape key cancellation', async () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      
      const draftFab = document.querySelector('button[title="Draft a professional response"]');
      draftFab.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const textarea = document.querySelector('textarea');
      
      // Simulate Escape key
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      textarea.dispatchEvent(escapeEvent);
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Should not send message
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
      
      // Modal should be removed
      expect(document.querySelector('div[style*="z-index: 99999"]')).toBeFalsy();
    });

    test('should handle OK button click', async () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      
      const draftFab = document.querySelector('button[title="Draft a professional response"]');
      draftFab.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const textarea = document.querySelector('textarea');
      textarea.value = 'My instructions';
      
      const okButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.innerText === 'OK'
      );
      okButton.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'draft',
        text: 'Selected text',
        instructions: 'My instructions'
      });
    });

    test('should handle Cancel button click', async () => {
      sandbox.window.getSelection = jest.fn().mockReturnValue({
        toString: () => 'Selected text'
      });
      
      const draftFab = document.querySelector('button[title="Draft a professional response"]');
      draftFab.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const cancelButton = Array.from(document.querySelectorAll('button')).find(
        btn => btn.innerText === 'Cancel'
      );
      cancelButton.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
      expect(document.querySelector('div[style*="z-index: 99999"]')).toBeFalsy();
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