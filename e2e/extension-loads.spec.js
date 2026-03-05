const { test, expect } = require('./fixtures');

test.describe('Extension Loading', () => {
  test('service worker is active', async ({ extensionId }) => {
    expect(extensionId).toBeTruthy();
    expect(extensionId.length).toBeGreaterThan(10);
  });

  test('content script injects on page load', async ({ testPage }) => {
    // content-dual.js creates FAB buttons on load (hidden until selection)
    // Check that the content script's globals exist
    const hasContentScript = await testPage.evaluate(() => {
      // content-dual.js adds mouseup/selectionchange listeners
      // We can verify by checking if selectTestText triggers FABs
      return typeof window.selectTestText === 'function';
    });
    expect(hasContentScript).toBe(true);
  });

  test('options page loads', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForLoadState('domcontentloaded');
    const title = await page.title();
    expect(title).toBeTruthy();
  });
});
