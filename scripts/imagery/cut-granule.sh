#!/usr/bin/env bash
#
# Cut one Sentinel granule down to the corpus and push the result to R2 (N6e PR 2, D148).
#
#   cut-granule <granule-id> [--smoke]
#
# ## The contract, and why it is one granule
#
# One granule id in. One artifact in R2 out. Nonzero exit if that did not happen. No queue, no list,
# no knowledge of what else is running or of who called it. D148's hosting note turns on keeping
# "which granules, when" *outside* this container — so a caller can be `fan-out.sh`, a cron, a GitHub
# Action, or a person with Docker, and none of them are a migration.
#
# It also makes the parallel story trivial. One season is ~750 granules; because no job can observe
# another, 25 at once is the same total spend as 25 in a row (§C2), and a crash takes exactly one
# granule with it.
#
# ## Status: plumbing only
#
# ⚠ The masking transform is PR 2's work and is NOT implemented here — see `transform_granule` below,
# which spells out precisely what has to land in it. What *is* real is everything around it: argument
# handling, secret checks, the STAC resolve, the R2 push, and `--smoke`, which runs the whole path
# end to end on one band so the Fly + R2 + GDAL wiring can be proven before any of the interesting
# code exists. Prove the boring parts first; a masking bug is much easier to read when you already
# know the box can reach the bucket.
set -euo pipefail

GRANULE_ID="${1:-}"
SMOKE=false
[[ "${2:-}" == "--smoke" ]] && SMOKE=true

if [[ -z "$GRANULE_ID" ]]; then
  echo "usage: cut-granule <granule-id> [--smoke]" >&2
  echo "  e.g. cut-granule S2B_18TXP_20260115_0_L2A" >&2
  exit 64
fi

WORKDIR="${GRANULE_WORKDIR:-/data}"
STAC_URL="${STAC_URL:-https://earth-search.aws.element84.com/v1}"
STAC_COLLECTION="${STAC_COLLECTION:-sentinel-2-l2a}"
R2_BUCKET="${R2_BUCKET:-skating-imagery}"

log() { echo "[cut-granule] $*" >&2; }
die() { echo "[cut-granule] FATAL: $*" >&2; exit 1; }

# --- Secrets ---------------------------------------------------------------------------------------
# Checked up front and by name. A batch job that discovers a missing credential after paying for the
# granule read is a job that wasted the expensive half of its runtime; these are `fly secrets` (see
# README.md) and they are either all there or the Machine should die in under a second.
for var in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT; do
  [[ -n "${!var:-}" ]] || die "missing required secret: $var"
done

mkdir -p "$WORKDIR"
cd "$WORKDIR"

# rclone's config is written at runtime from the secrets rather than baked into the image, so the
# image itself carries nothing sensitive and can live in a registry without care.
RCLONE_CONF="${RCLONE_CONFIG:-$WORKDIR/rclone.conf}"
umask 077
cat > "$RCLONE_CONF" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = ${R2_ENDPOINT}
region = auto
acl = private
EOF

# --- Resolve the granule ---------------------------------------------------------------------------
# STAC turns an id into signed-free COG hrefs plus the metadata the product actually needs: the
# capture datetime (D84/C4 — the date is content, not a caption) and the cloud fraction that decides
# whether this pass is worth cutting at all.
resolve_granule() {
  local url="${STAC_URL}/collections/${STAC_COLLECTION}/items/${GRANULE_ID}"
  log "resolving $GRANULE_ID via $url"
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o granule.json \
    || die "STAC lookup failed for $GRANULE_ID"

  CAPTURED_AT="$(jq -r '.properties.datetime // empty' granule.json)"
  CLOUD_PCT="$(jq -r '.properties["eo:cloud_cover"] // empty' granule.json)"
  [[ -n "$CAPTURED_AT" ]] || die "no datetime on $GRANULE_ID"

  log "captured $CAPTURED_AT, cloud ${CLOUD_PCT:-unknown}%"
}

# Assets we care about, and why each one (§C1). True colour is what PR 2 ships; the rest are the
# bands N6f is built on and they cost nothing extra to note while we are already holding the granule.
#   visual — the RGB composite, the frame a skater actually looks at
#   scl    — ESA's per-pixel scene classification: snow/ice AND cloud mask in one band. The single
#            most valuable asset here, per §C1.
#   green, swir16 — the NDSI pair, the only way to tell snow/ice from cloud (true colour cannot).
asset_href() { jq -r --arg k "$1" '.assets[$k].href // empty' granule.json; }

