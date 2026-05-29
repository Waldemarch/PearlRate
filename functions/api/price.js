// Cloudflare Pages Function — endpoint /api/price
//
//   GET  /api/price  -> returns the last stored PRL price as JSON
//   POST /api/price  -> stores a new price (requires a bearer token)
//
// Bindings (configure on the Pages project, see AUTOMATION.md):
//   KV namespace binding:  PRICE_KV     -> namespace "pearlrate-price"
//   Secret / env var:      PRICE_TOKEN  -> shared secret used by the updater
//
// Stored record shape: {"price":1.45,"ts":1716998400000,"source":"safetrade:prlusdt"}

const KEY = "prl_price";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const NO_STORE = { ...JSON_HEADERS, "Cache-Control": "no-store" };

export async function onRequestGet({ env }) {
  const raw = await env.PRICE_KV.get(KEY);
  if (!raw) {
    return new Response(JSON.stringify({ price: null }), { status: 404, headers: NO_STORE });
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

  const price = Number(body && body.price);
  if (!isFinite(price) || price <= 0 || price > 1e6) {
    return new Response(JSON.stringify({ error: "invalid price" }), { status: 400, headers: JSON_HEADERS });
  }

  const record = {
    price,
    ts: Date.now(),
    source: body && body.source ? String(body.source).slice(0, 64) : "unknown",
  };

  // Latest price -> KV (fast single read for the page).
  await env.PRICE_KV.put(KEY, JSON.stringify(record));

  // Full history -> D1 (for the chart). Guarded so the endpoint still works
  // before the D1 binding is configured.
  if (env.PRICE_DB) {
    try {
      await env.PRICE_DB
        .prepare("INSERT INTO prl_price (ts, price, source) VALUES (?, ?, ?)")
        .bind(record.ts, record.price, record.source)
        .run();
    } catch (e) {
      // don't fail the request if the history write hiccups
    }
  }

  return new Response(JSON.stringify(record), { headers: JSON_HEADERS });
}
