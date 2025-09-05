const { createOpenAIStreamMock, createAnthropicStreamMock, createErrorResponse } = require('./test-utils');

// We'll use a different approach - actually export the functions from background.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('Background Script Tests', () => {
  let getSummary, getDraftResponse;
  let originalChrome;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Save original chrome object
    originalChrome = global.chrome;
    
    // Mock storage to properly store and retrieve conversations
    const mockStorage = {};
    global.chrome.storage.local.set.mockImplementation((data) => {
      Object.assign(mockStorage, data);
      return Promise.resolve();
    });
    global.chrome.storage.local.get.mockImplementation((keys) => {
      if (keys === null) {
        return Promise.resolve(mockStorage);
      }
      if (typeof keys === 'string') {
        return Promise.resolve({ [keys]: mockStorage[keys] });
      }
      if (Array.isArray(keys)) {
        const result = {};
        keys.forEach(key => {
          if (mockStorage[key]) result[key] = mockStorage[key];
        });
        return Promise.resolve(result);
      }
      return Promise.resolve({});
    });
    
    // Create a sandbox with all needed globals
    const sandbox = {
      chrome: global.chrome,
      fetch: global.fetch,
      TextDecoder: global.TextDecoder,
      TextEncoder: global.TextEncoder,
      console: console,
      Promise: Promise,
      getSummary: null,
      getDraftResponse: null,
      getVideoSummary: null,
      crypto: {
        randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
      },
      importScripts: function(script) {
        // Mock importScripts - config.js will fail to load in tests
        throw new Error('Cannot load ' + script);
      },
      CONFIG: {
        OPENAI_API_KEY: 'test-openai-key',
        ANTHROPIC_API_KEY: 'test-anthropic-key'
      }
    };
    
    // Read and execute background.js in the sandbox
    const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(backgroundCode, sandbox);
    
    // Extract the functions
    getSummary = sandbox.getSummary;
    getDraftResponse = sandbox.getDraftResponse;
  });

  afterEach(() => {
    global.chrome = originalChrome;
  });

  describe('getSummary (OpenAI o3)', () => {
    test('should successfully summarize text using OpenAI o3', async () => {
      const mockText = 'This is a long text that needs to be summarized.';
      const expectedSummary = 'This is a summary.';
      
      global.fetch.mockResolvedValueOnce(createOpenAIStreamMock(expectedSummary));
      
      const mockTab = { id: 123 };
      const result = await getSummary(mockText, mockTab);
      
      expect(result).toBe(expectedSummary);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': expect.stringContaining('Bearer')
          }),
          body: expect.stringContaining('"model":"o3"')
        })
      );
      
      // Verify streaming updates were sent
      expect(chrome.tabs.sendMessage).toHaveBeenCalled();
    });

    test('should handle OpenAI API errors gracefully', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));
      
      const result = await getSummary('test text', null);
      
      expect(result).toBe('Summary generation failed.');
    });

    test('should handle empty text input', async () => {
      const expectedSummary = 'No content to summarize.';
      
      global.fetch.mockResolvedValueOnce(createOpenAIStreamMock(expectedSummary));
      
      const result = await getSummary('', null);
      
      expect(result).toBe(expectedSummary);
    });

    test('should parse streaming responses correctly', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Part1"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" Part2"}}]}\n\n',
        'data: [DONE]\n\n'
      ];
      
      let index = 0;
      const mockResponse = {
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[0]) })
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[1]) })
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[2]) })
              .mockResolvedValueOnce({ done: true })
          })
        }
      };
      
      global.fetch.mockResolvedValueOnce(mockResponse);
      
      const result = await getSummary('test', null);
      
      expect(result).toBe('Part1 Part2');
    });

    test('should handle malformed streaming chunks', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Valid"}}]}\n\n',
        'data: invalid json\n\n',
        'data: {"choices":[{"delta":{"content":" content"}}]}\n\n',
      ];
      
      let index = 0;
      const mockResponse = {
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[0]) })
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[1]) })
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[2]) })
              .mockResolvedValueOnce({ done: true })
          })
        }
      };
      
      global.fetch.mockResolvedValueOnce(mockResponse);
      
      const result = await getSummary('test', null);
      
      // Should skip the invalid chunk
      expect(result).toBe('Valid content');
    });
  });

  describe('getDraftResponse (Claude)', () => {
    test('should generate draft using Claude API', async () => {
      const mockText = 'Please help me with this task.';
      const expectedDraft = 'Here is my response.';
      
      global.fetch.mockResolvedValueOnce(createAnthropicStreamMock(expectedDraft));
      
      const mockTab = { id: 456 };
      const result = await getDraftResponse(mockText, mockTab);
      
      expect(result).toBe(expectedDraft);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-api-key': expect.any(String),
            'anthropic-version': '2023-06-01'
          }),
          body: expect.stringContaining('"model":"claude-3-5-sonnet-latest"')
        })
      );
    });

    test('should include user instructions in prompt', async () => {
      const mockText = 'Original message';
      const instructions = 'Make it more formal';
      
      global.fetch.mockResolvedValueOnce(createAnthropicStreamMock('Formal response'));
      
      await getDraftResponse(mockText, null, instructions);
      
      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      
      expect(body.messages[0].content).toContain(instructions);
      expect(body.messages[0].content).toContain('Make it more formal');
    });

    test('should use correct prompt template', async () => {
      global.fetch.mockResolvedValueOnce(createAnthropicStreamMock('Response'));
      
      await getDraftResponse('Test', null, '');
      
      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      const prompt = body.messages[0].content;
      
      expect(prompt).toContain('My name is Tj');
      expect(prompt).toContain('recruiting');
      expect(prompt).toContain('friendly and informal yet still professional');
    });

    test('should handle Claude API errors', async () => {
      global.fetch.mockRejectedValueOnce(new Error('API Error'));
      
      const result = await getDraftResponse('test', null);
      
      expect(result).toBe('Draft generation failed.');
    });

    test('should handle streaming with tab updates', async () => {
      const mockTab = { id: 789 };
      global.fetch.mockResolvedValueOnce(createAnthropicStreamMock('Streaming draft'));
      
      await getDraftResponse('test', mockTab);
      
      // Should have sent updates to content script
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        789,
        expect.objectContaining({
          action: 'updateDraft',
          draft: expect.any(String)
        })
      );
    });
  });

  describe('Message Handlers', () => {
    test('should handle summarize action', async () => {
      // First, load the background script to register the listener
      const sandbox = {
        chrome: global.chrome,
        fetch: global.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        console: console,
        Promise: Promise,
        crypto: {
          randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
        },
        CONFIG: {
          OPENAI_API_KEY: 'test-openai-key',
          ANTHROPIC_API_KEY: 'test-anthropic-key'
        }
      };
      
      const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
      vm.createContext(sandbox);
      vm.runInContext(backgroundCode, sandbox);
      
      // Get the registered listener
      const mockListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const mockSender = { tab: { id: 111 } };
      
      global.fetch.mockResolvedValueOnce(createOpenAIStreamMock('Summary result'));
      
      const response = mockListener(
        { action: 'summarize', text: 'Text to summarize' },
        mockSender,
        jest.fn()
      );
      
      expect(response).toBe(true); // Indicates async response
      
      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Should send streaming updates
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        111,
        expect.objectContaining({
          action: 'updateSummary',
          summary: expect.any(String),
          conversationId: expect.any(String)
        })
      );
      
      // Should send completion message
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        111,
        expect.objectContaining({
          action: 'summaryComplete',
          conversationId: expect.any(String)
        })
      );
    });

    test('should handle draft action with instructions', async () => {
      // Load background script
      const sandbox = {
        chrome: global.chrome,
        fetch: global.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        console: console,
        Promise: Promise,
        crypto: {
          randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
        },
        CONFIG: {
          OPENAI_API_KEY: 'test-openai-key',
          ANTHROPIC_API_KEY: 'test-anthropic-key'
        }
      };
      
      const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
      vm.createContext(sandbox);
      vm.runInContext(backgroundCode, sandbox);
      
      const mockListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const mockSender = { tab: { id: 222 } };
      
      global.fetch.mockResolvedValueOnce(createAnthropicStreamMock('Draft result'));
      
      const response = mockListener(
        { 
          action: 'draft', 
          text: 'Original text',
          instructions: 'Be concise'
        },
        mockSender,
        jest.fn()
      );
      
      expect(response).toBe(true);
      
      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        222,
        expect.objectContaining({
          action: 'displayDraft',
          draft: 'Draft result'
        })
      );
    });
  });
});