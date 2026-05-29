# Automating the PRL price

PearlRate is a static site, so the live price lives in **Cloudflare KV** and is
served by a tiny **Pages Function** (`functions/api/price.js`). The Mac mini
fetches the price from the **SafeTrade public API** and pushes it to that
endpoint on a schedule. The page reads `/api/price` on load.

```
 Mac mini (every N min)                 Cloudflare Pages
 ┌────────────────────┐   POST /api/price  ┌─────────────────────┐
 │ update-prl-price.sh │ ─────────────────▶ │ functions/api/price │──▶ KV (pearlrate-price)
 │  curl SafeTrade API │   Bearer TOKEN     │   GET reads KV ◀────┼──── index.html fetch()
 └────────────────────┘                     └─────────────────────┘
```

No browser scraping — SafeTrade exposes the price directly, which is far more
robust than reading a browser window.

## 1. Cloudflare setup (once)

The KV namespace already exists: **`pearlrate-price`**, id
`cb93529a1f724c3a9e104350bd7c8a63` (also declared in `wrangler.toml`).

In the Cloudflare dashboard → **Workers & Pages → pearlrate → Settings**:

1. **Bindings → KV namespace**: add binding
   - Variable name: `PRICE_KV`
   - Namespace: `pearlrate-price`
   (If you deploy with Wrangler, `wrangler.toml` already does this.)
2. **Variables and Secrets**: add a **secret**
   - Name: `PRICE_TOKEN`
   - Value: a long random string (e.g. `openssl rand -hex 24`)
   Keep this value — the Mac mini needs the same string.

Redeploy (any push to the production branch redeploys). Verify:

```bash
curl https://pearlrate.pages.dev/api/price        # -> {"price":null} until first push
```

## 2. Mac mini updater

`scripts/update-prl-price.sh` fetches `prlusdt` from SafeTrade and POSTs it.
Requires `curl` and `jq` (`brew install jq`).

Test it manually first:

```bash
export PEARLRATE_URL="https://pearlrate.pages.dev"
export PRICE_TOKEN="<the same secret you set on Cloudflare>"
./scripts/update-prl-price.sh
# -> {"price":1.45,"ts":...,"source":"safetrade:prlusdt"}
```

> If SafeTrade lists PRL against a different quote (e.g. PRL/BTC), set
> `PRL_MARKET=prlbtc`. Check the exact market id in the SafeTrade URL.

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
    <key>PEARLRATE_URL</key><string>https://pearlrate.pages.dev</string>
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
> variables `PEARLRATE_URL=https://pearlrate.pages.dev` and
> `PRICE_TOKEN=<secret>` set. The script fetches the latest PRL/USDT price from
> the SafeTrade public API and POSTs it to the PearlRate `/api/price` endpoint.
> On success it prints a JSON record like
> `{"price":1.45,"ts":...,"source":"safetrade:prlusdt"}`. If the script exits
> non‑zero (network error, malformed price, or HTTP error from the endpoint),
> log the failure and retry on the next cycle — do not push a fallback value.

If you specifically need Hermes to read the **browser window** instead of the
API (e.g. SafeTrade blocks API access), tell me and I'll adapt the script into
a DOM/OCR-based reader — but expect it to be more fragile.
