#!/usr/bin/env bash
#
# The summer aerial's whole Fly surface (B05 §2.2, §2.4): spawn the work tiles' Machines, or the
# assembler's one, and wait for them. `fan-out.sh`'s shape and its hard-won flags, for the aerial's
# own image; the winter cutter's image, scripts and `FLY_IMAGE` are never touched.
#
#   spawn.sh tiles <campaign> <units dir> <work tiles file|-> [--drain]
#       one Machine per listed work tile (`11/<x>/<y>` a line), its unit (`11_<x>_<y>.json`) handed
#       in as a file; at most MAX_PARALLEL Machines alive on the app; `--drain` returns only once
#       every aerial Machine has gone
#   spawn.sh assemble <campaign> [--pilot <name>]
#       one Machine running `assemble-aerial`; returns once it has gone (the assembler's own record
#       in the bucket says whether it succeeded — `cli/assemble.ts` follows it)
#
# **What to cut is decided upstream** (`src/tiles.ts` writes the units, `src/cli/tiles.ts` reconciles
# by done record and calls this per round), and **how** is the image's (`cut-aerial.sh`). This file is
# the only one that knows about Fly, so leaving Fly is rewriting this file (D148's condition).
#
# **A spawn is not a result.** Machines run detached; only a done record whose input hash is the
# manifest's says a work tile landed (`shard.ts`' `shardLanded`), and `cli/tiles.ts` asks the bucket.
#
# Env (from the shell or the gitignored `scripts/aerial/.env.local`; never echo a value):
#   AERIAL_IMAGE         required: the aerial image pinned by digest, `registry.fly.io/…@sha256:…`
#   FLY_APP              default skating-imagery (the winter cutter's app; its own image label)
#   FLY_REGION           default ams — the tiles read Planetary Computer's COGs in Azure West Europe
#   FLY_ASSEMBLE_REGION  default iad — the assembler reads and writes only R2 (see the README)
#   MAX_PARALLEL         default 25 live Machines on the app, the winter pump's included
#   FLY_VM_SIZE / FLY_VM_MEMORY             default shared-cpu-4x / 2048 (a work tile)
#   FLY_ASSEMBLE_VM_SIZE / FLY_ASSEMBLE_MEMORY  default shared-cpu-4x / 4096 (P measured ~2 GB)
set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "spawn.sh needs bash 4+ (you have ${BASH_VERSION}); macOS /bin/bash is 3.2 — brew install bash." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/.env.local" ]] && { set -a; . "$HERE/.env.local" >/dev/null 2>&1; set +a; }

APP="${FLY_APP:-skating-imagery}"
REGION="${FLY_REGION:-ams}"
ASSEMBLE_REGION="${FLY_ASSEMBLE_REGION:-iad}"
MAX_PARALLEL="${MAX_PARALLEL:-25}"
# ⚠ `fly machine run` ignores fly.toml's [[vm]] block, and `--vm-size` sets CPUs, not memory: both
# flags, always (the imagery README's traps 5 and "three more flags").
VM_SIZE="${FLY_VM_SIZE:-shared-cpu-4x}"
VM_MEMORY="${FLY_VM_MEMORY:-2048}"
ASSEMBLE_VM_SIZE="${FLY_ASSEMBLE_VM_SIZE:-shared-cpu-4x}"
ASSEMBLE_MEMORY="${FLY_ASSEMBLE_MEMORY:-4096}"
SPAWN_TIMEOUT="${SPAWN_TIMEOUT:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
CAPACITY_TRIES="${CAPACITY_TRIES:-240}"
DRAIN_TRIES="${DRAIN_TRIES:-720}"
IMAGE="${AERIAL_IMAGE:-}"

usage() {
  echo "usage: spawn.sh tiles <campaign> <units dir> <work tiles file|-> [--drain]" >&2
  echo "       spawn.sh assemble <campaign> [--pilot <name>]" >&2
  exit 64
}

