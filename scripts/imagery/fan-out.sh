#!/usr/bin/env bash
#
# Spawn one throwaway Fly Machine per granule (N6e PR 2, D148).
#
#   scripts/imagery/fan-out.sh granules.txt              # one granule id per line
#   scripts/imagery/fan-out.sh granules.txt --smoke      # plumbing only, no masking
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

INPUT="${1:-}"
SMOKE_FLAG=""
[[ "${2:-}" == "--smoke" ]] && SMOKE_FLAG="--smoke"

if [[ -z "$INPUT" ]]; then
  echo "usage: fan-out.sh <granules.txt|-> [--smoke]" >&2
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

mapfile -t GRANULES < <(if [[ "$INPUT" == "-" ]]; then cat; else cat "$INPUT"; fi | sed 's/#.*//' | tr -d '\r' | grep -v '^[[:space:]]*$')
COUNT=${#GRANULES[@]}
[[ $COUNT -gt 0 ]] || { echo "no granule ids in $INPUT" >&2; exit 1; }

echo "[fan-out] $COUNT granules -> app=$APP region=$REGION image=$IMAGE"
[[ -n "$SMOKE_FLAG" ]] && echo "[fan-out] SMOKE MODE — plumbing only, no masking"

running=0
for granule in "${GRANULES[@]}"; do
  # A crude throttle rather than a scheduler. Fly will happily accept all 750 create calls; the cap
  # exists to keep the org's Machine count legible in the dashboard and to keep a bad build from
  # burning the whole backfill's compute before anyone reads a log.
  if (( running >= MAX_PARALLEL )); then
    wait -n
    running=$((running - 1))
  fi

  (
    # --rm and --restart no together are what make this a batch job: the Machine is destroyed when
    # the process exits, and a failure is a failure rather than a crash loop quietly re-reading the
    # same granule on our bill. `on-failure` is flyctl's default and is wrong for every job here.
    # --detach is not optional here. Without it `fly machine run` monitors the Machine after creating
    # it and does not return for minutes even though the job itself exits in seconds — which would
    # make the MAX_PARALLEL throttle below meter spawn *monitoring* rather than spawn *concurrency*,
    # and stall a 750-granule backfill for hours. Measured 2026-08-22: a job that ran and exited in
    # ~2s held the CLI for over 5 minutes. Watch jobs with `fly logs`, not with the spawning process.
    fly machine run "$IMAGE" \
      --app "$APP" \
      --region "$REGION" \
      --vm-size "$VM_SIZE" \
      --detach \
      --rm \
      --restart no \
      ${MASK_SEASON:+--env "MASK_SEASON=$MASK_SEASON"} \
      # Naming the Machine after its granule is what makes the dashboard and `fly logs` readable
      # during a 750-job backfill. The tradeoff: names must be unique, so re-spawning a granule whose
      # previous Machine has not finished being destroyed will fail the spawn (reported below, not
      # swallowed). That is the right failure — it means the earlier job is still on the bill.
      --name "granule-$(echo "$granule" | tr '[:upper:]_' '[:lower:]-')" \
      -- "$granule" $SMOKE_FLAG \
      >/dev/null 2>&1 \
      && echo "[fan-out]   spawned $granule" \
      || echo "[fan-out]   FAILED to spawn $granule" >&2
  ) &
  running=$((running + 1))
done

wait
echo "[fan-out] all $COUNT spawn calls returned. Machines run detached — watch them with:"
echo "  fly logs --app $APP"
