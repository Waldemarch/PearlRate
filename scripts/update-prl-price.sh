#!/usr/bin/env bash
#
# Fetch the latest PRL/USDT price from SafeTrade and push it to PearlRate.
# Run this on the Mac mini on a schedule (launchd / cron / Hermes task).
#
# Required env vars:
#   PEARLRATE_URL   base URL of the deployed site, e.g. https://pearlrate.pages.dev
#   PRICE_TOKEN     shared secret, identical to the PRICE_TOKEN set on the Pages project
# Optional:
#   PRL_MARKET      SafeTrade market id (default: prlusdt)
#
# Dependencies: curl, jq  (brew install jq)

set -euo pipefail

MARKET="${PRL_MARKET:-prlusdt}"
: "${PEARLRATE_URL:?set PEARLRATE_URL (e.g. https://pearlrate.pages.dev)}"
: "${PRICE_TOKEN:?set PRICE_TOKEN}"

TICKER_URL="https://safe.trade/api/v2/trade/public/markets/${MARKET}/tickers"

# SafeTrade (Peatio) returns: {"at":...,"ticker":{"last":"1.45", ...}}
price="$(curl -fsS --max-time 20 "$TICKER_URL" | jq -er '.ticker.last')"

# sanity check: numeric and > 0
if ! awk "BEGIN{exit !($price > 0)}" 2>/dev/null; then
  echo "update-prl-price: bad price from SafeTrade: '$price'" >&2
  exit 1
fi

curl -fsS --max-time 20 \
  -X POST "${PEARLRATE_URL%/}/api/price" \
  -H "Authorization: Bearer ${PRICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"price\": ${price}, \"source\": \"safetrade:${MARKET}\"}"

echo  # newline after the JSON response
echo "update-prl-price: pushed PRL=${price} (${MARKET})" >&2
