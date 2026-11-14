// Unit tests: Telegram alert rules, state transitions, cooldown, hysteresis,
// KV write budget, and the Worker wiring (scheduled ticks + token-guarded test).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseRules, runAlerts, evaluateRule, STATE_KV_KEY, RULES_KV_KEY } from "../lib/alerts.js";
import { CARDS, econ, fleetEcon, cardById } from "../lib/calc.js";
import worker from "../price-cron.js";
import { fakeKV, fakeD1, fakeCtx, stubFetch } from "./fakes.js";

const NOW = Date.UTC(2026, 10, 14, 12);
const MIN = 60e3, HOUR = 3600e3;
const market = (price, mult = 1.18, at = NOW) => ({ price, priceTs: at - MIN, mult, diffTs: at - HOUR });

function telegram({ fail = false } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, ...JSON.parse(init.body) });
    return fail ? new Response('{"ok":false}', { status: 500 }) : new Response('{"ok":true}', { status: 200 });
  };
  return { sent, fetchImpl };
}
const envWith = (rules, extra = {}) => ({
  TELEGRAM_BOT_TOKEN: "123:secret-token", TELEGRAM_CHAT_ID: "42",
  ALERT_RULES: rules == null ? undefined : JSON.stringify(rules), PRICE_KV: fakeKV(), ...extra,
});

test("disabled cleanly without both Telegram secrets: no KV, no network", async () => {
  for (const env of [{ PRICE_KV: fakeKV() }, { PRICE_KV: fakeKV(), TELEGRAM_BOT_TOKEN: "x" }, { PRICE_KV: fakeKV(), TELEGRAM_CHAT_ID: "1" }]) {
    const tg = telegram();
    const r = await runAlerts({ ...env, ALERT_RULES: '[{"id":"p","type":"price_below","threshold":5}]' }, market(1), { now: NOW, fetchImpl: tg.fetchImpl });
    assert.deepEqual(r, { enabled: false });
    assert.equal(env.PRICE_KV.reads + env.PRICE_KV.puts, 0);
    assert.equal(tg.sent.length, 0);
  }
});

test("parseRules validates and reports, never throws", () => {
  assert.match(parseRules("{nope").errors[0], /not valid JSON/);
  const { rules, errors } = parseRules({
    rules: [
      { id: "ok", type: "price_below", threshold: 0.5 },
      { id: "ok", type: "price_above", threshold: 2 },
      { id: "bad id!", type: "price_below", threshold: 1 },
      { id: "t", type: "moon", threshold: 1 },
      { id: "z", type: "price_below" },
      { id: "fleet", type: "fleet_net_below", fleet: { 9999: 2 } },
      { id: "rent", type: "breakeven_rent_below", gpu: "5090" },
      { id: "rent2", type: "breakeven_rent_below", gpu: "nope", threshold: 0.3 },
    ],
  });
  assert.deepEqual(rules.map((r) => r.id), ["ok"]);
  assert.equal(errors.length, 8);                    // the bad fleet reports its GPU and that it's empty
  assert.ok(errors.some((e) => /duplicate id/.test(e)));
  assert.ok(errors.some((e) => /unknown type "moon"/.test(e)));
  assert.ok(errors.some((e) => /unknown GPU id "9999"/.test(e)));
  assert.ok(errors.some((e) => /your rental rate/.test(e)));
  assert.deepEqual(parseRules(undefined), { rules: [], errors: [] });
});

