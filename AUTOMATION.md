# Automating the PRL price

PearlRate is a static site, so the live price lives in **Cloudflare KV** and is
served by a tiny **Pages Function** (`functions/api/price.js`). The Mac mini
fetches the price from the **CoinGecko public API** and pushes it to that
endpoint on a schedule. The page reads `/api/price` on load.

```
 Mac mini (every N min)                 Cloudflare Pages
 ┌────────────────────┐   POST /api/price  ┌─────────────────────┐
 │ update-prl-price.sh │ ─────────────────▶ │ functions/api/price │──▶ KV (pearlrate-price)
 │  curl CoinGecko API │   Bearer TOKEN     │   GET reads KV ◀────┼──── index.html fetch()
 └────────────────────┘                     └─────────────────────┘
```

No browser scraping — CoinGecko exposes the price directly via JSON, which is
far more robust than reading a browser window.

> **Why CoinGecko, not SafeTrade?** SafeTrade's native PRL market sits behind a
> Cloudflare WAF that geo-blocks Polish IPs (a plain `curl` gets `HTTP 403
> "you have been blocked"`), so it's unreachable from the Mac mini without a
> third-party proxy. CoinGecko's `wrapped-pearl` (WPRL on Ethereum/Uniswap) is
> the same asset, reachable with no proxy, and tracks the SafeTrade price
> closely (within a few % spread).

## 1. Cloudflare setup (once)

Two stores already exist (and are declared in `wrangler.toml`):

| Store | Name | Binding | id |
|---|---|---|---|
| KV (latest price) | `pearlrate-price` | `PRICE_KV` | `cb93529a1f724c3a9e104350bd7c8a63` |
| D1 (price history) | `pearlrate-history` | `PRICE_DB` | `733d5091-4c91-48d3-b1d8-c1488f9121f0` |

The D1 table is created (`prl_price(id, ts, price, source)` + index on `ts`).

In the Cloudflare dashboard → **Workers & Pages → pearlrate → Settings →
Bindings** (skip if you deploy with Wrangler — `wrangler.toml` covers it):

1. **KV namespace**: variable `PRICE_KV` → namespace `pearlrate-price`
2. **D1 database**: variable `PRICE_DB` → database `pearlrate-history`
3. **Variables and Secrets**: add a **secret**
   - Name: `PRICE_TOKEN`
   - Value: a long random string (e.g. `openssl rand -hex 24`)
   - Keep this value — the Mac mini needs the same string.

Redeploy (any push to the production branch redeploys). Verify:

```bash
curl https://pearlrate.dcnb.eu/api/price          # -> {"price":null} until first push
curl https://pearlrate.dcnb.eu/api/history?range=7d   # -> {"range":"7d","points":[]}
```

Each `POST /api/price` writes the latest value to KV **and** appends a row to
D1. The page draws the chart from `GET /api/history?range=24h|7d|30d|all`.

## 2. Mac mini updater

`scripts/update-prl-price.sh` fetches the `wrapped-pearl` USD price from
CoinGecko and POSTs it. Requires `curl` and `jq` (`brew install jq`).

Test it manually first:

```bash
export PEARLRATE_URL="https://pearlrate.dcnb.eu"
export PRICE_TOKEN="<the same secret you set on Cloudflare>"
./scripts/update-prl-price.sh
# -> {"price":0.86,"ts":...,"source":"coingecko:wrapped-pearl"}
```

You can dry-run the fetch with **no token and no Cloudflare** set up:

```bash
PRICE_DRYRUN=1 ./scripts/update-prl-price.sh
# -> {"price":0.86,"source":"coingecko:wrapped-pearl","dryrun":true}
```

> To track a different CoinGecko coin, set `PRL_COINGECKO_ID=<id>` (the id is
> the last path segment of the coin's CoinGecko URL). For higher rate limits,
> set `COINGECKO_API_KEY=<demo-key>`.

### Schedule it (launchd — recommended on macOS)

Create `~/Library/LaunchAgents/biz.chrobok.pearlrate-price.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>biz.chrobok.pearlrate-price</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/YOU/PearlRate/scripts/update-prl-price.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PEARLRATE_URL</key><string>https://pearlrate.dcnb.eu</string>
    <key>PRICE_TOKEN</key><string>REPLACE_WITH_SECRET</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>   <!-- every 5 min -->
  <key>StandardErrorPath</key><string>/tmp/pearlrate-price.log</string>
  <key>StandardOutPath</key><string>/tmp/pearlrate-price.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/biz.chrobok.pearlrate-price.plist
```

## 3. Hermes task (alternative to launchd)

If you'd rather Hermes own the schedule, give it this task. Note the source is
the **API**, not the browser window — so no open tab is needed:

> **Task: Update PRL price every 5 minutes**
> Every 5 minutes, run the shell script
> `/Users/YOU/PearlRate/scripts/update-prl-price.sh` with the environment
> variables `PEARLRATE_URL=https://pearlrate.dcnb.eu` and
> `PRICE_TOKEN=<secret>` set. The script fetches the latest PRL price from
> the CoinGecko public API and POSTs it to the PearlRate `/api/price` endpoint.
> On success it prints a JSON record like
> `{"price":0.86,"ts":...,"source":"coingecko:wrapped-pearl"}`. If the script
> exits non‑zero (network error, malformed price, or HTTP error from the
> endpoint), log the failure and retry on the next cycle — do not push a
> fallback value.

If CoinGecko ever rate-limits or drops the `wrapped-pearl` listing, tell me and
I'll point the script at another source (or wrap the fetch in the Cloudflare
Worker on a Cron Trigger, which removes the Mac mini entirely).

