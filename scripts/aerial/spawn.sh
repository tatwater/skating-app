#!/usr/bin/env bash
#
# The summer aerial's whole Fly surface (B05 §2.2, §2.4): spawn the work tiles' Machines, or the
# assembler's one, and wait for them. `fan-out.sh`'s shape and its hard-won flags, for the aerial's
# own image; the winter cutter's image, scripts and `FLY_IMAGE` are never touched.
#
#   spawn.sh tiles <campaign> <units dir> <work tiles file|-> [--drain]
#       one Machine per listed work tile (`11/<x>/<y>` a line), its unit (`11_<x>_<y>.json`) handed
#       in as a file — except a work tile whose Machine is still running (an earlier round's, or an
#       earlier run's that the laptop lost), which is waited for, never doubled — and nothing at all
#       while the campaign's assembler is up (it is reading the shards a re-cut replaces); at most
#       MAX_PARALLEL Machines alive on the app; each worker killed past AERIAL_TILE_DEADLINE;
#       `--drain` returns only once every aerial Machine has gone
#   spawn.sh assemble <campaign> [--pilot <name>]
#       one Machine running `assemble-aerial` — or, when it is already running, that one, attached
#       to and never doubled; returns 0 once it has gone (the assembler's own record in the bucket
#       says whether it succeeded — `cli/assemble.ts` follows it), 3 if it gave up waiting while the
#       Machine was still up, 1 when it started nothing
#   spawn.sh status <campaign>
#       read-only: the campaign's live Machines, one a line — `assembler`, or `worktile 11/<x>/<y>` —
#       and exit 0; exit 1 when the app's Machines can't be listed. The stages' preflights read it
#       (`preflight.ts`) before they write anything, so a refusal starts nothing (B05 §2.8)
#   spawn.sh drain <campaign>
#       read-only: returns 0 once none of the campaign's work-tile Machines is up — any selection's,
#       an earlier run's detached ones included — and 3 if it gave up waiting (a listing that keeps
#       failing reads as "still up"). The tiles stage runs it before every reconcile, so no work
#       tile is called landed while a worker may still replace its shard (PR #188's ninth review)
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
#   FLY_VM_SIZE / FLY_VM_MEMORY             default performance-4x / 8192 (a work tile; see below)
#   FLY_ASSEMBLE_VM_SIZE / FLY_ASSEMBLE_MEMORY  default shared-cpu-4x / 4096 (P measured ~2 GB)
#   AERIAL_TILE_DEADLINE default 3600 s: a worker still running then is killed (below)
set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "spawn.sh needs bash 4+ (you have ${BASH_VERSION}); macOS /bin/bash is 3.2 — brew install bash." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${AERIAL_ENV_FILE:-$HERE/.env.local}"
[[ -f "$ENV_FILE" ]] && { set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a; }

APP="${FLY_APP:-skating-imagery}"
REGION="${FLY_REGION:-ams}"
ASSEMBLE_REGION="${FLY_ASSEMBLE_REGION:-iad}"
MAX_PARALLEL="${MAX_PARALLEL:-25}"
# ⚠ `fly machine run` ignores fly.toml's [[vm]] block, and `--vm-size` sets CPUs, not memory: both
# flags, always (the imagery README's traps 5 and "three more flags").
# A work tile runs on `performance-4x` (the governor's ruling, 2026-11-27): the pilot's `shared-cpu-4x`
# drained its burst balance in ~3 minutes and ran at ~0.44 of a core after, while `performance-4x`
# never throttled (256 s a work tile). Performance sizes need 2 GB a CPU, hence 8192 MB; a tile used
# under 0.6 GB. The assembler's stays shared (`FLY_ASSEMBLE_*`): it streams, it doesn't decode.
VM_SIZE="${FLY_VM_SIZE:-performance-4x}"
VM_MEMORY="${FLY_VM_MEMORY:-8192}"
ASSEMBLE_VM_SIZE="${FLY_ASSEMBLE_VM_SIZE:-shared-cpu-4x}"
ASSEMBLE_MEMORY="${FLY_ASSEMBLE_MEMORY:-4096}"
SPAWN_TIMEOUT="${SPAWN_TIMEOUT:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
CAPACITY_TRIES="${CAPACITY_TRIES:-240}"
# The drain outlasts a hung worker's deadline (AERIAL_TILE_DEADLINE, below) with room to spare.
DRAIN_TRIES="${DRAIN_TRIES:-1080}"
LIST_TRIES="${LIST_TRIES:-5}"
# **A hung worker is killed, not left on the bill.** Nothing in GDAL bounds a stalled read (no
# GDAL_HTTP_TIMEOUT or low-speed limit is set), and a Machine whose worker never exits holds a slot
# under the cap and bills until someone looks — once in a pilot's 28 work tiles is unlikely, once in
# the region's 1,764 isn't. The pilot's slowest work tile took 356 s (256 s the mean) and the border
# tiles read most (2.5 GB, about 3× the mean), so an hour is ~10× the mean and kills only a hung
# one; it dies without a done record and the next round re-cuts it. coreutils' `timeout`, in the
# image's Ubuntu base, signals the worker's whole process group (GDAL's children too), then KILLs.
TILE_DEADLINE="${AERIAL_TILE_DEADLINE:-3600}"
[[ "$TILE_DEADLINE" =~ ^[1-9][0-9]*$ ]] || { echo "AERIAL_TILE_DEADLINE must be whole seconds" >&2; exit 64; }
IMAGE="${AERIAL_IMAGE:-}"

