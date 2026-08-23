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
# ## Two seasons, and they are not the same season
#
# `MASK_SEASON` says which reveal geometry to clip against; the frame's own season comes from its
# capture date. A backfill of winter 2025-26 is cut against *today's* corpus, because that is the best
# shape of those lakes we have — but the picture is of February 2026 and belongs in that winter's
# scrubber. Conflating them files a whole backfill under the wrong year.
#
# ## `--smoke`
#
# Runs the plumbing alone: resolve, read one band over the network, write it to R2, exit. No masks, no
# transform, no claim about the picture. For proving credentials and connectivity when something is
# broken and you want the boring half eliminated first.
set -euo pipefail

GRANULE_ID="${1:-}"
SMOKE=false
[[ "${2:-}" == "--smoke" ]] && SMOKE=true

if [[ -z "$GRANULE_ID" ]]; then
  echo "usage: cut-granule <granule-id> [--smoke]" >&2
  echo "  e.g. cut-granule S2C_18TXP_20260215_0_L2A" >&2
  exit 64
fi

WORKDIR="${GRANULE_WORKDIR:-/data}"
STAC_URL="${STAC_URL:-https://earth-search.aws.element84.com/v1}"
STAC_COLLECTION="${STAC_COLLECTION:-sentinel-2-l2a}"
R2_BUCKET="${R2_BUCKET:-skating-imagery}"
# Which season's masks to clip against. The bake names its artifact for a season and the cutter has
# to be told which one — deriving it from the granule's own date would silently cut a January frame
# against a mask baked for the wrong winter the first time a backfill crosses a July.
MASK_SEASON="${MASK_SEASON:-}"

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

  # ⚠ **The frame's season is its own, not the masks'.** These are two different things and filing a
  # frame under the mask label conflates them: a backfill of winter 2025-26 is cut against *today's*
  # corpus geometry (`winter-2026-27`), because that is the best shape of those lakes we have — but
  # the picture is of February 2026 and belongs in that season's scrubber. Deriving it from the
  # capture date is also what makes the whole backfill fall into the right buckets without anybody
  # passing a flag per granule.
  #
  # D63's July boundary, in shell: anything from July onward belongs to the season named by that
  # calendar year, anything before it to the one that started the previous July.
  local year month season_year
  year="${CAPTURED_AT:0:4}"
  month="${CAPTURED_AT:5:2}"
  if [[ "$((10#$month))" -ge 7 ]]; then season_year="$year"; else season_year="$((year - 1))"; fi
  FRAME_SEASON="$(printf 'winter-%d-%02d' "$season_year" "$(((season_year + 1) % 100))")"

  log "captured $CAPTURED_AT, cloud ${CLOUD_PCT:-unknown}%, season $FRAME_SEASON"
}

# Assets we care about, and why each one (§C1). True colour is what PR 2 ships; the rest are the
# bands N6f is built on and they cost nothing extra to note while we are already holding the granule.
#   visual — the RGB composite, the frame a skater actually looks at
#   scl    — ESA's per-pixel scene classification: snow/ice AND cloud mask in one band. The single
#            most valuable asset here, per §C1.
#   green, swir16 — the NDSI pair, the only way to tell snow/ice from cloud (true colour cannot).
asset_href() { jq -r --arg k "$1" '.assets[$k].href // empty' granule.json; }

# --- The transform ---------------------------------------------------------------------------------
#
# Six GDAL steps, each of which was run against a real granule before it was written down here
# (S2C_18TXP_20260215, Champlain, 7.6% cloud). The order matters and the reasons are inline.

