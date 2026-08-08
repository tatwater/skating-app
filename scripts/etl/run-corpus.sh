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

SCRATCH=".scratch/merge"
MANIFEST="${SCRATCH}/merge-manifest.json"

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
if [ -s "${SCRATCH}/sub-areas.ndjson" ]; then
  echo "══ load sub-areas${APPLY_SUB_AREAS:+ (applying)}"
  if [ -n "$APPLY_SUB_AREAS" ] && [ -z "$ACTOR" ]; then
    echo "--apply-sub-areas needs --actor=<profileId>: every sub-area write is audited (N2/D60)" >&2
    exit 1
  fi
  pnpm --filter @skating/etl load-sub-areas "${SCRATCH}/sub-areas.ndjson" \
    --campaign="$CAMPAIGN" ${ACTOR:+"$ACTOR"} $APPLY_SUB_AREAS
else
  echo "══ no sub-areas emitted — skipping"
fi

echo
echo "campaign ${CAMPAIGN} complete — the path is at /admin/imports?campaign=${CAMPAIGN}"
echo "Still manual, and deliberately so: prune-floor deletes rows the new rules refuse."
echo "  pnpm --filter @skating/etl prune-floor            # dry run"
