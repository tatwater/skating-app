#!/usr/bin/env bash
#
# The summer aerial, one campaign, by stage or whole (B05 §3.1).
#
#   scripts/aerial/run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all]
#                                [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>]
#                                [--dry-run] [--old <key>]
#
# `all` (the default) runs select → tiles → assemble → verify and stops at the first refusal; one
# stage re-runs that stage against the campaign's stored manifest; cleanup is only ever run alone.
# Every stage is its own `pnpm --filter @skating/aerial <stage>` CLI reading the same arguments
# through `stages.ts`' `parseStageArgs`, so a flag means one thing everywhere; each writes its own
# run row (`aerial_select`, `aerial_tiles`, `aerial_assemble`) under the one campaign id.
#
# **Every argument is checked before anything starts** (`src/tilesRunArgs.ts`): the flags, and where
# the run rows would go — a pilot (`--pilot`, a `naip-pilot-<YYYYMMDD>` campaign) writes them to a
# throwaway local backend only and refuses dev and prod (G-8 a); nothing writes prod's (F-4 a). A
# cheap argument must never fail an expensive build at its last step (run-corpus.sh's lesson).
#
# The heavy stages run on Fly and this laptop orchestrates them for the build's wall time (about 16 h
# for the region): run it under `caffeinate -i`. Every stage resumes — a sleep costs a re-run of the
# reconcile, not the work done. The README is the runbook, the gated steps and the Fly traps.
#
# ## It logs itself, so you never have to pipe it — and it refuses to be piped
#
# ⚠ `run-aerial.sh … | tee run.log` would report the pipe's status, `tee`'s 0, for a run that
# failed (run-corpus.sh's 2026-08-09 trap). So output goes to the terminal **and**
# `scripts/aerial/.scratch/run-<campaign>.log`, every line stamped, and a piped stdout is refused
# outright. The exit status is always the failing stage's own.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The gitignored `scripts/aerial/.env.local` (the README's list: `AERIAL_IMAGE`, `R2_BUCKET`,
# `R2_REMOTE`, a pilot's `CONVEX_DEPLOYMENT`), loaded before anything reads it — the run rows'
# target check included — and never echoed. `spawn.sh` loads the same file the same way, so a value
# there wins over the shell's in both. `AERIAL_ENV_FILE` points elsewhere (the tests).
ENV_FILE="${AERIAL_ENV_FILE:-$HERE/.env.local}"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE" >/dev/null 2>&1; set +a; fi
USAGE="usage: run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all] [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>] [--dry-run] [--old <key>]"

# A FIFO (`| tee`) or a socket (how most process runners wire stdout): either way the status a
# caller sees is not necessarily this run's. Redirect to a file or a terminal instead.
if [[ -p /dev/stdout || -S /dev/stdout ]]; then
  echo "run-aerial.sh refuses to be piped: a pipe reports its last command's status, not this run's." >&2
  echo "It logs itself to scripts/aerial/.scratch/run-<campaign>.log: run it in a terminal, or with" >&2
  echo "its output sent to a file (> /dev/null) and its status read from \$?." >&2
  exit 64
fi

CAMPAIGN="${1:-}"
if [[ -z "$CAMPAIGN" || "$CAMPAIGN" == -* ]]; then
  echo "$USAGE" >&2
  exit 64
fi

# A relative --cells path means what the caller typed: absolutize it before moving.
ARGS=()
expect_cells=""
for arg in "$@"; do
  if [[ -n "$expect_cells" ]]; then
    [[ "$arg" == /* ]] || arg="$PWD/$arg"
    expect_cells=""
  elif [[ "$arg" == --cells ]]; then
    expect_cells=1
  elif [[ "$arg" == --cells=* && "${arg#--cells=}" != /* ]]; then
    arg="--cells=$PWD/${arg#--cells=}"
  fi
  ARGS+=("$arg")
done
cd "$HERE"

# The stages, or the refusal — before the log exists, so a refused run leaves nothing behind.
TSX="${AERIAL_TSX:-pnpm --silent exec tsx}"
STAGES="$($TSX src/tilesRunArgs.ts "${ARGS[@]}")" || exit $?

# Everything but `--stage`, forwarded to each stage CLI (which takes its own stage as given).
FORWARD=()
skip=""
for arg in "${ARGS[@]:1}"; do
  if [[ -n "$skip" ]]; then skip=""; continue; fi
  case "$arg" in
    --stage) skip=1 ;;
    --stage=*) ;;
    *) FORWARD+=("$arg") ;;
  esac
done

SCRATCH="${AERIAL_SCRATCH_DIR:-$HERE/.scratch}"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/run-${CAMPAIGN}.log"

# One stamp per line, ISO 8601 with the offset (run-corpus.sh's logger): bash's own clock where it
# has one, `date` on the macOS system bash. A last line with no newline is stamped, never dropped.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 2) )); then
  stamp_lines() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%(%Y-%m-%dT%H:%M:%S%z)T %s\n' -1 "$line"
    done
  }
else
  stamp_lines() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$line"
    done
  }
fi

# Process substitution, not a pipe: the script still exits with its own status. And it waits for
# its logger, so a failing run's last lines — the ones worth keeping — reach the file.
exec > >(stamp_lines | tee -a "$LOG") 2>&1
TEE_PID=$!
finish() {
  local status=$?
  exec 1>&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
  exit "$status"
}
trap finish EXIT
echo "══ ${CAMPAIGN}: $(echo $STAGES) — logging to ${LOG} (do NOT pipe this script)"

for stage in $STAGES; do
  echo "══ ${stage}"
  pnpm --filter @skating/aerial "$stage" "$CAMPAIGN" ${FORWARD[@]+"${FORWARD[@]}"}
done

echo
echo "campaign ${CAMPAIGN}: $(echo $STAGES) done — its rows are at /admin/imports?campaign=${CAMPAIGN}"