# Pull only the reveal masks this granule's footprint touches.
#
# The mask file is one FlatGeobuf for the whole corpus. FlatGeobuf carries a packed Hilbert R-tree
# **inside the file**, and GDAL uses it over HTTP range requests — so `-spat` against a `/vsicurl/`
# URL fetches the index and then only the intersecting features. A 25,000-body, ~150 MB artifact is
# read as a few megabytes, without this job ever knowing how big it was.
fetch_masks() {
  [[ -n "$MASK_SEASON" ]] || die "MASK_SEASON is unset — which season's masks should this cut against?"

  local base="masks/${MASK_SEASON}"

  # Read over `/vsis3/` with the credentials this job already has, rather than over a public URL.
  #
  # The archive of *frames* will eventually be public, because the clients have to fetch it. The
  # masks never need to be — so requiring a public bucket here would widen the archive's exposure to
  # buy nothing, and it would couple this job to a Cloudflare setting rather than to a secret it is
  # already holding. R2 is S3-compatible; path-style addressing is what it wants.
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_S3_ENDPOINT="${R2_ENDPOINT#https://}"
  export AWS_VIRTUAL_HOSTING=FALSE
  export AWS_DEFAULT_REGION=auto

  # The sidecar carries the buffer distances the masks were baked with, so the container never holds
  # its own copy of a tuned constant. See the note in bakeMasks.ts for why they travel together.
  rclone --config "$RCLONE_CONF" copyto "r2:${R2_BUCKET}/${base}.json" mask-meta.json \
    --s3-no-check-bucket \
    || die "no mask sidecar at ${base}.json — has bake-masks run for $MASK_SEASON?"
  FEATHER_M="$(jq -r '.featherMeters' mask-meta.json)"
  [[ "$FEATHER_M" =~ ^[0-9.]+$ ]] || die "mask sidecar has no usable featherMeters"

  read -r MINLNG MINLAT MAXLNG MAXLAT <<<"$(jq -r '.bbox | "\(.[0]) \(.[1]) \(.[2]) \(.[3])"' granule.json)"
  log "granule footprint $MINLNG $MINLAT $MAXLNG $MAXLAT"

  local src="/vsis3/${R2_BUCKET}/${base}.fgb"

  # ⚠ **Count first, and do not let `ogr2ogr` discover the empty case.**
  #
  # `ogr2ogr -t_srs` on a spatial filter that matches nothing does not produce an empty file — it
  # fails, with `ERROR 1: Reprojection failed`. Over five states an enormous number of granules match
  # nothing: the Atlantic off Cape Cod, the Gulf of Maine, Québec, western New York. Without this
  # branch every one of them dies as an error instead of taking the "nothing to cut" path a few lines
  # down, and a backfill reports a 65% failure rate for doing exactly the right thing.
  #
  # Measured 2026-08-23 on a 20-granule slice: 13 "failures", all of them ocean tiles, all of them
  # this. `-skipfailures` would silence it and would also silence a real reprojection error, so the
  # count is asked for explicitly instead.
  MASK_COUNT="$(ogrinfo -so -al -spat "$MINLNG" "$MINLAT" "$MAXLNG" "$MAXLAT" "$src" 2>/dev/null \
    | sed -n 's/^Feature Count: //p' | head -1)"
  MASK_COUNT="${MASK_COUNT:-0}"
  log "masks intersecting this granule: $MASK_COUNT"
  [[ "$MASK_COUNT" -eq 0 ]] && return 0

  # Reprojected to 3857 on the way out, because everything downstream is. EPSG:3857 is not optional
  # anywhere in this pipeline: a linear lat/lng mask sits ~20 m off the shoreline at 44°N and reads
  # as the imagery being misregistered rather than as our bug (packages/core/src/webMercator.ts).
  ogr2ogr -f GeoJSON masks.geojson \
    -spat "$MINLNG" "$MINLAT" "$MAXLNG" "$MAXLAT" -spat_srs EPSG:4326 \
    -t_srs EPSG:3857 \
    "$src" \
    || die "could not read masks from ${base}.fgb"
}

# The projected extent the masks occupy, which is all of the granule worth warping.
mask_extent() {
  jq -r '
    [.features[].geometry | (if .type=="Polygon" then [.coordinates] else .coordinates end)[][][]]
    | (map(.[0]) | min), (map(.[1]) | min), (map(.[0]) | max), (map(.[1]) | max)
  ' masks.geojson | paste -sd' ' -
}

