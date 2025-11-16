/**
 * UI-focused tests for dual-mode tabbed interface
 * Tests visual states, interactions, and animations
 */

const { JSDOM } = require('jsdom');

describe('Dual-Mode UI Visual Tests', () => {
  let dom;
  let document;
  let window;
  let createDualTabPanel;
  let switchTab;
  let updateFastSummary;
  let updateDeepSummary;
  let markDeepComplete;
  let showToast;
  let resetState;

  // State variables (from content-dual.js)
  let activeTab = 'fast';
  let fastSummary = '';
  let deepSummary = '';
  let deepInProgress = false;
  let deepComplete = false;
  let currentTranscript = null;

  beforeEach(() => {
    // Create a fresh DOM for each test
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    });
    document = dom.window.document;
    window = dom.window;
    global.document = document;
    global.window = window;

    // Reset state
    activeTab = 'fast';
    fastSummary = '';
    deepSummary = '';
    deepInProgress = false;
    deepComplete = false;
    currentTranscript = null;

    // Mock chrome API
    global.chrome = {
      runtime: {
        sendMessage: jest.fn(),
      },
    };

    // Define UI functions (simplified versions from content-dual.js)
    createDualTabPanel = function() {
      const container = document.createElement('div');
      container.id = 'claude-summary-container';
      container.style.cssText = 'position: fixed; top: 20px; right: 20px; width: 450px;';

      const dragHandle = document.createElement('div');
      dragHandle.id = 'drag-handle';
      dragHandle.style.cssText = 'height: 35px; background: #2a2a2a;';

      const titleLabel = document.createElement('span');
      titleLabel.textContent = 'AI Summary';
      dragHandle.appendChild(titleLabel);

      const closeButton = document.createElement('button');
      closeButton.innerHTML = '×';
      closeButton.onclick = () => {
        if (deepInProgress) {
          chrome.runtime.sendMessage({ action: 'cancelDeepAnalysis' });
        }
        container.remove();
        resetState();
      };
      dragHandle.appendChild(closeButton);

      const tabBar = document.createElement('div');
      tabBar.id = 'tab-bar';
      tabBar.style.cssText = 'display: flex; gap: 0; padding: 10px 15px 0 15px;';

      const fastTab = document.createElement('button');
      fastTab.id = 'fast-tab';
      fastTab.innerHTML = '⚡ Fast (3-5s)';
      fastTab.style.cssText = `background: ${activeTab === 'fast' ? '#2a2a2a' : 'transparent'}; border-bottom: 2px solid ${activeTab === 'fast' ? '#5C5CFF' : 'transparent'};`;
      fastTab.onclick = () => switchTab('fast');

      const deepTab = document.createElement('button');
      deepTab.id = 'deep-tab';
      deepTab.innerHTML = '🧠 Deep (30-60s)';
      deepTab.style.cssText = `background: ${activeTab === 'deep' ? '#2a2a2a' : 'transparent'}; border-bottom: 2px solid ${activeTab === 'deep' ? '#5C5CFF' : 'transparent'};`;
      deepTab.onclick = () => switchTab('deep');

      const deepBadge = document.createElement('span');
      deepBadge.id = 'deep-badge';
      deepBadge.innerHTML = '•';
      deepBadge.style.cssText = 'position: absolute; top: 5px; right: 5px; color: #50C550; display: none;';
      deepTab.appendChild(deepBadge);

      tabBar.appendChild(fastTab);
      tabBar.appendChild(deepTab);

      const contentArea = document.createElement('div');
      contentArea.id = 'content-area';
      contentArea.style.cssText = 'flex: 1; overflow-y: auto; padding: 15px;';

      const fastContent = document.createElement('div');
      fastContent.id = 'fast-content';
      fastContent.style.cssText = `display: ${activeTab === 'fast' ? 'block' : 'none'};`;
      fastContent.textContent = fastSummary || 'Loading...';

      const deepContent = document.createElement('div');
      deepContent.id = 'deep-content';
      deepContent.style.cssText = `display: ${activeTab === 'deep' ? 'block' : 'none'};`;

      if (deepInProgress) {
        deepContent.innerHTML = '<div style="text-align: center; color: #888; padding: 40px 20px;"><div style="font-size: 24px; margin-bottom: 10px;">🤔</div><div>Thinking deeply... ~45s</div></div>';
      } else if (deepSummary) {
        deepContent.textContent = deepSummary;
      } else {
        deepContent.textContent = 'Starting deep analysis...';
      }

      contentArea.appendChild(fastContent);
      contentArea.appendChild(deepContent);

      container.appendChild(dragHandle);
      container.appendChild(tabBar);
      container.appendChild(contentArea);
      document.body.appendChild(container);

      return container;
    };

    switchTab = function(tab) {
      activeTab = tab;

      const fastTab = document.getElementById('fast-tab');
      const deepTab = document.getElementById('deep-tab');

      if (fastTab && deepTab) {
        fastTab.style.background = tab === 'fast' ? '#2a2a2a' : 'transparent';
        fastTab.style.borderBottom = `2px solid ${tab === 'fast' ? '#5C5CFF' : 'transparent'}`;

        deepTab.style.background = tab === 'deep' ? '#2a2a2a' : 'transparent';
        deepTab.style.borderBottom = `2px solid ${tab === 'deep' ? '#5C5CFF' : 'transparent'}`;
      }

      const fastContent = document.getElementById('fast-content');
      const deepContent = document.getElementById('deep-content');

      if (fastContent && deepContent) {
        fastContent.style.display = tab === 'fast' ? 'block' : 'none';
        deepContent.style.display = tab === 'deep' ? 'block' : 'none';
      }

      if (tab === 'deep' && deepComplete) {
        const badge = document.getElementById('deep-badge');
        if (badge) badge.style.display = 'none';
      }
    };

    updateFastSummary = function(text) {
      fastSummary = text;
      const fastContent = document.getElementById('fast-content');
      if (fastContent) {
        fastContent.textContent = text;
      }
    };

    updateDeepSummary = function(text) {
      deepSummary = text;
      const deepContent = document.getElementById('deep-content');
      if (deepContent) {
        deepContent.textContent = text;
      }
    };

    markDeepComplete = function() {
      deepInProgress = false;
      deepComplete = true;

      if (activeTab === 'fast') {
        const badge = document.getElementById('deep-badge');
        if (badge) {
          badge.style.display = 'block';
        }
        showToast('Deep analysis ready');
      }
    };

    showToast = function(message) {
      const toast = document.createElement('div');
      toast.className = 'toast-notification';
      toast.textContent = message;
      toast.style.cssText = 'position: fixed; bottom: 30px; right: 30px; background: #2a2a2a; padding: 12px 20px; border-radius: 6px;';
      document.body.appendChild(toast);
      return toast;
    };

    resetState = function() {
      activeTab = 'fast';
      fastSummary = '';
      deepSummary = '';
      deepInProgress = false;
      deepComplete = false;
      currentTranscript = null;
    };
  });

  describe('Panel Creation', () => {
    test('should create panel with correct structure', () => {
      createDualTabPanel();

      const container = document.getElementById('claude-summary-container');
      expect(container).toBeTruthy();
      expect(container.style.position).toBe('fixed');
      expect(container.style.width).toBe('450px');
    });

    test('should have drag handle with title', () => {
      createDualTabPanel();

      const dragHandle = document.getElementById('drag-handle');
      expect(dragHandle).toBeTruthy();
      expect(dragHandle.textContent).toContain('AI Summary');
    });

    test('should create both Fast and Deep tabs', () => {
      createDualTabPanel();

      const fastTab = document.getElementById('fast-tab');
      const deepTab = document.getElementById('deep-tab');

      expect(fastTab).toBeTruthy();
      expect(deepTab).toBeTruthy();
      expect(fastTab.textContent).toContain('⚡ Fast');
      expect(deepTab.textContent).toContain('🧠 Deep');
    });

    test('should have content areas for both tabs', () => {
      createDualTabPanel();

      const fastContent = document.getElementById('fast-content');
      const deepContent = document.getElementById('deep-content');

      expect(fastContent).toBeTruthy();
      expect(deepContent).toBeTruthy();
    });

    test('should show Fast tab as active by default', () => {
      createDualTabPanel();

      const fastTab = document.getElementById('fast-tab');
      const fastContent = document.getElementById('fast-content');

      expect(fastTab.style.background).toBe('#2a2a2a');
      expect(fastTab.style.borderBottom).toContain('#5C5CFF');
      expect(fastContent.style.display).toBe('block');
    });

    test('should hide Deep tab content by default', () => {
      createDualTabPanel();

      const deepTab = document.getElementById('deep-tab');
      const deepContent = document.getElementById('deep-content');

      expect(deepTab.style.background).toBe('transparent');
      expect(deepContent.style.display).toBe('none');
    });
  });

  describe('Tab Switching', () => {
    test('should switch from Fast to Deep tab', () => {
      createDualTabPanel();

      const fastTab = document.getElementById('fast-tab');
      const deepTab = document.getElementById('deep-tab');
      const fastContent = document.getElementById('fast-content');
      const deepContent = document.getElementById('deep-content');

      // Switch to deep
      deepTab.click();

      expect(deepTab.style.background).toBe('#2a2a2a');
      expect(deepTab.style.borderBottom).toContain('#5C5CFF');
      expect(deepContent.style.display).toBe('block');

      expect(fastTab.style.background).toBe('transparent');
      expect(fastContent.style.display).toBe('none');
    });

    test('should switch from Deep back to Fast tab', () => {
      createDualTabPanel();
      activeTab = 'deep';

      const fastTab = document.getElementById('fast-tab');
      const deepTab = document.getElementById('deep-tab');

      // Switch to fast
      fastTab.click();

      expect(fastTab.style.background).toBe('#2a2a2a');
      expect(deepTab.style.background).toBe('transparent');
    });

    test('should update visual indicators when switching tabs', () => {
      createDualTabPanel();

      const fastTab = document.getElementById('fast-tab');
      const deepTab = document.getElementById('deep-tab');

      // Initially on fast
      expect(fastTab.style.borderBottom).toContain('#5C5CFF');
      expect(deepTab.style.borderBottom).toContain('transparent');

      // Switch to deep
      switchTab('deep');

      expect(fastTab.style.borderBottom).toContain('transparent');
      expect(deepTab.style.borderBottom).toContain('#5C5CFF');
    });
  });

  describe('Badge Notifications', () => {
    test('should create badge element on deep tab', () => {
      createDualTabPanel();

      const badge = document.getElementById('deep-badge');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toBe('•');
      expect(badge.style.color).toBe('#50C550');
    });

    test('should hide badge initially', () => {
      createDualTabPanel();

      const badge = document.getElementById('deep-badge');
      expect(badge.style.display).toBe('none');
    });

    test('should show badge when deep analysis completes on fast tab', () => {
      activeTab = 'fast';
      createDualTabPanel();

      markDeepComplete();

      const badge = document.getElementById('deep-badge');
      expect(badge.style.display).toBe('block');
    });

    test('should hide badge when user switches to deep tab', () => {
      activeTab = 'fast';
      createDualTabPanel();
      markDeepComplete();

      const badge = document.getElementById('deep-badge');
      expect(badge.style.display).toBe('block');

      // Switch to deep tab
      switchTab('deep');

      expect(badge.style.display).toBe('none');
    });

    test('should not show badge when deep completes on deep tab', () => {
      activeTab = 'deep';
      createDualTabPanel();

      markDeepComplete();

      const badge = document.getElementById('deep-badge');
      expect(badge.style.display).not.toBe('block');
    });
  });

  describe('Toast Notifications', () => {
    test('should create toast notification', () => {
      const toast = showToast('Test message');

      expect(toast).toBeTruthy();
      expect(toast.textContent).toBe('Test message');
      expect(toast.style.position).toBe('fixed');
    });

    test('should show toast when deep analysis completes', () => {
      activeTab = 'fast';
      createDualTabPanel();

      markDeepComplete();

      const toasts = document.querySelectorAll('.toast-notification');
      expect(toasts.length).toBe(1);
      expect(toasts[0].textContent).toBe('Deep analysis ready');
    });

    test('should position toast at bottom right', () => {
      const toast = showToast('Message');

      expect(toast.style.bottom).toBe('30px');
      expect(toast.style.right).toBe('30px');
    });
  });

  describe('Content Updates', () => {
    test('should update fast summary content', () => {
      createDualTabPanel();

      updateFastSummary('This is the fast summary');

      const fastContent = document.getElementById('fast-content');
      expect(fastContent.textContent).toBe('This is the fast summary');
    });

    test('should update deep summary content', () => {
      createDualTabPanel();

      updateDeepSummary('This is the deep analysis');

      const deepContent = document.getElementById('deep-content');
      expect(deepContent.textContent).toBe('This is the deep analysis');
    });

    test('should show loading state in fast tab initially', () => {
      createDualTabPanel();

      const fastContent = document.getElementById('fast-content');
      expect(fastContent.textContent).toBe('Loading...');
    });

    test('should show thinking state in deep tab when in progress', () => {
      deepInProgress = true;
      createDualTabPanel();

      const deepContent = document.getElementById('deep-content');
      expect(deepContent.innerHTML).toContain('🤔');
      expect(deepContent.innerHTML).toContain('Thinking deeply');
    });

    test('should incrementally update fast summary', () => {
      createDualTabPanel();

      updateFastSummary('Part 1');
      expect(document.getElementById('fast-content').textContent).toBe('Part 1');

      updateFastSummary('Part 1 Part 2');
      expect(document.getElementById('fast-content').textContent).toBe('Part 1 Part 2');

      updateFastSummary('Part 1 Part 2 Part 3');
      expect(document.getElementById('fast-content').textContent).toBe('Part 1 Part 2 Part 3');
    });
  });

  describe('Cancellation', () => {
    test('should send cancel message when closing during deep analysis', () => {
      deepInProgress = true;
      createDualTabPanel();

      const closeButton = document.querySelector('#drag-handle button');
      closeButton.click();

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'cancelDeepAnalysis'
      });
    });

    test('should remove container when closing', () => {
      createDualTabPanel();

      const closeButton = document.querySelector('#drag-handle button');
      closeButton.click();

      const container = document.getElementById('claude-summary-container');
      expect(container).toBeFalsy();
    });

    test('should reset state when closing', () => {
      fastSummary = 'Some summary';
      deepSummary = 'Some deep analysis';
      deepComplete = true;
      createDualTabPanel();

      const closeButton = document.querySelector('#drag-handle button');
      closeButton.click();

      expect(activeTab).toBe('fast');
      expect(fastSummary).toBe('');
      expect(deepSummary).toBe('');
      expect(deepComplete).toBe(false);
    });
  });

  describe('Visual States', () => {
    test('should apply correct colors to active tab', () => {
      createDualTabPanel();

      const fastTab = document.getElementById('fast-tab');
      expect(fastTab.style.background).toBe('#2a2a2a');
      expect(fastTab.style.borderBottom).toContain('#5C5CFF');
    });

    test('should apply transparent background to inactive tab', () => {
      createDualTabPanel();

      const deepTab = document.getElementById('deep-tab');
      expect(deepTab.style.background).toBe('transparent');
      expect(deepTab.style.borderBottom).toContain('transparent');
    });

    test('should show green badge color', () => {
      createDualTabPanel();

      const badge = document.getElementById('deep-badge');
      expect(badge.style.color).toBe('#50C550');
    });

    test('should use dark theme colors', () => {
      createDualTabPanel();

      const container = document.getElementById('claude-summary-container');
      const dragHandle = document.getElementById('drag-handle');

      expect(dragHandle.style.background).toBe('#2a2a2a');
    });
  });

  describe('Simultaneous Updates', () => {
    test('should handle fast and deep updates at the same time', () => {
      createDualTabPanel();

      updateFastSummary('Fast result...');
      updateDeepSummary('Deep thinking...');

      const fastContent = document.getElementById('fast-content');
      const deepContent = document.getElementById('deep-content');

      expect(fastContent.textContent).toBe('Fast result...');
      expect(deepContent.textContent).toBe('Deep thinking...');
    });

    test('should maintain separate content for each tab', () => {
      createDualTabPanel();

      updateFastSummary('Fast: Quick summary');
      updateDeepSummary('Deep: Detailed analysis with insights');

      switchTab('fast');
      expect(document.getElementById('fast-content').textContent).toBe('Fast: Quick summary');

      switchTab('deep');
      expect(document.getElementById('deep-content').textContent).toBe('Deep: Detailed analysis with insights');
    });

    test('should complete deep analysis while fast tab is visible', () => {
      activeTab = 'fast';
      createDualTabPanel();

      updateFastSummary('Fast summary done');
      updateDeepSummary('Deep analysis...');

      // Complete deep while on fast tab
      markDeepComplete();

      const badge = document.getElementById('deep-badge');
      expect(badge.style.display).toBe('block');
      expect(activeTab).toBe('fast');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty summaries', () => {
      createDualTabPanel();

      updateFastSummary('');
      updateDeepSummary('');

      expect(document.getElementById('fast-content').textContent).toBe('');
      expect(document.getElementById('deep-content').textContent).toBe('');
    });

    test('should handle very long summaries', () => {
      createDualTabPanel();

      const longText = 'A'.repeat(10000);
      updateFastSummary(longText);

      const fastContent = document.getElementById('fast-content');
      expect(fastContent.textContent.length).toBe(10000);
    });

    test('should handle rapid tab switching', () => {
      createDualTabPanel();

      for (let i = 0; i < 10; i++) {
        switchTab(i % 2 === 0 ? 'fast' : 'deep');
      }

      // Should end on deep
      expect(activeTab).toBe('deep');
      const deepContent = document.getElementById('deep-content');
      expect(deepContent.style.display).toBe('block');
    });

    test('should handle special characters in summaries', () => {
      createDualTabPanel();

      const specialText = '<script>alert("xss")</script> & "quotes" \'apostrophes\'';
      updateFastSummary(specialText);

      const fastContent = document.getElementById('fast-content');
      // Using textContent should escape HTML
      expect(fastContent.textContent).toBe(specialText);
      expect(fastContent.innerHTML).not.toContain('<script>');
    });
  });
});
