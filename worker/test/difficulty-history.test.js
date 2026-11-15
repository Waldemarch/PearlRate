// Unit tests: D1 difficulty history (write + read) and the growth regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendDifficulty, readDailyMedians, fitGrowth, historyPayload, median, DAY_MS, MONTH_DAYS,
} from "../lib/difficulty-history.js";
import { fakeD1 } from "./fakes.js";

const T0 = Date.UTC(2026, 9, 1); // 1 Oct 2026 00:00 UTC

// n days of hourly readings growing `monthly` per month (exactly exponential).
async function seed(db, { days, monthly, start = T0, base = 18_098_085, perDay = 24 }) {
  const b = Math.log(1 + monthly) / MONTH_DAYS;
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < perDay; h++) {
      const t = start + d * DAY_MS + h * (DAY_MS / perDay);
      await appendDifficulty(db, { ts: t, difficulty: base * Math.exp(b * (t - start) / DAY_MS), source: "test" });
    }
  }
}

test("appendDifficulty creates the table on first use, then just inserts", async () => {
  const db = fakeD1();
  const first = await appendDifficulty(db, { ts: T0, difficulty: 21_355_740, source: "alphapool:miningcore" });
  assert.deepEqual(first, { stored: true, created: true });
  const second = await appendDifficulty(db, { ts: T0 + 3600e3, difficulty: 21_400_000, source: "alphapool:miningcore" });
  assert.deepEqual(second, { stored: true });
  assert.deepEqual(db.rows("prl_difficulty"), [
    { ts: T0, difficulty: 21_355_740, source: "alphapool:miningcore" },
    { ts: T0 + 3600e3, difficulty: 21_400_000, source: "alphapool:miningcore" },
  ]);
  const creates = db.statements.filter((s) => s.startsWith("CREATE"));
  assert.equal(creates.length, 2, "table + index created exactly once");
  assert.ok(creates.every((s) => s.includes("IF NOT EXISTS")), "schema is idempotent");
  const idx = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='prl_difficulty'").all();
  assert.deepEqual(idx.map((r) => r.name), ["idx_prl_difficulty_ts"]);
});

test("appendDifficulty tolerates a missing binding and rejects bad readings", async () => {
  assert.deepEqual(await appendDifficulty(undefined, { ts: T0, difficulty: 1 }), { stored: false, reason: "no PRICE_DB binding" });
  const db = fakeD1();
  assert.equal((await appendDifficulty(db, { ts: T0, difficulty: NaN })).stored, false);
  assert.equal((await appendDifficulty(db, { ts: T0, difficulty: -5 })).stored, false);
  assert.equal((await appendDifficulty(db, { difficulty: 5 })).stored, false);
  assert.equal(db.statements.length, 0, "nothing reaches D1");
});

test("appendDifficulty truncates the source and lets other D1 errors through", async () => {
  const db = fakeD1();
  await appendDifficulty(db, { ts: T0, difficulty: 1e7, source: "x".repeat(200) });
  assert.equal(db.rows("prl_difficulty")[0].source.length, 64);
  const broken = fakeD1({ failWith: "D1_ERROR: database is locked" });
  await assert.rejects(appendDifficulty(broken, { ts: T0, difficulty: 1e7 }), /locked/);
});

test("readDailyMedians: one median per UTC day, robust to a glitch reading", async () => {
  const db = fakeD1();
  for (const [h, d] of [[1, 100], [2, 102], [3, 101], [4, 9_999]]) await appendDifficulty(db, { ts: T0 + h * 3600e3, difficulty: d });
  for (const [h, d] of [[1, 200], [5, 210]]) await appendDifficulty(db, { ts: T0 + DAY_MS + h * 3600e3, difficulty: d });
  const out = await readDailyMedians(db, { since: 0 });
  assert.deepEqual(out.days, [{ t: T0, d: 101.5, n: 4 }, { t: T0 + DAY_MS, d: 205, n: 2 }]);
  assert.equal(out.first, T0 + 3600e3);
  assert.equal(out.count, 6);
  const later = await readDailyMedians(db, { since: T0 + DAY_MS });
  assert.equal(later.days.length, 1);
  assert.equal(later.count, 6, "count/first describe the whole table");
});

test("readDailyMedians reads a missing table as an empty history", async () => {
  const out = await readDailyMedians(fakeD1());
  assert.deepEqual(out, { days: [], first: null, count: 0, missing: true });
  await assert.rejects(readDailyMedians(fakeD1({ failWith: "D1_ERROR: network" })), /network/);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("fitGrowth recovers an exact exponential trend", async () => {
  const db = fakeD1();
  await seed(db, { days: 60, monthly: 0.04 });
  const { days } = await readDailyMedians(db);
  assert.equal(days.length, 60);
  const g = fitGrowth(days, { windowDays: 90 });
  assert.ok(Math.abs(g.monthly - 0.04) < 1e-9, `monthly ${g.monthly}`);
  assert.equal(g.days, 60);
  assert.equal(g.n, 60);
  assert.ok(g.r2 > 0.999999);
  assert.ok(Math.abs(g.toD / g.fromD - Math.exp(Math.log(1.04) / MONTH_DAYS * 59)) < 1e-9);
});

test("fitGrowth: windows, falling difficulty, noise, too little data", () => {
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY_MS, d: f(i) }));
  // 30 flat days, then 30 days growing 10%/month: the 30-day window sees only the growth.
  const b = Math.log(1.1) / MONTH_DAYS;
  const kinked = mk(60, (i) => (i < 30 ? 1e7 : 1e7 * Math.exp(b * (i - 29))));
  assert.ok(Math.abs(fitGrowth(kinked, { windowDays: 30 }).monthly - 0.1) < 0.005);
  assert.equal(fitGrowth(kinked, { windowDays: 30 }).days, 30);
  assert.ok(fitGrowth(kinked, { windowDays: 90 }).monthly < 0.1);
  // shrinking network
  const down = fitGrowth(mk(20, (i) => 1e7 * Math.pow(0.99, i)));
  assert.ok(Math.abs(down.monthly - (Math.pow(0.99, MONTH_DAYS) - 1)) < 1e-9);
  assert.ok(down.monthly < 0);
  // flat
  assert.equal(fitGrowth(mk(10, () => 5e6)).monthly, 0);
  // deterministic ±2% noise around 5%/month still lands close
  let s = 7;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const b5 = Math.log(1.05) / MONTH_DAYS;
  const noisy = fitGrowth(mk(90, (i) => 2e7 * Math.exp(b5 * i) * (1 + (rnd() - 0.5) * 0.04)));
  assert.ok(Math.abs(noisy.monthly - 0.05) < 0.005, `noisy ${noisy.monthly}`);
  // fewer than 7 distinct days: no figure
  assert.equal(fitGrowth(mk(6, (i) => 1e7 + i)), null);
  assert.notEqual(fitGrowth(mk(7, (i) => 1e7 + i)), null);
  assert.equal(fitGrowth([]), null);
  assert.equal(fitGrowth(null), null);
});

test("historyPayload: range window and the collecting state", async () => {
  const db = fakeD1();
  await seed(db, { days: 3, monthly: 0.05 });
  const short = historyPayload(await readDailyMedians(db), "90d");
  assert.equal(short.range, "90d");
  assert.equal(short.first, T0);
  assert.equal(short.count, 72);
  assert.equal(short.points.length, 3);
  assert.equal(short.growth, null, "3 days are not enough");
  const empty = historyPayload(await readDailyMedians(fakeD1()), "30d");
  assert.deepEqual(empty, { range: "30d", first: null, count: 0, points: [], growth: null });
});