MODE="${1:-}"
CAMPAIGN="${2:-}"
[[ "$MODE" == tiles || "$MODE" == assemble ]] || usage
[[ "$CAMPAIGN" =~ ^naip-(pilot-)?[0-9]{8}$ ]] || { echo "spawn.sh: not a campaign: $CAMPAIGN" >&2; usage; }
STAMP="${CAMPAIGN#naip-}"; STAMP="${STAMP/pilot-/p}"

command -v fly >/dev/null 2>&1 || { echo "flyctl not installed (brew install flyctl)" >&2; exit 1; }

# Pinned by digest, so every Machine of a build runs the same code and its done record can say
# which. A label resolves at spawn time; a digest never moves.
if [[ ! "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "AERIAL_IMAGE must be the aerial image pinned by digest (registry.fly.io/${APP}@sha256:…)." >&2
  echo "Build and push it under its own label first — the README's gated step — and pin the digest" >&2
  echo "it prints. Never the winter cutter's FLY_IMAGE." >&2
  exit 1
fi

# macOS has no timeout(1): gtimeout from coreutils, else unbounded (fan-out.sh's degrade).
if command -v timeout >/dev/null 2>&1; then :
elif command -v gtimeout >/dev/null 2>&1; then timeout() { gtimeout "$@"; }
else timeout() { shift; "$@"; }; fi

# Live Machines on the app, in every live state — and an API error is not zero Machines: it reads as
# the cap, so a failing list makes the caller wait rather than flood (fan-out.sh's lesson).
# `prefix` narrows to Machines named so (the drain waits for ours, not the winter pump's).
live_machines() {
  local prefix="${1:-}" listed
  if ! listed="$(fly machine list --app "$APP" --json 2>/dev/null)"; then
    echo "$MAX_PARALLEL"
    return 0
  fi
  jq --arg p "$prefix" '[.[] | select((.name // "") | startswith($p))
    | select(.state | test("^(created|starting|started|replacing)$"))] | length' <<<"$listed" \
    || echo "$MAX_PARALLEL"
}

# Room for a whole batch before spawning it, or the cap is really MAX_PARALLEL + BATCH.
await_capacity() {
  local live
  for _ in $(seq 1 "$CAPACITY_TRIES"); do
    live="$(live_machines)"
    (( live + BATCH <= MAX_PARALLEL )) && return 0
    sleep "$POLL_SECONDS"
  done
  echo "[spawn] ⚠ still $live Machines alive after waiting — continuing anyway" >&2
}

# Until none of the Machines named with `prefix` is alive.
await_gone() {
  local prefix="$1" live
  for _ in $(seq 1 "$DRAIN_TRIES"); do
    live="$(live_machines "$prefix")"
    (( live == 0 )) && return 0
    sleep "$POLL_SECONDS"
  done
  echo "[spawn] ⚠ $live Machines named ${prefix}* still alive — gave up waiting" >&2
  return 1
}

if [[ "$MODE" == assemble ]]; then
  shift 2
  PILOT=()
  if (( $# > 0 )); then
    [[ "$1" == --pilot && -n "${2:-}" && $# -eq 2 ]] || usage
    PILOT=(--pilot "$2")
  fi
  NAME="aerial-asm-${STAMP}"
  echo "[spawn] assemble $CAMPAIGN -> app=$APP region=$ASSEMBLE_REGION vm=$ASSEMBLE_VM_SIZE/${ASSEMBLE_MEMORY}MB"
  # ⚠ No comments inside this command: a `#` between continuations drops every argument after it.
  timeout "$SPAWN_TIMEOUT" fly machine run "$IMAGE" \
    --app "$APP" \
    --region "$ASSEMBLE_REGION" \
    --vm-size "$ASSEMBLE_VM_SIZE" \
    --vm-memory "$ASSEMBLE_MEMORY" \
    --detach \
    --rm \
    --restart no \
    --name "$NAME" \
    --metadata "aerial=$CAMPAIGN" \
    --env "AERIAL_IMAGE=$IMAGE" \
    -- assemble-aerial "$CAMPAIGN" ${PILOT[@]+"${PILOT[@]}"} \
    >/dev/null 2>&1 || { echo "[spawn] FAILED to spawn the assembler" >&2; exit 1; }
  echo "[spawn] spawned $NAME; waiting for it to finish (fly logs --app $APP)"
  DRAIN_TRIES="${ASSEMBLE_TRIES:-4320}" await_gone "$NAME"
  echo "[spawn] $NAME has gone — its record in the bucket says how it ended"
  exit 0
fi

# --- tiles ---------------------------------------------------------------------------------------
UNITS="${3:-}"
LIST="${4:-}"
[[ -n "$UNITS" && -n "$LIST" ]] || usage
DRAIN=false
for arg in "${@:5}"; do
  case "$arg" in
    --drain) DRAIN=true ;;
    *) echo "spawn.sh: unknown option $arg" >&2; exit 64 ;;
  esac
done
[[ -d "$UNITS" ]] || { echo "spawn.sh: no units directory $UNITS" >&2; exit 1; }

# The same normalization as fan-out.sh and backfill.sh: comments, CRs, whitespace, blank lines.
mapfile -t TILES < <(
  if [[ "$LIST" == "-" ]]; then cat; else cat "$LIST"; fi |
    awk '{ sub(/#.*/, ""); gsub(/\r/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 != "") print }'
)
(( ${#TILES[@]} > 0 )) || { echo "spawn.sh: no work tiles in $LIST" >&2; exit 1; }

# Every unit checked before the first spawn: a missing one found halfway is half a round on the bill.
for tile in "${TILES[@]}"; do
  [[ "$tile" =~ ^11/[0-9]+/[0-9]+$ ]] || { echo "spawn.sh: not a work tile: $tile" >&2; exit 1; }
  [[ -f "$UNITS/${tile//\//_}.json" ]] || { echo "spawn.sh: no unit for $tile in $UNITS" >&2; exit 1; }
done

echo "[spawn] ${#TILES[@]} work tiles -> app=$APP region=$REGION vm=$VM_SIZE/${VM_MEMORY}MB, at most $MAX_PARALLEL alive"
BATCH=$(( MAX_PARALLEL / 4 ))
(( BATCH < 1 )) && BATCH=1
SPAWNED=0
for tile in "${TILES[@]}"; do
  # `wait` before polling, or spawns since the last poll aren't in the count (fan-out.sh).
  (( SPAWNED % BATCH == 0 )) && { wait; await_capacity; }
  SPAWNED=$((SPAWNED + 1))
  IFS=/ read -r _ x y <<<"$tile"
  unit="$UNITS/11_${x}_${y}.json"
  name="aerial-${STAMP}-${x}-${y}"
  (
    # --rm --restart no: a batch job, never a crash loop on the bill. --detach: return once created.
    # --file-local: the unit, written into the Machine at /data/unit.json. No comments below.
    timeout "$SPAWN_TIMEOUT" fly machine run "$IMAGE" \
      --app "$APP" \
      --region "$REGION" \
      --vm-size "$VM_SIZE" \
      --vm-memory "$VM_MEMORY" \
      --detach \
      --rm \
      --restart no \
      --name "$name" \
      --metadata "aerial=$CAMPAIGN" \
      --env "AERIAL_IMAGE=$IMAGE" \
      --file-local "/data/unit.json=$unit" \
      -- cut-aerial /data/unit.json \
      >/dev/null 2>&1 \
      && echo "[spawn]   spawned $tile" \
      || echo "[spawn]   FAILED to spawn $tile" >&2
  ) &
done
wait
echo "[spawn] all ${#TILES[@]} spawn calls returned (a spawn is not a result: the done records are)"
if [[ "$DRAIN" == true ]]; then
  echo "[spawn] waiting for the aerial Machines to drain…"
  await_gone "aerial-${STAMP}-" || true
  echo "[spawn] drained."
fi
