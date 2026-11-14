// "Rent vs mine": verdict, the three strategies, flip prices, fleet, persistence.
//
// Worked example (one RTX 5090, PRL $0.92, difficulty ×1.18, $0.10/kWh, pool 4%,
// rate $0.45/h, platform fee 25%, occupancy 60%, idle 30 W):
//   k = 4.58/1.18·0.96 = 3.7261 $/day per $ of PRL;  eL = $0.051/h;  eI = $0.003/h
//   rent  = 0.45·14.4·0.75 − 0.051·14.4 − 0.003·9.6  = $4.10/day
//   combo = 4.86 − 0.051·24 + 3.7261·0.92·9.6/24       = $5.01/day
//   self  = 3.7261·0.92 − 1.224                         = $2.20/day  (the table's net)
//   flips: rent→combo at 24·(eL−eI)/k = $0.309;  combo→self at 24·0.45·0.75/k = $2.17
const { test, expect, openApp, savedState, FLEET_STATE } = require('../fixtures');
const { contrastViolations, overflowingElements } = require('../audit');

test('the summary invites a comparison and opens the tab', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#sumVerdictTxt')).toContainText('Add your $/h rates');
  await page.click('#sumVerdictBtn');
  await expect(page.locator('#tab-rent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#rentCard')).toBeVisible();
  await expect(page.locator('#rentEmpty')).toBeVisible();
  await expect(page.locator('#rentWrap')).toBeHidden();
  await expect(page.locator('#rentRates .ratein').first()).toBeFocused();
  await expect(page.locator('#rentTiles')).toContainText('no rental rate set');
});

test('one RTX 5090: three strategies, verdict and the exact flip prices', async ({ page }) => {
  await openApp(page);
  await page.click('#tab-rent');
  await expect(page.locator('#rentRates .ratebe')).toHaveText('miner break-even $0.143/h');
  await page.fill('#rentRates .ratein[data-id="5090"]', '0.45');

  const tiles = page.locator('#rentTiles .tile');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0)).toContainText('Best at PRL $0.92');
  await expect(tiles.nth(0)).toContainText('Rent + mine idle');
  await expect(tiles.nth(0)).toContainText('+$0.91/day vs rent only');
  await expect(tiles.nth(1)).toContainText('Rent only$4.10/day');
  await expect(tiles.nth(2)).toContainText('Rent + mine idle$5.01/day');
  await expect(tiles.nth(2)).toHaveClass(/best/);
  await expect(tiles.nth(3)).toContainText('Self-mine$2.20/day');
  // Self-mine equals the table's net for the same card.
  await expect(page.locator('#rows tr[data-id="5090"] td.c-net')).toHaveText('$2.20');
  await expect(page.locator('#rentFlip')).toHaveText('Self-mine wins above PRL $2.17 (+136%). Rent only wins below PRL $0.309 (−66%).');
  await expect(page.locator('#rentSvg circle.flip')).toHaveCount(2);
  await expect(page.locator('#rentSvg')).toHaveAttribute('aria-label', /flips at PRL \$0\.309 and \$2\.17/);
  await expect(page.locator('#sumVerdictTxt')).toHaveText(
    'Rent vs mine at PRL $0.92: Rent + mine idle pays most, $5.01/day (+$0.91 vs rent only). Self-mine wins above PRL $2.17 (+136%).');

  // Hover reads every strategy at that price.
  const svg = page.locator('#rentSvg');
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await expect(page.locator('#rentTip')).toBeVisible();
  await expect(page.locator('#rentTip')).toContainText('— best');

  // Full occupancy: nothing is left to mine, renting wins.
  await page.fill('#roccNum', '100');
  await expect(tiles.nth(0)).toContainText('Rent only');
  await expect(tiles.nth(1)).toContainText('$6.88/day');

  // A high PRL price flips it to self-mining (both are linear in price).
  await page.fill('#roccNum', '60');
  await page.fill('#priceNum', '2.50');
  await expect(tiles.nth(0)).toContainText('Self-mine');
  await expect(page.locator('#rentFlip')).toContainText('Rent + mine idle wins below PRL $2.17');

  await page.waitForTimeout(400);
  const st = await savedState(page);
  expect(st.rate).toEqual({ 5090: 0.45 });
  expect([st.rfee, st.rocc, st.ridle]).toEqual([25, 60, 30]);
});

test.describe('fleet', () => {
  test.use({ seedState: { ...FLEET_STATE, rate: { 5090: 0.45, 3090: 0.2 } }, seedStorage: { 'pearlrate:antab': 'rent' } });

  test('per-model breakdown; GPUs without a rate keep self-mining', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#rentCard')).toBeVisible();
    await expect(page.locator('#rentRates .ratein')).toHaveCount(3);
    await expect(page.locator('#rentRates .ratein[data-id="3060"]')).toHaveValue('');
    const rows = page.locator('#rentList .rlrow');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('4× RTX 5090');
    await expect(rows.nth(0)).toContainText('Rent + mine idle');
    await expect(rows.nth(2)).toContainText('2× RTX 3060');
    await expect(rows.nth(2)).toContainText('not offered — self-mines');
    await expect(page.locator('#sumVerdictTxt')).toContainText('Rent vs mine at PRL $0.92');
    // Clearing a rate takes that model off the rental market.
    await page.fill('#rentRates .ratein[data-id="3090"]', '');
    await expect(rows.nth(1)).toContainText('not offered');
  });
});

for (const scheme of ['dark', 'light']) {
  test(`rent view meets AA contrast (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await page.click('#tab-rent');
    await page.fill('#rentRates .ratein[data-id="5090"]', '0.45');
    await expect(page.locator('#rentSvg circle.flip')).toHaveCount(2);
    expect(await contrastViolations(page)).toEqual([]);
  });
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, seedState: { ...FLEET_STATE, rate: { 5090: 0.45 } } });

  test('tabs and the rent view fit at 390 px', async ({ page }) => {
    await openApp(page);
    await page.tap('#tab-rent');
    await expect(page.locator('#rentSvg circle.flip').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await overflowingElements(page)).toEqual([]);
    const tabs = await page.$$eval('#anTabs [role="tab"]', (els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.min(...tabs)).toBeGreaterThanOrEqual(40);
  });
});
