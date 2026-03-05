const { test, expect } = require('./fixtures');

test.describe('YouTube Integration', () => {
  test('summarize button appears on YouTube video page', { timeout: 90000 }, async ({ context }) => {
    const page = await context.newPage();

    // Navigate to a YouTube video
    await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // Wait for youtube-content.js to inject the button
    await page.waitForTimeout(3000);

    // Look for the button container with both buttons
    const buttonExists = await page.evaluate(() => {
      return !!document.querySelector('#yt-btn-container') ||
             !!document.querySelector('#yt-summarize-btn');
    });

    expect(buttonExists).toBe(true);
  });
});
