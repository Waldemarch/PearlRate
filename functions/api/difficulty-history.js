// Cloudflare Pages Function — endpoint /api/difficulty-history
//
//   GET /api/difficulty-history?range=30d|90d|all     (default 90d)
//
// Network-difficulty history recorded by the cron Worker (one D1 row per
// hourly tick), as daily medians plus the measured monthly growth:
//   {"range":"90d","first":<ms of oldest reading>|null,"count":<readings>,
//    "points":[{"t":<UTC day start ms>,"d":<median difficulty>,"n":<readings>}, ...],
//    "growth":{"monthly":0.043,"days":41,"n":41,"r2":0.97,...} | null}
// growth is a log-linear fit over the range and stays null until there are at
// least 7 days of data. A missing table reads as an empty history.
//
// Binding: D1 database PRICE_DB -> "pearlrate-history" (see wrangler.toml).

import { RANGES, DAY_MS, readDailyMedians, historyPayload } from "../../worker/lib/difficulty-history.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export async function onRequestGet({ request, env }) {
  if (!env.PRICE_DB) {
    return new Response(JSON.stringify({ error: "history not configured" }), {
      status: 503,
      headers: { ...JSON_HEADERS, "Cache-Control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const asked = url.searchParams.get("range");
  const range = Object.prototype.hasOwnProperty.call(RANGES, asked) ? asked : "90d";
  const span = RANGES[range];
  const since = span == null ? 0 : Date.now() - span * DAY_MS;
  try {
    const history = await readDailyMedians(env.PRICE_DB, { since });
    return new Response(JSON.stringify(historyPayload(history, range)), {
      // New readings land hourly, so a few minutes of caching costs nothing.
      headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "history read failed" }), {
      status: 500,
      headers: { ...JSON_HEADERS, "Cache-Control": "no-store" },
    });
  }
}
