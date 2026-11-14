// WCAG AA text contrast in both themes, on desktop and phone, with every
// Analysis tab opened in turn (hidden tabs aren't audited otherwise).
const { test, expect, openApp, FLEET_STATE } = require('../fixtures');
const { contrastViolations } = require('../audit');

const STATE = { ...FLEET_STATE, rate: { 5090: 0.45, 3090: 0.2 } };
const TABS = ['map', 'roi', 'eff', 'rent'];

for (const scheme of ['dark', 'light']) {
  for (const [device, use] of [
    ['desktop', {}],
    ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ]) {
    test.describe(`${scheme} theme, ${device}`, () => {
      test.use({ colorScheme: scheme, seedState: STATE, ...use });

      test('all visible text meets AA contrast on every Analysis tab', async ({ page }) => {
        await openApp(page);
        await expect(page.locator('#chartSvg .cline')).toHaveCount(1);
        await expect(page.locator('#dSvg .cline')).toHaveCount(1);
        const failures = {};
        for (const tab of TABS) {
          await page.click(`#tab-${tab}`);
          await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
          const v = await contrastViolations(page);
          if (v.length) failures[tab] = v;
        }
        expect(failures).toEqual({});
      });
    });
  }
}
