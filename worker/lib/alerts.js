// Telegram alerts for the PearlRate cron Worker.
//
// Owner-only by construction: rules come from a Worker secret/var
// (ALERT_RULES) or a KV key the owner writes with wrangler (alert_rules).
// No HTTP endpoint can create or change them. Disabled unless both
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
//
// Evaluated after each price tick (every 5 min) and difficulty tick (hourly).
// A message goes out only when a rule changes state (ok -> alert, alert -> ok),
// with a per-rule cooldown on alerts and a hysteresis margin on recovery, and
// the rule state lives in one KV key written only on those transitions — the
// free KV plan's 1,000 writes/day are shared with the price updater.
//
// Rule format and examples: AUTOMATION.md -> "Telegram alerts".

import { CARDS, econ, cardById } from "./calc.js";

export const RULES_KV_KEY = "alert_rules";
export const STATE_KV_KEY = "alert_state";
export const DEFAULT_COOLDOWN_H = 6;
export const DEFAULT_MARGIN = 0.02;            // 2 % of the threshold's scale
export const PRICE_MAX_AGE_MS = 3 * 3600e3;    // don't judge on a stale price...
export const DIFF_MAX_AGE_MS = 30 * 3600e3;    // ...or a stale difficulty (6 h heartbeat)

// type -> direction of the alert condition
const TYPES = {
  price_below: "below",
  price_above: "above",
  difficulty_above: "above",
  fleet_net_below: "below",
  breakeven_rent_below: "below",
};

export const alertsEnabled = (env) => !!(env && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// A GPU in a rule: a built-in id ("5090") or {name, power, yield}.
function gpuSpec(g, yields) {
  if (typeof g === "string" || typeof g === "number") {
    const c = cardById(g);
    if (!c) return null;
    const y = yields ? num(yields[c.id]) : undefined;
    return { name: c.name, power: c.power, yield: y !== undefined && y >= 0 ? y : c.yield };
  }
  if (g && typeof g === "object" && num(g.power) > 0 && num(g.yield) >= 0) {
    return { name: String(g.name || "custom GPU").slice(0, 40), power: g.power, yield: g.yield };
  }
  return null;
}

// Validate the owner's rules. Accepts a JSON string, an array, or {rules:[...]}.
// Invalid rules are skipped and reported, never fatal.
export function parseRules(raw) {
  const errors = [];
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch (e) { return { rules: [], errors: ["ALERT_RULES is not valid JSON: " + e.message] }; }
  }
  if (list && !Array.isArray(list) && Array.isArray(list.rules)) list = list.rules;
  if (!Array.isArray(list)) return { rules: [], errors: list == null ? [] : ["rules must be a JSON array"] };
  const rules = [], seen = new Set();
  list.forEach((r, i) => {
    const where = `rule #${i + 1}${r && r.id ? ` (${r.id})` : ""}`;
    if (!r || typeof r !== "object") return errors.push(`${where}: not an object`);
    const id = String(r.id || "");
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) return errors.push(`${where}: id must be 1-40 chars of A-Z a-z 0-9 _ . -`);
    if (seen.has(id)) return errors.push(`${where}: duplicate id`);
    if (!TYPES[r.type]) return errors.push(`${where}: unknown type "${r.type}" (use ${Object.keys(TYPES).join(", ")})`);
    const rule = {
      id, type: r.type, dir: TYPES[r.type],
      label: r.label ? String(r.label).slice(0, 80) : "",
      enabled: r.enabled !== false,
      cooldownMs: (num(r.cooldown_h) !== undefined && r.cooldown_h >= 0 ? r.cooldown_h : DEFAULT_COOLDOWN_H) * 3600e3,
      margin: num(r.margin) !== undefined && r.margin >= 0 ? r.margin : null,
      threshold: num(r.threshold),
    };
    if (r.type === "fleet_net_below") {
      if (rule.threshold === undefined) rule.threshold = 0;
      rule.elec = num(r.elec) !== undefined && r.elec >= 0 ? r.elec : 0.1;
      rule.fee = num(r.fee) !== undefined ? r.fee : 4;
      const items = [];
      const fleet = r.fleet && typeof r.fleet === "object" ? r.fleet : {};
      for (const [gid, qty] of Object.entries(fleet)) {
        const spec = gpuSpec(gid, r.yields);
        if (!spec) { errors.push(`${where}: unknown GPU id "${gid}" (use ${CARDS.map((c) => c.id).join(", ")}; list other GPUs under "custom")`); continue; }
        if (num(qty) > 0) items.push({ ...spec, qty: Math.round(qty) });
      }
      for (const g of Array.isArray(r.custom) ? r.custom : []) {
        const spec = gpuSpec(g);
        if (spec && num(g.qty) > 0) items.push({ ...spec, qty: Math.round(g.qty) });
        else errors.push(`${where}: custom GPUs need name, power, yield and qty`);
      }
      if (!items.length) return errors.push(`${where}: fleet is empty`);
      rule.items = items;
    } else if (r.type === "breakeven_rent_below") {
      rule.fee = num(r.fee) !== undefined ? r.fee : 4;
      rule.gpu = gpuSpec(r.gpu, r.yield !== undefined ? { [String(r.gpu)]: r.yield } : null);
      if (!rule.gpu) return errors.push(`${where}: gpu must be a card id (${CARDS.map((c) => c.id).join(", ")}) or {name, power, yield}`);
      if (!(rule.threshold > 0)) return errors.push(`${where}: threshold must be your rental rate in $/h (> 0)`);
    } else if (rule.threshold === undefined || rule.threshold <= 0) {
      return errors.push(`${where}: threshold must be a number > 0`);
    }
    seen.add(id);
    rule.sig = signature(r);
    rules.push(rule);
  });
  return { rules, errors };
}

