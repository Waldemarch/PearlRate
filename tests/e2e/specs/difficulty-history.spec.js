// Network difficulty history chart and the measured growth that feeds ROI.
// Default mock: 45 daily medians growing exactly 3.2 %/month up to today's ×1.18,
// passed through the Pages Function's own payload code (worker/lib).
const { test, expect, openApp, savedState, diffHistory, json, FLEET_STATE } = require('../fixtures');

test('chart, measured growth, and ROI following it until you take over', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#dSvg .cline')).toHaveCount(1);
  await expect(page.locator('#dSvg .dtrend')).toHaveCount(1);
  await expect(page.locator('#dStats')).toContainText('×1.18');
  await expect(page.locator('#dStats')).toContainText('21.36M');
  await expect(page.locator('#dStats')).toContainText('+3.2%/mo');
  await expect(page.locator('#dStats')).toContainText('measured over 45 days');
  await expect(page.locator('#dRanges button[data-drange="90d"]')).toHaveClass(/active/);

  const svg = page.locator('#dSvg');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator('#dTip')).toBeVisible();
  await expect(page.locator('#dTip')).toContainText('median of 24 readings');
  await page.mouse.move(2, 2);
  await svg.focus();
  await page.keyboard.press('End');
  await expect(page.locator('#dTip')).toContainText('median of 12 readings');

  await page.click('#tab-roi');
  await expect(page.locator('#growthNum')).toHaveValue('3.2');
  await expect(page.locator('#growthHint')).toHaveText('Measured over 45 days · band ±3 pp');
  await expect(page.locator('#growthHint .hdot')).toHaveCount(1);

  await page.focus('#growthRange');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#growthNum')).toHaveValue('4');
  await expect(page.locator('#growthHint')).toContainText('Manual · measured +3.2%/mo');
  await page.waitForTimeout(400);
  expect((await savedState(page)).live.growth).toBe(false);
  await page.click('#growthLive');
  await expect(page.locator('#growthNum')).toHaveValue('3.2');
  await expect(page.locator('#growthHint')).toContainText('Measured over 45 days');
  await page.waitForTimeout(400);
  expect((await savedState(page)).live.growth).toBe(true);
});

test('range buttons refit over the visible window', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#dStats')).toContainText('measured over 45 days');
  const req = page.waitForRequest((r) => r.url().includes('/api/difficulty-history?range=30d'));
  await page.click('#dRanges button[data-drange="30d"]');
  await req;
  await expect(page.locator('#dStats')).toContainText('measured over 30 days');
  await expect(page.locator('#dRanges button[data-drange="30d"]')).toHaveAttribute('aria-pressed', 'true');
  // ROI keeps the 90-day measurement whatever the chart shows.
  await page.click('#tab-roi');
  await expect(page.locator('#growthHint')).toContainText('Measured over 45 days');
});

test.describe('a manual growth from an older save', () => {
  test.use({ seedState: { ...FLEET_STATE, growth: 7 } });

  test('is kept, with the measured value one click away', async ({ page }) => {
    await openApp(page);
    await page.click('#tab-roi');
    await expect(page.locator('#growthNum')).toHaveValue('7');
    await expect(page.locator('#growthHint')).toContainText('Manual · measured +3.2%/mo');
  });
});

test.describe('fewer than 7 days of history', () => {
  test.use({ apiOverrides: { '/api/difficulty-history': (u) => diffHistory(u.searchParams.get('range'), { days: 3 }) } });

  test('says "collecting since …" and keeps the 5% default', async ({ page }) => {
    await openApp(page);
    // three points are drawn, with the reason there's no growth figure yet
    await expect(page.locator('#dSvg .cline')).toHaveCount(1);
    await expect(page.locator('#dSvg .dtrend')).toHaveCount(0);
    await expect(page.locator('#dStats')).toContainText('Collecting since 12 Nov 2026 — 3 days so far; growth is measured from 7 days');
    await page.click('#tab-roi');
    await expect(page.locator('#growthNum')).toHaveValue('5');
    await expect(page.locator('#growthHint')).toContainText('Default 5% · difficulty history collecting since 12 Nov 2026');
  });
});

test.describe('a single day of history', () => {
  test.use({ apiOverrides: { '/api/difficulty-history': (u) => diffHistory(u.searchParams.get('range'), { days: 1 }) } });

  test('has nothing to draw yet and says what ROI assumes meanwhile', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#dMsg')).toHaveText('Collecting since 14 Nov 2026 — 1 day so far; growth is measured from 7 days. Until then Payback & ROI assumes 5%/month.');
  });
});

test.describe('an empty table', () => {
  test.use({ apiOverrides: { '/api/difficulty-history': (u) => diffHistory(u.searchParams.get('range'), { days: 0 }) } });

  test('explains that readings arrive hourly', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#dMsg')).toContainText('No difficulty history yet');
    await expect(page.locator('#growthNum')).toHaveValue('5');
  });
});

test.describe('history not configured', () => {
  test.use({ apiOverrides: { '/api/difficulty-history': () => json({ error: 'history not configured' }, 503) } });

  test('shows a setup hint; ROI uses the default', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#dMsg')).toHaveText('Difficulty history not set up yet (connect the D1 binding).');
    await page.click('#tab-roi');
    await expect(page.locator('#growthHint')).toContainText('Default 5%');
  });
});
