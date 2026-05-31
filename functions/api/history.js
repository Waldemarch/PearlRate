// Cloudflare Pages Function — endpoint /api/history
//
//   GET /api/history?range=24h|7d|30d|all
//
// Returns downsampled PRL price history from D1 for charting:
//   {"range":"7d","points":[{"t":<ms>,"p":<price>}, ...]}
//
// Binding: D1 database PRICE_DB -> "pearlrate-history" (see wrangler.toml).

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const NO_STORE = { ...JSON_HEADERS, "Cache-Control": "no-store" };

const RANGES = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

const TARGET_POINTS = 300; // cap returned points; bucket-average the rest

export async function onRequestGet({ request, env }) {
  if (!env.PRICE_DB) {
    return new Response(JSON.stringify({ error: "history not configured" }), {
      status: 503,
      headers: NO_STORE,
    });
  }

  const url = new URL(request.url);
  const range = RANGES.hasOwnProperty(url.searchParams.get("range"))
    ? url.searchParams.get("range")
    : "7d";
  const span = RANGES[range];
  const since = span == null ? 0 : Date.now() - span;

  // Bucket width so we return roughly TARGET_POINTS averaged samples.
  // For "all", base the bucket on the actual data span.
  let bucket;
  if (span == null) {
    const row = await env.PRICE_DB
      .prepare("SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM prl_price")
      .first();
    const dataSpan = row && row.hi ? Math.max(1, row.hi - row.lo) : 1;
    bucket = Math.max(60 * 1000, Math.floor(dataSpan / TARGET_POINTS));
  } else {
    bucket = Math.max(60 * 1000, Math.floor(span / TARGET_POINTS));
  }

  const { results } = await env.PRICE_DB
    .prepare(
      `SELECT (ts / ?1) * ?1 AS t, AVG(price) AS p
         FROM prl_price
        WHERE ts >= ?2
        GROUP BY ts / ?1
        ORDER BY t ASC`
    )
    .bind(bucket, since)
    .all();

  const points = (results || []).map((r) => ({ t: r.t, p: r.p }));
  return new Response(JSON.stringify({ range, points }), { headers: NO_STORE });
}