usage() {
  echo "usage: spawn.sh tiles <campaign> <units dir> <work tiles file|-> [--drain]" >&2
  echo "       spawn.sh assemble <campaign> [--pilot <name>]" >&2
  echo "       spawn.sh status <campaign>" >&2
  echo "       spawn.sh drain <campaign>" >&2
  exit 64
}

MODE="${1:-}"
CAMPAIGN="${2:-}"
[[ "$MODE" == tiles || "$MODE" == assemble || "$MODE" == status || "$MODE" == drain ]] || usage
[[ "$CAMPAIGN" =~ ^naip-(pilot-)?[0-9]{8}$ ]] || { echo "spawn.sh: not a campaign: $CAMPAIGN" >&2; usage; }
STAMP="${CAMPAIGN#naip-}"; STAMP="${STAMP/pilot-/p}"

command -v fly >/dev/null 2>&1 || { echo "flyctl not installed (brew install flyctl)" >&2; exit 1; }

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

# The names of the app's live Machines that start with `prefix`, one a line. **Can't tell is never
# none**: a listing that keeps failing (LIST_TRIES of them) fails here, and the caller starts
# nothing — a lost listing read as "not running" would start a second worker or assembler beside a
# live one, both writing the same keys.
live_names() {
  local prefix="$1" listed names
  for _ in $(seq 1 "$LIST_TRIES"); do
    if listed="$(fly machine list --app "$APP" --json 2>/dev/null)" \
      && names="$(jq -r --arg p "$prefix" '.[] | select((.name // "") | startswith($p))
        | select(.state | test("^(created|starting|started|replacing)$")) | .name' <<<"$listed")"; then
      [[ -n "$names" ]] && printf '%s\n' "$names"
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
  return 1
}

