#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/gini/Documents/ZMI/zao-market-intelligence"
cd "$REPO"

mkdir -p "$REPO/.logs"

echo "=== ZMI BI Web publish start $(date '+%Y-%m-%d %H:%M:%S %z') ==="

if [ ! -f "$REPO/.env.cloudflare.local" ]; then
  echo "decision=bi_web_publish_skipped_env_missing"
  echo "note=.env.cloudflare.local is missing"
  exit 0
fi

# Do not print token values.
# shellcheck disable=SC1091
source "$REPO/.env.cloudflare.local"

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "decision=bi_web_publish_skipped_env_incomplete"
  exit 0
fi

npm run bi:web:publish

echo "=== ZMI BI Web publish end $(date '+%Y-%m-%d %H:%M:%S %z') ==="
