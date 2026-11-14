// Phone layout (390 px, touch): no sideways scroll, tap targets, touch input.
const { test, expect, openApp, num, FLEET_STATE } = require('../fixtures');
const { overflowingElements, targetSizes } = require('../audit');

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'light',
  seedState: FLEET_STATE,
});

test('no horizontal scroll and nothing sticks out at 390 px', async ({ page }) => {
  await openApp(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await overflowingElements(page)).toEqual([]);
});

test('touch targets are at least 40 px (sliders at least 36 px tall)', async ({ page }) => {
  await openApp(page);
  const small = (list, min) => list.filter((s) => s.w < min || s.h < min);
  expect(small(await targetSizes(page, '#rows .qbtn, #ranges button, #roiHorizon button, #themeBtn, #beToggle'), 40)).toEqual([]);
  const sliders = await targetSizes(page, 'input[type=range]');
  expect(sliders.filter((s) => s.h < 36)).toEqual([]);
});

test('tapping + adds a GPU and tapping the track moves the slider', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#fGpus')).toHaveText('12');
  await page.tap('#rows tr[data-id="5080"] .qbtn[data-step="1"]');
  await expect(page.locator('#fGpus')).toHaveText('13');
  const range = page.locator('#priceRange');
  await range.scrollIntoViewIfNeeded();
  const rb = await range.boundingBox();
  await page.mouse.click(rb.x + rb.width * 0.8, rb.y + rb.height / 2);
  await expect.poll(async () => num(await page.locator('#priceNum').inputValue())).toBeGreaterThan(3);
  await expect(page.locator('#priceHint')).toContainText('Manual');
});
