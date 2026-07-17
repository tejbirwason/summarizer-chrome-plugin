const { test, expect } = require('./fixtures');

test.describe('YouTube Integration', () => {
  test('summarize + Claude Code buttons appear top-right of the player on video page', { timeout: 90000 }, async ({ context }) => {
    const page = await context.newPage();

    // Navigate to a YouTube video
    await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // Wait for youtube-content.js to inject the buttons
    await page.waitForTimeout(3000);

    const info = await page.evaluate(() => {
      const container = document.querySelector('#yt-btn-container');
      const summarize = document.querySelector('#yt-summarize-btn');
      const cc = document.querySelector('#yt-cc-btn');
      const player = document.querySelector('#movie_player');
      if (!container || !player) return { ok: false, hasPlayer: !!player };
      const style = container.getAttribute('style') || '';
      const rect = container.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      return {
        ok: true,
        hasSummarize: !!summarize,
        hasCC: !!cc,
        style,
        // Must live inside the player so it rides the video in theater/fullscreen.
        insidePlayer: player.contains(container),
        // top-right OF THE PLAYER, not of the viewport.
        nearPlayerTop: rect.top - playerRect.top < 60,
        nearPlayerRight: playerRect.right - rect.right < 60,
      };
    });

    expect(info.ok).toBe(true);
    expect(info.hasSummarize).toBe(true);
    expect(info.hasCC).toBe(true);
    expect(info.insidePlayer).toBe(true);
    expect(info.style).toContain('top:');
    expect(info.style).toContain('right:');
    expect(info.nearPlayerTop).toBe(true);
    expect(info.nearPlayerRight).toBe(true);
  });
});
