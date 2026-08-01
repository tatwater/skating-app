#!/usr/bin/env bash
#
# Shared body for the raw-archive mirrors. Sourced, not run.
#
# A caller sets ARCHIVE_LABEL, ARCHIVE_DIR and DEFAULT_BUCKET, then calls `mirror_main "$@"`. Two
# packages keep permanent `.raw/` archives with the same handling requirements, and letting them
# drift would mean two subtly different definitions of "backed up" — which is the failure mode a
# backup can least afford.
#
# The rules this encodes, in one place:
#
#   * `rclone copy`, NEVER `sync`. Sync propagates a local deletion to the remote copy, which is the
#     one thing a backup must not do.
#   * Private buckets only. The basemap bucket has r2.dev public access on so browsers can range-read
#     the .pmtiles; mirroring third-party source data there would republish it as a side effect of
#     backing it up.
#   * A legible preflight. The raw 403 that a correctly-scoped-but-too-narrow token produces is
#     unreadable, and it is the single most likely thing to go wrong.

set -euo pipefail

RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
RAW_BUCKET="${RAW_BUCKET:-$DEFAULT_BUCKET}"
REMOTE="$RCLONE_REMOTE:$RAW_BUCKET"

command -v rclone >/dev/null || { echo "rclone not found — brew install rclone" >&2; exit 1; }

preflight() {
  if ! rclone lsjson "$REMOTE" --max-depth 1 >/dev/null 2>&1; then
    cat >&2 <<MSG
✗ Can't reach $REMOTE.

  Almost always this is the API token's scope rather than the bucket. A token scoped to a
  different bucket returns 403 for this one — the same response as "doesn't exist", which is
  why this message exists instead of the raw error.

    1. Cloudflare → R2 → Manage API Tokens.
    2. Either widen the token behind the "$RCLONE_REMOTE" remote to include "$RAW_BUCKET",
       or mint an Object Read & Write token scoped to it and add a second rclone remote:

         rclone config create <name> s3 provider=Cloudflare \\
           access_key_id=… secret_access_key=… \\
           endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com region=auto acl=private

       then set RCLONE_REMOTE=<name> in this package's .env.local.
    3. Verify: rclone ls $REMOTE   (empty output = working)

  Until then the $ARCHIVE_LABEL archive lives only on this machine, which is the thing the
  mirror exists to fix.
MSG
    exit 1
  fi
}

mirror_main() {
  local mode="${1:-}" key="${2:-}"
  case "$mode" in
    push)
      preflight
      mkdir -p "$ARCHIVE_DIR"
      if [ -n "$key" ]; then
        echo "→ pushing $ARCHIVE_LABEL/$key to $REMOTE/$key"
        rclone copy "$ARCHIVE_DIR/$key" "$REMOTE/$key" --progress
      else
        echo "→ pushing the $ARCHIVE_LABEL archive to $REMOTE"
        rclone copy "$ARCHIVE_DIR" "$REMOTE" --progress
      fi
      ;;
    pull)
      preflight
      mkdir -p "$ARCHIVE_DIR"
      if [ -n "$key" ]; then
        echo "← pulling $ARCHIVE_LABEL/$key from $REMOTE/$key"
        rclone copy "$REMOTE/$key" "$ARCHIVE_DIR/$key" --progress
      else
        echo "← pulling the $ARCHIVE_LABEL archive from $REMOTE"
        rclone copy "$REMOTE" "$ARCHIVE_DIR" --progress
      fi
      ;;
    status)
      echo "archive  $ARCHIVE_LABEL"
      echo "local    $ARCHIVE_DIR"
      if [ -d "$ARCHIVE_DIR" ]; then du -sh "$ARCHIVE_DIR"/* 2>/dev/null || echo "  (empty)"; else echo "  (missing)"; fi
      echo
      echo "remote   $REMOTE"
      rclone size "$REMOTE" 2>/dev/null || echo "  (not reachable — run push for setup instructions)"
      ;;
    *)
      echo "usage: $(basename "$0") push|pull|status [<key>]" >&2
      exit 1
      ;;
  esac
}
