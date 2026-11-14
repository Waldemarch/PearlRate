// Desktop dashboard: live data, controls, table, fleet, chart, analysis, theme.
// Ported from the hand-run verify.js harness.
const { test, expect, openApp, num, FLEET_STATE } = require('../fixtures');

test.use({ colorScheme: 'dark' });

test.describe('live market data', () => {
  test('badge, controls and hints follow /api/price and /api/difficulty', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#badgePrice')).toHaveText('$0.92');
    await expect(page.locator('#badgeAge')).toHaveText('3 min ago');
    await expect(page.locator('#priceNum')).toHaveValue('0.92');
    await expect(page.locator('#diffNum')).toHaveValue('1.18');
    await expect(page.locator('#priceHint')).toHaveText('Live · Coingecko · 3 min ago');
    await expect(page.locator('#diffHint')).toHaveText('Live ×1.18 · 21.4M · 22 min ago');
    await expect(page).toHaveTitle(/^\$0\.92 [▲▼]\d+\.\d% · PearlRate$/);
  });

  test('moving the price slider switches to manual; ↺ Live switches back', async ({ page }) => {
    await openApp(page);
    const net5090 = page.locator('#rows tr[data-id="5090"] td.c-net');
    await expect(net5090).toHaveText('$2.20');
    await page.focus('#priceRange');
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('#priceNum')).toHaveValue('1.02');
    await expect(page.locator('#priceHint')).toContainText('Manual · market $0.92');
    await expect(page.locator('#priceTick')).toBeVisible();
    await expect(net5090).toHaveText('$2.58');
    await page.click('#priceHint .golive');
    await expect(page.locator('#priceNum')).toHaveValue('0.92');
    await expect(page.locator('#priceHint')).toContainText('Live');
    await expect(page.locator('#priceTick')).toBeHidden();
    await expect(net5090).toHaveText('$2.20');
  });

  test('typing in a number box moves its slider', async ({ page }) => {
    await openApp(page);
    await page.fill('#elecNum', '0.20');
    await expect(page.locator('#elecRange')).toHaveValue('0.2');
    await expect(page.locator('#rows tr[data-id="5090"] td.c-net')).toHaveText('$0.98');
  });
});

test.describe('table', () => {
  test('inline yield override: edit, mark, clear, escape', async ({ page }) => {
    await openApp(page);
    const row = page.locator('#rows tr[data-id="5090"]');
    await row.locator('.yieldcell').click();
    await expect(row.locator('.yieldedit')).toBeFocused();
    await row.locator('.yieldedit').fill('5.9');
    await page.keyboard.press('Enter');
    await expect(row.locator('.yv')).toHaveText((5.9 / 1.18).toFixed(2));
    await expect(row.locator('.yieldcell')).toHaveClass(/custom/);
    await row.locator('.yieldcell').click();
    await row.locator('.yieldedit').fill('');
    await page.keyboard.press('Enter');
    await expect(row.locator('.yv')).toHaveText((4.58 / 1.18).toFixed(2));
    await expect(row.locator('.yieldcell')).not.toHaveClass(/custom/);
    const r3090 = page.locator('#rows tr[data-id="3090"]');
    await r3090.locator('.yieldcell').click();
    await page.keyboard.press('Escape');
    await expect(r3090.locator('.yieldedit')).toHaveCount(0);
  });

  test('fleet quantities drive totals, the summary strip and the analysis map', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#sumTitle')).toHaveText('Per card · RTX 5090');
    const plus5090 = page.locator('#rows tr[data-id="5090"] .qbtn[data-step="1"]');
    await plus5090.click();
    await plus5090.click();
    await page.fill('#rows tr[data-id="3090"] .qty', '3');
    await expect(page.locator('#fGpus')).toHaveText('5');
    await expect(page.locator('#sumTitle')).toHaveText('Your fleet · 5 GPUs');
    await expect(page.locator('#fNet')).toHaveText('$5.74');
    await expect(page.locator('#sumNet')).toHaveText('$5.74');
    await expect(page.locator('#sumBE')).toHaveText(await page.locator('#fBE').textContent());
    await expect(page.locator('#sumGross')).toHaveText(await page.locator('#fGrossDay').textContent());
    await page.selectOption('#subject', 'fleet');
    const bep = await page.locator('#sumBEP').textContent();
    await expect(page.locator('#mapTiles')).toContainText(`to ${bep} before a loss`);
    await page.locator('#rows tr[data-id="5090"] .qbtn[data-step="-1"]').click();
    await expect(page.locator('#fGpus')).toHaveText('4');
  });

  test('quantities persist across a reload', async ({ page }) => {
    await openApp(page);
    await page.fill('#rows tr[data-id="5080"] .qty', '7');
    await expect(page.locator('#fGpus')).toHaveText('7');
    await page.waitForTimeout(400); // persist() is debounced
    await page.reload();
    await expect(page.locator('#rows tr[data-id="5080"] .qty')).toHaveValue('7');
  });
});