// Stable fingerprint of a rule's definition: editing a rule resets its state.
function signature(r) {
  const canon = (v) => (v && typeof v === "object"
    ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])))
    : v);
  const s = JSON.stringify(canon(r));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const money = (v, dp = 2) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(dp);
const rate = (v) => money(v, v >= 10 ? 2 : 3) + "/h";
const usdP = (v) => "$" + v.toFixed(v >= 1 ? 2 : 4);

// Current value of a rule's measure, its scale (for the default margin) and how to say it.
export function evaluateRule(rule, m) {
  const { price: P, mult: D } = m;
  let value, scale, what, unit;
  switch (rule.type) {
    case "price_below":
    case "price_above":
      value = P; scale = rule.threshold; what = "PRL price"; unit = usdP; break;
    case "difficulty_above":
      value = D; scale = rule.threshold; what = "Network difficulty"; unit = (v) => "×" + v.toFixed(2); break;
    case "fleet_net_below": {
      let net = 0, gross = 0, gpus = 0;
      for (const it of rule.items) {
        const r = econ(it.yield, it.power, P, D, rule.fee, rule.elec);
        net += r.net * it.qty; gross += r.grossDay * it.qty; gpus += it.qty;
      }
      value = net; scale = Math.max(Math.abs(rule.threshold), gross);
      what = `Fleet self-mine net (${gpus} GPU${gpus > 1 ? "s" : ""}, $${rule.elec}/kWh, pool ${rule.fee}%)`;
      unit = (v) => money(v) + "/day";
      break;
    }
    case "breakeven_rent_below":
      value = econ(rule.gpu.yield, rule.gpu.power, P, D, rule.fee, 0).be; scale = rule.threshold;
      what = `${rule.gpu.name} break-even rent`; unit = rate; break;
    default:
      throw new Error("unknown rule type " + rule.type);
  }
  const margin = rule.margin != null ? rule.margin : DEFAULT_MARGIN * Math.abs(scale);
  const breach = rule.dir === "below" ? value < rule.threshold : value > rule.threshold;
  const cleared = rule.dir === "below" ? value >= rule.threshold + margin : value <= rule.threshold - margin;
  return { value, breach, cleared, margin, what, unit };
}

function message(rule, ev, m, kind) {
  const head = kind === "alert" ? "PearlRate alert" : "PearlRate recovered";
  const name = rule.label || rule.id;
  let line;
  if (rule.type === "breakeven_rent_below") {
    line = kind === "alert"
      ? `${ev.what} is ${ev.unit(ev.value)}, below your ${rate(rule.threshold)} rate: a PRL miner can't profit renting at your price.`
      : `${ev.what} is back to ${ev.unit(ev.value)}, at or above your ${rate(rule.threshold)} rate.`;
  } else {
    const rel = rule.dir === "below" ? (kind === "alert" ? "below" : "back above") : (kind === "alert" ? "above" : "back below");
    line = `${ev.what} is ${ev.unit(ev.value)}, ${rel} ${ev.unit(rule.threshold)}.`;
  }
  return `${head} · ${name}\n${line}\nPRL ${usdP(m.price)} · difficulty ×${m.mult.toFixed(2)}`;
}

export async function sendTelegram(env, text, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (res.ok) return true;
    // Never log the request URL: it carries the bot token.
    console.error("telegram sendMessage failed: HTTP", res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    console.error("telegram sendMessage failed:", (e && e.name) || "error");
  }
  return false;
}

// The owner's rules: ALERT_RULES (secret or var) wins; otherwise the KV key.
export async function loadRules(env) {
  if (env.ALERT_RULES) return parseRules(env.ALERT_RULES);
  const raw = await env.PRICE_KV.get(RULES_KV_KEY);
  return raw ? parseRules(raw) : { rules: [], errors: [] };
}

