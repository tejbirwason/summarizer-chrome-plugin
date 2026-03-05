const pw = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '..');

const test = pw.test.extend({
  // Launch browser with extension loaded
  context: async ({}, use) => {
    const context = await pw.chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
    await use(context);
    await context.close();
  },

  // Extract extension ID from service worker
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    await use(id);
  },

  // Page with extension active
  extensionPage: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },

  // Test page served from local file
  testPage: async ({ context }, use) => {
    const page = await context.newPage();
    const testPagePath = path.join(EXTENSION_PATH, 'tests', 'test-page.html');
    await page.goto(`file://${testPagePath}`);
    // Wait for both the test page and content script to be ready
    await page.waitForFunction(() => window.testPageReady === true);
    // Give content script time to inject
    await page.waitForTimeout(500);
    await use(page);
  },
});

const expect = test.expect;

module.exports = { test, expect, EXTENSION_PATH };
