// Cloudflare Worker — scheduled PRL price updater.
//
// Runs on a Cron Trigger (see worker/wrangler.toml, default every 5 min),
// fetches the PRL price, and writes it to the SAME stores the PearlRate Pages
// Functions read from:
//   - KV  PRICE_KV  key "prl_price"  -> latest price (served by /api/price)
//   - D1  PRICE_DB  table prl_price  -> full history (served by /api/history)
//
// This replaces the Mac-mini updater: no machine to keep awake, no shared
// token (the writes happen inside Cloudflare via bindings, not over HTTP).
//
// PRICE SOURCE — IMPORTANT:
//   CoinGecko's public API returns HTTP 403 to Cloudflare Workers egress IPs
//   (it blocks datacenter IPs without an API key). So we prefer sources that
//   *do* accept Worker traffic and fall back in order:
//     1. DexScreener      (no key, by token address — primary)
//     2. GeckoTerminal    (no key, by token address)
//     3. CoinGecko        (only works if COINGECKO_API_KEY is set)
//   All three price the same asset (WPRL on Ethereum/Uniswap, ~the SafeTrade
//   PRL price within a few %). The first source that returns a sane price wins.
//
// Optional vars (set with `wrangler secret put NAME` or in the dashboard):
//   PRL_TOKEN_ADDRESS   ERC-20 address (default WPRL on Ethereum)
//   PRL_DEX_CHAIN       DexScreener chainId filter (default "ethereum")
//   PRL_GT_NETWORK      GeckoTerminal network slug (default "eth")
//   PRL_COINGECKO_ID    CoinGecko coin id (default "wrapped-pearl")
//   COINGECKO_API_KEY   demo key, sent as x-cg-demo-api-key

const KV_KEY = "prl_price";
const DIFF_KV_KEY = "prl_diff";
const DEFAULT_TOKEN = "0x07696dcab55e62cfef953666b29fe1970518cb00"; // WPRL / Ethereum
const DEFAULT_DEX_CHAIN = "ethereum";
const DEFAULT_GT_NETWORK = "eth";
const DEFAULT_COIN_ID = "wrapped-pearl";

// --- network-difficulty sources ---
// Most PRL explorers (prlscan, hashrate.no, kryptex) 403 datacenter IPs, but
// the mining pools' own JSON APIs accept Worker traffic. Shapes differ between
// pools, so we try a list and use the first that yields a sane network
// difficulty. Override the list with DIFFICULTY_URLS (comma-separated);
// DIFFICULTY_URL still works as a single override and is tried first.
const DEFAULT_DIFF_URLS = [
  "https://pearl.alphapool.tech/api/pools",
  "https://pearl.alphapool.tech/api/poolstats",
  "https://pearl.luckypool.io/api/stats",
  "https://pearl.luckypool.io/api/network/stats",
  "https://pearlpool.io/api/stats",
];
// Current network difficulty = the page's ×1.00 baseline (the point the table
// yields are stated at). Confirmed 18,098,085 on 17 Jun 2026. Override with the
// BASELINE_DIFFICULTY var to re-anchor to a newer snapshot.
const DEFAULT_BASELINE_DIFFICULTY = 18098085;

const JSON_HEADERS = { accept: "application/json" };
const sane = (p) => isFinite(p) && p > 0 && p <= 1e6;
const saneMult = (m) => isFinite(m) && m > 0 && m <= 100;

