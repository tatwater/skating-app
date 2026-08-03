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

#
# `--s3-no-check-bucket` is required, not a tuning knob.
#
# rclone's S3 backend issues a `CreateBucket` before its first upload to a bucket it has not seen
# succeed in this process. R2 answers that with **403 AccessDenied** for any Object Read & Write
# token — which is every token we use, and correctly so: a backup mirror has no business being able
# to create buckets. The failure is doubly misleading because it names `CreateBucket` on a bucket
# that plainly exists and that `rclone ls` just listed without complaint.
#
# It only bites an EMPTY bucket, which is why four mirrors have worked and this was found on the
# fifth. `skating-raw-wind-climate` is empty too and would have hit it on its first push.
#
RCLONE_FLAGS=(--s3-no-check-bucket)

preflight() {
  if ! rclone lsjson "${RCLONE_FLAGS[@]}" "$REMOTE" --max-depth 1 >/dev/null 2>&1; then
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

#
# Write one `importRuns` row for a push, via the run-log CLI (N6c F2).
#
# Everything here is best-effort and swallowed: a mirror push that succeeded must not report failure
# because its receipt could not be filed. `rclone size` is asked *after* the push, so the counts
# describe what is now in the bucket rather than what we hoped to put there — the number an operator
# actually wants when asking "is the archive complete".
#
record_run() {
  local rc="$1" started_at="$2" key="$3"
  local status="succeeded" error="null" objects=0 bytes=0 remote_json

  [ "$rc" -eq 0 ] || { status="failed"; error="\"rclone exited $rc\""; }

  if remote_json=$(rclone size "${RCLONE_FLAGS[@]}" "$REMOTE" --json 2>/dev/null); then
    objects=$(printf '%s' "$remote_json" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')
    bytes=$(printf '%s' "$remote_json" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
  fi
  : "${objects:=0}" "${bytes:=0}"

  local scope="the whole archive"
  [ -n "$key" ] && scope="$key only"

  printf '%s' "{
    \"kind\": \"r2_mirror\",
    \"label\": \"$ARCHIVE_LABEL → $RAW_BUCKET\",
    \"status\": \"$status\",
    \"startedAt\": $started_at,
    \"finishedAt\": $(date +%s)000,
    \"error\": $error,
    \"counts\": [
      {\"name\": \"objectsInBucket\", \"value\": $objects},
      {\"name\": \"bytesInBucket\", \"value\": $bytes}
    ],
    \"stages\": [{
      \"name\": \"mirror\",
      \"detail\": \"rclone copy (never sync — a local deletion must not propagate to the backup); pushed $scope\",
      \"command\": \"rclone copy $ARCHIVE_DIR $REMOTE\",
      \"input\": \"$ARCHIVE_DIR\",
      \"output\": \"$REMOTE\",
      \"bytes\": $bytes
    }],
    \"notes\": [\"Object and byte counts are read back from the bucket after the push, so they describe what is actually there.\"]
  }" | (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pnpm --filter @skating/run-log record) 2>&1 |
    sed 's/^/[mirror] /' || true
}

mirror_main() {
  local mode="${1:-}" key="${2:-}"
  case "$mode" in
    push)
      preflight
      mkdir -p "$ARCHIVE_DIR"
      local started_at rc=0
      started_at=$(date +%s)000
      if [ -n "$key" ]; then
        echo "→ pushing $ARCHIVE_LABEL/$key to $REMOTE/$key"
        rclone copy "${RCLONE_FLAGS[@]}" "$ARCHIVE_DIR/$key" "$REMOTE/$key" --progress || rc=$?
      else
        echo "→ pushing the $ARCHIVE_LABEL archive to $REMOTE"
        rclone copy "${RCLONE_FLAGS[@]}" "$ARCHIVE_DIR" "$REMOTE" --progress || rc=$?
      fi
      # File the receipt (N6c F2). The push is the step that makes an archive durable, and "when did
      # we last mirror this, and did it work" had no answer outside whoever ran it. `|| rc=$?` above
      # rather than letting `set -e` kill us, so a FAILED push is recorded as failed rather than
      # vanishing — the outcome most worth knowing is the one that used to leave no trace.
      record_run "$rc" "$started_at" "$key"
      [ "$rc" -eq 0 ] || exit "$rc"
      ;;
    pull)
      preflight
      mkdir -p "$ARCHIVE_DIR"
      if [ -n "$key" ]; then
        echo "← pulling $ARCHIVE_LABEL/$key from $REMOTE/$key"
        rclone copy "${RCLONE_FLAGS[@]}" "$REMOTE/$key" "$ARCHIVE_DIR/$key" --progress
      else
        echo "← pulling the $ARCHIVE_LABEL archive from $REMOTE"
        rclone copy "${RCLONE_FLAGS[@]}" "$REMOTE" "$ARCHIVE_DIR" --progress
      fi
      ;;
    status)
      echo "archive  $ARCHIVE_LABEL"
      echo "local    $ARCHIVE_DIR"
      if [ -d "$ARCHIVE_DIR" ]; then du -sh "$ARCHIVE_DIR"/* 2>/dev/null || echo "  (empty)"; else echo "  (missing)"; fi
      echo
      echo "remote   $REMOTE"
      rclone size "${RCLONE_FLAGS[@]}" "$REMOTE" 2>/dev/null || echo "  (not reachable — run push for setup instructions)"
      ;;
    *)
      echo "usage: $(basename "$0") push|pull|status [<key>]" >&2
      exit 1
      ;;
  esac
}