test.describe('price history chart', () => {
  test.use({ seedState: FLEET_STATE });

  test('tooltip by pointer and keyboard, ranges, break-even toggle', async ({ page }) => {
    await openApp(page);
    const svg = page.locator('#chartSvg');
    await expect(svg.locator('.cline')).toHaveCount(1);
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator('#chartTip')).toBeVisible();
    await expect(page.locator('#chartTip')).toContainText('Your fleet here');
    await page.mouse.move(5, 5);
    await expect(page.locator('#chartTip')).toBeHidden();
    await svg.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#chartTip')).toBeVisible();
    await page.click('#ranges button[data-range="30d"]');
    await expect(page.locator('#ranges button[data-range="30d"]')).toHaveClass(/active/);
    await expect(page.locator('#cStats')).toContainText('30 days');
    await expect(page.locator('#beNote')).toContainText('each card in your fleet');
    await page.click('#beToggle');
    await expect(page.locator('#beToggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#beNote')).toBeHidden();
    await page.click('#beToggle');
    await expect(page.locator('#beToggle')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('analysis', () => {
  test('subject switch, ROI horizon + tooltip, map click, efficiency bubbles', async ({ page }) => {
    await openApp(page);
    await page.selectOption('#subject', '3090');
    await expect(page.locator('#anSub')).toContainText('1× RTX 3090');
    await page.click('#roiHorizon button[data-h="24"]');
    await expect(page.locator('#roiHorizon button[data-h="24"]')).toHaveClass(/active/);
    await expect(page.locator('#roiTiles')).toContainText('24 mo');
    const roi = page.locator('#roiSvg');
    await roi.scrollIntoViewIfNeeded();
    const rb = await roi.boundingBox();
    await page.mouse.move(rb.x + rb.width * 0.6, rb.y + rb.height * 0.5);
    await expect(page.locator('#roiTip')).toBeVisible();

    const map = page.locator('#mapSvg');
    await map.scrollIntoViewIfNeeded();
    const mb = await map.boundingBox();
    await page.mouse.click(mb.x + mb.width * 0.7, mb.y + mb.height * 0.6);
    await expect(page.locator('#priceHint')).toContainText('Manual');
    await expect(page.locator('#diffHint')).toContainText('Manual');
    await page.click('#priceHint .golive');
    await page.click('#diffHint .golive');
    await expect(page.locator('#priceNum')).toHaveValue('0.92');
    await expect(page.locator('#diffNum')).toHaveValue('1.18');

    await expect(page.locator('#effSvg circle.bub')).toHaveCount(8);
    await expect(page.locator('#effRank .rrow')).toHaveCount(8);
  });
});

test.describe('theme and reset', () => {
  test.use({ seedState: FLEET_STATE });

  test('theme toggles and persists; reset restores defaults', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.click('#themeBtn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#faf5e9');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.click('#themeBtn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await expect(page.locator('#fGpus')).toHaveText('12');
    await page.click('#resetBtn');
    await expect(page.locator('#fGpus')).toHaveText('0');
    await expect(page.locator('#elecNum')).toHaveValue('0.10');
    expect(num(await page.locator('#priceNum').inputValue())).toBe(0.92); // reset keeps the live price
  });
});
