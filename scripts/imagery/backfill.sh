#!/usr/bin/env bash
#
# Run a granule list to completion, retrying whatever did not land (N6e PR 2).
#
#   scripts/imagery/backfill.sh granules.txt <season> [max-rounds]
#   e.g. scripts/imagery/backfill.sh .scratch/granules-2025-11-01-to-2026-05-05.txt winter-2025-26
#
# ## Why a retry loop rather than a more careful fan-out
#
# `fan-out.sh` spawns; it cannot know what happened. Over a few thousand jobs against a cloud provider
# a small fraction will always fail in ways that leave nothing behind — a Machine that is created and
# never starts, a transient API error, a log that has already aged out. Measured 2026-08-23: a
# throttled run of 60 landed 57, and the three that did not were reported as spawned, produced no
# artifact, and left no log to read.
#
# Diagnosing each of those individually is not a good use of anyone's time, and it is not what makes
# the archive correct. **Reconciling is.** Ask the bucket what is there, re-run the difference, repeat
# until the difference stops shrinking. That converges regardless of *why* a job failed, and it is the
# same listing-based check `build-index` uses — the bucket is the only thing that knows.
#
# ## What "stops shrinking" means, and why it is not "reaches zero"
#
# Roughly 40% of any granule list over five states covers only ocean, Québec or empty land, and those
# jobs correctly produce nothing (`nothing to cut`, exit 0). So a miss set never empties. It plateaus,
# and the plateau *is* the empty-granule count. The loop stops when a round adds nothing new, which is
# the honest signal that everything cuttable has been cut.
#
# ## ⚠ `<season>` here is the FRAME season, and it is not `MASK_SEASON`
#
# The two are both spelled `winter-YYYY-YY` and they mean different things (cut-granule.sh, "Two
# seasons, and they are not the same season"). This argument names the bucket prefix a cut *lands* in,
# which `cut-granule` derives from each granule's capture date — so for a list running Nov 2025 → May
# 2026 it is `winter-2025-26`. `MASK_SEASON`, which fan-out.sh forwards from the environment, names the
# reveal geometry those cuts are clipped *against*, and today's corpus is usually the newest bake.
#
# Passing the mask season here instead reconciles against a prefix nothing is writing to, so every
# round finds zero frames — which the loop below reports as such rather than as convergence.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/.env.local" ]] && { set -a; . "$HERE/.env.local"; set +a; }
BUCKET="${R2_BUCKET:-skating-imagery}"

LIST="${1:-}"
SEASON="${2:-}"
MAX_ROUNDS="${3:-6}"
if [[ -z "$LIST" || -z "$SEASON" ]]; then
  echo "usage: backfill.sh <granules.txt> <season> [max-rounds]" >&2
  exit 64
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ⚠ **Normalised exactly the way `fan-out.sh` normalises, or the two disagree about the list.**
#
# fan-out strips `#` comments, CR line endings and blank lines before spawning. A plain `sort -u` here
# does not, so a hand-annotated list — which is the common case for a retry — puts entries in
# `asked.txt` that no Machine will ever be asked to cut. They can therefore never land, the miss set
# never shrinks past them, and the loop reports them as the empty-granule plateau: a wrong number, in
# the one file whose whole job is producing a right one.
#
# One `awk` rather than a `sed | tr | grep` pipeline, because under `pipefail` a `grep` that filters
# everything out exits 1 and takes the script with it.
awk '{ sub(/#.*/, ""); gsub(/\r/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 != "") print }' \
  "$LIST" | sort -u > "$WORK/asked.txt"
TOTAL=$(wc -l < "$WORK/asked.txt" | tr -d ' ')
if (( TOTAL == 0 )); then
  echo "[backfill] no granule ids in $LIST" >&2
  exit 1
fi
echo "[backfill] $TOTAL granules -> season $SEASON"

