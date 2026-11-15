// Unit tests: the cron Worker end to end through its public entry points
// (scheduled + fetch), with fake KV/D1 and a stubbed fetch for the sources.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../price-cron.js";
import { fakeD1, fakeKV, fakeCtx, stubFetch } from "./fakes.js";

const DIFF_CRON = "7 * * * *";
const PRICE_CRON = "*/5 * * * *";
let net, difficulty, price;

beforeEach(() => {
  difficulty = 21_355_740;
  price = 0.92;
  net = stubFetch([
    ["https://pearl.alphapool.tech/api/pools", () => ({ pools: [{ id: "prl", networkStats: { networkDifficulty: difficulty } }] })],
    ["https://api.dexscreener.com/", () => ({ pairs: [{ chainId: "ethereum", priceUsd: String(price), liquidity: { usd: 1e6 }, baseToken: { symbol: "WPRL" } }] })],
  ]);
});
afterEach(() => net.restore());

async function tick(env, cron) {
  const ctx = fakeCtx();
  await worker.scheduled({ cron }, env, ctx);
  await ctx.done();
}

test("hourly tick appends a D1 history row every time, KV only on change", async () => {
  const env = { PRICE_KV: fakeKV(), PRICE_DB: fakeD1() };
  await tick(env, DIFF_CRON);
  assert.equal(env.PRICE_KV.puts, 1);
  assert.equal(env.PRICE_KV.json("prl_state").diff.mult, 1.18);
  let rows = env.PRICE_DB.rows("prl_difficulty");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].difficulty, 21_355_740);
  assert.equal(rows[0].source, "pearl.alphapool.tech:pools[0].networkStats.networkDifficulty");

  await tick(env, DIFF_CRON);                 // unchanged value: no KV write, still a history row
  assert.equal(env.PRICE_KV.puts, 1);
  rows = env.PRICE_DB.rows("prl_difficulty");
  assert.equal(rows.length, 2);

  difficulty = 22_000_000;                    // changed: KV write + row
  await tick(env, DIFF_CRON);
  assert.equal(env.PRICE_KV.puts, 2);
  assert.equal(env.PRICE_DB.rows("prl_difficulty").length, 3);
});

test("price ticks never touch the difficulty history", async () => {
  const db = fakeD1();
  db.sqlite.exec("CREATE TABLE prl_price (id INTEGER PRIMARY KEY, ts INTEGER, price REAL, source TEXT)");
  const env = { PRICE_KV: fakeKV(), PRICE_DB: db };
  await tick(env, PRICE_CRON);
  assert.equal(env.PRICE_KV.json("prl_state").price.price, 0.92);
  assert.equal(db.rows("prl_price").length, 1);
  assert.ok(!db.statements.some((s) => s.includes("prl_difficulty")));
});

test("?diff=1 reports the history write; a missing D1 binding is tolerated", async () => {
  const env = { PRICE_KV: fakeKV(), PRICE_DB: fakeD1() };
  let res = await worker.fetch(new Request("https://cron.example/?diff=1"), env);
  let body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.history, "table created, row stored");
  res = await worker.fetch(new Request("https://cron.example/?diff=1"), env);
  assert.equal((await res.json()).history, "row stored");

  const noDb = { PRICE_KV: fakeKV() };
  res = await worker.fetch(new Request("https://cron.example/?diff=1"), noDb);
  body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.mult, 1.18);
  assert.equal(body.history, "no PRICE_DB binding");
  assert.equal(noDb.PRICE_KV.json("prl_state").diff.mult, 1.18, "KV still updated");
});

test("a failing D1 insert never breaks the difficulty update", async () => {
  const env = { PRICE_KV: fakeKV(), PRICE_DB: fakeD1({ failWith: "D1_ERROR: overloaded" }) };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const res = await worker.fetch(new Request("https://cron.example/?diff=1"), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.history, "failed");
    assert.equal(env.PRICE_KV.json("prl_state").diff.difficulty, 21_355_740);
    assert.ok(errors.some((e) => /history write failed/.test(e)));
  } finally {
    console.error = orig;
  }
});
