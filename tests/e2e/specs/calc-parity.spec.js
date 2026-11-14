// Calc parity: the cron Worker's maths (worker/lib/calc.js, used for Telegram
// alerts) must equal index.html's, which can't import modules. The page's own
// econ() is evaluated in the browser over a grid of inputs and compared with
// the Worker module, figure by figure, for exact equality.
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect, openApp, FLEET_STATE } = require('../fixtures');

const loadCalc = () => import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'worker', 'lib', 'calc.js')).href);

const PRICES = [0, 0.05, 0.3, 0.92, 1.45, 5, 37.5, 1000];
const DIFFS = [0.001, 0.25, 1, 1.18, 3.7, 8, 100];
const FEES = [-5, 0, 4, 12.5, 100, 150];
const ELEC = [0, 0.1, 0.6];
const FIELDS = ['eff', 'grossDay', 'grossH', 'be', 'net', 'bePrice'];

test('benchmark table and econ() match worker/lib/calc.js exactly', async ({ page }) => {
  const calc = await loadCalc();
  await openApp(page);
  const pageCards = await page.evaluate(() => window.PearlRate.cards.map((c) => ({ ...c })));
  expect(pageCards).toEqual(calc.CARDS);
  expect(await page.evaluate(() => window.PearlRate.baselineDifficulty)).toBe(calc.BASELINE_DIFFICULTY);

  const cards = calc.CARDS.map((c) => [c.yield, c.power]).concat([[0, 1], [12.34, 2500]]);
  const grid = [];
  for (const [y, w] of cards) for (const P of PRICES) for (const D of DIFFS) for (const f of FEES) for (const e of ELEC) grid.push([y, w, P, D, f, e]);
  const fromPage = await page.evaluate((g) => g.map((a) => {
    const r = window.PearlRate.econ(...a);
    // Infinity / NaN don't survive JSON: send them as strings
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number.isFinite(v) ? v : String(v)]));
  }), grid);

  let mismatches = 0;
  const examples = [];
  grid.forEach((args, i) => {
    const w = calc.econ(...args);
    for (const k of FIELDS) {
      const pv = fromPage[i][k], wv = Number.isFinite(w[k]) ? w[k] : String(w[k]);
      if (!Object.is(pv, wv)) { mismatches++; if (examples.length < 5) examples.push({ args, k, page: pv, worker: wv }); }
    }
  });
  expect(grid.length).toBe(10 * PRICES.length * DIFFS.length * FEES.length * ELEC.length);
  expect(examples, `${mismatches} mismatching figures`).toEqual([]);
});

test.describe('fleet totals', () => {
  test.use({ seedState: FLEET_STATE });

  test('the Worker’s fleet maths reproduces the table’s fleet row', async ({ page }) => {
    const calc = await loadCalc();
    await openApp(page);
    const items = Object.entries(FLEET_STATE.qty).map(([id, qty]) => ({ ...calc.cardById(id), qty }));
    const t = calc.fleetEcon(items, 0.92, 1.18, FLEET_STATE.fee, FLEET_STATE.elec);
    await expect(page.locator('#fGpus')).toHaveText(String(t.gpus));
    await expect(page.locator('#fNet')).toHaveText('$' + t.net.toFixed(2));
    await expect(page.locator('#fBE')).toHaveText('$' + t.be.toFixed(3));
    await expect(page.locator('#fGrossDay')).toHaveText('$' + t.grossDay.toFixed(2));
  });
});
