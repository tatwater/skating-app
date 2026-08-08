#!/usr/bin/env bash
#
# One canonical water re-import across every archived state extract (N6c pass 1).
#
# Exists because the pass is five near-identical invocations of three tools, and the interesting
# arguments are the ones that are easy to forget: the manifest that carries the extract's checksum,
# the transform summary that carries the itemized skips, and the campaign id that makes the five
# runs legible as one operation on /admin/imports. Typed by hand, those are exactly what gets
# dropped, and a run row missing its provenance is the failure this whole workstream is about.
#
#   ./run-canonical.sh <campaign-id> [state ...]
#
# Reads the archived extracts under `.raw/<state>/` (written by `pnpm --filter @skating/etl archive`)
# and never re-downloads: the archive *is* the reproducible input. Loads dev — pass --prod to the
# loader yourself if you mean production, which this script deliberately does not plumb through.
set -euo pipefail

cd "$(dirname "$0")"

CAMPAIGN="${1:?usage: ./run-canonical.sh <campaign-id> [state ...]}"
shift
STATES=("$@")
if [ ${#STATES[@]} -eq 0 ]; then STATES=(vt nh me ma ny); fi

SCRATCH=".scratch/${CAMPAIGN}"
mkdir -p "$SCRATCH"


# The tag filter is a superset of what we import — the transform's classifier makes the final call.
# Kept in a variable so the exact command lands on the run row rather than a description of it.
TAGS="natural=water landuse=reservoir natural=bay natural=wetland water"

failed=()

for state in "${STATES[@]}"; do
  pbf=$(ls ".raw/${state}"/*.osm.pbf)
  manifest=".raw/${state}/manifest.json"
  echo "══ ${state} — ${pbf}"

  filter_cmd="osmium tags-filter -t ${pbf} ${TAGS} -o ${SCRATCH}/${state}-water.osm.pbf && osmium export ${SCRATCH}/${state}-water.osm.pbf --geometry-types=polygon -a type,id -f geojsonseq -x print_record_separator=false -o ${SCRATCH}/${state}-water.geojsonseq"

  osmium tags-filter -t "$pbf" $TAGS -o "${SCRATCH}/${state}-water.osm.pbf" --overwrite
  osmium export "${SCRATCH}/${state}-water.osm.pbf" \
    --geometry-types=polygon -a type,id \
    -f geojsonseq -x print_record_separator=false \
    -o "${SCRATCH}/${state}-water.geojsonseq" --overwrite

  # MA's extract is large enough that the default heap is uncomfortably close; the transform reads
  # the whole geojsonseq at once by design (it needs the full feature set to report a densest ring).
  NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @skating/etl transform \
    "${SCRATCH}/${state}-water.geojsonseq" "${SCRATCH}/${state}-bodies.ndjson" \
    --depths="${SCRATCH}/${state}-depths.ndjson" \
    --summary="${SCRATCH}/${state}-transform.json"

  # `|| failed+=` rather than `set -e` doing it: one state failing should not abandon the other
  # four, and the run row for the failure survives either way.
  if pnpm --filter @skating/etl load "${SCRATCH}/${state}-bodies.ndjson" \
    --state="$(echo "$state" | tr '[:lower:]' '[:upper:]')" \
    --campaign="$CAMPAIGN" \
    --label="$(echo "$state" | tr '[:lower:]' '[:upper:]') canonical water" \
    --manifest="$manifest" \
    --transform-summary="${SCRATCH}/${state}-transform.json" \
    --filter-command="$filter_cmd"; then
    echo "══ ${state} done"
  else
    echo "══ ${state} FAILED (continuing; see /admin/imports)"
    failed+=("$state")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "canonical re-import finished with failures: ${failed[*]}"
  exit 1
fi
echo "canonical re-import complete for campaign ${CAMPAIGN}"
