const { test, expect } = require('./fixtures');

test.describe('Summarize Flow', () => {
  test('clicking summarize sends message (FAB shows loading state)', async ({ testPage }) => {
    await testPage.evaluate(() => window.selectTestText());
    const textEl = testPage.locator('#auto-select-text');
    await textEl.dispatchEvent('mouseup');
    await testPage.waitForTimeout(500);

    const clicked = await testPage.evaluate(() => {
      const btn = document.querySelector('.fab[title="Summarize"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    expect(clicked).toBe(true);

    await testPage.waitForTimeout(300);

    const fabLoading = await testPage.evaluate(() => {
      const fab = document.querySelector('.fab[title="Summarize"]');
      return fab ? fab.disabled : null;
    });
    expect(fabLoading).toBe(true);
  });

  test('overlay renders when service worker sends streaming messages', async ({ testPage, context }) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');

    // Get model config from the service worker (same as what content script gets)
    const config = await sw.evaluate(async () => {
      // Read ai-config.json the same way the background does
      try {
        const response = await fetch(chrome.runtime.getURL('ai-config.json'));
        return await response.json();
      } catch (e) {
        return null;
      }
    });

    if (!config?.models?.length) {
      test.skip(true, 'No ai-config.json models available');
      return;
    }

    const firstModelId = config.models[0].id;

    // Select text and click summarize
    await testPage.evaluate(() => window.selectTestText());
    const textEl = testPage.locator('#auto-select-text');
    await textEl.dispatchEvent('mouseup');
    await testPage.waitForTimeout(500);

    await testPage.evaluate(() => {
      const btn = document.querySelector('.fab[title="Summarize"]');
      btn?.click();
    });
    await testPage.waitForTimeout(500);

    // Find the tab
    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => t.url && t.url.includes('test-page.html'));
      return tab?.id;
    });

    if (!tabId) { test.skip(true, 'Tab not found'); return; }

    // Send initSummary with real config (matching what background would send)
    await sw.evaluate(async ({ tid, cfg }) => {
      await chrome.tabs.sendMessage(tid, {
        action: 'initSummary',
        originalText: 'Test text for summarization',
        config: cfg
      });
    }, { tid: tabId, cfg: config });

    await testPage.waitForTimeout(200);

    // Send first streaming token using real model ID
    await sw.evaluate(async ({ tid, mid }) => {
      await chrome.tabs.sendMessage(tid, {
        action: 'updateSummary',
        modelId: mid,
        delta: 'Hello from the E2E test summary!'
      });
    }, { tid: tabId, mid: firstModelId });

    await testPage.waitForTimeout(200);

    // Send completion
    await sw.evaluate(async ({ tid, mid }) => {
      await chrome.tabs.sendMessage(tid, {
        action: 'summaryComplete',
        modelId: mid,
        duration: 1234
      });
    }, { tid: tabId, mid: firstModelId });

    await testPage.waitForTimeout(500);

    // Verify panel appeared
    const panelExists = await testPage.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      return divs.some(div => {
        const style = getComputedStyle(div);
        return style.position === 'fixed' && parseInt(style.zIndex) >= 10000 &&
          div.offsetWidth > 200;
      });
    });
    expect(panelExists).toBe(true);

    // Verify summary text rendered
    const bodyText = await testPage.evaluate(() => document.body.innerText);
    expect(bodyText).toContain('Hello from the E2E test summary!');
  });
});
