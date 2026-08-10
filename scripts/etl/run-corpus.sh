#!/usr/bin/env bash
#
# One unified-corpus campaign, end to end (N7).
#
# The OSM-per-state path has had `run-canonical.sh` since N6c, for a stated reason: the interesting
# arguments are the ones that are easy to forget, and a run row missing its provenance is the failure
# that whole workstream was about. The N7 path — the one that decides every row in the corpus — had
# no wrapper at all. It was four commands typed by hand, and the 2026-08-07 campaign is what that
# costs: a `corpus_merge` run with an empty Path, and a `canonical_water` run labelled "unscoped
# canonical water" for the load of all 25,050 bodies.
#
#   ./run-corpus.sh <campaign-id> [--refresh] [--apply-sub-areas --actor=<profileId>]
#
# The loaders now discover `.scratch/merge/merge-manifest.json` on their own, so this script is a
# convenience and an ordering guarantee rather than the only way to get a full record. What it adds
# that discovery cannot: the load order (bodies BEFORE sub-areas — a bay needs its parent to exist),
# one campaign id across every pass, and a refusal to load a merge that did not finish.
#
# Dev only. Pass --prod to the loader yourself if you mean production; this script does not plumb it.
#
# ## It logs itself, so you never have to pipe it — and you must not
#
# ⚠ **`./run-corpus.sh … | tee run.log` reports SUCCESS for a run that failed.** A pipeline's exit
# status is its *last* command's, so `tee` returning 0 masks this script returning 1 — and `pipefail`
# does not help, because it governs pipelines *inside* a script rather than one a caller wraps it in.
# That happened on 2026-08-09: the sub-area step refused a missing `--actor`, the script exited 1,
# and the wrapper reported exit 0. The prune correctly did not run; nothing else said so.
#
# The known half of this trap was already written down — *"piping a long run through `tail` hides its
# progress until the pipeline ends; log to a file"* — and the fix for both halves is the same, so the
# script now does it. Output goes to stdout **and** `.scratch/merge/run-<campaign>.log`, which means
# there is no reason left to wrap it and no way for a wrapper to eat the status.
set -euo pipefail

cd "$(dirname "$0")"

CAMPAIGN="${1:?usage: ./run-corpus.sh <campaign-id> [--refresh] [--apply-sub-areas --actor=<id>]}"
shift

REFRESH=""
APPLY_SUB_AREAS=""
ACTOR=""
for arg in "$@"; do
  case "$arg" in
    --refresh) REFRESH="--refresh" ;;
    --apply-sub-areas) APPLY_SUB_AREAS="--apply" ;;
    --actor=*) ACTOR="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ⚠ **An explicit `--apply-sub-areas` must never be silently skipped**, and this is the only place
# that can say so cheaply. The sub-area step below treats a missing `--actor` as "skip and carry on",
# which is right for a plain `./run-corpus.sh <id>` — but an operator who typed `--apply-sub-areas`
# asked for a write, and answering that with a SKIP line and exit 0 is the same class of lie as the
# `| tee` trap in the header: a run that reports success for something it did not do.
#
# Checked HERE rather than at the step, because the rule this campaign already paid to learn is that
# *a cheap argument must not be able to fail an expensive campaign at its last step*. Two seconds in
# is the honest place to refuse; forty-five minutes and 25,000 bodies later is not.
if [ -n "$APPLY_SUB_AREAS" ] && [ -z "$ACTOR" ]; then
  echo "--apply-sub-areas needs --actor=<profileId>: every sub-area write is audited (N2/D60)" >&2
  exit 1
fi

SCRATCH=".scratch/merge"
MANIFEST="${SCRATCH}/merge-manifest.json"

# **Self-logging, via process substitution rather than a pipe.** `exec > >(tee …)` redirects this
# script's own stdout; the script still exits with its own status, where `./run-corpus.sh | tee`
# would exit with `tee`'s. That difference is the whole point — see the header.
mkdir -p "$SCRATCH"
LOG="${SCRATCH}/run-${CAMPAIGN}.log"
exec > >(tee "$LOG") 2>&1
TEE_PID=$!
# **And the script waits for its own logger.** Bash does not wait for a process substitution at exit,
# so `tee` can be torn down with the pipe still holding the last lines — which on a FAILING run are
# exactly the lines worth keeping. Closing both descriptors gives `tee` its EOF, `wait` reaps it, and
# the original status is re-raised explicitly so the trap itself cannot become the thing that eats the
# exit code the header is about.
finish() {
  local status=$?
  exec 1>&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
  exit "$status"
}
trap finish EXIT
echo "══ logging to ${SCRATCH#./}/run-${CAMPAIGN}.log — do NOT pipe this script; it eats the exit code"