# Room for a whole batch before spawning it, or the cap is really MAX_PARALLEL + BATCH. **Waiting
# out the cap is not room under it**: fan-out.sh continues anyway after 20 minutes, which on a list
# that keeps failing (read as the cap, above) or an app the winter pump keeps full spawns past the
# cap — so here the round fails instead, nothing more is spawned, and the next round (or a re-run)
# resumes by done record.
await_capacity() {
  local live
  for _ in $(seq 1 "$CAPACITY_TRIES"); do
    live="$(live_machines)"
    (( live + BATCH <= MAX_PARALLEL )) && return 0
    sleep "$POLL_SECONDS"
  done
  echo "[spawn] ⚠ still $live Machines alive after waiting — spawning no more (cap $MAX_PARALLEL)" >&2
  return 1
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

# --- status and drain: read-only, so no image is needed -------------------------------------------
if [[ "$MODE" == status || "$MODE" == drain ]]; then
  (( $# == 2 )) || usage
fi
# **Nothing is called landed while a worker may still write.** A worker drops its done record only
# at the end of its cut, so an earlier selection's worker still running (the laptop lost the stage,
# then the selection was put back) leaves the old record in place for minutes — and then replaces
# the pack, the index and the record. The tiles stage waits here before each reconcile.
if [[ "$MODE" == drain ]]; then
  await_gone "aerial-${STAMP}-" || exit 3
  exit 0
fi
if [[ "$MODE" == status ]]; then
  if ! running="$(live_names "aerial-")"; then
    echo "[spawn] can't list the app's Machines" >&2
    exit 1
  fi
  # An `if`, not `[[ … ]] && …`: an empty last line would make the loop's status 1, and `set -e` exit.
  while IFS= read -r n; do
    if [[ "$n" == "aerial-asm-${STAMP}" ]]; then
      echo assembler
    elif [[ "$n" == "aerial-${STAMP}-"* ]]; then
      xy="${n#"aerial-${STAMP}-"}"
      echo "worktile 11/${xy%%-*}/${xy#*-}"
    fi
  done <<<"$running"
  exit 0
fi

# Pinned by digest, so every Machine of a build runs the same code and its done record can say
# which. A label resolves at spawn time; a digest never moves.
if [[ ! "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "AERIAL_IMAGE must be the aerial image pinned by digest (registry.fly.io/${APP}@sha256:…)." >&2
  echo "Build and push it under its own label first — the README's gated step — and pin the digest" >&2
  echo "it prints. Never the winter cutter's FLY_IMAGE." >&2
  exit 1
fi

if [[ "$MODE" == assemble ]]; then
  shift 2
  PILOT=()
  if (( $# > 0 )); then
    [[ "$1" == --pilot && -n "${2:-}" && $# -eq 2 ]] || usage
    PILOT=(--pilot "$2")
  fi
  NAME="aerial-asm-${STAMP}"
  echo "[spawn] assemble $CAMPAIGN -> app=$APP region=$ASSEMBLE_REGION vm=$ASSEMBLE_VM_SIZE/${ASSEMBLE_MEMORY}MB"
  # **A re-run attaches; it never starts a second assembler.** Two would stream the same archive to
  # the same key, each past the other's "never overwrite" check (it runs before the first byte).
  if ! running="$(live_names "$NAME")"; then
    echo "[spawn] can't list the app's Machines, so whether $NAME is already running can't be told — starting none" >&2
    exit 1
  fi
  if grep -qx -- "$NAME" <<<"$running"; then
    echo "[spawn] $NAME is already running: following it, not starting a second assembler"
  else
    # One Machine, but under the same cap as every other: the app is shared with the winter pump.
    BATCH=1 await_capacity || exit 1
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
  fi
  # 8,640 polls of at least 5 s is 12 h: ~8× the region's ~1.5 h assembly. The Machine's own
  # watchdog stops a stuck one long before; giving up here means one still moving, far too slowly.
  DRAIN_TRIES="${ASSEMBLE_TRIES:-8640}" await_gone "$NAME" || exit 3
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

# A work tile whose Machine is still up is not spawned again: its own worker lands it (or dies, and
# a later round re-cuts it). That is a round after a drain that gave up, a re-run after the laptop
# lost a round (asleep, offline, a failed reconcile), or a spawn whose `fly machine run` timed out
# after creating its Machine — two Machines on one work tile would race on its keys.
if ! running="$(live_names "aerial-")"; then
  echo "[spawn] can't list the app's Machines, so which work tiles are still running can't be told — spawning none" >&2
  exit 1
fi
declare -A RUNNING=()
ASSEMBLING=false
# An `if`, not `[[ … ]] && …`: an empty last line would make the loop's status 1, and `set -e` exit.
while IFS= read -r n; do
  if [[ "$n" == "aerial-${STAMP}-"* ]]; then RUNNING["$n"]=1
  elif [[ "$n" == "aerial-asm-${STAMP}" ]]; then ASSEMBLING=true; fi
done <<<"$running"
TODO=()
for tile in "${TILES[@]}"; do
  IFS=/ read -r _ x y <<<"$tile"
  if [[ -n "${RUNNING["aerial-${STAMP}-${x}-${y}"]:-}" ]]; then
    echo "[spawn]   $tile is still running: waiting for it, not spawning a second"
  else
    TODO+=("$tile")
  fi
done

# **Never re-cut under a live assembler.** It range-reads each landed work tile's pack zoom by zoom
# for an hour and more, and a re-cut drops the done record and overwrites the pack and index at the
# same keys: the assembler would stream the new pack's bytes at the old offsets into an archive whose
# keys are never overwritten. A re-run of the stage while the campaign assembles (a changed pick, a
# resume from a laptop that lost the stage) waits for the assembly instead.
if [[ "$ASSEMBLING" == true ]] && (( ${#TODO[@]} > 0 )); then
  echo "[spawn] aerial-asm-${STAMP} is assembling $CAMPAIGN from these work tiles' shards: re-cutting ${#TODO[@]} now would change what it reads — spawning none; let the assembly finish (or stop it) first" >&2
  exit 1
fi

echo "[spawn] ${#TODO[@]} of ${#TILES[@]} work tiles -> app=$APP region=$REGION vm=$VM_SIZE/${VM_MEMORY}MB, at most $MAX_PARALLEL alive"
BATCH=$(( MAX_PARALLEL / 4 ))
(( BATCH < 1 )) && BATCH=1
SPAWNED=0
for tile in ${TODO[@]+"${TODO[@]}"}; do
  # `wait` before polling, or spawns since the last poll aren't in the count (fan-out.sh).
  if (( SPAWNED % BATCH == 0 )); then
    wait
    await_capacity || { echo "[spawn] stopped after $SPAWNED of ${#TODO[@]} spawn calls" >&2; exit 1; }
  fi
  SPAWNED=$((SPAWNED + 1))
  IFS=/ read -r _ x y <<<"$tile"
  unit="$UNITS/11_${x}_${y}.json"
  name="aerial-${STAMP}-${x}-${y}"
  (
    # --rm --restart no: a batch job, never a crash loop on the bill. --detach: return once created.
    # --file-local: the unit, written into the Machine at /data/unit.json. `timeout`: the deadline,
    # above. No comments below.
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
      -- timeout --kill-after=60 "$TILE_DEADLINE" cut-aerial /data/unit.json \
      >/dev/null 2>&1 \
      && echo "[spawn]   spawned $tile" \
      || echo "[spawn]   FAILED to spawn $tile" >&2
  ) &
done
wait
echo "[spawn] all ${#TODO[@]} spawn calls returned (a spawn is not a result: the done records are)"
if [[ "$DRAIN" == true ]]; then
  echo "[spawn] waiting for the aerial Machines to drain…"
  await_gone "aerial-${STAMP}-" || true
  echo "[spawn] drained."
fi
