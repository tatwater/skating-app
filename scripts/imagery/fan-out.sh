#!/usr/bin/env bash
#
# Spawn one throwaway Fly Machine per granule (N6e PR 2, D148).
#
#   scripts/imagery/fan-out.sh granules.txt              # one granule id per line
#   scripts/imagery/fan-out.sh granules.txt --smoke      # plumbing only, no masking
#   scripts/imagery/fan-out.sh granules.txt --drain      # …and do not return until the Machines are gone
#   echo S2B_18TXP_20260115_0_L2A | scripts/imagery/fan-out.sh -
#
# ## This script is meant to be replaceable, and that is the point
#
# D148's hosting call comes with one condition: *"lock-in is low if orchestration stays host-neutral —
# make the container's entrypoint take one granule id and keep 'which granules, when' outside Fly's
# Machines API."* This file is the entire Fly-specific surface of the pipeline. Everything that decides
# *what* to cut lives upstream of it and everything that does the cutting lives in the container, so
# leaving Fly means rewriting this one file against another runner. Keep it that way: no granule
# selection logic below this line, no STAC queries, no season logic.
#
# ## Why per-job Machines rather than a worker pool
#
# Per-second billing with no barrier between jobs means 25 Machines for an hour costs what one Machine
# costs for 25 hours. A season's ~750 granules is five days serial and a few hours fanned out, at the
# same total spend (§C2). A pool would add scheduling, idle time, and a reason to care which host a job
# lands on --- all of which we get to not have.
set -euo pipefail

# `mapfile` and `wait -n` are bash 4+. macOS still ships bash 3.2 at /bin/bash, so this fails loudly
# rather than silently fanning out zero granules if someone invokes it with the system shell.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "fan-out.sh needs bash 4+ (you have ${BASH_VERSION}). macOS /bin/bash is 3.2 — use \`brew install bash\`." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/.env.local" ]] && { set -a; . "$HERE/.env.local"; set +a; }

APP="${FLY_APP:-skating-imagery}"
REGION="${FLY_REGION:-sjc}"
IMAGE="${FLY_IMAGE:-}"
MAX_PARALLEL="${MAX_PARALLEL:-25}"
MASK_SEASON="${MASK_SEASON:-}"

# ⚠ **`fly machine run` does NOT read `fly.toml`'s `[[vm]]` block.** That file sizes machines created
# by `fly deploy`, and this app never deploys — so a job spawned without an explicit size gets Fly's
# default, which is far smaller. Found the hard way on 2026-08-23: the first real transform died with
# `gdalwarp ... Killed`, an OOM wearing a generic exit code, on a granule that warps fine in 8 GB.
VM_SIZE="${FLY_VM_SIZE:-shared-cpu-4x}"

# ⚠ **And `--vm-size` sets CPUs, not memory.** `shared-cpu-4x` comes with 1 GB by default, so passing
# only the size fixes half the OOM and leaves the other half looking fixed — `fly machine list` shows
# `shared-cpu-4x:1024MB`. A 20-granule slice then cut 49–498 bodies happily and lost one job to
# `FATAL: overview build failed`, which is `gdaladdo` running out of room on a big tile.
#
# The two flags are independent and both are required. There is no size name that implies the memory
# this workload needs.
#
# ## ⚠ 2048, not 8192 — RAM was 82% of everything this project has ever spent
#
# Fly's dashboard, 2026-08-24, against $6.36 of lifetime spend: **$5.19 "Machines Shared 4x —
# Additional RAM"**, $1.15 CPU, $0.00 egress. Published `shared-cpu-4x` rates per machine-hour are
# 1 GB $0.0112, 2 GB $0.0184, 4 GB $0.0329, 8 GB $0.0617 — so the RAM dial, not the CPU one, decides
# whether nine seasons costs $19 or $102.
#
# The largest granule in the corpus (Champlain, 923 bodies, 237.7 Mpixels) completes in 1024 MB.
# 2048 is the tested-safe setting with room to spare, and it is what makes the founder's $40 ceiling
# comfortable rather than marginal. See the `GDAL_CACHEMAX` note in the Dockerfile for why dropping
# the RAM does *not* drop the block cache with it.
VM_MEMORY="${FLY_VM_MEMORY:-2048}"

