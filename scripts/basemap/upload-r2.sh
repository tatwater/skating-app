#!/usr/bin/env bash
# Upload a self-built `.pmtiles` basemap to Cloudflare R2 (via rclone) and print the serving URL to
# wire into VITE_PMTILES_URL / EXPO_PUBLIC_PMTILES_URL. Thin glue over rclone — see this dir's README
# (the "Host on Cloudflare R2" section) for the one-time setup, public access, and CORS.
#
#   scripts/basemap/upload-r2.sh <file.pmtiles> <key>
#   e.g. scripts/basemap/upload-r2.sh .scratch/northeast-basemap.pmtiles dev/northeast-20260714.pmtiles
#
# Non-secret config (R2_REMOTE / R2_BUCKET / R2_PUBLIC_BASE_URL) comes from scripts/basemap/.env.local
# (copy .env.example). rclone credentials live in ~/.config/rclone/rclone.conf — never in the repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load non-secret config if present.
if [[ -f "$SCRIPT_DIR/.env.local" ]]; then
  set -a; . "$SCRIPT_DIR/.env.local"; set +a
fi
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-skating-basemap}"

FILE="${1:-}"
KEY="${2:-}"
if [[ -z "$FILE" || -z "$KEY" ]]; then
  echo "usage: scripts/basemap/upload-r2.sh <file.pmtiles> <key>" >&2
  echo "  e.g. scripts/basemap/upload-r2.sh .scratch/northeast-basemap.pmtiles dev/northeast-20260714.pmtiles" >&2
  exit 1
fi
if [[ ! -f "$FILE" ]]; then echo "no such file: $FILE" >&2; exit 1; fi
command -v rclone >/dev/null 2>&1 || { echo "rclone not installed (brew install rclone)" >&2; exit 1; }

echo "[basemap] uploading $FILE ($(du -h "$FILE" | cut -f1)) -> $R2_REMOTE:$R2_BUCKET/$KEY"
# copyto: deterministic destination key (not a dir). --s3-no-check-bucket skips the account-level
# HeadBucket/CreateBucket probe rclone does by default — our R2 token is bucket-scoped, so that probe
# 403s (see README); we know the bucket exists. Larger chunks speed the multi-GB multipart upload.
rclone copyto "$FILE" "$R2_REMOTE:$R2_BUCKET/$KEY" \
  --s3-no-check-bucket \
  --s3-chunk-size=64M \
  --progress

echo ""
echo "[basemap] uploaded: $R2_REMOTE:$R2_BUCKET/$KEY"
if [[ -n "${R2_PUBLIC_BASE_URL:-}" ]]; then
  SERVING_URL="${R2_PUBLIC_BASE_URL%/}/$KEY"
  echo "[basemap] set this in VITE_PMTILES_URL (web) / EXPO_PUBLIC_PMTILES_URL (mobile):"
  echo ""
  echo "  $SERVING_URL"
  echo ""
else
  echo "[basemap] R2_PUBLIC_BASE_URL is unset — enable public access on the bucket (r2.dev or a"
  echo "          custom domain, see README), then set R2_PUBLIC_BASE_URL in scripts/basemap/.env.local."
  echo "          The serving URL will be:  <R2_PUBLIC_BASE_URL>/$KEY"
fi
