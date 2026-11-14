// WCAG AA text contrast in both themes (desktop, populated fleet).
const { test, expect, openApp, FLEET_STATE } = require('../fixtures');
const { contrastViolations } = require('../audit');

for (const scheme of ['dark', 'light']) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme, seedState: FLEET_STATE });

    test('all visible text meets AA contrast', async ({ page }) => {
      await openApp(page);
      await expect(page.locator('#chartSvg .cline')).toHaveCount(1);
      expect(await contrastViolations(page)).toEqual([]);
    });
  });
}
