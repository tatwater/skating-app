#!/usr/bin/env bash
# Upload a self-built `.pmtiles` basemap to Convex file storage and print the serving URL to
# wire into VITE_PMTILES_URL. Thin glue over the Convex CLI + curl — see this dir's README.
#
#   scripts/basemap/upload.sh <file.pmtiles> [--prod]
#
# Dev-first (same rule as the ETL loader): targets the dev deployment unless --prod is passed,
# so the normal command can't touch production by accident.
set -euo pipefail

FILE=""
PROD=""
for arg in "$@"; do
  case "$arg" in
    --prod) PROD="--prod" ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) FILE="$arg" ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo "usage: scripts/basemap/upload.sh <file.pmtiles> [--prod]" >&2
  exit 1
fi
if [[ ! -f "$FILE" ]]; then
  echo "no such file: $FILE" >&2
  exit 1
fi

# Run the Convex CLI from the convex package (reads its .env.local for the dev deployment).
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
run_convex() {
  (cd "$REPO_ROOT/packages/convex" && pnpm exec convex run "$@" ${PROD:+$PROD})
}

TARGET="dev"; [[ -n "$PROD" ]] && TARGET="PRODUCTION"
echo "[basemap] target: $TARGET · file: $FILE ($(du -h "$FILE" | cut -f1))"

echo "[basemap] minting upload URL…"
UPLOAD_URL="$(run_convex basemap:generateUploadUrl 2>/dev/null | tr -d '"')"
if [[ -z "$UPLOAD_URL" ]]; then echo "[basemap] failed to get upload URL" >&2; exit 1; fi

echo "[basemap] uploading (this can take a minute for a ~280 MB file)…"
RESP="$(curl -s -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$FILE" "$UPLOAD_URL")"
STORAGE_ID="$(printf '%s' "$RESP" | sed -n 's/.*"storageId":"\([^"]*\)".*/\1/p')"
if [[ -z "$STORAGE_ID" ]]; then echo "[basemap] upload failed: $RESP" >&2; exit 1; fi
echo "[basemap] stored: $STORAGE_ID"

SERVING_URL="$(run_convex basemap:getServingUrl "{\"storageId\":\"$STORAGE_ID\"}" 2>/dev/null | tr -d '"')"
# getServingUrl returns null if the id can't be resolved; never print VITE_PMTILES_URL=null.
if [[ -z "$SERVING_URL" || "$SERVING_URL" == "null" ]]; then
  echo "[basemap] failed to resolve serving URL for: $STORAGE_ID" >&2
  exit 1
fi
echo ""
echo "[basemap] done. Set this ($TARGET) in VITE_PMTILES_URL:"
echo ""
echo "  VITE_PMTILES_URL=$SERVING_URL"
echo ""