transform_granule() {
  fetch_masks

  # **Nothing to cut is a success, not a failure.** Plenty of granules in a five-state region cover
  # only land, or Québec, or ocean. Exiting non-zero would light up a fan-out with red for jobs that
  # did exactly the right thing, and the noise would hide a real failure.
  if [[ "$MASK_COUNT" -eq 0 ]]; then
    log "no corpus bodies under this granule — nothing to cut"
    return 0
  fi

  local href
  href="$(asset_href visual)"
  [[ -n "$href" ]] || die "no 'visual' (TCI) asset on $GRANULE_ID"

  read -r MINX MINY MAXX MAXY <<<"$(mask_extent)"
  log "mask extent (3857) $MINX $MINY $MAXX $MAXY"

  # ⚠ **Mercator metres are not ground metres, and this is where that bites.**
  #
  # Web Mercator inflates distance by 1/cos(latitude) — ~1.39× at 44°N. `gdal_proximity -distunits
  # GEO` measures in the raster's own units, so feeding it 240 would ramp the feather over 240
  # *projected* metres, which is only ~173 m on the ground: a 28% error that looks like a slightly
  # tight edge rather than like a units bug. `groundMetersPerPixel` carries the same correction on
  # the client, and this is the server's copy of it.
  local centre_lat feather_projected
  centre_lat="$(awk -v miny="$MINY" -v maxy="$MAXY" 'BEGIN{
    mw=20037508.342789244; cy=(miny+maxy)/2;
    printf "%.6f", (2*atan2(exp((cy/mw)*3.14159265358979),1)-3.14159265358979/2)*180/3.14159265358979
  }')"
  feather_projected="$(awk -v f="$FEATHER_M" -v lat="$centre_lat" 'BEGIN{
    printf "%.1f", f/cos(lat*3.14159265358979/180)
  }')"
  log "feather ${FEATHER_M} ground m -> ${feather_projected} projected m at ${centre_lat}°N"

  # 1. Warp the granule into 3857 over just the mask extent. 14 m/px is ~10 m on the ground here,
  #    which is Sentinel-2's native sample — upsampling would invent detail, downsampling would throw
  #    away the only resolution we have.
  log "warping $href"
  gdalwarp -q -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" -tr 14 14 \
    -r bilinear -multi -co COMPRESS=DEFLATE -overwrite \
    "/vsicurl/${href}" scene.tif \
    || die "gdalwarp failed"

  # 2. Burn the reveal shapes into a byte mask on exactly that grid.
  gdal_rasterize -q -burn 255 -init 0 -ot Byte \
    -te "$MINX" "$MINY" "$MAXX" "$MAXY" -tr 14 14 -co COMPRESS=DEFLATE \
    masks.geojson mask.tif \
    || die "gdal_rasterize failed"

  # 3. Distance from every pixel to the nearest revealed one. This is the feather, and it is a true
  #    ramp by ground distance rather than a blur — which is the whole reason the archive bakes alpha
  #    server-side instead of leaving it to a rasteriser (see imageryCanvas.ts's closing note).
  gdal_proximity -q mask.tif dist.tif -values 255 -distunits GEO \
    -maxdist "$feather_projected" -nodata "$feather_projected" -ot Float32 -co COMPRESS=DEFLATE \
    || die "gdal_proximity failed"

  # 4. Distance -> alpha, via a colour ramp.
  #
  #    `gdaldem color-relief` rather than `gdal raster calc`, deliberately: calc needs muparser, which
  #    this GDAL build does not carry ("Dialect 'muparser' is not supported by this GDAL build"), and
  #    `gdal_calc.py` needs the Python bindings the -small image may not ship. color-relief is core
  #    C++ with neither dependency, and a two-stop ramp linearly interpolated *is* the feather.
  #
  #    No `nv` entry. `gdal_proximity -nodata` sets the *fill value* for pixels past maxdist but does
  #    not flag them as nodata, so color-relief warns "Input dataset has no nodata value. Ignoring
  #    'nv' entry" on every single job. It is redundant anyway: the fill is `feather_projected`, which
  #    is precisely where the ramp already reaches zero. Confirmed against a real run — distance spans
  #    exactly 0→333.6 and the alpha it produces spans 0→255. Dropping it costs nothing and keeps a
  #    fan-out's logs free of a warning that would train everyone to ignore warnings.
  printf '%s\n' '0 255 255 255' "$feather_projected 0 0 0" > ramp.txt
  gdaldem color-relief dist.tif ramp.txt alpha_rgb.tif -co COMPRESS=DEFLATE -q \
    || die "gdaldem color-relief failed"
  gdal_translate -q -b 1 -ot Byte -co COMPRESS=DEFLATE alpha_rgb.tif alpha.tif \
    || die "alpha extraction failed"

  # 5. RGB + alpha into one four-band image. VRTs all the way, so nothing is copied until tiling.
  local i
  for i in 1 2 3; do
    gdal_translate -q -of VRT -b "$i" scene.tif "band${i}.vrt" || die "band $i split failed"
  done
  gdalbuildvrt -q -separate rgba.vrt band1.vrt band2.vrt band3.vrt alpha.tif || die "gdalbuildvrt failed"
  gdal_translate -q -of VRT -colorinterp red,green,blue,alpha rgba.vrt rgba_ci.vrt \
    || die "colorinterp assignment failed"

  # 6. Tile, then convert.
  #
  #    ⚠ `ZOOM_LEVEL_STRATEGY=UPPER` is load-bearing. The MBTiles driver defaults to the *nearest*
  #    zoom, and at our 14 m/px that is z13 (19.1 projected m/px) — coarser than the source, so the
  #    default silently throws away resolution we paid to fetch. UPPER picks z14 and keeps it. The
  #    founder's "no zoom floor" call cuts the same way: what renders is the archive's business, and
  #    discarding detail up front removes a choice the skater is supposed to have.
  rm -f archive.mbtiles archive.pmtiles
  gdal_translate -q -of MBTILES rgba_ci.vrt archive.mbtiles \
    -co TILE_FORMAT=WEBP -co QUALITY=80 -co ZOOM_LEVEL_STRATEGY=UPPER \
    || die "MBTiles tiling failed"
  # ⚠ **Overview levels are explicit, and they have to be.** With no levels given, `gdaladdo` derives
  # factors from the raster's own size, and the MBTiles driver rejects anything that is not a power of
  # two — on a 672-body eastern-Maine extent it derived 129 and died with `ERROR 5: Overview factor
  # '129' is not a power of 2`. Small granules never hit it, so this fails only on the biggest jobs,
  # which are the ones a backfill can least afford to lose.
  #
  # Seven levels take z14 down to about z7, which covers the whole zoom range a scrubber is looked at
  # across — including the founder's "no zoom floor", where a skater is free to pull right out.
  gdaladdo -q -r average archive.mbtiles 2 4 8 16 32 64 128 || die "overview build failed"
  pmtiles convert archive.mbtiles archive.pmtiles >/dev/null 2>&1 || die "pmtiles convert failed"

  # The manifest, because a raster cannot say when it was taken or how cloudy it was — and D84/C4
  # make the date content rather than a caption. Whatever reads this archive reads dates from here.
  jq -n \
    --arg granule "$GRANULE_ID" \
    --arg captured "$CAPTURED_AT" \
    --arg season "$FRAME_SEASON" \
    --arg maskSeason "$MASK_SEASON" \
    --arg collection "$STAC_COLLECTION" \
    --argjson cloud "${CLOUD_PCT:-null}" \
    --argjson bodies "$MASK_COUNT" \
    --argjson feather "$FEATHER_M" \
    '{granuleId:$granule, capturedAt:$captured, cloudCoverPct:$cloud, season:$season,
      maskSeason:$maskSeason, collection:$collection, bodies:$bodies, featherMeters:$feather,
      band:"visual"}' \
    > manifest.json || die "manifest build failed"

  local key_base="frames/${FRAME_SEASON}/${GRANULE_ID}"
  log "uploading $(du -h archive.pmtiles | cut -f1) -> r2:${R2_BUCKET}/${key_base}.pmtiles"
  rclone --config "$RCLONE_CONF" copyto archive.pmtiles "r2:${R2_BUCKET}/${key_base}.pmtiles" \
    --s3-no-check-bucket --s3-chunk-size=64M || die "R2 upload failed"
  rclone --config "$RCLONE_CONF" copyto manifest.json "r2:${R2_BUCKET}/${key_base}.json" \
    --s3-no-check-bucket || die "R2 manifest upload failed"

  log "cut $MASK_COUNT bodies from $GRANULE_ID ($CAPTURED_AT, ${CLOUD_PCT:-?}% cloud)"
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
