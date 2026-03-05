const { test, expect } = require('./fixtures');

test.describe('FAB Buttons', () => {
  test('FABs appear when text is selected', async ({ testPage }) => {
    // Programmatically select text using the test page helper
    await testPage.evaluate(() => window.selectTestText());

    // Also fire a mouseup to trigger the FAB logic in content-dual.js
    const textEl = testPage.locator('#auto-select-text');
    const box = await textEl.boundingBox();
    await testPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // Select again after click (click may clear selection)
    await testPage.evaluate(() => window.selectTestText());

    // Fire mouseup on the element to trigger content script
    await textEl.dispatchEvent('mouseup');
    await testPage.waitForTimeout(300);

    // Check for FAB buttons
    const fabs = await testPage.evaluate(() => {
      const container = document.getElementById('fab-container');
      const all = Array.from(document.querySelectorAll('.fab'));
      const summarize = all.find(el => el.textContent?.trim() === '✨');
      const draft = all.find(el => el.textContent?.trim() === '✒️');
      return {
        summarizeFound: !!summarize,
        draftFound: !!draft,
        containerVisible: container ? getComputedStyle(container).display !== 'none' : false,
      };
    });

    expect(fabs.summarizeFound).toBe(true);
    expect(fabs.draftFound).toBe(true);
    expect(fabs.containerVisible).toBe(true);
  });

  test('FABs hide when selection is cleared', async ({ testPage }) => {
    // Select text
    await testPage.evaluate(() => window.selectTestText());
    const textEl = testPage.locator('#auto-select-text');
    await textEl.dispatchEvent('mouseup');
    await testPage.waitForTimeout(300);

    // Clear selection
    await testPage.evaluate(() => window.getSelection().removeAllRanges());
    await testPage.dispatchEvent('body', 'mouseup');
    await testPage.waitForTimeout(300);

    // Check FABs are hidden or removed
    const fabsVisible = await testPage.evaluate(() => {
      return window.areFABsVisible?.() ?? false;
    });

    expect(fabsVisible).toBe(false);
  });
});
