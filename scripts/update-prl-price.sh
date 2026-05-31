#!/usr/bin/env bash
#
# Fetch the latest PRL (Pearl) price from CoinGecko and push it to PearlRate.
# Run this on the Mac mini on a schedule (launchd / cron / Hermes task).
#
# We use CoinGecko's `wrapped-pearl` (WPRL on Ethereum / Uniswap) market.
# Rationale: SafeTrade's native PRL market sits behind a Cloudflare WAF that
# geo-blocks Polish IPs (HTTP 403), so it can't be reached directly. CoinGecko
# is reachable without any proxy and exposes the same asset's USD price.
#
# Required env vars:
#   PEARLRATE_URL       base URL of the deployed site, e.g. https://pearlrate.dcnb.eu
#   PRICE_TOKEN         shared secret, identical to the PRICE_TOKEN on the Pages project
# Optional:
#   PRL_COINGECKO_ID    CoinGecko coin id (default: wrapped-pearl)
#   COINGECKO_API_KEY   demo API key; sent as x-cg-demo-api-key (raises rate limits)
#   PRICE_DRYRUN=1      only fetch + print the price, do NOT POST (no token needed)
#
# Dependencies: curl, jq  (brew install jq)

set -euo pipefail

COIN_ID="${PRL_COINGECKO_ID:-wrapped-pearl}"

if [ -z "${PRICE_DRYRUN:-}" ]; then
  : "${PEARLRATE_URL:?set PEARLRATE_URL (e.g. https://pearlrate.dcnb.eu)}"
  : "${PRICE_TOKEN:?set PRICE_TOKEN}"
fi

API_URL="https://api.coingecko.com/api/v3/simple/price?ids=${COIN_ID}&vs_currencies=usd"

# Optional demo API key header (CoinGecko free tier allows higher limits with a key).
KEY_HEADER=()
if [ -n "${COINGECKO_API_KEY:-}" ]; then
  KEY_HEADER=(-H "x-cg-demo-api-key: ${COINGECKO_API_KEY}")
fi

# Fetch with a couple of retries (CoinGecko occasionally returns 429).
price=""
for attempt in 1 2 3; do
  body="$(curl -fsS --max-time 20 "${KEY_HEADER[@]+"${KEY_HEADER[@]}"}" "$API_URL" 2>/dev/null || true)"
  cand="$(printf '%s' "$body" | jq -er --arg id "$COIN_ID" '.[$id].usd' 2>/dev/null || true)"
  if [ -n "$cand" ] && awk "BEGIN{exit !($cand > 0)}" 2>/dev/null; then
    price="$cand"; break
  fi
  sleep 3
done

if [ -z "$price" ]; then
  echo "update-prl-price: could not fetch a valid PRL price from CoinGecko (${COIN_ID})" >&2
  exit 1
fi

SOURCE="coingecko:${COIN_ID}"

if [ -n "${PRICE_DRYRUN:-}" ]; then
  echo "{\"price\": ${price}, \"source\": \"${SOURCE}\", \"dryrun\": true}"
  echo "update-prl-price: DRYRUN PRL=${price} (${SOURCE})" >&2
  exit 0
fi

curl -fsS --max-time 20 \
  -X POST "${PEARLRATE_URL%/}/api/price" \
  -H "Authorization: Bearer ${PRICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"price\": ${price}, \"source\": \"${SOURCE}\"}"

echo  # newline after the JSON response
echo "update-prl-price: pushed PRL=${price} (${SOURCE})" >&2