INPUT="${1:-}"
SMOKE_FLAG=""
DRAIN=false
for arg in "${@:2}"; do
  case "$arg" in
    --smoke) SMOKE_FLAG="--smoke" ;;
    --drain) DRAIN=true ;;
    *) echo "fan-out.sh: unknown option $arg" >&2; exit 64 ;;
  esac
done

if [[ -z "$INPUT" ]]; then
  echo "usage: fan-out.sh <granules.txt|-> [--smoke] [--drain]" >&2
  exit 64
fi

command -v fly >/dev/null 2>&1 || { echo "flyctl not installed (brew install flyctl)" >&2; exit 1; }

# The image is pinned by digest/label rather than resolved at spawn time, so every Machine in a
# fan-out runs *the same code*. Letting 750 jobs each resolve ':latest' is how a backfill ends up
# half-cut by one build and half by another, with nothing in the artifact to say which.
if [[ -z "$IMAGE" ]]; then
  echo "FLY_IMAGE is unset. Build and push first, then pin the printed ref:" >&2
  echo "" >&2
  echo "  fly deploy --build-only --push --app $APP" >&2
  echo "  export FLY_IMAGE=registry.fly.io/$APP:deployment-XXXXX" >&2
  echo "" >&2
  exit 1
fi

# ⚠ **Refused here rather than discovered 750 times.** `cut-granule` dies in its first second without
# `MASK_SEASON` — it has no way to guess which season's reveal geometry to clip against — and this
# script forwards the variable without ever looking at it. So an unset one spawns the whole list, every
# Machine exits 1, and every line below still says "spawned": the exact shape of the 2026-08-23 comment
# bug, which is why the same up-front refusal FLY_IMAGE gets applies here. `--smoke` is exempt because
# it never reads a mask.
if [[ -z "$MASK_SEASON" && -z "$SMOKE_FLAG" ]]; then
  echo "MASK_SEASON is unset. It names the reveal masks a cut clips against — and it is NOT the" >&2
  echo "frame's season, which cut-granule derives from the capture date (see cut-granule.sh)." >&2
  echo "" >&2
  echo "  export MASK_SEASON=winter-2026-27   # whichever bake-masks last uploaded" >&2
  echo "  rclone lsf r2:\${R2_BUCKET:-skating-imagery}/masks/   # to see what is staged" >&2
  echo "" >&2
  exit 1
fi