# The region masks come first and are not optional: the merge clips against `boundaries.ndjson` and
# `downstate-ny.geojson`, and a stale mask moves tens of thousands of bodies across the region line
# without changing anything else about the run.
echo "══ region masks (TIGER)"
pnpm --filter @skating/admin-areas build-region

echo "══ merge — three catalogues, one filter"
pnpm --filter @skating/etl merge --campaign="$CAMPAIGN" $REFRESH

# **The merge is not a step that can be half-done.** It writes `bodies.ndjson` before the manifest,
# so a manifest on disk is the merge's own statement that it reached the end — and loading a corpus
# from a truncated artifact is the one mistake here that is invisible afterwards.
if [ ! -f "$MANIFEST" ]; then
  echo "merge did not write ${MANIFEST} — refusing to load a corpus it did not finish producing" >&2
  exit 1
fi

echo "══ load bodies"
pnpm --filter @skating/etl load "${SCRATCH}/bodies.ndjson" --campaign="$CAMPAIGN"

# Bays after bodies, always: `importBaySubAreas` resolves a parent by catalogue id and refuses a bay
# whose lake is not in the table yet. Dry by default — seeding sub-areas is audited to a person, so
# it needs an explicit actor and an explicit --apply-sub-areas.
if [ ! -s "${SCRATCH}/sub-areas.ndjson" ]; then
  echo "══ no sub-areas emitted — skipping"
elif [ -z "$ACTOR" ]; then
  # ⚠ **Skipped, not failed** (2026-08-09). `load-sub-areas` requires `--actor` *unconditionally* —
  # even for a dry run — while this script only ever guarded the `--apply` case. So a plain
  # `./run-corpus.sh <id>` reached that command with no actor and exited 1 at the **last** step, after
  # a 45-minute merge and a 25,000-body load had both succeeded. The campaign read as a failure, and
  # the non-zero exit then suppressed the prune the operator was meant to run next.
  #
  # Bays need an actor by design (N2/D60 audits every sub-area write to a person), and this script's
  # own comment already said it needs *both* an actor and `--apply-sub-areas`. So the honest
  # behaviour when neither is present is to say what was not done and carry on — the bay lane is
  # idempotent and can be run on its own afterwards, which is exactly what the message tells you.
  #
  # This branch is reachable only when the operator asked for **neither**. `--apply-sub-areas` with no
  # actor is refused up at the argument parse, because a skip is an honest answer to a request that
  # was never made and a dishonest one to a request that was.
  echo "══ sub-areas: SKIPPED — no --actor given, and every sub-area write is audited (N2/D60)"
  echo "   the bodies above are loaded and this changes nothing about them. To seed bays:"
  echo "   pnpm --filter @skating/etl load-sub-areas ${SCRATCH}/sub-areas.ndjson \\"
  echo "     --campaign=${CAMPAIGN} --actor=<moderatorProfileId> [--apply]"
else
  echo "══ load sub-areas${APPLY_SUB_AREAS:+ (applying)}"
  pnpm --filter @skating/etl load-sub-areas "${SCRATCH}/sub-areas.ndjson" \
    --campaign="$CAMPAIGN" "$ACTOR" $APPLY_SUB_AREAS
fi

echo
echo "campaign ${CAMPAIGN} complete — the path is at /admin/imports?campaign=${CAMPAIGN}"
echo "Still manual, and deliberately so — both of these can remove a body from the map, so both are"
echo "dry by default and neither runs without you. Order does not matter; skipping either is silent."
echo
echo "  pnpm --filter @skating/etl prune-floor            # dry run; --apply to delete"
echo "      rows the current admission rules refuse."
echo
echo "  pnpm --filter @skating/etl retire-absorbed \\"
echo "    --campaign=${CAMPAIGN}                          # dry run; --apply to fold"
echo "      the duplicate rows this merge collapsed (D136). REQUIRED after any merge that absorbed"
echo "      pairs: the load is an upsert, so it never removes a row it simply stopped emitting."
