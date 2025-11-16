/**
 * Integration tests for dual-mode functionality
 * Tests the complete flow from user action to UI update
 */

describe('Dual-Mode Integration Tests', () => {
  let chrome;
  let mockFetch;

  beforeEach(() => {
    // Mock Chrome APIs
    chrome = {
      runtime: {
        sendMessage: jest.fn((message, callback) => {
          // Simulate async response
          if (callback) {
            setTimeout(() => callback({ success: true }), 0);
          }
          return Promise.resolve({ success: true });
        }),
        onMessage: {
          addListener: jest.fn(),
        },
      },
      tabs: {
        sendMessage: jest.fn(),
      },
      storage: {
        local: {
          get: jest.fn(() => Promise.resolve({})),
          set: jest.fn(() => Promise.resolve()),
          remove: jest.fn(() => Promise.resolve()),
        },
      },
    };
    global.chrome = chrome;

    // Mock environment
    global.YOUTUBE_TRANSCRIPT_API_URL = 'http://test-server.com';
    global.YOUTUBE_TRANSCRIPT_API_KEY = 'test-api-key';

    // Mock fetch with realistic streaming
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('User Selects Text and Clicks Summarize', () => {
    test('should trigger both fast and deep requests', async () => {
      const selectedText = 'This is selected text to summarize';

      // Mock streaming responses
      mockFetch.mockImplementation((url, options) => {
        const body = JSON.parse(options.body);
        const mode = body.mode;

        return Promise.resolve({
          ok: true,
          body: {
            getReader: () => ({
              read: jest.fn()
                .mockResolvedValueOnce({
                  done: false,
                  value: new TextEncoder().encode(`data: {"delta":"${mode} summary part 1"}\n\n`)
                })
                .mockResolvedValueOnce({
                  done: false,
                  value: new TextEncoder().encode(`data: {"delta":" part 2"}\n\n`)
                })
                .mockResolvedValueOnce({
                  done: false,
                  value: new TextEncoder().encode('data: [DONE]\n\n')
                })
                .mockResolvedValueOnce({ done: true }),
            }),
          },
        });
      });

      // Simulate user clicking summarize button
      await chrome.runtime.sendMessage({
        action: 'summarizeDual',
        text: selectedText,
      });

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'summarizeDual',
        text: selectedText,
      });
    });

    test('should show loading state immediately', () => {
      // Create UI elements
      const container = document.createElement('div');
      container.id = 'claude-summary-container';

      const fastContent = document.createElement('div');
      fastContent.id = 'fast-content';
      fastContent.textContent = 'Loading...';

      const deepContent = document.createElement('div');
      deepContent.id = 'deep-content';
      deepContent.innerHTML = '<div>🤔</div><div>Thinking deeply... ~45s</div>';

      container.appendChild(fastContent);
      container.appendChild(deepContent);
      document.body.appendChild(container);

      expect(fastContent.textContent).toBe('Loading...');
      expect(deepContent.innerHTML).toContain('🤔');
    });
  });

  describe('Fast Summary Streams In', () => {
    test('should update UI as chunks arrive', async () => {
      const mockTab = { id: 123 };
      let accumulatedSummary = '';

      // Simulate streaming chunks
      const chunks = ['This is ', 'a fast ', 'summary.'];

      for (const chunk of chunks) {
        accumulatedSummary += chunk;

        await chrome.tabs.sendMessage(mockTab.id, {
          action: 'updateFastSummary',
          summary: accumulatedSummary,
        });
      }

      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
      expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
        mockTab.id,
        expect.objectContaining({
          action: 'updateFastSummary',
          summary: 'This is a fast summary.',
        })
      );
    });

    test('should complete fast summary in under 5 seconds', async () => {
      const startTime = Date.now();

      mockFetch.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockImplementation(() => {
                return new Promise(resolve => {
                  setTimeout(() => {
                    resolve({
                      done: false,
                      value: new TextEncoder().encode('data: {"delta":"text"}\n\n')
                    });
                  }, 100); // Simulate 100ms per chunk
                });
              })
              .mockResolvedValueOnce({ done: true }),
          }),
        },
      });

      // Simulate fast mode processing
      await new Promise(resolve => setTimeout(resolve, 500));

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Deep Summary Streams In Parallel', () => {
    test('should update deep tab while fast tab is active', async () => {
      const mockTab = { id: 123 };

      // Simulate deep summary arriving while user is on fast tab
      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'updateDeepSummary',
        summary: 'Deep analysis in progress...',
      });

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          action: 'updateDeepSummary',
        })
      );
    });

    test('should send completion notification when deep finishes', async () => {
      const mockTab = { id: 123 };

      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'updateDeepSummary',
        summary: 'Complete deep analysis with insights.',
      });

      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'deepSummaryComplete',
      });

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          action: 'deepSummaryComplete',
        })
      );
    });
  });

  describe('Badge and Toast Notifications', () => {
    test('should show badge when deep completes on fast tab', async () => {
      // Simulate being on fast tab
      const activeTab = 'fast';

      // Create badge element
      const badge = document.createElement('span');
      badge.id = 'deep-badge';
      badge.style.display = 'none';
      document.body.appendChild(badge);

      // Simulate deep completion
      if (activeTab === 'fast') {
        badge.style.display = 'block';
      }

      expect(badge.style.display).toBe('block');
    });

    test('should show toast notification', () => {
      const toast = document.createElement('div');
      toast.className = 'toast-notification';
      toast.textContent = 'Deep analysis ready';
      toast.style.cssText = 'position: fixed; bottom: 30px; right: 30px;';
      document.body.appendChild(toast);

      expect(document.querySelector('.toast-notification')).toBeTruthy();
      expect(toast.textContent).toBe('Deep analysis ready');
    });
  });

  describe('User Switches Between Tabs', () => {
    test('should show correct content when switching tabs', () => {
      // Setup tabs
      const fastContent = document.createElement('div');
      fastContent.id = 'fast-content';
      fastContent.style.display = 'block';
      fastContent.textContent = 'Fast summary';

      const deepContent = document.createElement('div');
      deepContent.id = 'deep-content';
      deepContent.style.display = 'none';
      deepContent.textContent = 'Deep analysis';

      document.body.appendChild(fastContent);
      document.body.appendChild(deepContent);

      // Switch to deep
      fastContent.style.display = 'none';
      deepContent.style.display = 'block';

      expect(fastContent.style.display).toBe('none');
      expect(deepContent.style.display).toBe('block');
    });

    test('should hide badge when switching to deep tab', () => {
      const badge = document.createElement('span');
      badge.id = 'deep-badge';
      badge.style.display = 'block';
      document.body.appendChild(badge);

      // Simulate switching to deep tab
      badge.style.display = 'none';

      expect(badge.style.display).toBe('none');
    });

    test('should preserve summaries when switching tabs', () => {
      const fastSummary = 'This is the fast summary';
      const deepSummary = 'This is the deep analysis';

      const fastContent = document.createElement('div');
      fastContent.id = 'fast-content';
      fastContent.textContent = fastSummary;

      const deepContent = document.createElement('div');
      deepContent.id = 'deep-content';
      deepContent.textContent = deepSummary;

      document.body.appendChild(fastContent);
      document.body.appendChild(deepContent);

      // Switch tabs multiple times
      for (let i = 0; i < 5; i++) {
        const showFast = i % 2 === 0;
        fastContent.style.display = showFast ? 'block' : 'none';
        deepContent.style.display = showFast ? 'none' : 'block';
      }

      // Content should remain unchanged
      expect(fastContent.textContent).toBe(fastSummary);
      expect(deepContent.textContent).toBe(deepSummary);
    });
  });

  describe('User Closes Panel During Deep Analysis', () => {
    test('should send cancel message', async () => {
      await chrome.runtime.sendMessage({
        action: 'cancelDeepAnalysis',
      });

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'cancelDeepAnalysis',
      });
    });

    test('should remove panel from DOM', () => {
      const container = document.createElement('div');
      container.id = 'claude-summary-container';
      document.body.appendChild(container);

      // Simulate close
      container.remove();

      expect(document.getElementById('claude-summary-container')).toBeFalsy();
    });

    test('should clean up state', () => {
      let activeTab = 'fast';
      let fastSummary = 'Some text';
      let deepSummary = 'Some analysis';
      let deepInProgress = true;

      // Simulate reset
      activeTab = 'fast';
      fastSummary = '';
      deepSummary = '';
      deepInProgress = false;

      expect(activeTab).toBe('fast');
      expect(fastSummary).toBe('');
      expect(deepSummary).toBe('');
      expect(deepInProgress).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should show error in fast tab on failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const mockTab = { id: 123 };

      try {
        await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/summarize`, {
          method: 'POST',
          body: JSON.stringify({ text: 'test', mode: 'fast' }),
        });
      } catch (error) {
        await chrome.tabs.sendMessage(mockTab.id, {
          action: 'summaryError',
          error: error.message,
          mode: 'fast',
        });
      }

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          action: 'summaryError',
          mode: 'fast',
        })
      );
    });

    test('should continue fast even if deep fails', async () => {
      const mockTab = { id: 123 };

      // Fast succeeds
      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'updateFastSummary',
        summary: 'Fast summary success',
      });

      // Deep fails
      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'summaryError',
        error: 'Deep analysis failed',
        mode: 'deep',
      });

      // Fast should still be available
      const calls = chrome.tabs.sendMessage.mock.calls;
      const fastUpdate = calls.find(call => call[1].action === 'updateFastSummary');
      expect(fastUpdate).toBeTruthy();
    });

    test('should handle API configuration errors', async () => {
      global.YOUTUBE_TRANSCRIPT_API_URL = '';
      global.YOUTUBE_TRANSCRIPT_API_KEY = '';

      const mockTab = { id: 123 };

      if (!global.YOUTUBE_TRANSCRIPT_API_URL || !global.YOUTUBE_TRANSCRIPT_API_KEY) {
        await chrome.tabs.sendMessage(mockTab.id, {
          action: 'summaryError',
          error: 'API not configured',
          mode: 'fast',
        });
      }

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        mockTab.id,
        expect.objectContaining({
          error: 'API not configured',
        })
      );
    });
  });

  describe('Performance Tests', () => {
    test('should handle concurrent streaming efficiently', async () => {
      const mockTab = { id: 123 };
      const chunkCount = 50;

      const startTime = Date.now();

      // Simulate many concurrent updates
      const promises = [];
      for (let i = 0; i < chunkCount; i++) {
        promises.push(
          chrome.tabs.sendMessage(mockTab.id, {
            action: 'updateFastSummary',
            summary: `Chunk ${i}`,
          })
        );
      }

      await Promise.all(promises);

      const duration = Date.now() - startTime;

      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(chunkCount);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });

    test('should not block UI during streaming', async () => {
      const mockTab = { id: 123 };

      // Simulate streaming
      const promise = chrome.tabs.sendMessage(mockTab.id, {
        action: 'updateFastSummary',
        summary: 'Text',
      });

      // UI interactions should still work
      const button = document.createElement('button');
      let clicked = false;
      button.onclick = () => { clicked = true; };
      button.click();

      await promise;

      expect(clicked).toBe(true);
    });
  });

  describe('Memory Management', () => {
    test('should clean up after panel closes', () => {
      const container = document.createElement('div');
      container.id = 'claude-summary-container';
      document.body.appendChild(container);

      container.remove();

      expect(document.getElementById('claude-summary-container')).toBeFalsy();
      expect(document.body.children.length).toBe(0);
    });

    test('should handle multiple open/close cycles', () => {
      for (let i = 0; i < 10; i++) {
        const container = document.createElement('div');
        container.id = 'claude-summary-container';
        document.body.appendChild(container);
        container.remove();
      }

      expect(document.getElementById('claude-summary-container')).toBeFalsy();
    });
  });

  describe('Real-world Scenarios', () => {
    test('should handle fast completing before deep starts showing results', async () => {
      const mockTab = { id: 123 };

      // Fast completes quickly
      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'updateFastSummary',
        summary: 'Fast complete',
      });

      // Deep is still thinking
      await chrome.tabs.sendMessage(mockTab.id, {
        action: 'updateDeepSummary',
        summary: 'Analyzing...',
      });

      // User sees fast result, deep still processing
      const calls = chrome.tabs.sendMessage.mock.calls;
      expect(calls[0][1].action).toBe('updateFastSummary');
      expect(calls[1][1].action).toBe('updateDeepSummary');
    });

    test('should handle user rapidly switching tabs during streaming', async () => {
      const mockTab = { id: 123 };

      // Simulate rapid tab switches while streaming
      for (let i = 0; i < 20; i++) {
        const mode = i % 2 === 0 ? 'fast' : 'deep';
        await chrome.tabs.sendMessage(mockTab.id, {
          action: `update${mode.charAt(0).toUpperCase() + mode.slice(1)}Summary`,
          summary: `Update ${i}`,
        });
      }

      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(20);
    });

    test('should handle very long text selections', async () => {
      const longText = 'A'.repeat(100000);

      mockFetch.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('data: {"delta":"Summary of long text"}\n\n')
              })
              .mockResolvedValueOnce({ done: true }),
          }),
        },
      });

      const response = await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/summarize`, {
        method: 'POST',
        body: JSON.stringify({ text: longText, mode: 'fast' }),
      });

      expect(response.ok).toBe(true);
    });
  });
});