test("price_below: alert on the transition, silence while it holds, recovery past the margin", async () => {
  const env = envWith([{ id: "price-low", type: "price_below", threshold: 0.5 }]);
  const tg = telegram();
  const run = (p) => runAlerts(env, market(p), { now: NOW, fetchImpl: tg.fetchImpl });

  await run(0.6);
  assert.equal(tg.sent.length, 0);
  assert.equal(env.PRICE_KV.puts, 0, "no state write while nothing happens");

  const a = await run(0.48);
  assert.equal(a.results[0].notified, true);
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].chat_id, "42");
  assert.ok(tg.sent[0].url.startsWith("https://api.telegram.org/bot123:secret-token/sendMessage"));
  assert.equal(tg.sent[0].text, "PearlRate alert · price-low\nPRL price is $0.4800, below $0.5000.\nPRL $0.4800 · difficulty ×1.18");
  assert.equal(env.PRICE_KV.puts, 1);

  await run(0.47);
  await run(0.505);                                   // inside the 2 % hysteresis margin: still alerting
  assert.equal(tg.sent.length, 1);
  assert.equal(env.PRICE_KV.puts, 1);

  await run(0.52);
  assert.equal(tg.sent.length, 2);
  assert.equal(tg.sent[1].text.split("\n")[0], "PearlRate recovered · price-low");
  assert.match(tg.sent[1].text, /back above \$0\.5000/);
  assert.equal(env.PRICE_KV.puts, 2, "exactly one KV write per transition");
  assert.equal(env.PRICE_KV.json(STATE_KV_KEY).rules["price-low"].on, false);
});

test("cooldown: a flapping rule records state but doesn't re-alert; its recovery stays quiet", async () => {
  const env = envWith([{ id: "p", type: "price_above", threshold: 2, cooldown_h: 6, margin: 0 }]);
  const tg = telegram();
  const at = (p, t) => runAlerts(env, market(p, 1.18, t), { now: t, fetchImpl: tg.fetchImpl });
  await at(2.1, NOW);                                 // alert
  await at(1.9, NOW + 10 * MIN);                      // recovery (announced: its alert was)
  const again = await at(2.2, NOW + 20 * MIN);        // within 6 h: suppressed
  assert.equal(again.results[0].suppressed, "cooldown");
  await at(1.8, NOW + 30 * MIN);                      // recovery of a silent alert: silent
  assert.deepEqual(tg.sent.map((m) => m.text.split(" · ")[0]), ["PearlRate alert", "PearlRate recovered"]);
  await at(2.3, NOW + 7 * HOUR);                      // cooldown over
  assert.equal(tg.sent.length, 3);
  assert.equal(env.PRICE_KV.puts, 5, "every transition is one write, nothing else");
});

test("a failed Telegram send changes nothing and is retried on the next tick", async () => {
  const env = envWith([{ id: "p", type: "price_below", threshold: 1 }]);
  const down = telegram({ fail: true });
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const r = await runAlerts(env, market(0.5), { now: NOW, fetchImpl: down.fetchImpl });
    assert.match(r.results[0].error, /retry/);
  } finally { console.error = orig; }
  assert.equal(env.PRICE_KV.puts, 0);
  assert.ok(errs.length && errs.every((e) => !e.includes("secret-token")), "the bot token is never logged");
  const up = telegram();
  await runAlerts(env, market(0.5), { now: NOW + 5 * MIN, fetchImpl: up.fetchImpl });
  assert.equal(up.sent.length, 1);
  assert.equal(env.PRICE_KV.puts, 1);
});

test("fleet_net_below uses the same maths as the dashboard (custom GPUs and yield overrides too)", async () => {
  const rule = { id: "fleet-loss", type: "fleet_net_below", fleet: { 5090: 4, 3090: 6, 3060: 2 }, elec: 0.1, fee: 4,
                 yields: { 3090: 1.7 }, custom: [{ name: "A6000", power: 300, yield: 1.2, qty: 2 }] };
  const [parsed] = parseRules([rule]).rules;
  const items = [{ ...cardById("5090"), qty: 4 }, { ...cardById("3090"), yield: 1.7, qty: 6 }, { ...cardById("3060"), qty: 2 }, { power: 300, yield: 1.2, qty: 2 }];
  for (const [P, D] of [[0.92, 1.18], [0.2, 1.18], [1.45, 3]]) {
    const want = fleetEcon(items, P, D, 4, 0.1).net;   // same terms; JS orders integer-like keys, so allow float noise
    assert.ok(Math.abs(evaluateRule(parsed, market(P, D)).value - want) < 1e-9);
  }
  const env = envWith([rule]);
  const tg = telegram();
  await runAlerts(env, market(0.92), { now: NOW, fetchImpl: tg.fetchImpl });
  assert.equal(tg.sent.length, 0);
  await runAlerts(env, market(0.2), { now: NOW, fetchImpl: tg.fetchImpl });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /^PearlRate alert · fleet-loss\nFleet self-mine net \(14 GPUs, \$0\.1\/kWh, pool 4%\) is −\$\d+\.\d\d\/day, below \$0\.00\/day\./);
});

