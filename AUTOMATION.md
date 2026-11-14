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
the current baseline difficulty** — the ×1.00 point the table yields are stated
at (`18,098,085`, 17 Jun 2026):

```
mult = current network difficulty / baseline difficulty
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

## Baseline difficulty

`BASELINE_DIFFICULTY` is the ×1.00 point — the difficulty the table yields are
stated at. It's anchored to the **confirmed current value `18,098,085`
(17 Jun 2026)**, so the live multiplier reads ≈×1.00 today and climbs as the
network grows. To re-anchor the calculator to a newer snapshot, restate the
table yields at that difficulty and set `BASELINE_DIFFICULTY=...` to match.

## Mac mini updater

`scripts/update-prl-difficulty.sh` mirrors the price script. Dry-run it with no
token and no Cloudflare:

```bash
DIFFICULTY_DRYRUN=1 ./scripts/update-prl-difficulty.sh
# -> {"mult":1.00,"difficulty":18098085,"baseline":18098085,"source":"alphapool:miningcore","dryrun":true}
```

Live (POSTs the multiplier):

```bash
export PEARLRATE_URL="https://pearlrate.dcnb.eu"
export PRICE_TOKEN="<the same secret you set on Cloudflare>"
export BASELINE_DIFFICULTY=18098085    # <-- current ×1.00 baseline (17 Jun 2026)
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
# -> {"mult":1.00,"difficulty":18098085,"baseline":18098085,...}
```

Until the first push, the page just keeps its manual ×1.00 default (the slider
still works as an override).

---

# KV write budget (why writes stay low)

Cloudflare's free KV plan allows **1,000 writes/day**. Writing both the price
and the difficulty on every 5-minute tick used ~576 writes/day (~58% of quota),
so the Cron Worker now minimises writes three ways:

- **One combined key.** Price and difficulty live in a single KV key
  `prl_state = {price:{…}, diff:{…}}` instead of two keys. Each scheduled run
  read-modify-writes that one key; the Pages Functions still expose them
  separately at `/api/price` and `/api/difficulty` (and fall back to the old
  `prl_price` / `prl_diff` keys until the first combined write lands).
- **Write-on-change with a heartbeat.** A tick only PUTs when the value
  actually changed. To keep the page's "updated N min ago" honest, an unchanged
  value is still refreshed at most every **30 min** (price) / **6 h**
  (difficulty). So a flat price costs ~48 writes/day instead of 288, and a flat
  difficulty costs ~4/day.
- **Difficulty on its own hourly cron.** Difficulty barely moves, so it runs at
  minute 7 each hour (`7 * * * *`) rather than every 5 min — a slot that never
  collides with the `*/5` price ticks, so the two never write `prl_state` in the
  same minute. The Worker routes each schedule by `event.cron`.

Net effect: a quiet day now costs roughly **50 writes (~5% of quota)** instead
of ~580, with plenty of headroom for price volatility. (`?run=1` / `?diff=1`
force a write regardless, for testing.) D1 history writes are unchanged — D1 has
its own, separate quota.

---

# Network difficulty history (D1)

The hourly difficulty tick (`7 * * * *`) also appends **one row per tick** to
D1, so the dashboard can chart the network difficulty and **measure** how fast
it grows instead of assuming it:

```
 cron Worker (hourly)                      D1 pearlrate-history
 updateDifficulty() ── appendDifficulty ──▶ prl_difficulty(ts, difficulty, source)
                                                     │
 index.html ◀── GET /api/difficulty-history ◀────────┘  daily medians + growth fit
