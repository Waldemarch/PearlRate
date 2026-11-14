// Scenario links (#s=…): copy, open as a different visitor, Keep / Back, errors.
const { test, expect, openApp, preparePage, savedState, FLEET_STATE } = require('../fixtures');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// Build a rich scenario in the default page and return the copied link.
async function makeLink(page) {
  await openApp(page);
  await page.fill('#priceNum', '1.30');                                   // pinned price = manual
  await page.fill('#elecNum', '0.15');
  await page.fill('#feeNum', '3');
  await page.fill('#rows tr[data-id="5090"] .qty', '2');
  await page.fill('#rows tr[data-id="4090"] .qty', '1');
  await page.click('#rows tr[data-id="5090"] .yieldcell');
  await page.fill('#rows tr[data-id="5090"] .yieldedit', '5');
  await page.keyboard.press('Enter');
  await page.click('#addGpuBtn');
  await page.fill('#gfName', 'Zażółć A6000, "rig"');                      // UTF-8 + CSV-hostile name
  await page.fill('#gfPower', '300');
  await page.fill('#gfYield', '1.25');
  await page.click('#gfSave');
  await page.fill('#rows tr[data-id="c1"] .qty', '3');
  await page.click('#tab-roi');
  await page.fill('#growthNum', '8');
  await page.fill('#trendNum', '-2');
  await page.click('#roiHorizon button[data-h="24"]');
  await page.selectOption('#subject', '4090');
  await page.locator('#roiCosts .costin[data-id="4090"]').fill('1500');
  await page.click('#tab-rent');
  await page.fill('#rentRates .ratein[data-id="4090"]', '0.33');
  await page.fill('#rfeeNum', '20');
  await page.fill('#roccNum', '75');
  await page.fill('#ridleNum', '40');
  await page.click('#copyLinkBtn');
  await expect(page.locator('#shareStatus')).toHaveText('Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html#s=[A-Za-z0-9_-]+$/);
  return link;
}

test('a shared link previews the full scenario without touching the visitor’s own setup', async ({ page, browser }) => {
  const link = await makeLink(page);
  expect(link.length).toBeLessThan(600);

  // A different visitor, with their own saved fleet.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  const other = await ctx.newPage();
  const errors = await preparePage(other, { seedState: FLEET_STATE });
  await other.goto(link);
  await expect(other.locator('#badge')).toHaveAttribute('data-state', 'live');

  const bar = other.locator('#shareBar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('PRL price pinned at $1.30');
  await expect(bar).toContainText('live difficulty');
  await expect(bar).toContainText('6 GPUs');
  await expect(other.locator('#shareBack')).toHaveText('Back to my setup');

  await expect(other.locator('#priceNum')).toHaveValue('1.30');
  await expect(other.locator('#priceHint')).toContainText('Manual · market $0.92');
  await expect(other.locator('#diffNum')).toHaveValue('1.18');
  await expect(other.locator('#diffHint')).toContainText('Live');
  await expect(other.locator('#elecNum')).toHaveValue('0.15');
  await expect(other.locator('#feeNum')).toHaveValue('3');
  await expect(other.locator('#rows tr[data-id="5090"] .qty')).toHaveValue('2');
  await expect(other.locator('#rows tr[data-id="5090"] .yieldcell')).toHaveClass(/custom/);
  await expect(other.locator('#rows tr[data-id="c1"] .nmt')).toHaveText('Zażółć A6000, "rig"');
  await expect(other.locator('#rows tr[data-id="c1"] .qty')).toHaveValue('3');
  await expect(other.locator('#fGpus')).toHaveText('6');
  await expect(other.locator('#growthNum')).toHaveValue('8');
  await expect(other.locator('#trendNum')).toHaveValue('-2');
  await expect(other.locator('#roiHorizon button[data-h="24"]')).toHaveClass(/active/);
  await expect(other.locator('#subject')).toHaveValue('4090');
  await expect(other.locator('#roiCosts .costin[data-id="4090"]')).toHaveValue('1500');
  await expect(other.locator('#rentRates .ratein[data-id="4090"]')).toHaveValue('0.33');
  await expect(other.locator('#rfeeNum')).toHaveValue('20');
  await expect(other.locator('#roccNum')).toHaveValue('75');
  await expect(other.locator('#ridleNum')).toHaveValue('40');

  // Same numbers as the sender sees.
  await expect(other.locator('#fNet')).toHaveText(await page.locator('#fNet').textContent());

  // Tweaking the preview never writes over the visitor's own setup.
  await other.click('#rows tr[data-id="5080"] .qbtn[data-step="1"]');
  await expect(other.locator('#fGpus')).toHaveText('7');
  await other.waitForTimeout(400);
  expect(await savedState(other)).toEqual(FLEET_STATE);

  await other.click('#shareBack');
  await expect(bar).toBeHidden();
  await expect(other.locator('#fGpus')).toHaveText('12');
  await expect(other.locator('#rows tr[data-id="c1"]')).toHaveCount(0);
  await expect(other.locator('#priceHint')).toContainText('Live');
  expect(new URL(other.url()).hash).toBe('');
  expect(await savedState(other)).toEqual(FLEET_STATE);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('Keep this scenario makes it the visitor’s setup', async ({ page, browser }) => {
  const link = await makeLink(page);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  const other = await ctx.newPage();
  const errors = await preparePage(other, { seedState: FLEET_STATE });
  await other.goto(link);
  await expect(other.locator('#shareBar')).toBeVisible();
  await other.click('#shareKeep');
  await expect(other.locator('#shareBar')).toBeHidden();
  await expect(other.locator('#shareStatus')).toHaveText('Scenario saved as your setup');
  expect(new URL(other.url()).hash).toBe('');
  const st = await savedState(other);
  expect(st.qty).toEqual({ 5090: 2, 4090: 1, c1: 3 });
  expect(st.live).toEqual({ price: false, diff: true });
  expect(st.price).toBe(1.3);
  await other.reload();
  await expect(other.locator('#shareBar')).toBeHidden();
  await expect(other.locator('#fGpus')).toHaveText('6');
  await expect(other.locator('#priceNum')).toHaveValue('1.30');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a first-time visitor is offered the defaults instead', async ({ page, browser }) => {
  const link = await makeLink(page);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  const other = await ctx.newPage();
  const errors = await preparePage(other);
  await other.goto(link);
  await expect(other.locator('#shareBar')).toContainText('Nothing is saved until you keep it.');
  await expect(other.locator('#shareBack')).toHaveText('Use defaults instead');
  expect(await savedState(other)).toBeNull();
  await other.click('#shareBack');
  await expect(other.locator('#fGpus')).toHaveText('0');
  await expect(other.locator('#elecNum')).toHaveValue('0.10');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a live price in the link follows the visitor’s market price', async ({ page }) => {
  const payload = { v: 1, p: [3.21, 1], d: [2, 0], e: 0.2, f: 5, q: { 3090: 4 } };
  const hash = '#s=' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  await openApp(page, { path: '/index.html' + hash });
  await expect(page.locator('#priceNum')).toHaveValue('0.92');
  await expect(page.locator('#diffNum')).toHaveValue('2.00');
  await expect(page.locator('#diffHint')).toContainText('Manual · network ×1.18');
  await expect(page.locator('#shareBar')).toContainText('live PRL price · difficulty pinned at ×2.00 · 4 GPUs');
});

test('opening a link in an open tab (hashchange) switches to the preview', async ({ page }) => {
  await openApp(page);
  const payload = { v: 1, p: [2, 0], d: [1, 1], q: { 5080: 5 } };
  await page.evaluate((h) => { location.hash = h; }, 's=' + Buffer.from(JSON.stringify(payload)).toString('base64url'));
  await expect(page.locator('#shareBar')).toBeVisible();
  await expect(page.locator('#fGpus')).toHaveText('5');
  await expect(page.locator('#priceNum')).toHaveValue('2.00');
});

test('a damaged or future link shows a notice and keeps the visitor’s setup', async ({ page }) => {
  await openApp(page, { path: '/index.html#s=AAAA' });
  await expect(page.locator('#shareBar')).toContainText('Couldn’t open that link');
  await expect(page.locator('#shareKeep')).toBeHidden();
  await page.click('#shareBack');
  await expect(page.locator('#shareBar')).toBeHidden();
  const future = '#s=' + Buffer.from(JSON.stringify({ v: 9 })).toString('base64url');
  await page.goto('/index.html' + future);
  await expect(page.locator('#shareBar')).toContainText('newer version');
});

test.describe('without clipboard access', () => {
  test.use({ permissions: [] });

  test('Copy link falls back to a selectable field', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
    await page.click('#copyLinkBtn');
    await expect(page.locator('#linkBox')).toBeVisible();
    await expect(page.locator('#linkInput')).toBeFocused();
    expect(await page.locator('#linkInput').inputValue()).toContain('#s=');
    await page.click('#linkClose');
    await expect(page.locator('#linkBox')).toBeHidden();
  });
});
