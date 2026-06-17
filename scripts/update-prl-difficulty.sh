#!/usr/bin/env bash
#
# Fetch the current Pearl (PRL) network difficulty from a mining-pool API and
# push the resulting difficulty *multiplier* to PearlRate. Run on the Mac mini
# on a schedule (launchd / cron / Hermes task), exactly like update-prl-price.sh.
#
# The page's "Network difficulty ×" is relative to the 26 May 2026 baseline:
#
#     mult = current network difficulty / baseline difficulty (26 May 2026)
#
# Yields divide by this, so 2x difficulty (≈2x hashrate) → half yield.
#
# SOURCE: AlphaPool (https://pearl.alphapool.tech) runs the standard miningcore
# frontend, whose JSON API at /api/pools exposes networkStats.networkDifficulty.
# (Public PRL explorers — prlscan, mineaitokens, hashrate.no, kryptex — sit
# behind a WAF that 403s datacenter IPs, just like CoinGecko does for price, so
# the residential Mac mini is the reliable fetcher.)
#
# Required env vars:
#   PEARLRATE_URL        base URL of the deployed site, e.g. https://pearlrate.dcnb.eu
#   PRICE_TOKEN          shared secret, identical to the PRICE_TOKEN on the Pages project
# Tunable:
#   BASELINE_DIFFICULTY  network difficulty on 26 May 2026 (the ×1.00 baseline).
#                        DEFAULT BELOW IS AN ESTIMATE — set the confirmed value.
#   DIFFICULTY_URL       miningcore /api/pools URL (default AlphaPool)
#   PRL_POOL_ID          pick a specific pool id from the pools array (default: first)
#   DIFFICULTY_DRYRUN=1  only fetch + print, do NOT POST (no token needed)
#
# Dependencies: curl, jq  (brew install jq)

set -euo pipefail

DIFFICULTY_URL="${DIFFICULTY_URL:-https://pearl.alphapool.tech/api/pools}"
# Estimate: difficulty ~18.1M at ~25.7 EH/s (Jun 2026) vs ~3.56 EH/s at launch
# (≈26-28 May 2026) → baseline ≈ 18.1M × 3.56/25.7 ≈ 2.5M. CONFIRM AND SET THIS.
BASELINE_DIFFICULTY="${BASELINE_DIFFICULTY:-2500000}"

if [ -z "${DIFFICULTY_DRYRUN:-}" ]; then
  : "${PEARLRATE_URL:?set PEARLRATE_URL (e.g. https://pearlrate.dcnb.eu)}"
  : "${PRICE_TOKEN:?set PRICE_TOKEN}"
fi

# jq filter: select the pool (by id if PRL_POOL_ID set, else the first) and read
# its network difficulty. Tolerates either {"pools":[...]} or a bare [...] array.
if [ -n "${PRL_POOL_ID:-}" ]; then
  JQ='(.pools // .) | map(select(.id == $pid))[0].networkStats.networkDifficulty'
else
  JQ='(.pools // .)[0].networkStats.networkDifficulty'
fi

# Fetch with a couple of retries.
difficulty=""
for attempt in 1 2 3; do
  body="$(curl -fsS --max-time 20 -H "Accept: application/json" "$DIFFICULTY_URL" 2>/dev/null || true)"
  cand="$(printf '%s' "$body" | jq -er --arg pid "${PRL_POOL_ID:-}" "$JQ" 2>/dev/null || true)"
  if [ -n "$cand" ] && awk "BEGIN{exit !($cand > 0)}" 2>/dev/null; then
    difficulty="$cand"; break
  fi
  sleep 3
done

if [ -z "$difficulty" ]; then
  echo "update-prl-difficulty: could not fetch a valid network difficulty from ${DIFFICULTY_URL}" >&2
  exit 1
fi

# mult = current difficulty / baseline difficulty (26 May 2026), rounded to 2dp.
mult="$(awk "BEGIN{printf \"%.2f\", $difficulty / $BASELINE_DIFFICULTY}")"
if ! awk "BEGIN{exit !($mult > 0)}" 2>/dev/null; then
  echo "update-prl-difficulty: computed non-positive multiplier ($mult)" >&2
  exit 1
fi

SOURCE="alphapool:miningcore"

if [ -n "${DIFFICULTY_DRYRUN:-}" ]; then
  echo "{\"mult\": ${mult}, \"difficulty\": ${difficulty}, \"baseline\": ${BASELINE_DIFFICULTY}, \"source\": \"${SOURCE}\", \"dryrun\": true}"
  echo "update-prl-difficulty: DRYRUN diff=${difficulty} baseline=${BASELINE_DIFFICULTY} → ×${mult}" >&2
  exit 0
fi

curl -fsS --max-time 20 \
  -X POST "${PEARLRATE_URL%/}/api/difficulty" \
  -H "Authorization: Bearer ${PRICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"mult\": ${mult}, \"difficulty\": ${difficulty}, \"baseline\": ${BASELINE_DIFFICULTY}, \"source\": \"${SOURCE}\"}"

echo  # newline after the JSON response
echo "update-prl-difficulty: pushed diff=${difficulty} baseline=${BASELINE_DIFFICULTY} → ×${mult} (${SOURCE})" >&2