# --- The transform ---------------------------------------------------------------------------------
transform_granule() {
  # ⚠ NOT IMPLEMENTED — this is PR 2a. What belongs here, in order:
  #
  #   1. Fetch the pre-baked reveal mask for this granule's footprint. **Not computed here.** The
  #      shape comes from `revealShape` in `@skating/core`, which is TypeScript, and putting Node in
  #      this image to call it would be the wrong trade twice over: the masks depend on body polygons
  #      and access points, which change rarely, while ~1,000 granules a season clip against the
  #      identical shapes. So `pnpm --filter @skating/imagery bake-masks` computes them once per
  #      season and stages one GeoJSON in R2; this job downloads it. Keeping geometry out of the
  #      container is also what keeps D148's host-neutrality claim true.
  #   2. `gdal raster clip` against that union. Masking first is what makes the numbers work: water
  #      plus buffers is ~5% of the region, so this is the ~20× shrink D148 depends on.
  #   3. Bake the alpha. `outerRingsOnly` semantics — islands are revealed in full, never punched
  #      out; the first render settled that a lake full of holes "reads as damage rather than
  #      cartography". The feather is a **distance transform** (`gdal_proximity`), not a blur:
  #      alpha ramps by true ground distance from the reveal edge over SENTINEL_MASK_METERS.feather.
  #      The web client blurs instead only because a rasteriser is what a canvas has — see the note
  #      at the end of `paintRevealMask` in apps/web/src/lib/imageryCanvas.ts, which hands this case
  #      to us explicitly: *"PR 2's Sentinel archive bakes its alpha server-side, where there is no
  #      rasteriser and the real geometry is the answer."*
  #   4. `gdal raster tile` (WebMercatorQuad) then `pmtiles convert`. EPSG:3857 is not optional: a
  #      linear lat/lng mask sits ~20 m off the shoreline at 44°N and reads as the source being
  #      misregistered (see packages/core/src/webMercator.ts).
  #
  # ⚠ **Fail closed.** If the mask cannot be built, produce nothing — never an unclipped granule.
  # `composeImagery` takes the same care on the client, and for the same reason: a reveal that fails
  # open is a photograph of the whole Northeast with no way to tell which lake you were looking at.
  #
  # Kept as a hard failure rather than a silent no-op: a job that exits 0 having produced nothing is
  # the one outcome a fan-out over 750 granules cannot afford to hide.
  die "transform not implemented — this is PR 2a (see plans/phase-N6e-satellite-imagery.md §C2)"
}

# --- Smoke test ------------------------------------------------------------------------------------
# The whole path on one small band, to prove Fly can reach the granule store, GDAL can read a remote
# COG, and rclone can write to R2. No masking, no corpus, no correctness claim about the picture.
smoke_test() {
  local href
  href="$(asset_href scl)"
  [[ -n "$href" ]] || die "no 'scl' asset on $GRANULE_ID"

  # /vsicurl/ reads windows over HTTP instead of pulling the granule down — the property the entire
  # cost model rests on. If this line is slow, the COG is not being range-read and that is the bug.
  log "reading a window of $href"
  gdal raster info --input "/vsicurl/${href}" > /dev/null || die "GDAL could not read the COG"

  gdal raster convert \
    --input "/vsicurl/${href}" \
    --output smoke.tif \
    --output-format COG \
    --overwrite \
    --creation-option COMPRESS=DEFLATE \
    || die "GDAL convert failed"

  local key="smoke/${GRANULE_ID}.tif"
  log "uploading $(du -h smoke.tif | cut -f1) -> r2:${R2_BUCKET}/${key}"
  rclone --config "$RCLONE_CONF" copyto smoke.tif "r2:${R2_BUCKET}/${key}" \
    --s3-no-check-bucket \
    --s3-chunk-size=64M \
    || die "R2 upload failed"

  log "smoke test OK — box reads granules and writes R2"
}

# --- Main ------------------------------------------------------------------------------------------
resolve_granule
if [[ "$SMOKE" == true ]]; then
  smoke_test
else
  transform_granule
fi
