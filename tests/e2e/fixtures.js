// Shared fixtures for the PearlRate e2e suite.
//
// Every test gets, automatically:
//   - a fixed wall clock (Date.now() === NOW) so "3 min ago" labels are exact;
//     timers, requestAnimationFrame and performance.now() keep running.
//   - deterministic /api/* mocks (shapes from functions/api/*.js), switchable
//     per describe block with test.use({ apiMode: 'ok' | 'error' | 'slow' }).
//   - Google Fonts stubbed out (empty stylesheet), so runs never touch the
//     network and always lay out with the same fallback fonts.
//   - console errors / page errors collected and asserted empty at teardown.
const base = require('@playwright/test');
const { expect } = base;

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0); // Sat 14 Nov 2026 12:00 UTC
const DAY = 864e5;
const PRICE = 0.92;
const DIFF = { mult: 1.18, difficulty: 21355740, baseline: 18098085 };
const BASELINE_DIFFICULTY = 18098085;

// Deterministic PRNG so every run sees the same price history.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: 52 * DAY };
function priceHistory(range) {
  const span = RANGES[range] || RANGES['7d'];
  const n = 300, step = span / n, r = rng(42 + Object.keys(RANGES).indexOf(range));
  const pts = [];
  let p = PRICE * 0.995;
  for (let i = n - 1; i >= 0; i--) {
    pts.push({ t: Math.round(NOW - 4 * 60e3 - (n - 1 - i) * step), p: +p.toFixed(4) });
    const drift = range === 'all' ? 0.0022 : range === '30d' ? 0.0012 : 0.0004;
    p = p * (1 + drift + (r() - 0.5) * (range === '24h' ? 0.012 : 0.03));
  }
  return pts.reverse();
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Default answers for every endpoint the page calls. `overrides` maps a path
// to a function (url) => {status, body} | null (null = never answer).
function apiResponse(url, mode, overrides) {
  const p = url.pathname;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, p)) return overrides[p](url);
  if (mode === 'slow') return null;
  if (mode === 'error') {
    if (p === '/api/history') return json({ error: 'history not configured' }, 503);
    return json({ error: 'boom' }, 500);
  }
  if (p === '/api/price') return json({ price: PRICE, ts: NOW - 3 * 60e3, source: 'coingecko:wrapped-pearl' });
  if (p === '/api/difficulty') return json({ ...DIFF, ts: NOW - 22 * 60e3, source: 'alphapool:miningcore' });
  if (p === '/api/history') {
    const range = url.searchParams.get('range') || '7d';
    return json({ range, points: priceHistory(range) });
  }
  return json({ error: 'not found' }, 404);
}

// A fleet of 12 GPUs (4× 5090, 6× 3090, 2× 3060), live price & difficulty.
const FLEET_STATE = {
  price: PRICE, diff: 1.18, elec: 0.10, fee: 4, growth: 5, trend: 0, horizon: 12,
  qty: { '5090': 4, '3090': 6, '3060': 2 }, yields: {}, cost: {}, live: { price: true, diff: true },
};

const IGNORED_CONSOLE = [/Failed to load resource/];

// Wire one page up: fixed clock, font stubs, /api mocks, seeded storage and
// console capture. Used by the auto fixture below and by tests that open a
// second browser context (e.g. a different visitor opening a shared link).
async function preparePage(page, { apiMode = 'ok', apiOverrides = {}, seedState = null, seedStorage = null } = {}) {
  const errors = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) {
      errors.push(`[console.${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.clock.setFixedTime(NOW);
  await page.route(/^https:\/\/fonts\.googleapis\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route(/^https:\/\/fonts\.gstatic\.com\//, (r) => r.abort());
  await page.route(/\/api\//, (route) => {
    const res = apiResponse(new URL(route.request().url()), apiMode, apiOverrides);
    if (res) return route.fulfill(res);
    // 'slow': never answer, so the page stays in its loading state.
  });
  // Seed localStorage once per page (a reload keeps whatever the page saved).
  const seed = {};
  if (seedState) seed['pearlrate:state'] = JSON.stringify(seedState);
  if (seedStorage) Object.entries(seedStorage).forEach(([k, v]) => { seed[k] = JSON.stringify(v); });
  if (Object.keys(seed).length) {
    await page.addInitScript((s) => {
      try {
        if (sessionStorage.getItem('__pw_seeded')) return;
        sessionStorage.setItem('__pw_seeded', '1');
        Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v));
      } catch (e) { /* storage blocked */ }
    }, seed);
  }
  return errors;
}

const test = base.test.extend({
  apiMode: ['ok', { option: true }],
  apiOverrides: [{}, { option: true }],
  seedState: [null, { option: true }],
  seedStorage: [null, { option: true }],
  // Collected console errors/warnings; asserted empty when the test ends.
  consoleErrors: [async ({ page, apiMode, apiOverrides, seedState, seedStorage }, use) => {
    const errors = await preparePage(page, { apiMode, apiOverrides, seedState, seedStorage });
    await use(errors);
    expect(errors, 'console errors / page errors').toEqual([]);
  }, { auto: true }],
});

// Load the dashboard and wait until live data has landed (or the given state).
async function openApp(page, { path = '/index.html', badge = 'live' } = {}) {
  await page.goto(path);
  if (badge) await expect(page.locator('#badge')).toHaveAttribute('data-state', badge);
}

const num = (s) => parseFloat(String(s).replace(/[^0-9.\-−]/g, '').replace('−', '-'));

// Read the persisted setup straight from localStorage.
const savedState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('pearlrate:state') || 'null'));

module.exports = {
  test, expect, openApp, preparePage, savedState, num,
  NOW, DAY, PRICE, DIFF, BASELINE_DIFFICULTY, FLEET_STATE, priceHistory, json,
};