mapfile -t GRANULES < <(if [[ "$INPUT" == "-" ]]; then cat; else cat "$INPUT"; fi | sed 's/#.*//' | tr -d '\r' | grep -v '^[[:space:]]*$')
COUNT=${#GRANULES[@]}
[[ $COUNT -gt 0 ]] || { echo "no granule ids in $INPUT" >&2; exit 1; }

echo "[fan-out] $COUNT granules -> app=$APP region=$REGION vm=$VM_SIZE/${VM_MEMORY}MB"
echo "[fan-out] image=$IMAGE"
[[ -n "$SMOKE_FLAG" ]] && echo "[fan-out] SMOKE MODE — plumbing only, no masking"

# How many Machines are alive right now, which is the only number worth throttling on.
#
# ⚠ **Every live state, not just `started`.** A Machine spends its first seconds in `created` and
# `starting` and its last in `replacing`, and during a burst of spawns those are exactly the ones
# piling up — counting only `started` undercounts precisely the load this throttle exists to bound.
# Matched lower-case, which is what flyctl prints in the STATE column; the uppercase `CREATED` header
# cannot collide.
#
# ⚠ **And an API error is not zero Machines.** `|| true` on the pipeline used to turn a failed list
# into "nothing is running", which switches the throttle off exactly when Fly is unhappy — the moment
# it matters most. A failure reports the cap instead, so the caller waits rather than floods; the wait
# is bounded and prints a warning, where the flood cost most of a backfill.
live_machines() {
  local listed
  if ! listed="$(fly machine list --app "$APP" 2>/dev/null)"; then
    echo "$MAX_PARALLEL"
    return 0
  fi
  printf '%s\n' "$listed" | grep -cE '(created|starting|started|replacing)' || true
}

# ⚠ **Wait on RUNNING Machines, not on spawn calls.**
#
# The obvious throttle — cap the number of concurrent `fly machine run` invocations — does not
# throttle anything once `--detach` is in play. A detached spawn returns as soon as the Machine is
# *created*, in well under a second, while the job it started runs for 20 s to 2 min. So a cap of 25
# spawn calls creates Machines roughly fifty times faster than they retire.
#
# Measured 2026-08-23, and it cost most of a backfill: 2,345 granules spawned under a `MAX_PARALLEL=25`
# that was really a spawn-rate cap piled up thousands of simultaneous Machines, and only 359 of ~1,523
# expected frames landed. Re-running the same granules 30 at a time produced them without a single
# failure, which is what ruled out the granules and pointed at the concurrency.
#
# Polling `fly machine list` is crude and costs an API call per batch. It is also the only number that
# corresponds to load, and a backfill that takes twenty minutes longer is free next to one that
# silently drops three quarters of its work.
#
# ⚠ **Waiting for room for *one* more is not a cap.** The check runs once per batch, so returning as
# soon as `live < MAX_PARALLEL` lets a whole batch land on top of a cap that had only just been
# reached — a real ceiling of `MAX_PARALLEL + BATCH`. Waiting for room for the batch is what makes
# MAX_PARALLEL mean what this file says it means.
await_capacity() {
  local live
  for _ in $(seq 1 240); do
    live="$(live_machines)"
    (( live + BATCH <= MAX_PARALLEL )) && return 0
    sleep 5
  done
  echo "[fan-out] ⚠ still $live Machines alive after 20 min — continuing anyway" >&2
}

# Wait until nothing is left running. `--drain` turns a fan-out from "the spawns returned" into "the
# work is over", which is what a reconciling caller needs before it asks the bucket what landed —
# counting frames while Machines are still writing reads as failure and triggers a pointless round
# against jobs that were about to succeed. It lives here because this is the only file that is allowed
# to know about Fly.
await_drain() {
  local live
  echo "[fan-out] waiting for Machines to drain…"
  for _ in $(seq 1 360); do
    live="$(live_machines)"
    (( live == 0 )) && { echo "[fan-out] drained."; return 0; }
    sleep 10
  done
  echo "[fan-out] ⚠ $live Machines still alive after an hour — draining gave up" >&2
}

# Spawns between capacity checks. A quarter of the cap: `await_capacity` polls Fly once per batch, so
# a batch of `MAX_PARALLEL` would make the overshoot as large as the cap itself, while a batch of one
# would cost an API call per granule. A quarter is four calls per cap's worth of spawns.
# ⚠ **A spawn that hangs must not wedge the backfill.**
#
# `fly machine run` normally returns in under a second with `--detach`. On 2026-08-25 four of them did
# not return **for over an hour** — with zero Machines alive, so nothing was billing and nothing was
# progressing. The parent's closing `wait` blocked forever, `--drain` was never reached, and
# `backfill.sh` sat on a round that had already done its work. The season looked stalled at 4,365 of
# 4,485 frames when in fact only 16 granules were outstanding.
#
# A bounded spawn turns that from a wedge into a reported failure, which the reconcile loop already
# knows how to retry. macOS has no `timeout(1)`; `gtimeout` arrives with coreutils, and where neither
# exists this degrades to calling `fly` directly rather than refusing to run.
SPAWN_TIMEOUT="${SPAWN_TIMEOUT:-120}"
if command -v timeout >/dev/null 2>&1; then :
elif command -v gtimeout >/dev/null 2>&1; then timeout() { gtimeout "$@"; }
else timeout() { shift; "$@"; }; fi

BATCH=$(( MAX_PARALLEL / 4 ))
(( BATCH < 1 )) && BATCH=1

SPAWNED=0
running=0
for granule in "${GRANULES[@]}"; do
  if (( running >= MAX_PARALLEL )); then
    wait -n
    running=$((running - 1))
  fi
  # Re-checked every `BATCH` spawns rather than every spawn, so the poll cost stays proportional to
  # batches and not to granules.
  # ⚠ **`wait` before polling, or the cap is fiction.**
  #
  # `await_capacity` reads `fly machine list` and then spawns a batch — so a spawn issued since the
  # last poll is not in the count it acted on. Compounding that, the spawn calls run as background
  # subshells capped at `MAX_PARALLEL` *spawn calls* rather than at Machines, so up to a cap's worth
  # can be in flight against a reading that predates all of them. Measured 2026-08-25 on the season
  # backfill: **58–71 live Machines against a cap of 50**, after the same script held at exactly 50 on
  # a single-wave test.
  #
  # `fly machine run --detach` returns once the Machine is *created*, so once every call in a batch has
  # returned, `fly machine list` has seen every Machine we asked for and the next poll is accurate.
  # That puts the peak at exactly `MAX_PARALLEL` — which is what makes a cap something you can set
  # deliberately rather than drift into.
  (( SPAWNED % BATCH == 0 )) && { wait; running=0; await_capacity; }
  SPAWNED=$((SPAWNED + 1))

  (
    # --rm and --restart no together are what make this a batch job: the Machine is destroyed when
    # the process exits, and a failure is a failure rather than a crash loop quietly re-reading the
    # same granule on our bill. `on-failure` is flyctl's default and is wrong for every job here.
    # --detach is not optional here. Without it `fly machine run` monitors the Machine after creating
    # it and does not return for minutes even though the job itself exits in seconds — which would
    # make the MAX_PARALLEL throttle below meter spawn *monitoring* rather than spawn *concurrency*,
    # and stall a 750-granule backfill for hours. Measured 2026-08-22: a job that ran and exited in
    # ~2s held the CLI for over 5 minutes. Watch jobs with `fly logs`, not with the spawning process.
    # ⚠ **No comments inside this command.** A `#` line between backslash-continuations does not
    # comment "within" the command — the continuation splices the lines, so the `#` terminates the
    # whole thing and every argument after it silently disappears. A comment sat between `--restart`
    # and `-- "$granule"` here on 2026-08-23 and twenty Machines booted, ran `cut-granule` with no
    # granule id at all, and exited 64. Nothing in the spawn output said anything was wrong.
    #
    # `--name` makes the dashboard and `fly logs` readable during a backfill. The tradeoff: names must
    # be unique, so re-spawning a granule whose previous Machine is still being destroyed fails the
    # spawn (reported below, not swallowed) — the right failure, since it means the earlier job is
    # still on the bill.
    #
    # `FLY_VM_SIZE_LABEL` is what `cut-granule` stamps into every manifest's `cost.vmSize`. It had
    # never been passed, so every manifest ever written recorded `"unknown"` — leaving the one
    # artifact designed to compare cost across Machine sizes blind, at exactly the moment we started
    # changing the most expensive setting on the box. The manifests are the permanent record (`fly
    # logs` ages out in hours), so a size that is not stamped is a measurement that cannot be redone.
    timeout "$SPAWN_TIMEOUT" fly machine run "$IMAGE" \
      --app "$APP" \
      --region "$REGION" \
      --vm-size "$VM_SIZE" \
      --vm-memory "$VM_MEMORY" \
      --detach \
      --rm \
      --restart no \
      ${MASK_SEASON:+--env "MASK_SEASON=$MASK_SEASON"} \
      --env "FLY_VM_SIZE_LABEL=$VM_SIZE/${VM_MEMORY}MB" \
      --name "granule-$(echo "$granule" | tr '[:upper:]_' '[:lower:]-')" \
      -- "$granule" $SMOKE_FLAG \
      >/dev/null 2>&1 \
      && echo "[fan-out]   spawned $granule" \
      || echo "[fan-out]   FAILED to spawn $granule" >&2
  ) &
  running=$((running + 1))
done

wait
echo ""
echo "[fan-out] all $COUNT spawn calls returned."
[[ "$DRAIN" == true ]] && await_drain
echo ""
# **A spawn is not a result, and this script cannot tell you otherwise.** Jobs run detached, so
# "spawned" means Fly accepted the request — nothing more. The 2026-08-23 comment bug spawned twenty
# Machines that all exited 64 without cutting anything, and every line here said "spawned".
#
# `build-index` is the check, because it builds from what is actually in the bucket: if a job did not
# produce a frame, there is no entry for it. Compare its count against $COUNT.
echo "[fan-out] watch:    fly logs --app $APP"
echo "[fan-out] verify:   pnpm --filter @skating/imagery build-index --dry-run"
echo "[fan-out]           (a spawn is not a result — only the bucket knows what landed)"