test("breakeven_rent_below: the RTX 5090 ceiling vs your rate", async () => {
  const env = envWith([{ id: "rent-5090", label: "5090 rate check", type: "breakeven_rent_below", gpu: "5090", threshold: 0.35 }]);
  const tg = telegram();
  await runAlerts(env, market(0.92), { now: NOW, fetchImpl: tg.fetchImpl });
  const be = econ(4.58, 510, 0.92, 1.18, 4, 0.1).be;
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].text.split("\n")[1],
    `RTX 5090 break-even rent is $${be.toFixed(3)}/h, below your $0.350/h rate: a PRL miner can't profit renting at your price.`);
  assert.match(tg.sent[0].text, /^PearlRate alert · 5090 rate check/);
  await runAlerts(env, market(3), { now: NOW + HOUR, fetchImpl: tg.fetchImpl });   // ceiling now above the rate
  assert.equal(tg.sent.length, 2);
  assert.match(tg.sent[1].text, /back to \$0\.\d+\/h, at or above your \$0\.350\/h rate/);
});

test("difficulty_above, disabled rules, rule edits and removals", async () => {
  const rules = [{ id: "diff", type: "difficulty_above", threshold: 1.5 }, { id: "off", type: "price_below", threshold: 9, enabled: false }];
  const env = envWith(rules);
  const tg = telegram();
  await runAlerts(env, market(1, 1.6), { now: NOW, fetchImpl: tg.fetchImpl });
  assert.equal(tg.sent.length, 1, "disabled rule never fires");
  assert.match(tg.sent[0].text, /Network difficulty is ×1\.60, above ×1\.50/);
  // Editing a rule resets its state (it may alert again under the new definition).
  env.ALERT_RULES = JSON.stringify([{ id: "diff", type: "difficulty_above", threshold: 1.55 }]);
  const r = await runAlerts(env, market(1, 1.6), { now: NOW + MIN, fetchImpl: tg.fetchImpl });
  assert.equal(r.results[0].notified, true, "a new definition starts from a clean state, so it alerts again");
  assert.equal(tg.sent.length, 2);
  assert.deepEqual(Object.keys(env.PRICE_KV.json(STATE_KV_KEY).rules), ["diff"], "removed rule's state dropped");
});

test("stale or missing market data never flips a rule", async () => {
  const env = envWith([{ id: "p", type: "price_below", threshold: 5 }]);
  const tg = telegram();
  const stale = { ...market(1), priceTs: NOW - 4 * HOUR };
  assert.equal((await runAlerts(env, stale, { now: NOW, fetchImpl: tg.fetchImpl })).skipped, "market data is stale");
  assert.equal((await runAlerts(env, { price: NaN, mult: 1 }, { now: NOW, fetchImpl: tg.fetchImpl })).skipped, "no market data");
  assert.equal(tg.sent.length + env.PRICE_KV.puts, 0);
});

test("rules can live in KV instead of a secret", async () => {
  const kv = fakeKV({ [RULES_KV_KEY]: JSON.stringify([{ id: "p", type: "price_below", threshold: 5 }]) });
  const env = envWith(null, { PRICE_KV: kv });
  const tg = telegram();
  const r = await runAlerts(env, market(1), { now: NOW, fetchImpl: tg.fetchImpl });
  assert.equal(r.rules, 1);
  assert.equal(tg.sent.length, 1);
});

// ---- the Worker itself ----
let net;
const DEX = ["https://api.dexscreener.com/", () => ({ pairs: [{ chainId: "ethereum", priceUsd: "0.42", liquidity: { usd: 1e6 } }] })];
const POOL = ["https://pearl.alphapool.tech/api/pools", () => ({ pools: [{ networkStats: { networkDifficulty: 21_355_740 } }] })];
const TG = ["https://api.telegram.org/", () => ({ ok: true })];
beforeEach(() => { net = stubFetch([DEX, POOL, TG]); });
afterEach(() => net.restore());
const tgCalls = () => net.calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));