```

- **No KV cost.** The KV write-on-change logic above is untouched; history goes
  to D1 only (24 rows/day, far inside D1's own free quota).
- **Table.** Created automatically on the first insert that finds it missing,
  and the code tolerates it missing everywhere (the endpoint returns an empty
  history). To create it up front, run once:

  ```sql
  CREATE TABLE IF NOT EXISTS prl_difficulty (ts INTEGER NOT NULL, difficulty REAL NOT NULL, source TEXT);
  CREATE INDEX IF NOT EXISTS idx_prl_difficulty_ts ON prl_difficulty (ts);
  ```

  ```bash
  cd worker
  wrangler d1 execute pearlrate-history --remote \
    --command "CREATE TABLE IF NOT EXISTS prl_difficulty (ts INTEGER NOT NULL, difficulty REAL NOT NULL, source TEXT); CREATE INDEX IF NOT EXISTS idx_prl_difficulty_ts ON prl_difficulty (ts);"
  ```

- **Endpoint.** `functions/api/difficulty-history.js`:

  ```bash
  curl "https://pearlrate.dcnb.eu/api/difficulty-history?range=90d"   # 30d | 90d | all
  # -> {"range":"90d","first":<ms of oldest row>,"count":<rows>,
  #     "points":[{"t":<UTC day ms>,"d":<median difficulty>,"n":<rows that day>},...],
  #     "growth":{"monthly":0.043,"days":41,"n":41,"r2":0.97,...} | null}
  ```

  SQLite groups the hourly rows per UTC day (`GROUP_CONCAT`), the Function takes
  the median of each day (robust to a glitchy pool reading) and fits
  `ln(difficulty) = a + b·day` by least squares. Monthly growth = `e^(30.44·b) − 1`.
  `growth` stays `null` until there are **7 days** of data. Responses are
  cacheable for 5 minutes. It shares `worker/lib/difficulty-history.js` with the
  Worker, so the Pages build bundles that file from outside `functions/`.

- **UI.** A *Network difficulty* chart (daily medians and the dashed fitted
  trend, 30d / 90d / all) under the price chart. *Payback & ROI*'s
  "Difficulty growth / mo %" follows the 90-day measurement ("measured over N
  days") until you move it, then shows *Manual · measured +x%/mo ↺ Measured*.
  With less than a week of history it says "collecting since …" and keeps the
  5% default.

Test it after deploying the Worker: `curl ".../?diff=1"` now also reports
`"history":"table created, row stored"` (first call) or `"row stored"`.

Unit tests (`cd worker && npm test`, Node 22.5+, no dependencies) cover the
write path, the table creation, the medians and the regression against a fake
D1 built on `node:sqlite`. CI runs them on every PR and before every Worker
deploy.

---

# Telegram alerts

The cron Worker can message you on Telegram when something you care about
changes: the fleet starts mining at a loss, PRL drops below a price, the
RTX 5090's break-even rent falls under the rate you charge… Rules are checked
after **every price tick (5 min)** and **every difficulty tick (hourly)**.

**Owner-only by design.** Rules live in a Worker secret (or a KV key you write
with wrangler). The public site has no endpoint that can create, list or change
alerts. **Off by default:** nothing runs (no KV reads, no requests) until both
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set on the Worker.

## 1. Create the bot and find your chat id

1. In Telegram, open **@BotFather** → `/newbot` → pick a name and a username
   ending in `bot`. BotFather replies with the **bot token**
   (`123456789:AA…`). Treat it like a password.
2. Open a chat with your new bot and send it any message (for a group: add the
   bot to the group and post a message there).
3. Get the chat id:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat'
   # -> {"id": 123456789, "first_name": "...", "type": "private"}   (group ids are negative)
   ```

## 2. Secrets on the Worker

```bash
cd worker
wrangler secret put TELEGRAM_BOT_TOKEN      # paste the BotFather token
wrangler secret put TELEGRAM_CHAT_ID        # paste the chat id
wrangler secret put PRICE_TOKEN             # same value as the Pages project's PRICE_TOKEN (guards the test trigger)
jq -c . alert-rules.json | wrangler secret put ALERT_RULES    # your rules, see below
```

Secrets take effect immediately (no redeploy) and survive the CI deploys.
Prefer KV for the rules if you'll edit them often (one extra KV read per tick,
no write):

```bash
wrangler kv key put alert_rules "$(jq -c . alert-rules.json)" --binding PRICE_KV --remote
```

If both exist, `ALERT_RULES` wins. Never put any of these in `[vars]` in
`worker/wrangler.toml`: that file is public.

## 3. Rule format

`ALERT_RULES` is a JSON array (or `{"rules":[…]}`). Each rule:

