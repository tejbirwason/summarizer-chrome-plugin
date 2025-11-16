const { createHetznerStreamMock, createHetznerSSEStreamMock, createErrorResponse } = require('./test-utils');

const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('Background Script Tests', () => {
  let getSummary, getDraftResponse, getSummaryMode, getDualSummary;
  let originalChrome;

  beforeEach(() => {
    jest.clearAllMocks();

    // Save original chrome object
    originalChrome = global.chrome;

    // Mock storage to properly store and retrieve summaries/cache
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
    global.chrome.storage.local.remove.mockImplementation((keys) => {
      if (typeof keys === 'string') {
        delete mockStorage[keys];
      } else if (Array.isArray(keys)) {
        keys.forEach(key => delete mockStorage[key]);
      }
      return Promise.resolve();
    });

    // Create a sandbox with all needed globals
    const sandbox = {
      chrome: global.chrome,
      fetch: global.fetch,
      TextDecoder: global.TextDecoder,
      TextEncoder: global.TextEncoder,
      console: console,
      Promise: Promise,
      Map: Map,
      URL: URL,
      AbortController: class AbortController {
        constructor() {
          this.signal = { aborted: false };
        }
        abort() {
          this.signal.aborted = true;
        }
      },
      getSummary: null,
      getDraftResponse: null,
      getSummaryMode: null,
      getDualSummary: null,
      crypto: {
        randomUUID: () => 'test-uuid-123'
      },
      importScripts: function(script) {
        // Mock importScripts - config.js will fail to load in tests
        throw new Error('Cannot load ' + script);
      },
      CONFIG: {
        YOUTUBE_TRANSCRIPT_API_URL: 'http://test-api.com',
        YOUTUBE_TRANSCRIPT_API_KEY: 'test-api-key'
      }
    };

    // Read and execute background.js in the sandbox
    const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(backgroundCode, sandbox);

    // Extract the functions
    getSummary = sandbox.getSummary;
    getDraftResponse = sandbox.getDraftResponse;
    getSummaryMode = sandbox.getSummaryMode;
    getDualSummary = sandbox.getDualSummary;
  });

  afterEach(() => {
    global.chrome = originalChrome;
  });

  describe('getSummary (Hetzner /summarize)', () => {
    test('should successfully summarize text using Hetzner API', async () => {
      const mockText = 'This is a long text that needs to be summarized.';
      const expectedSummary = 'This is a summary.';

      global.fetch.mockResolvedValueOnce(createHetznerStreamMock(expectedSummary));

      const mockTab = { id: 123, url: 'https://example.com/page' };
      const result = await getSummary(mockText, mockTab);

      expect(result).toBe(expectedSummary);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-api.com/summarize',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-api-key'
          }),
          body: expect.stringContaining(mockText)
        })
      );

      // Verify streaming updates were sent
      expect(chrome.tabs.sendMessage).toHaveBeenCalled();
    });

    test('should return cached summary if available', async () => {
      const mockText = 'Test text';
      const mockTab = { id: 123, url: 'https://example.com/page' };
      const cachedSummary = {
        summary: 'Cached summary',
        conversationId: 'cached-id',
        timestamp: Date.now()
      };

      // Pre-populate cache
      const summaryKey = 'summary:page:https://example.com/page';
      await chrome.storage.local.set({ [summaryKey]: cachedSummary });

      const result = await getSummary(mockText, mockTab);

      // Should not call fetch (cache hit)
      expect(global.fetch).not.toHaveBeenCalled();

      // Should return cached summary
      expect(result).toBe('Cached summary');

      // Should send cached summary to tab
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          action: 'displaySummary',
          summary: 'Cached summary',
          fromCache: true
        })
      );
    });

    test('should handle Hetzner API errors gracefully', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const mockTab = { id: 123, url: 'https://example.com/page' };
      const result = await getSummary('test text', mockTab);

      expect(result).toBe('Summary generation failed.');
    });

    test('should parse NDJSON streaming responses correctly', async () => {
      const expectedSummary = 'Part1 Part2 Rest';
      global.fetch.mockResolvedValueOnce(createHetznerStreamMock(expectedSummary));

      const mockTab = { id: 123, url: 'https://example.com/page' };
      const result = await getSummary('test', mockTab);

      expect(result).toBe(expectedSummary);
    });

    test('should save summary to cache after generation', async () => {
      const mockText = 'Test text';
      const expectedSummary = 'Generated summary';
      const mockTab = { id: 123, url: 'https://example.com/page' };

      global.fetch.mockResolvedValueOnce(createHetznerStreamMock(expectedSummary));

      await getSummary(mockText, mockTab);

      // Check that summary was saved to storage
      const summaryKey = 'summary:page:https://example.com/page';
      const stored = await chrome.storage.local.get(summaryKey);

      expect(stored[summaryKey]).toBeDefined();
      expect(stored[summaryKey].summary).toBe(expectedSummary);
      expect(stored[summaryKey].pageContent).toBe(mockText);
    });
  });

  describe('getDraftResponse (Hetzner /draft)', () => {
    test('should generate draft using Hetzner API', async () => {
      const mockText = 'Please help me with this task.';
      const expectedDraft = 'Here is my response.';

      global.fetch.mockResolvedValueOnce(createHetznerStreamMock(expectedDraft));

      const mockTab = { id: 456 };
      const result = await getDraftResponse(mockText, mockTab);

      expect(result).toBe(expectedDraft);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-api.com/draft',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-api-key'
          }),
          body: JSON.stringify({
            text: mockText,
            instructions: ''
          })
        })
      );
    });

    test('should include user instructions in request', async () => {
      const mockText = 'Original message';
      const instructions = 'Make it more formal';

      global.fetch.mockResolvedValueOnce(createHetznerStreamMock('Formal response'));

      await getDraftResponse(mockText, null, instructions);

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.text).toBe(mockText);
      expect(body.instructions).toBe(instructions);
    });

    test('should handle Hetzner API errors', async () => {
      global.fetch.mockRejectedValueOnce(new Error('API Error'));

      const result = await getDraftResponse('test', null);

      expect(result).toBe('Draft generation failed.');
    });

    test('should handle streaming with tab updates', async () => {
      const mockTab = { id: 789 };
      global.fetch.mockResolvedValueOnce(createHetznerStreamMock('Streaming draft'));

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

  describe('Dual-Mode Summaries', () => {
    test('should initiate both fast and deep requests via native messaging', async () => {
      const mockText = 'Test text for dual mode';
      const mockTab = { id: 123 };

      const fastPort = {
        onMessage: { addListener: jest.fn() },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };
      const deepPort = {
        onMessage: { addListener: jest.fn() },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };

      chrome.runtime.connectNative
        .mockReturnValueOnce(fastPort)
        .mockReturnValueOnce(deepPort);

      await getDualSummary(mockText, mockTab);

      expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(2);
      expect(chrome.runtime.connectNative).toHaveBeenCalledWith('com.localai');

      expect(fastPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'summarize',
          text: mockText,
          mode: 'fast'
        })
      );
      expect(deepPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'summarize',
          text: mockText,
          mode: 'deep'
        })
      );
    });

    test('should stream fast summary updates', async () => {
      const mockTab = { id: 123 };
      const mockText = 'Test text summary';

      let onMessageHandler;
      const port = {
        onMessage: {
          addListener: jest.fn((handler) => {
            onMessageHandler = handler;
          })
        },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };

      chrome.runtime.connectNative.mockReturnValue(port);

      await getSummaryMode(mockText, mockTab, 'fast');

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'summarize',
          text: mockText,
          mode: 'fast'
        })
      );

      // Simulate streaming delta message
      await onMessageHandler({
        type: 'delta',
        summary: 'Fast summary chunk'
      });

      const updateCalls = chrome.tabs.sendMessage.mock.calls.filter(
        call => call[1].action === 'updateFastSummary'
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      expect(updateCalls[0][1].summary).toBe('Fast summary chunk');
    });

    test('should stream deep summary updates with completion signal', async () => {
      const mockTab = { id: 123 };
      const mockText = 'Test text summary';

      let onMessageHandler;
      const port = {
        onMessage: {
          addListener: jest.fn((handler) => {
            onMessageHandler = handler;
          })
        },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };

      chrome.runtime.connectNative.mockReturnValue(port);

      await getSummaryMode(mockText, mockTab, 'deep');

      // Simulate streaming delta message
      await onMessageHandler({
        type: 'delta',
        summary: 'Deep summary chunk'
      });

      // Simulate completion message
      await onMessageHandler({
        type: 'complete'
      });

      const updateCalls = chrome.tabs.sendMessage.mock.calls.filter(
        call => call[1].action === 'updateDeepSummary'
      );
      expect(updateCalls.length).toBeGreaterThan(0);

      const completeCalls = chrome.tabs.sendMessage.mock.calls.filter(
        call => call[1].action === 'deepSummaryComplete'
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });
  });

  describe('YouTube Transcript (Native Messaging)', () => {
    test('should fetch transcript via native messaging and start dual-mode summarization', async () => {
      const mockVideoId = 'dQw4w9WgXcQ';
      const mockTranscript = 'Never gonna give you up, never gonna let you down...';
      const mockTab = { id: 123 };

      // Mock native messaging transcript response
      chrome.runtime.sendNativeMessage.mockResolvedValueOnce({
        text: mockTranscript
      });

      const fastPort = {
        onMessage: { addListener: jest.fn() },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };
      const deepPort = {
        onMessage: { addListener: jest.fn() },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };

      chrome.runtime.connectNative
        .mockReturnValueOnce(fastPort)
        .mockReturnValueOnce(deepPort);

      const sandbox = {
        chrome: global.chrome,
        fetch: global.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        console: console,
        Promise: Promise,
        Map: Map,
        URL: URL,
        AbortController: class AbortController {
          constructor() {
            this.signal = { aborted: false };
          }
          abort() {
            this.signal.aborted = true;
          }
        },
        crypto: {
          randomUUID: () => 'test-uuid-123'
        },
        CONFIG: {
          YOUTUBE_TRANSCRIPT_API_URL: 'http://test-api.com',
          YOUTUBE_TRANSCRIPT_API_KEY: 'test-api-key'
        }
      };

      const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
      vm.createContext(sandbox);
      vm.runInContext(backgroundCode, sandbox);

      const getVideoTranscriptAndSummarize = sandbox.getVideoTranscriptAndSummarize;
      await getVideoTranscriptAndSummarize(mockVideoId, mockTab);

      expect(chrome.runtime.sendNativeMessage).toHaveBeenCalledWith(
        'com.ytsummary',
        { video_id: mockVideoId }
      );

      expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(2);
      expect(chrome.runtime.connectNative).toHaveBeenCalledWith('com.localai');

      expect(fastPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'summarize',
          text: mockTranscript,
          mode: 'fast'
        })
      );
      expect(deepPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'summarize',
          text: mockTranscript,
          mode: 'deep'
        })
      );
    });

    test('should handle native messaging transcript errors gracefully', async () => {
      const mockVideoId = 'invalid-video';
      const mockTab = { id: 123 };

      // Mock native messaging error
      chrome.runtime.sendNativeMessage.mockResolvedValueOnce({
        text: 'Error: No transcript available'
      });

      const sandbox = {
        chrome: global.chrome,
        fetch: global.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        console: console,
        Promise: Promise,
        Map: Map,
        URL: URL,
        AbortController: class AbortController {
          constructor() {
            this.signal = { aborted: false };
          }
          abort() {
            this.signal.aborted = true;
          }
        },
        crypto: {
          randomUUID: () => 'test-uuid-123'
        },
        CONFIG: {
          YOUTUBE_TRANSCRIPT_API_URL: 'http://test-api.com',
          YOUTUBE_TRANSCRIPT_API_KEY: 'test-api-key'
        }
      };

      const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
      vm.createContext(sandbox);
      vm.runInContext(backgroundCode, sandbox);

      const getVideoTranscriptAndSummarize = sandbox.getVideoTranscriptAndSummarize;
      await getVideoTranscriptAndSummarize(mockVideoId, mockTab);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          action: 'summaryError',
          mode: 'fast',
          error: expect.stringContaining('Failed to get video transcript')
        })
      );

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Message Handlers', () => {
    test('should handle summarize action', async () => {
      const sandbox = {
        chrome: global.chrome,
        fetch: global.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        console: console,
        Promise: Promise,
        Map: Map,
        URL: URL,
        AbortController: class AbortController {
          constructor() {
            this.signal = { aborted: false };
          }
          abort() {
            this.signal.aborted = true;
          }
        },
        crypto: {
          randomUUID: () => 'test-uuid-123'
        },
        CONFIG: {
          YOUTUBE_TRANSCRIPT_API_URL: 'http://test-api.com',
          YOUTUBE_TRANSCRIPT_API_KEY: 'test-api-key'
        }
      };

      const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
      vm.createContext(sandbox);
      vm.runInContext(backgroundCode, sandbox);

      const mockListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const mockSender = { tab: { id: 111, url: 'https://example.com' } };

      let fastHandler;
      let deepHandler;
      const fastPort = {
        onMessage: {
          addListener: jest.fn((handler) => {
            fastHandler = handler;
          })
        },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };
      const deepPort = {
        onMessage: {
          addListener: jest.fn((handler) => {
            deepHandler = handler;
          })
        },
        onDisconnect: { addListener: jest.fn() },
        postMessage: jest.fn(),
        disconnect: jest.fn()
      };

      chrome.runtime.connectNative
        .mockReturnValueOnce(fastPort)
        .mockReturnValueOnce(deepPort);

      const response = mockListener(
        { action: 'summarize', text: 'Text to summarize' },
        mockSender,
        jest.fn()
      );

      expect(response).toBe(true); // Indicates async response

      // Simulate streaming updates from native host
      await fastHandler({
        type: 'delta',
        summary: 'Fast summary result'
      });
      await deepHandler({
        type: 'delta',
        summary: 'Deep summary result'
      });
      await deepHandler({
        type: 'complete'
      });

      const fastCalls = chrome.tabs.sendMessage.mock.calls.filter(
        call => call[0] === 111 && call[1].action === 'updateFastSummary'
      );
      expect(fastCalls.length).toBeGreaterThan(0);

      const deepCompleteCalls = chrome.tabs.sendMessage.mock.calls.filter(
        call => call[0] === 111 && call[1].action === 'deepSummaryComplete'
      );
      expect(deepCompleteCalls.length).toBeGreaterThan(0);
    });

    test('should handle clearSummary action', async () => {
      const sandbox = {
        chrome: global.chrome,
        fetch: global.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        console: console,
        Promise: Promise,
        Map: Map,
        URL: URL,
        AbortController: class AbortController {
          constructor() {
            this.signal = { aborted: false };
          }
          abort() {
            this.signal.aborted = true;
          }
        },
        crypto: {
          randomUUID: () => 'test-uuid-123'
        },
        CONFIG: {
          YOUTUBE_TRANSCRIPT_API_URL: 'http://test-api.com',
          YOUTUBE_TRANSCRIPT_API_KEY: 'test-api-key'
        }
      };

      const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
      vm.createContext(sandbox);
      vm.runInContext(backgroundCode, sandbox);

      const mockListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const mockSender = { tab: { id: 111, url: 'https://example.com/page' } };
      const sendResponse = jest.fn();

      // Pre-populate cache
      const summaryKey = 'summary:page:https://example.com/page';
      await chrome.storage.local.set({ [summaryKey]: { summary: 'test' } });

      const response = mockListener(
        { action: 'clearSummary' },
        mockSender,
        sendResponse
      );

      expect(response).toBe(true); // Indicates async response

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify cache was cleared
      const stored = await chrome.storage.local.get(summaryKey);
      expect(stored[summaryKey]).toBeUndefined();
    });
  });
});
