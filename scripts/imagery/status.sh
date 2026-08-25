#!/usr/bin/env bash
#
# Is the backfill working, draining, finished, or stuck? (N6e PR 2)
#
#   scripts/imagery/status.sh [season] [sample-seconds]
#
# ## Why this exists, and the mistake it is a response to
#
# Machine counts were being read with `fly machine list | grep -c started` — in the throttle *and* in
# every by-hand check. That is the bug the 2026-08-23 review found in `live_machines`, and it makes an
# undercount look like an all-clear: a Machine spends its first seconds in `created`, then `starting`,
# and only then `started`. During a burst most Machines are in the states the grep cannot see.
#
# So "0 machines" was reported repeatedly during a run that was very much still spending money, and
# there was no way to tell that from a run that had genuinely finished. **This file exists so that
# question has one answer instead of an inference.**
#
# Three things it refuses to do:
#
#  1. **Filter by state.** `fly machine list` takes no state filter and lists everything; the count is
#     every row, broken down, with nothing hidden behind a grep.
#  2. **Treat an API failure as zero.** A failed call is reported as UNKNOWN, never as "nothing
#     running" — the direction that would tell you to relax at exactly the wrong moment.
#  3. **Infer progress from a single sample.** It watches for `sample-seconds` and reports the frame
#     delta, because "flat" and "finished" and "wedged" look identical in one reading.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/.env.local" ]] && { set -a; . "$HERE/.env.local"; set +a; }
APP="${FLY_APP:-skating-imagery}"
BUCKET="${R2_BUCKET:-skating-imagery}"
SEASON="${1:-winter-2025-26}"
SAMPLE="${2:-45}"

frames() {
  local out status=0
  out="$(rclone lsf "r2:${BUCKET}/frames/${SEASON}/" --s3-no-check-bucket 2>/dev/null)" || status=$?
  # exit 3 is "prefix does not exist", which is a legitimate zero. Anything else is a failed read and
  # must not be reported as a count.
  if (( status != 0 && status != 3 )); then echo "UNKNOWN"; return; fi
  printf '%s\n' "$out" | grep -c '\.pmtiles$' || true
}

echo "── machines ──────────────────────────────────────────"
if ! machines_json="$(fly machine list --app "$APP" --json 2>/dev/null)"; then
  echo "  UNKNOWN — could not reach the Fly API (NOT the same as zero)"
  MACHINES=-1
else
  MACHINES="$(printf '%s' "$machines_json" | python3 -c "
import json,sys
from collections import Counter
try: ms = json.load(sys.stdin)
except Exception: print(-1); sys.exit()
print(len(ms))
" 2>/dev/null || echo -1)"
  printf '%s' "$machines_json" | python3 -c "
import json,sys
from collections import Counter
try: ms = json.load(sys.stdin)
except Exception:
    print('  UNKNOWN — unparseable response'); sys.exit()
if not ms:
    print('  0 machines, in any state'); sys.exit()
for state, n in Counter(m.get('state','?') for m in ms).most_common():
    print(f'  {n:5d}  {state}')
" 2>/dev/null || echo "  UNKNOWN"
fi

echo ""
echo "── orchestrator ──────────────────────────────────────"
# `{ pgrep || true; } | wc -l`, not `pgrep | wc -l`: pgrep exits 1 when nothing matches, and under
# `pipefail` that kills this script before it can tell you anything — while looking like a crash
# rather than like "no processes running".
BACKFILL_PIDS="$({ pgrep -f 'backfill\.sh' || true; } | wc -l | tr -d ' ')"
FANOUT_PIDS="$({ pgrep -f 'fan-out\.sh' || true; } | wc -l | tr -d ' ')"
echo "  backfill.sh processes: $BACKFILL_PIDS"
echo "  fan-out.sh processes:  $FANOUT_PIDS"

echo ""
echo "── frames (${SEASON}) ────────────────────────────────"
BEFORE="$(frames)"
echo "  $BEFORE  — sampling ${SAMPLE}s…"
sleep "$SAMPLE"
AFTER="$(frames)"
if [[ "$BEFORE" == "UNKNOWN" || "$AFTER" == "UNKNOWN" ]]; then
  DELTA="UNKNOWN"
else
  DELTA=$((AFTER - BEFORE))
fi
echo "  $AFTER  (Δ ${DELTA} in ${SAMPLE}s)"

echo ""
echo "── verdict ───────────────────────────────────────────"
if (( MACHINES < 0 )); then
  echo "  UNKNOWN — the Fly API did not answer. Do not read this as idle."
elif (( MACHINES > 0 )); then
  echo "  WORKING — $MACHINES Machine(s) alive. Billing."
  echo "  stop everything:  fly machine list -q -a $APP | xargs -n1 fly machine destroy --force -a $APP"
elif (( BACKFILL_PIDS > 0 )); then
  # No Machines but the loop is alive: it is between rounds, reconciling against the bucket. That gap
  # is normally seconds. Minutes of it means the loop is wedged, not resting.
  echo "  IDLE, ORCHESTRATOR ALIVE — between rounds (reconciling), nothing billing."
  echo "  If this persists for more than a few minutes it is wedged, not working."
else
  echo "  STOPPED — no Machines, no orchestrator, nothing billing."
  echo "  Whether that is 'finished' or 'died' is in the log's last [backfill] line, not here."
fi