// 1. DexScreener — pick the most-liquid pair on the target chain.
async function fromDexScreener(env) {
  const addr = env.PRL_TOKEN_ADDRESS || DEFAULT_TOKEN;
  const chain = env.PRL_DEX_CHAIN || DEFAULT_DEX_CHAIN;
  const res = await fetch(
    "https://api.dexscreener.com/latest/dex/tokens/" + addr,
    { headers: JSON_HEADERS, cf: { cacheTtl: 0 } }
  );
  if (!res.ok) throw new Error("dexscreener http " + res.status);
  const data = await res.json();
  const pairs = (data.pairs || [])
    .filter((p) => !chain || p.chainId === chain)
    .sort(
      (a, b) =>
        Number((b.liquidity && b.liquidity.usd) || 0) -
        Number((a.liquidity && a.liquidity.usd) || 0)
    );
  const top = pairs[0];
  const price = Number(top && top.priceUsd);
  if (!sane(price)) throw new Error("dexscreener: no sane price");
  const sym = ((top.baseToken && top.baseToken.symbol) || "wprl").toLowerCase();
  return { price, source: "dexscreener:" + sym + "-" + chain };
}

// 2. GeckoTerminal — onchain price by token address.
async function fromGeckoTerminal(env) {
  const addr = (env.PRL_TOKEN_ADDRESS || DEFAULT_TOKEN).toLowerCase();
  const net = env.PRL_GT_NETWORK || DEFAULT_GT_NETWORK;
  const res = await fetch(
    "https://api.geckoterminal.com/api/v2/simple/networks/" +
      net +
      "/token_price/" +
      addr,
    { headers: JSON_HEADERS, cf: { cacheTtl: 0 } }
  );
  if (!res.ok) throw new Error("geckoterminal http " + res.status);
  const data = await res.json();
  const prices =
    (data && data.data && data.data.attributes && data.data.attributes.token_prices) ||
    {};
  const price = Number(prices[addr] != null ? prices[addr] : Object.values(prices)[0]);
  if (!sane(price)) throw new Error("geckoterminal: no sane price");
  return { price, source: "geckoterminal:" + net };
}

// 3. CoinGecko — only reachable from Workers with an API key.
async function fromCoinGecko(env) {
  const id = env.PRL_COINGECKO_ID || DEFAULT_COIN_ID;
  const headers = { ...JSON_HEADERS };
  if (env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = env.COINGECKO_API_KEY;
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=" +
      encodeURIComponent(id) +
      "&vs_currencies=usd",
    { headers, cf: { cacheTtl: 0 } }
  );
  if (!res.ok) throw new Error("coingecko http " + res.status);
  const data = await res.json();
  const price = Number(data && data[id] && data[id].usd);
  if (!sane(price)) throw new Error("coingecko: no sane price");
  return { price, source: "coingecko:" + id };
}

async function updatePrice(env) {
  const sources = [fromDexScreener, fromGeckoTerminal, fromCoinGecko];
  const errors = [];
  let result = null;
  for (const fn of sources) {
    try {
      result = await fn(env);
      if (result && sane(result.price)) break;
      result = null;
    } catch (e) {
      errors.push((fn.name || "source") + ": " + ((e && e.message) || e));
    }
  }
  if (!result) throw new Error("all price sources failed -> " + errors.join(" | "));

  const record = { price: result.price, ts: Date.now(), source: result.source };

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

// --- network difficulty multiplier (relative to the current baseline) ---
// Pool APIs vary in shape (miningcore: pools[].networkStats.networkDifficulty;
// luckypool: network.difficulty; etc.), so rather than hard-code one path we
// recursively pull every "*diff*" number out of the JSON and pick the most
// network-difficulty-like one that produces a sane multiplier vs the baseline.

function diffCandidates(obj) {
  const out = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, path + "[" + i + "]"));
    if (typeof node === "object") {
      for (const k of Object.keys(node)) walk(node[k], path ? path + "." + k : k);
      return;
    }
    const num = Number(node);
    const key = (path.split(/[.\[]/).pop() || path).toLowerCase();
    if (isFinite(num) && num > 0 && /diff/.test(key)) out.push({ path, value: num });
  };
  walk(obj, "");
  return out;
}

// Higher score = more likely the *network* difficulty (not pool/share/var diff).
function scoreCandidate(path) {
  const p = path.toLowerCase();
  let s = 0;
  if (/network/.test(p)) s += 3;
  if (/networkdifficulty/.test(p)) s += 2;
  if (/(pool|share|worker|miner|vardiff|var_diff|target|min)/.test(p)) s -= 4;
  return s;
}

