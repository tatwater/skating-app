#!/usr/bin/env bash
#
# Mirror the permanent raw snapshot archive to/from a PRIVATE R2 bucket (N6b).
#
#   scripts/bathymetry/mirror-r2.sh push [<key>]
#   scripts/bathymetry/mirror-r2.sh pull [<key>]
#   scripts/bathymetry/mirror-r2.sh status
#
# Why this exists: `.raw/` is the archive that makes reprocessing free, and an archive that lives on
# exactly one laptop is not an archive. This is the second copy.
#
# ⚠ DELIBERATELY A DIFFERENT BUCKET FROM THE BASEMAP. `skating-basemap` has r2.dev public access
# enabled so the browser can range-read the .pmtiles; putting third-party state data under it would
# republish that data to the internet as a side effect of backing it up. This bucket stays private —
# it is our copy of someone else's data, not a distribution channel.
#
# One-time setup (see scripts/basemap/README.md for the rclone remote itself, which is shared):
#   1. Create a PRIVATE R2 bucket, e.g. `skating-raw`. Do NOT enable public access.
#   2. Ensure the existing `r2` rclone remote's token has Object Read & Write on it (or mint a
#      second token scoped to both buckets).
#   3. cp scripts/bathymetry/.env.example scripts/bathymetry/.env.local  and set RAW_BUCKET.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_DIR="$HERE/.raw"

# shellcheck disable=SC1091
[ -f "$HERE/.env.local" ] && source "$HERE/.env.local"

RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
RAW_BUCKET="${RAW_BUCKET:-skating-raw}"
REMOTE="$RCLONE_REMOTE:$RAW_BUCKET/bathymetry"

command -v rclone >/dev/null || { echo "rclone not found — brew install rclone" >&2; exit 1; }

# The basemap's token is scoped to `skating-basemap` alone, so it cannot see — let alone create — the
# raw bucket. That is the secure, expected result rather than a misconfiguration, but the raw 403 it
# produces is unreadable, so say what is actually needed.
preflight() {
  if ! rclone lsjson "$RCLONE_REMOTE:$RAW_BUCKET" --max-depth 1 >/dev/null 2>&1; then
    cat >&2 <<MSG
✗ Can't reach $RCLONE_REMOTE:$RAW_BUCKET.

  This is expected until the bucket exists and the token can see it. One-time setup:

    1. Cloudflare R2 → Create bucket → "$RAW_BUCKET".
       Leave public access OFF. This is our copy of third-party state data, not a
       distribution channel — and it is deliberately NOT the basemap bucket, which
       has r2.dev public access enabled for browser range-reads.

    2. R2 → Manage API Tokens → Object Read & Write, scoped to "$RAW_BUCKET"
       (or widen the existing token to cover both buckets).

    3. Point rclone at it — either widen the existing "$RCLONE_REMOTE" remote's
       credentials, or add a second remote and set RCLONE_REMOTE in
       scripts/bathymetry/.env.local.

  Until then the archive lives only on this machine, which is the thing the mirror exists to fix.
MSG
    exit 1
  fi
}

MODE="${1:-}"
KEY="${2:-}"

case "$MODE" in
  push)
    preflight
    mkdir -p "$RAW_DIR"
    if [ -n "$KEY" ]; then
      echo "→ pushing $KEY to $REMOTE/$KEY"
      rclone copy "$RAW_DIR/$KEY" "$REMOTE/$KEY" --progress
    else
      echo "→ pushing the whole archive to $REMOTE"
      # `copy`, never `sync`: sync would propagate a local deletion to the remote copy, which is the
      # one thing a backup must not do.
      rclone copy "$RAW_DIR" "$REMOTE" --progress
    fi
    ;;
  pull)
    preflight
    mkdir -p "$RAW_DIR"
    if [ -n "$KEY" ]; then
      echo "← pulling $KEY from $REMOTE/$KEY"
      rclone copy "$REMOTE/$KEY" "$RAW_DIR/$KEY" --progress
    else
      echo "← pulling the whole archive from $REMOTE"
      rclone copy "$REMOTE" "$RAW_DIR" --progress
    fi
    ;;
  status)
    echo "local  $RAW_DIR"
    [ -d "$RAW_DIR" ] && du -sh "$RAW_DIR"/* 2>/dev/null || echo "  (empty)"
    echo
    echo "remote $REMOTE"
    rclone size "$REMOTE" 2>/dev/null || echo "  (not reachable / not created yet)"
    ;;
  *)
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
