#!/usr/bin/env bash
#
# Fetch the latest PRL/USDT price from SafeTrade and push it to PearlRate.
# Run this on the Mac mini on a schedule (launchd / cron / Hermes task).
#
# Required env vars:
#   PEARLRATE_URL   base URL of the deployed site, e.g. https://pearlrate.dcnb.eu
#   PRICE_TOKEN     shared secret, identical to the PRICE_TOKEN set on the Pages project
# Optional:
#   PRL_MARKET      SafeTrade market id (default: prlusdt)
#   PRICE_DRYRUN=1  only fetch + print the price, do NOT POST (no token needed)
#   PRICE_NO_PROXY=1  do not use the public proxy fallbacks (direct only)
#
# Dependencies: curl, jq  (brew install jq)
#
# NOTE on the proxy fallbacks:
#   SafeTrade sits behind a Cloudflare WAF that hard-blocks many IPs/regions
#   (a plain `curl` from a Polish residential line gets HTTP 403 "you have been
#   blocked"). When the direct request fails we fall back to public read-only
#   proxies that fetch the JSON server-side. These are third-party, best-effort
#   services -- if both go down the script just exits non-zero and tries again
#   on the next scheduled run. The cleaner long-term fix is to do this fetch
#   inside the Cloudflare Worker on a Cron Trigger (see AUTOMATION.md).

set -euo pipefail

MARKET="${PRL_MARKET:-prlusdt}"

if [ -z "${PRICE_DRYRUN:-}" ]; then
  : "${PEARLRATE_URL:?set PEARLRATE_URL (e.g. https://pearlrate.dcnb.eu)}"
  : "${PRICE_TOKEN:?set PRICE_TOKEN}"
fi

# Correct SafeTrade (Peatio) ticker endpoint. NOTE: it lives under /peatio/,
# NOT /trade/ -- the /trade/ path returns 404 for every market.
TICKER_URL="https://safe.trade/api/v2/peatio/public/markets/${MARKET}/tickers"
ENC="$(printf '%s' "$TICKER_URL" | jq -sRr @uri)"

# --- fetch strategies (each prints the ticker JSON to stdout) -----------------
fetch_direct()     { curl -fsS --max-time 20 "$TICKER_URL"; }
fetch_allorigins() { curl -fsS --max-time 25 "https://api.allorigins.win/raw?url=${ENC}"; }
fetch_jina()       { curl -fsS --max-time 25 -H "Accept: application/json" -H "x-no-cache: true" \
                       "https://r.jina.ai/${TICKER_URL}" | jq -r '.data.content'; }

if [ -n "${PRICE_NO_PROXY:-}" ]; then
  STRATEGIES=(fetch_direct)
else
  STRATEGIES=(fetch_direct fetch_allorigins fetch_jina)
fi

price=""
via=""
for fn in "${STRATEGIES[@]}"; do
  for attempt in 1 2; do
    body="$("$fn" 2>/dev/null || true)"
    cand="$(printf '%s' "$body" | jq -er '.ticker.last' 2>/dev/null || true)"
    if [ -n "$cand" ] && awk "BEGIN{exit !($cand > 0)}" 2>/dev/null; then
      price="$cand"; via="${fn#fetch_}"; break 2
    fi
  done
done

if [ -z "$price" ]; then
  echo "update-prl-price: could not fetch a valid PRL price from SafeTrade (all sources failed)" >&2
  exit 1
fi

if [ -n "${PRICE_DRYRUN:-}" ]; then
  echo "{\"price\": ${price}, \"source\": \"safetrade:${MARKET}\", \"via\": \"${via}\", \"dryrun\": true}"
  echo "update-prl-price: DRYRUN PRL=${price} (${MARKET}) via ${via}" >&2
  exit 0
fi

curl -fsS --max-time 20 \
  -X POST "${PEARLRATE_URL%/}/api/price" \
  -H "Authorization: Bearer ${PRICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"price\": ${price}, \"source\": \"safetrade:${MARKET}\"}"

echo  # newline after the JSON response
echo "update-prl-price: pushed PRL=${price} (${MARKET}) via ${via}" >&2