---

# Automating the network difficulty ×

The "Network difficulty ×" control is the same idea as the price: a live value
fetched on a schedule and served to the page. It's a **multiplier relative to
26 May 2026** (the baseline the GPU yields were measured at):

```
mult = current network difficulty / baseline difficulty (26 May 2026)
```

Block time is ~constant, so difficulty tracks hashrate — this is exactly the
"**2× hashrate → half yield**" factor the calculator divides every yield by.

It reuses the existing plumbing — the **same** `PRICE_KV` namespace (under key
`prl_diff`) and the **same** `PRICE_TOKEN` secret — so no new Cloudflare setup
is needed. The page reads `/api/difficulty` on load:

```
 updater (every N min)                   Cloudflare Pages
 ┌───────────────────────────┐  POST /api/difficulty  ┌────────────────────────┐
 │ update-prl-difficulty.sh  │ ─────────────────────▶ │ functions/api/difficulty│──▶ KV (prl_diff)
 │  miningcore /api/pools     │   Bearer PRICE_TOKEN   │   GET reads KV ◀────────┼──── index.html fetch()
 └───────────────────────────┘                        └────────────────────────┘
```

## Source: AlphaPool (miningcore)

`https://pearl.alphapool.tech` runs the standard **miningcore** frontend, whose
JSON API at `/api/pools` exposes `pools[].networkStats.networkDifficulty`.

> The public PRL explorers (prlscan, mineaitokens, hashrate.no, kryptex) sit
> behind a WAF that returns `HTTP 403` to datacenter IPs — same story as
> CoinGecko for the price. So the **residential Mac mini** is the reliable
> fetcher. The Cron Worker also tries AlphaPool (below); use whichever reaches.

## ⚠️ Set the baseline difficulty

The one value you must confirm is `BASELINE_DIFFICULTY` — the network difficulty
on **26 May 2026** (the ×1.00 point). The scripts default to an **estimate**
(`2,500,000`: ~18.1M difficulty at ~25.7 EH/s in Jun 2026 vs ~3.56 EH/s at
launch). If it's off, every yield is off by a constant factor, so plug in the
real 26 May 2026 difficulty once you have it (set `BASELINE_DIFFICULTY=...`).

## Mac mini updater

`scripts/update-prl-difficulty.sh` mirrors the price script. Dry-run it with no
token and no Cloudflare:

```bash
DIFFICULTY_DRYRUN=1 ./scripts/update-prl-difficulty.sh
# -> {"mult":7.24,"difficulty":18098085,"baseline":2500000,"source":"alphapool:miningcore","dryrun":true}
```

Live (POSTs the multiplier):

```bash
export PEARLRATE_URL="https://pearlrate.dcnb.eu"
export PRICE_TOKEN="<the same secret you set on Cloudflare>"
export BASELINE_DIFFICULTY=2500000     # <-- set the confirmed 26 May 2026 value
./scripts/update-prl-difficulty.sh
```

Schedule it exactly like the price (a second launchd plist, e.g.
`biz.chrobok.pearlrate-difficulty`, pointing at this script — difficulty moves
slowly, so a longer `StartInterval` such as 3600s is plenty). Tunables:
`DIFFICULTY_URL`, `PRL_POOL_ID` (pick a pool from the array), `BASELINE_DIFFICULTY`.

## Cron Worker (hands-free alternative)

`worker/price-cron.js` now also updates difficulty in the same scheduled run
(best-effort and fully independent — a difficulty failure never affects the
price write). It writes the same `prl_diff` KV key the Pages Function serves.
Optional vars on the Worker: `BASELINE_DIFFICULTY`, `DIFFICULTY_URL`, `PRL_POOL_ID`.

Test after deploy (forces one difficulty update immediately):

```bash
curl "https://pearlrate-price-cron.<your-subdomain>.workers.dev/?diff=1"
# -> {"mult":7.24,"difficulty":18098085,"baseline":2500000,...}
```

Until the first push, the page just keeps its manual ×1.00 default (the slider
still works as an override).
