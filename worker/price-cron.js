// Cloudflare Worker — scheduled PRL price updater.
//
// Runs on a Cron Trigger (see worker/wrangler.toml, default every 5 min),
// fetches the PRL price from CoinGecko, and writes it to the SAME stores the
// PearlRate Pages Functions read from:
//   - KV  PRICE_KV  key "prl_price"  -> latest price (served by /api/price)
//   - D1  PRICE_DB  table prl_price  -> full history (served by /api/history)
//
// This replaces the Mac-mini updater: no machine to keep awake, no shared
// token (the writes happen inside Cloudflare via bindings, not over HTTP).
//
// Bindings + cron are declared in worker/wrangler.toml. Optional vars:
//   PRL_COINGECKO_ID   CoinGecko coin id (default: wrapped-pearl)
//   COINGECKO_API_KEY  demo key, sent as x-cg-demo-api-key (higher rate limits)

const KV_KEY = "prl_price";
const DEFAULT_COIN_ID = "wrapped-pearl";

async function updatePrice(env) {
  const id = env.PRL_COINGECKO_ID || DEFAULT_COIN_ID;
  const api =
    "https://api.coingecko.com/api/v3/simple/price?ids=" +
    encodeURIComponent(id) +
    "&vs_currencies=usd";

  const headers = { accept: "application/json" };
  if (env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = env.COINGECKO_API_KEY;

  const res = await fetch(api, { headers, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error("coingecko http " + res.status);

  const data = await res.json();
  const price = Number(data && data[id] && data[id].usd);
  if (!isFinite(price) || price <= 0 || price > 1e6) {
    throw new Error("coingecko returned a bad price: " + JSON.stringify(data));
  }

  const record = { price, ts: Date.now(), source: "coingecko:" + id };

  // Latest price -> KV (single fast read for the page).
  await env.PRICE_KV.put(KV_KEY, JSON.stringify(record));

  // Full history -> D1 (for the chart). Don't fail the run if this hiccups.
  if (env.PRICE_DB) {
    try {
      await env.PRICE_DB
        .prepare("INSERT INTO prl_price (ts, price, source) VALUES (?, ?, ?)")
        .bind(record.ts, record.price, record.source)
        .run();
    } catch (e) {
      console.error("D1 history write failed:", e && e.message);
    }
  }

  return record;
}

export default {
  // Cron Trigger entry point.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      updatePrice(env)
        .then((r) => console.log("updated PRL price:", JSON.stringify(r)))
        .catch((e) => console.error("price update failed:", e && e.message))
    );
  },

  // Manual trigger / health check:
  //   GET /        -> liveness text
  //   GET /?run=1  -> fetch + store now, return the record (handy for testing)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("run") === "1") {
      try {
        const record = await updatePrice(env);
        return Response.json(record);
      } catch (e) {
        return Response.json({ error: String((e && e.message) || e) }, { status: 502 });
      }
    }
    return new Response("pearlrate price cron worker — ok\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