function diffSources(env) {
  if (env.DIFFICULTY_URLS) {
    return env.DIFFICULTY_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const list = DEFAULT_DIFF_URLS.slice();
  if (env.DIFFICULTY_URL) list.unshift(env.DIFFICULTY_URL);
  return list;
}

async function probeDiff(url) {
  const result = { url };
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, cf: { cacheTtl: 0 } });
    result.status = res.status;
    if (!res.ok) { result.error = "http " + res.status; return result; }
    const data = await res.json();
    result.candidates = diffCandidates(data)
      .map((c) => ({ ...c, score: scoreCandidate(c.path) }))
      .sort((a, b) => b.score - a.score || b.value - a.value);
  } catch (e) {
    result.error = (e && e.message) || String(e);
  }
  return result;
}

async function pickDifficulty(env, baseline) {
  const errors = [];
  for (const url of diffSources(env)) {
    const r = await probeDiff(url);
    if (!r.candidates || !r.candidates.length) {
      errors.push(url + ": " + (r.error || "no diff field"));
      continue;
    }
    const best = r.candidates.find((c) => saneMult(Math.round((c.value / baseline) * 100) / 100));
    if (best) return { difficulty: best.value, source: new URL(url).hostname + ":" + best.path };
    errors.push(url + ": no sane diff (" + r.candidates.slice(0, 3).map((c) => c.path + "=" + c.value).join(", ") + ")");
  }
  throw new Error("no difficulty source worked -> " + errors.join(" | "));
}

async function updateDifficulty(env) {
  const baseline = Number(env.BASELINE_DIFFICULTY) > 0
    ? Number(env.BASELINE_DIFFICULTY)
    : DEFAULT_BASELINE_DIFFICULTY;
  const { difficulty, source } = await pickDifficulty(env, baseline);
  const mult = Math.round((difficulty / baseline) * 100) / 100;
  if (!saneMult(mult)) throw new Error("computed insane multiplier: " + mult);

  const record = { mult, difficulty, baseline, ts: Date.now(), source };
  await env.PRICE_KV.put(DIFF_KV_KEY, JSON.stringify(record));
  return record;
}

// Diagnostics for /?diffdebug=1 — every source's HTTP status and the
// difficulty-like numbers found (with the resulting mult), so the correct
// endpoint/field can be confirmed without shell access to the pools.
async function debugDifficulty(env) {
  const baseline = Number(env.BASELINE_DIFFICULTY) > 0
    ? Number(env.BASELINE_DIFFICULTY)
    : DEFAULT_BASELINE_DIFFICULTY;
  const sources = [];
  for (const url of diffSources(env)) {
    const r = await probeDiff(url);
    if (r.candidates) {
      r.candidates = r.candidates.slice(0, 8).map((c) => ({
        ...c,
        mult: Math.round((c.value / baseline) * 100) / 100,
      }));
    }
    sources.push(r);
  }
  return { baseline, sources };
}

export default {
  // Cron Trigger entry point.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      updatePrice(env)
        .then((r) => console.log("updated PRL price:", JSON.stringify(r)))
        .catch((e) => console.error("price update failed:", e && e.message))
    );
    // Difficulty is best-effort and independent — its failure must not affect price.
    ctx.waitUntil(
      updateDifficulty(env)
        .then((r) => console.log("updated PRL difficulty:", JSON.stringify(r)))
        .catch((e) => console.error("difficulty update failed:", e && e.message))
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
    if (url.searchParams.get("diff") === "1") {
      try {
        const record = await updateDifficulty(env);
        return Response.json(record);
      } catch (e) {
        return Response.json({ error: String((e && e.message) || e) }, { status: 502 });
      }
    }
    if (url.searchParams.get("diffdebug") === "1") {
      return Response.json(await debugDifficulty(env));
    }
    return new Response("pearlrate price cron worker — ok\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
