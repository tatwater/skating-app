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

# `--recut` may appear anywhere; everything else is positional as before.
RECUT=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--recut" ]]; then RECUT=true; else ARGS+=("$arg"); fi
done

LIST="${ARGS[0]:-}"
SEASON="${ARGS[1]:-}"
MAX_ROUNDS="${ARGS[2]:-6}"
if [[ -z "$LIST" || -z "$SEASON" ]]; then
  echo "usage: backfill.sh <granules.txt> <season> [max-rounds] [--recut]" >&2
  echo "  --recut  re-cut granules that already have a frame — see the note on landed()" >&2
  exit 64
fi

# The instant this run began, in the format R2 reports modification times in. Everything written
# before it is last week's numbers as far as `--recut` is concerned.
RUN_STARTED_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$RECUT" == true ]] && echo "[backfill] --recut: a frame counts only if written after $RUN_STARTED_ISO"

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
# ## ⚠ `--recut` — because "already there" is the wrong question when replacing an archive
#
# This loop reconciles on **presence**: list the bucket, spawn the difference, repeat. That is exactly
# right when filling a season for the first time, and exactly wrong when re-cutting one. Every frame is
# already present, so a re-cut run reports `4,485/4,485 landed`, spawns nothing, exits 0 in thirty
# seconds and looks like a triumph.
#
# Caught 2026-08-25 on a 42-granule Mascoma run that finished before it could have started one job.
#
# So `--recut` reconciles on **freshness** instead: a manifest counts as landed only if the bucket says
# it was written *after this run began*. That keeps the retry property intact — a job that fails mid-run
# leaves its OLD manifest in place, which is correctly still stale, so the next round tries it again.
# Reconciling on presence there would see the stale frame, call it landed, and leave the re-cut with a
# silent hole wearing last week's numbers.
#
# The modification time comes from the listing this already performs, so freshness costs nothing extra.
landed() {
  local listing status=0
  if [[ "$RECUT" == true ]]; then
    # ⚠ **Epoch seconds, never a string compare.** rclone reports modification times in LOCAL time
    # with an offset (`2026-08-25T22:31:02.234857910-04:00`) while the run's start is UTC with `Z`.
    # Compared as text, `2026-08-25T22:36…-04:00` sorts BEFORE `2026-08-26T02:35…Z` even though it is
    # a minute later — so every fresh frame would read as stale, nothing would ever converge, and the
    # loop would re-spawn the whole season once per round until it hit `max-rounds`.
    listing="$(rclone lsjson "r2:${BUCKET}/frames/${SEASON}/" --s3-no-check-bucket 2>/dev/null \
      | jq -r --arg since "$RUN_STARTED_ISO" '
          def epoch:
            capture("(?<dt>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?<off>Z|[+-][0-9]{2}:[0-9]{2})")
            | ((.dt + "Z") | fromdateiso8601)
              - (if .off == "Z" then 0
                 else (if .off[0:1] == "-" then -1 else 1 end)
                      * ((.off[1:3] | tonumber) * 3600 + (.off[4:6] | tonumber) * 60)
                 end);
          ($since | epoch) as $cut
          | .[] | select(.Name | endswith(".json")) | select((.ModTime | epoch) > $cut) | .Name
        ')" || status=$?
    if (( status != 0 && status != 3 )); then
      echo "[backfill] FATAL: cannot list r2:${BUCKET}/frames/${SEASON}/ (rclone exit $status)" >&2
      return 1
    fi
    printf '%s\n' "$listing" | sed -n 's/\.json$//p' | sort
    return 0
  fi
  listing="$(rclone lsf "r2:${BUCKET}/frames/${SEASON}/" --s3-no-check-bucket 2>/dev/null)" || status=$?
  if (( status != 0 && status != 3 )); then
    echo "[backfill] FATAL: cannot list r2:${BUCKET}/frames/${SEASON}/ (rclone exit $status)" >&2
    return 1
  fi
  # ⚠ **Landed is the MANIFEST, `<granuleId>.json` — never the `.pmtiles`.**
  #
  # Two reasons, and the second is the one that bites.
  #
  # 1. A granule yields more than one frame, keyed by band (`-visual`, `-scl`, `-vv`, `-vh`), so
  #    `<granuleId>.pmtiles` names none of them. Matching `.pmtiles` at all therefore needs the band
  #    suffix stripped back off, which needs "granule ids contain no `-`" to hold forever on every
  #    mission we ever add. It happens to hold today. It is not a thing to depend on.
  #
  # 2. **A frame object does not mean the job finished.** `cut-granule` uploads visual, then SCL,
  #    then the manifest, each `|| die` — so a network blip on the SCL or manifest PUT, or a Machine
  #    killed between them, leaves `-visual.pmtiles` sitting in the bucket with no manifest behind
  #    it. Reducing that object to its granule id marks the granule landed, and it is then never
  #    retried; meanwhile `build-index` derives the season index from `*.json` under `frames/` and
  #    only from those, so the frame is invisible to every client forever. A silent permanent hole,
  #    paid for in storage, on the one loop whose whole job is noticing holes.
  #
  # The manifest is written last and is a single small PUT, which R2 stores atomically — so its
  # presence means every earlier step succeeded. That makes "landed" mean "will appear in the index",
  # which is the property this loop actually cares about, and it needs no suffix stripping at all.
  # A half-uploaded granule now reads as missing and gets re-spawned, which overwrites the orphan.
  #
  # The only `.json` under `frames/<season>/` is the per-granule manifest; the mask sidecar lives at
  # `masks/<season>.json`, a different prefix, and `lsf` does not recurse.
  #
  # `sed -n …p` rather than `grep | sed`: it selects and strips in one pass and exits 0 on no match.
  printf '%s\n' "$listing" | sed -n 's/\.json$//p' | sort
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