| Field | Applies to | Meaning |
|---|---|---|
| `id` | all, required | unique, `A-Z a-z 0-9 _ . -`, ≤ 40 chars (shown in the message unless `label` is set) |
| `type` | all, required | `price_below`, `price_above`, `difficulty_above`, `fleet_net_below`, `breakeven_rent_below` |
| `threshold` | all | PRL price in USDT · difficulty × · fleet net $/day (default `0`) · your rental rate $/h |
| `label` | optional | friendlier name for the message |
| `cooldown_h` | optional | no new alert for this rule within N hours of the last one (default **6**) |
| `margin` | optional | hysteresis, in the threshold's unit: an alert clears only once the value is past `threshold ± margin` (default 2 % of the threshold; for fleet rules 2 % of the fleet's gross $/day) |
| `enabled` | optional | `false` keeps the rule but never fires it |
| `fleet` | `fleet_net_below` | `{"<card id>": qty}` with ids `5090 4090 5080 5070ti 3090 5070 4060ti 3060` |
| `custom` | `fleet_net_below` | extra GPUs: `[{"name","power" (W),"yield" (PRL/day at ×1.00),"qty"}]` |
| `yields` | `fleet_net_below` | your benchmark overrides: `{"<card id>": PRL/day at ×1.00}` |
| `elec`, `fee` | `fleet_net_below` | $/kWh (default 0.10) and pool fee % (default 4) |
| `gpu` | `breakeven_rent_below` | a card id, or `{"name","power","yield"}`; optional `yield` override and `fee` (pool %, default 4) |

Example `alert-rules.json`:

```json
[
  { "id": "fleet-loss", "label": "Fleet mining at a loss", "type": "fleet_net_below", "threshold": 0,
    "fleet": { "5090": 4, "3090": 6, "3060": 2 }, "elec": 0.10, "fee": 4,
    "custom": [{ "name": "A6000", "power": 300, "yield": 1.2, "qty": 2 }] },
  { "id": "price-low", "type": "price_below", "threshold": 0.50 },
  { "id": "price-high", "type": "price_above", "threshold": 2.00, "cooldown_h": 12 },
  { "id": "rent-5090", "label": "5090 rate too high for miners", "type": "breakeven_rent_below",
    "gpu": "5090", "threshold": 0.35, "fee": 4 },
  { "id": "difficulty", "type": "difficulty_above", "threshold": 1.50 }
]
```

Messages look like:

```
PearlRate alert · Fleet mining at a loss
Fleet self-mine net (14 GPUs, $0.1/kWh, pool 4%) is −$3.20/day, below $0.00/day.
PRL $0.2100 · difficulty ×1.32
```

The maths is the dashboard's own. `worker/lib/calc.js` holds the Worker's copy
of `index.html`'s `calc()` and benchmark table, and CI (`calc-parity.spec.js`)
evaluates the page's maths in a browser and requires every figure to match
exactly over a grid of inputs. If you change a yield or a formula, change both.

## 4. How it behaves (and what it costs)

- **Transitions only.** A rule messages you when it goes *ok → alert* and
  again on *alert → ok* (a "recovered" message, sent only if the alert itself
  was sent). While the condition holds, nothing is sent.
- **Cooldown** stops a flapping rule from paging you repeatedly; the margin
  (hysteresis) stops it flapping on noise in the first place.
- **KV budget.** Rule state is one KV key, `alert_state`, written **only on a
  transition** (or once when you edit/remove a rule). A quiet day costs 0
  writes; reads are 1 per tick (~312/day, from the 100,000/day free reads).
- **Stale data never alerts.** Rules are skipped if the stored price is older
  than 3 h or the difficulty older than 30 h.
- **Failures:** if Telegram is unreachable nothing is recorded and the next
  tick retries; an alert problem never affects the price/difficulty update.
  Invalid rules are skipped and logged (`wrangler tail`) and listed by the test
  trigger.

## 5. Test it

```bash
curl -s -H "Authorization: Bearer $PRICE_TOKEN" \
  "https://pearlrate-price-cron.<your-subdomain>.workers.dev/?alerts=test" | jq
# -> {"enabled":true,"sent":true,"market":{"price":0.92,"mult":1.18},
#     "rules":[{"id":"price-low","value":0.92,"threshold":0.5,"active":false,"wouldBeActive":false,...}],"errors":[]}
```

It evaluates every rule against the stored price/difficulty **without
changing any alert state**, and sends one "alerts are wired up" message
listing each rule's current value (`&send=0` skips the message). Without the
right `PRICE_TOKEN` it answers 401 (403 if the Worker has no `PRICE_TOKEN`
secret at all).

To turn alerts off: `wrangler secret delete TELEGRAM_CHAT_ID`.

> The older `?run=1` / `?diff=1` / `?diffdebug=1` diagnostics on the Worker are
> still unauthenticated (unchanged). Each forced call can cost a KV write, so
> consider guarding them with the same `PRICE_TOKEN` check.
