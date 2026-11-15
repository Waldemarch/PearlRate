// Live-data states: endpoints failing, never answering, or serving old data.
const { test, expect, openApp, json, NOW } = require('../fixtures');

test.describe('API failure', () => {
  test.use({ apiMode: 'error' });

  test('falls back to defaults and explains why', async ({ page }) => {
    await openApp(page, { badge: 'off' });
    await expect(page.locator('#badgeAge')).toHaveText('offline');
    await expect(page.locator('#priceHint')).toContainText('Live price unavailable');
    await expect(page.locator('#chartMsg')).toHaveText('History not set up yet (connect the D1 binding).');
    await expect(page.locator('#priceNum')).toHaveValue('1.45');
    await expect(page.locator('#diffNum')).toHaveValue('1.00');
    await expect(page.locator('#rows tr[data-id="5090"] td.c-net')).toHaveText('$5.15');
  });
});

test.describe('loading', () => {
  test.use({ apiMode: 'slow' });

  test('shows the loading state while nothing has answered', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#badge')).toHaveAttribute('data-state', 'loading');
    await expect(page.locator('#priceHint')).toHaveText('Fetching live market price…');
    await expect(page.locator('#chartWrap')).toHaveClass(/skeleton/);
  });
});

test.describe('stale data', () => {
  test.use({
    apiOverrides: {
      '/api/price': () => json({ price: 0.88, ts: NOW - 3 * 3600e3, source: 'dexscreener:wprl-ethereum' }),
    },
  });

  test('an old price is flagged stale', async ({ page }) => {
    await openApp(page, { badge: 'stale' });
    await expect(page.locator('#badgeAge')).toHaveText('3 h ago');
    await expect(page.locator('#priceHint .hdot')).toHaveClass(/stale/);
    await expect(page.locator('#priceHint')).toContainText('Live · Dexscreener · 3 h ago');
  });
});

test.describe('history endpoint missing', () => {
  test.use({ apiOverrides: { '/api/history': () => json({ error: 'boom' }, 500) } });

  test('chart says history is unavailable, everything else works', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#chartMsg')).toHaveText('Price history unavailable.');
    await expect(page.locator('#badgePrice')).toHaveText('$0.92');
  });
});