# ⚠ **`set -euo pipefail` and an empty prefix do not mix, and the first round is always the empty one.**
#
# `rclone lsf` exits 3 when a prefix does not exist yet, which is what an untouched season looks like,
# and a `grep` that matches nothing exits 1. Either one used to kill this script through `pipefail`
# before a single line of output — the whole backfill gone, silently, with exit 1 and no message.
#
# The two cases are separated rather than blanketed with `|| true`, because they are not the same
# thing: "no frames yet" is the normal start, while a credentials or network failure reading as "no
# frames yet" would re-spawn the entire list against a bucket we cannot even see.
landed() {
  local listing status=0
  listing="$(rclone lsf "r2:${BUCKET}/frames/${SEASON}/" --s3-no-check-bucket 2>/dev/null)" || status=$?
  if (( status != 0 && status != 3 )); then
    echo "[backfill] FATAL: cannot list r2:${BUCKET}/frames/${SEASON}/ (rclone exit $status)" >&2
    return 1
  fi
  # ⚠ **A frame object is `<granuleId>-<band>.pmtiles`, not `<granuleId>.pmtiles`.**
  #
  # `cut-granule` started keying uploads by band the moment a granule could yield more than one
  # frame (`-visual`, `-scl`, `-vv`, `-vh`) — and stripping only the extension leaves
  # `S2C_18TXP_20260215_0_L2A-visual`, which never equals the id in `asked.txt`. Every round then
  # reads as "nothing landed", re-spawns the entire list, and after two rounds exits 1 claiming the
  # season prefix is wrong: a whole backfill re-run for a suffix.
  #
  # Granule ids contain no `-` (S2 `S2C_18TXP_…`, S1 `S1A_IW_GRDH_…`), so the trailing `-<band>` is
  # unambiguous. `sort -u` because two bands of one granule are one landed granule, not two.
  #
  # `sed -n …p` rather than `grep | sed`: it selects and strips in one pass and exits 0 on no match.
  printf '%s\n' "$listing" | sed -n 's/\.pmtiles$//p' | sed 's/-[A-Za-z0-9]\{1,\}$//' | sort -u
}

previous_missing=-1
for round in $(seq 1 "$MAX_ROUNDS"); do
  landed > "$WORK/landed.txt"
  comm -23 "$WORK/asked.txt" "$WORK/landed.txt" > "$WORK/missing.txt"
  missing=$(wc -l < "$WORK/missing.txt" | tr -d ' ')
  have=$(comm -12 "$WORK/asked.txt" "$WORK/landed.txt" | wc -l | tr -d ' ')

  echo ""
  echo "[backfill] round $round — $have landed, $missing outstanding"

  if (( missing == 0 )); then
    echo "[backfill] nothing outstanding"
    break
  fi
  # Converged: a whole round produced no new frame, so what is left is the empty-granule plateau
  # rather than work still to do.
  #
  # ⚠ **Unless nothing landed at all, which is not a plateau.** "These granules have nothing under
  # them" is a claim about geography, and it is only credible next to frames that *did* land. A run
  # where the whole list stayed outstanding is far more likely to be a season prefix nothing writes to
  # (see the header) or a job failing identically every time — and reporting that as convergence is
  # how a backfill gets marked done having produced nothing.
  if (( missing == previous_missing )); then
    if (( have == 0 )); then
      echo "[backfill] ⚠ NOT converged — two rounds landed nothing at all under frames/${SEASON}/."
      echo "[backfill]   Check that '$SEASON' is the season the capture dates fall in (not MASK_SEASON),"
      echo "[backfill]   then read one job's log: fly logs --app \${FLY_APP:-skating-imagery}"
      exit 1
    fi
    echo "[backfill] converged — the remaining $missing granules have nothing under them"
    break
  fi
  previous_missing=$missing

  # `--drain` so this returns when the *work* is over rather than when the spawns are. Counting frames
  # while Machines are still writing would read as failure and trigger a pointless extra round against
  # jobs that were about to succeed.
  #
  # The wait lives in fan-out.sh rather than here on purpose: that file documents itself as "the entire
  # Fly-specific surface of the pipeline", and a second `fly machine list` in this one would quietly
  # make that false — two places to update when we leave Fly, and two copies of a state-name grep that
  # has already been wrong once.
  "$HERE/fan-out.sh" "$WORK/missing.txt" --drain
done

landed > "$WORK/landed.txt"
final=$(comm -12 "$WORK/asked.txt" "$WORK/landed.txt" | wc -l | tr -d ' ')
echo ""
echo "[backfill] $final/$TOTAL granules produced a frame"
echo "[backfill] verify: pnpm --filter @skating/imagery build-index"