test("Worker: a price tick evaluates the rules on the fresh price", async () => {
  const kv = fakeKV({ prl_state: JSON.stringify({ diff: { mult: 1.18, ts: Date.now() - HOUR } }) });
  const env = { ...envWith([{ id: "p", type: "price_below", threshold: 0.5 }]), PRICE_KV: kv };
  const ctx = fakeCtx();
  await worker.scheduled({ cron: "*/5 * * * *" }, env, ctx);
  await ctx.done();
  assert.equal(kv.json("prl_state").price.price, 0.42);
  assert.equal(tgCalls().length, 1);
  assert.match(JSON.parse(tgCalls()[0].init.body).text, /PRL price is \$0\.4200, below \$0\.5000/);
});

test("Worker: the hourly difficulty tick checks alerts too; nothing alert-related without secrets", async () => {
  const kv = fakeKV({ prl_state: JSON.stringify({ price: { price: 0.42, ts: Date.now() - MIN } }) });
  const env = { ...envWith([{ id: "d", type: "difficulty_above", threshold: 1.1 }]), PRICE_KV: kv, PRICE_DB: fakeD1() };
  let ctx = fakeCtx();
  await worker.scheduled({ cron: "7 * * * *" }, env, ctx);
  await ctx.done();
  assert.equal(tgCalls().length, 1);

  const quiet = fakeKV({ prl_state: JSON.stringify({ diff: { mult: 1.18, ts: Date.now() } }) });
  ctx = fakeCtx();
  await worker.scheduled({ cron: "*/5 * * * *" }, { PRICE_KV: quiet, ALERT_RULES: '[{"id":"p","type":"price_below","threshold":5}]' }, ctx);
  await ctx.done();
  assert.equal(tgCalls().length, 1, "no Telegram call without the secrets");
  assert.ok(!quiet.map.has(STATE_KV_KEY));
  assert.equal(quiet.reads, 1, "only the price updater's own read");
});

test("Worker: /?alerts=test is guarded by PRICE_TOKEN and changes no state", async () => {
  const kv = fakeKV({ prl_state: JSON.stringify({ price: { price: 0.42, ts: Date.now() }, diff: { mult: 1.18, ts: Date.now() } }) });
  const env = { ...envWith([{ id: "p", type: "price_below", threshold: 0.5 }]), PRICE_KV: kv };
  const call = (token, qs = "") => worker.fetch(new Request("https://cron.example/?alerts=test" + qs,
    token ? { headers: { Authorization: "Bearer " + token } } : {}), env);

  let res = await call("anything");
  assert.equal(res.status, 403, "disabled until the Worker has a PRICE_TOKEN");
  env.PRICE_TOKEN = "s3cret-token-value";
  assert.equal((await call()).status, 401);
  assert.equal((await call("s3cret-token-valuX")).status, 401);
  assert.equal((await call("short")).status, 401);

  res = await call("s3cret-token-value");
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.sent, true);
  assert.equal(body.rules[0].wouldBeActive, true);
  assert.equal(body.market.price, 0.42);
  assert.ok(!JSON.stringify(body).includes("secret-token"), "never echoes the bot token");
  assert.equal(tgCalls().length, 1);
  assert.match(JSON.parse(tgCalls()[0].init.body).text, /^PearlRate test · alerts are wired up \(1 rule\)\n• p: PRL price: \$0\.4200 \(threshold \$0\.5000\) — ALERT$/);
  assert.equal(kv.puts, 0, "a test never writes alert state");

  res = await call("s3cret-token-value", "&send=0");
  assert.equal((await res.json()).sent, false);
  assert.equal(tgCalls().length, 1);

  delete env.TELEGRAM_CHAT_ID;
  assert.equal((await (await call("s3cret-token-value")).json()).enabled, false);
});

test("calc module carries the dashboard's benchmark table", () => {
  assert.equal(CARDS.length, 8);
  assert.deepEqual(CARDS.map((c) => c.id), ["5090", "4090", "5080", "5070ti", "3090", "5070", "4060ti", "3060"]);
});
