#!/usr/bin/env node

/**
 * Launch Chrome with extension loaded for manual testing
 *
 * Usage:
 *   node scripts/launch-dev.js
 *   node scripts/launch-dev.js https://example.com  # Open specific URL
 */

const puppeteer = require('puppeteer');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const startUrl = process.argv[2] || 'https://example.com';

(async () => {
  console.log('🚀 Launching Chrome with extension loaded...');
  console.log(`📂 Extension path: ${extensionPath}`);
  console.log(`🌐 Opening: ${startUrl}\n`);

  const browser = await puppeteer.launch({
    headless: false,
    devtools: true, // Auto-open DevTools
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1400,900'
    ]
  });

  const pages = await browser.pages();
  const page = pages[0];

  // Navigate to start URL
  await page.goto(startUrl, { waitUntil: 'networkidle0' });

  console.log('✅ Chrome launched successfully!');
  console.log('📝 Extension is loaded and active');
  console.log('🛠️  DevTools opened automatically');
  console.log('\n💡 Tips:');
  console.log('   - Select text to see FAB buttons');
  console.log('   - Go to YouTube to test video summarization');
  console.log('   - Check console for extension logs');
  console.log('   - Press Ctrl+C to close browser\n');

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('\n👋 Closing browser...');
    await browser.close();
    process.exit(0);
  });

  // Monitor page errors
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      console.log(`[${type.toUpperCase()}]:`, msg.text());
    }
  });

  page.on('pageerror', error => {
    console.log('❌ Page Error:', error.message);
  });

})().catch(error => {
  console.error('❌ Failed to launch:', error);
  process.exit(1);
});
