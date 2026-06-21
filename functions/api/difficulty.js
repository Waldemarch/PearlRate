// Cloudflare Pages Function — endpoint /api/difficulty
//
//   GET  /api/difficulty  -> returns the last stored difficulty multiplier as JSON
//   POST /api/difficulty  -> stores a new multiplier (requires a bearer token)
//
// The "difficulty ×" on the page is relative to the current baseline difficulty
// (18,098,085, the ×1.00 point the table yields are stated at):
//   mult = current network difficulty / baseline difficulty
// Because block time is ~constant, difficulty tracks hashrate, so this is the
// same "2× hashrate -> half yield" factor the calculator divides yields by.
//
// Bindings (configure on the Pages project, see AUTOMATION.md):
//   KV namespace binding:  PRICE_KV     -> namespace "pearlrate-price" (reused)
//   Secret / env var:      PRICE_TOKEN  -> shared secret used by the updater (reused)
//
// Stored record shape:
//   {"mult":1.00,"difficulty":18098085,"baseline":18098085,"ts":1750118400000,"source":"alphapool:miningcore"}

// Price + difficulty share one combined KV key (prl_state = {price, diff}).
// KEY is the legacy standalone key, still read as a fallback.
const STATE_KEY = "prl_state";
const KEY = "prl_diff";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const NO_STORE = { ...JSON_HEADERS, "Cache-Control": "no-store" };

export async function onRequestGet({ env }) {
  const rawState = await env.PRICE_KV.get(STATE_KEY);
  if (rawState) {
    try {
      const record = JSON.parse(rawState).diff;
      if (record) return new Response(JSON.stringify(record), { headers: NO_STORE });
    } catch {
      // fall through to the legacy key
    }
  }
  const raw = await env.PRICE_KV.get(KEY);
  if (!raw) {
    return new Response(JSON.stringify({ mult: null }), { status: 404, headers: NO_STORE });
  }
  return new Response(raw, { headers: NO_STORE });
}

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.PRICE_TOKEN || token !== env.PRICE_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: JSON_HEADERS });
  }

  // The updater computes the multiplier (it owns the baseline). It may also
  // send the raw difficulty + baseline for transparency, but mult is required.
  const mult = Number(body && body.mult);
  if (!isFinite(mult) || mult <= 0 || mult > 100) {
    return new Response(JSON.stringify({ error: "invalid mult" }), { status: 400, headers: JSON_HEADERS });
  }

  const record = {
    mult,
    ts: Date.now(),
    source: body && body.source ? String(body.source).slice(0, 64) : "unknown",
  };
  const difficulty = Number(body && body.difficulty);
  if (isFinite(difficulty) && difficulty > 0) record.difficulty = difficulty;
  const baseline = Number(body && body.baseline);
  if (isFinite(baseline) && baseline > 0) record.baseline = baseline;

  // Merge into the combined key so we keep the price half.
  let state = {};
  try {
    const raw = await env.PRICE_KV.get(STATE_KEY);
    if (raw) state = JSON.parse(raw) || {};
  } catch {
    state = {};
  }
  state.diff = record;
  await env.PRICE_KV.put(STATE_KEY, JSON.stringify(state));

  return new Response(JSON.stringify(record), { headers: JSON_HEADERS });
}