async function readState(env) {
  try {
    const raw = await env.PRICE_KV.get(STATE_KV_KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (s && typeof s === "object" && s.rules && typeof s.rules === "object") return s;
  } catch {
    // corrupt state: start clean
  }
  return { v: 1, rules: {} };
}

// Market snapshot from the combined KV state ({price:{price,ts}, diff:{mult,ts}}).
export function marketFrom(state) {
  const p = state && state.price, d = state && state.diff;
  return {
    price: p ? Number(p.price) : NaN, priceTs: p ? Number(p.ts) : NaN,
    mult: d ? Number(d.mult) : NaN, diffTs: d ? Number(d.ts) : NaN,
  };
}

// Evaluate every rule against the market and notify on state transitions.
// Writes the alert state to KV once, and only if something changed.
export async function runAlerts(env, market, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  if (!alertsEnabled(env)) return { enabled: false };
  const { rules, errors } = await loadRules(env);
  errors.forEach((e) => console.error("alert rules:", e));
  if (!rules.length) return { enabled: true, rules: 0, errors };
  if (!(market.price > 0) || !(market.mult > 0)) return { enabled: true, rules: rules.length, errors, skipped: "no market data" };
  if (now - market.priceTs > PRICE_MAX_AGE_MS || now - market.diffTs > DIFF_MAX_AGE_MS) {
    return { enabled: true, rules: rules.length, errors, skipped: "market data is stale" };
  }
  const state = await readState(env);
  let dirty = false;
  const results = [];
  const known = new Set(rules.map((r) => r.id));
  for (const id of Object.keys(state.rules)) if (!known.has(id)) { delete state.rules[id]; dirty = true; }

  for (const rule of rules) {
    let st = state.rules[rule.id];
    if (st && st.sig !== rule.sig) { delete state.rules[rule.id]; st = null; dirty = true; }
    st = st || { sig: rule.sig, on: false, at: 0, sent: 0, n: false };
    if (!rule.enabled) { results.push({ id: rule.id, disabled: true }); continue; }
    const ev = evaluateRule(rule, market);
    const on = st.on ? !ev.cleared : ev.breach;
    const r = { id: rule.id, value: ev.value, threshold: rule.threshold, on, was: st.on };
    results.push(r);
    if (on === st.on) continue;

    if (on) {
      const coolingDown = st.sent && now - st.sent < rule.cooldownMs;
      if (!coolingDown) {
        if (!(await sendTelegram(env, message(rule, ev, market, "alert"), fetchImpl))) { r.error = "telegram failed, will retry"; r.on = st.on; continue; }
        r.notified = true;
      } else r.suppressed = "cooldown";
      state.rules[rule.id] = { sig: rule.sig, on: true, at: now, sent: r.notified ? now : st.sent || 0, n: !!r.notified };
    } else {
      // Recovery is announced only if its alert was.
      if (st.n) {
        if (!(await sendTelegram(env, message(rule, ev, market, "recovered"), fetchImpl))) { r.error = "telegram failed, will retry"; r.on = st.on; continue; }
        r.notified = true;
      }
      state.rules[rule.id] = { sig: rule.sig, on: false, at: now, sent: st.sent || 0, n: false };
    }
    dirty = true;
  }
  if (dirty) await env.PRICE_KV.put(STATE_KV_KEY, JSON.stringify(state));
  return { enabled: true, rules: rules.length, errors, results, wrote: dirty };
}

// Dry run for the token-guarded test trigger: evaluates everything, changes
// nothing, and (unless send=false) sends one "alerts are wired up" message.
export async function testAlerts(env, market, { send = true, fetchImpl = globalThis.fetch } = {}) {
  if (!alertsEnabled(env)) return { enabled: false, reason: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set" };
  const { rules, errors } = await loadRules(env);
  const state = await readState(env);
  const ok = market.price > 0 && market.mult > 0;
  const report = rules.map((rule) => {
    const st = state.rules[rule.id];
    const active = !!(st && st.sig === rule.sig && st.on);
    if (!ok) return { id: rule.id, type: rule.type, active };
    const ev = evaluateRule(rule, market);
    return { id: rule.id, type: rule.type, enabled: rule.enabled, value: ev.value, threshold: rule.threshold, active,
             wouldBeActive: active ? !ev.cleared : ev.breach, text: `${ev.what}: ${ev.unit(ev.value)} (threshold ${ev.unit(rule.threshold)})` };
  });
  let sent = false;
  if (send) {
    const lines = report.map((r) => `• ${r.id}: ${r.text || "no market data"}${r.wouldBeActive ? " — ALERT" : ""}`);
    sent = await sendTelegram(env, [`PearlRate test · alerts are wired up (${rules.length} rule${rules.length === 1 ? "" : "s"})`]
      .concat(lines, errors.length ? [`${errors.length} rule error(s) — see the test response`] : []).join("\n"), fetchImpl);
  }
  return { enabled: true, sent, market: ok ? { price: market.price, mult: market.mult } : null, rules: report, errors };
}
