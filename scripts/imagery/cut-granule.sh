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
# ## Which mission this id belongs to, decided from the id itself
#
# `cut-granule <id>` stays a one-argument contract (D148) — the caller does not pass a mission, because
# the id already says. Sentinel-2 ids read `S2C_18TXP_20260215_0_L2A`; Sentinel-1 ids read
# `S1A_IW_GRDH_1SDV_20260213T224345_…`. Getting this from a flag instead would mean every caller —
# fan-out, a cron, a person with Docker — has to agree about a fact the id already carries.
case "$GRANULE_ID" in
  S1*) MISSION=s1 ;;
  *)   MISSION=s2 ;;
esac
if [[ "$MISSION" == s1 ]]; then
  STAC_COLLECTION="${STAC_COLLECTION:-sentinel-1-grd}"
else
  STAC_COLLECTION="${STAC_COLLECTION:-sentinel-2-l2a}"
fi

# ⚠ **Radar is warped at 28 m, optical at 14 m, and that is not a downgrade.**
#
# A GRD IW product has 10 m pixel *spacing* but its true spatial *resolution* is 20 x 22 m — the
# spacing oversamples the instrument. 28 projected metres is ~20 m on the ground at 44°N, which is
# what the sensor actually resolves. Warping radar to the optical grid would invent detail Sentinel-1
# does not have and pay four times over for it: a single S1 slice covers ~275 x 210 km, which at 14 m
# is a **700-megapixel** raster (2.8 GB as float32, on a 2 GB Machine) against 175 Mpixels at 28 m.
#
# The zoom range follows: z13 is 19.1 projected m/px, finer than the 28 m source, where z14 would be
# four times the tiles to encode detail the band does not contain.
#
# ## `EROSION_M` — how far in from the bank a pixel must sit to count as interior
#
# ⚠ **It is a centre-to-centre distance, so the ring it removes is one less than it looks.**
# `gdal_proximity` measures from a pixel's centre to the centre of the nearest pixel outside the lake,
# so a pixel in the outermost ring measures exactly one pixel width, the next ring in measures two,
# and so on. A threshold of *k* pixel widths therefore erodes **k−1** rings. Verified on a synthetic
# 20x20 lake: at 20 m (≈2 grid pixels) the interior came out 18x18, not 16x16.
#
# **Optical: 20 m ≈ 2 grid pixels ⇒ one ring off.** That is the mixed-pixel fix and nothing more —
# only the outermost ring can straddle the shoreline, and everything inside it is wholly water. The
# lake-ice literature's usual 1–2 px, taken at the conservative end deliberately, because each extra
# ring costs a small pond every pixel it had to vote with.
#
# **Radar: 60 m ≈ 3 grid pixels ⇒ two rings off**, and the asymmetry is the point. On the optical side
# a bank pixel is a blend; on the radar side it is a ~10 dB brighter target whose energy speckle and
# layover spread further than one pixel, against a ~2 dB signal. Under-eroding there does not blur the
# measurement, it dominates it. See the shoreline note in `sar-zonal.py`.
if [[ "$MISSION" == s1 ]]; then
  WARP_RES=28
  MAX_ZOOM=13
  EROSION_M="${EROSION_M:-60}"
else
  WARP_RES=14
  MAX_ZOOM=14
  EROSION_M="${EROSION_M:-20}"
fi
R2_BUCKET="${R2_BUCKET:-skating-imagery}"
# Which season's masks to clip against. The bake names its artifact for a season and the cutter has
# to be told which one — deriving it from the granule's own date would silently cut a January frame
# against a mask baked for the wrong winter the first time a backfill crosses a July.
MASK_SEASON="${MASK_SEASON:-}"

log() { echo "[cut-granule] $*" >&2; }
die() { echo "[cut-granule] FATAL: $*" >&2; exit 1; }

# --- Stage timing --------------------------------------------------------------------------------
#
# Every expensive step is wrapped so the manifest can say where its seconds went. Without this,
# "which line item costs money" is a guess — and the answer decides whether a nine-season backfill is
# affordable, whether SAR is worth adding, and what an every-few-days winter cadence will cost to run.
#
# Written into the manifest rather than only logged, because `fly logs` ages out within hours while
# the manifest is the permanent record beside the frame it describes. An aggregate across a sample of
# granules is then a bucket listing, not a log-scraping exercise.
STAGE_JSON="{}"
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
RUN_STARTED_MS="$(now_ms)"

# stage <name> <command…> — runs it, records elapsed milliseconds, preserves the exit status.
stage() {
  local name="$1"; shift
  local started ended status=0
  started="$(now_ms)"
  "$@" || status=$?
  ended="$(now_ms)"
  STAGE_JSON="$(jq -c --arg k "$name" --argjson v "$((ended - started))" '. + {($k): $v}' <<<"$STAGE_JSON")"
  return $status
}

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
  stage stac_resolve curl -fsSL --retry 3 --retry-delay 2 "$url" -o granule.json \
    || die "STAC lookup failed for $GRANULE_ID"

  CAPTURED_AT="$(jq -r '.properties.datetime // empty' granule.json)"
  CLOUD_PCT="$(jq -r '.properties["eo:cloud_cover"] // empty' granule.json)"
  [[ -n "$CAPTURED_AT" ]] || die "no datetime on $GRANULE_ID"

  # ⚠ **The radar acquisition parameters are content, not trivia.** Ascending and descending passes
  # view a lake at different incidence angles, and S1A/S1C/S1D differ from each other — so a per-body
  # timeline that blends them reads an instrument difference as an ice change. Selection deliberately
  # keeps every pass (dropping half of them would be irreversible), which makes recording these the
  # thing that lets a consumer filter to comparable frames. Absent on optical items, and null there.
  ORBIT_STATE="$(jq -r '.properties["sat:orbit_state"] // empty' granule.json)"
  POLARISATIONS="$(jq -c '.properties["sar:polarizations"] // empty' granule.json)"
  # ⚠ **The track, which is a finer comparability key than the direction.** Orbit direction separates
  # east-looking from west-looking; `relative_orbit` separates the individual repeat tracks *within* a
  # direction, and two of those still view a lake at different incidence angles. A consumer holding
  # only direction constant is holding most of the geometry constant, not all of it — which matters
  # because the surviving S1A/S1C offset and the planimetric bounce are both incidence-angle effects.
  # Free here, and impossible to recover later without re-reading every granule.
  RELATIVE_ORBIT="$(jq -r '.properties["sat:relative_orbit"] // empty' granule.json)"
  PLATFORM="${GRANULE_ID%%_*}"

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

# What a body looks like in `bodies[]` when it is in the frame but was not measured — see
# `reconcile_bodies`. Every statistic is `null` ("unmeasured"); only the counts are 0, because "no
# pixels" is itself a measurement and the thing N6g Lane 2 has to be able to read.
OPTICAL_NULL_BODY='{"clearPct":null,"coveragePct":null,"snowIcePct":null,"waterPct":null,
  "ndsiMean":null,"pixels":0,"interiorPixels":0,"classHist":null,"interiorClassHist":null}'
SAR_NULL_BODY='{"vvDb":null,"vhDb":null,"coveragePct":null,"pixels":0,"interiorPixels":0,
  "interiorVvDb":null,"interiorVhDb":null,"sigma0Hist":null,"belowNoiseFloorPct":null,
  "incidenceDeg":null,"geocodeReferenceHeightM":null,"geocodeShiftM":null}'

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

  # ⚠ **Refuse a pre-2026-08-25 bake outright rather than falling back to reveal-shaped zones.**
  #
  # Until that date there was one mask file and this script rasterised it as the zone grid — so every
  # per-body statistic in the archive counted the lake *plus* a 60 m ring of shore, plus its islands,
  # plus the trail and the parking lot. On a 1-acre pond that ring is 7x the pond's own area.
  #
  # A silent fallback would put that back on exactly the runs nobody is watching, and the output looks
  # completely normal — plausible percentages, no error, wrong denominator. So it is fatal, and the
  # remedy is a sentence rather than a diagnosis.
  [[ "$(jq -r '.waterMasks // false' mask-meta.json)" == "true" ]] \
    || die "masks/${MASK_SEASON} predates the water-mask split — re-run \`bake-masks --upload\` for it"

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
  # ⚠ **And "no count" is NOT zero.** `${MASK_COUNT:-0}` used to stand here, which meant any way of
  # failing that still exits 0 — a driver change, a renamed layer, an `ogrinfo` whose output format
  # moved — reported "nothing to cut", exited 0, and produced no frame. Across a fan-out that is a
  # whole backfill returning success having written nothing, which is exactly the failure
  # `assertTileSurveyUsable` exists to stop one layer up; the container had no equivalent.
  MASK_COUNT=""
  MASK_COUNT="$(ogrinfo -so -al -spat "$MINLNG" "$MINLAT" "$MAXLNG" "$MAXLAT" "$src" 2>/dev/null \
    | sed -n 's/^Feature Count: //p' | head -1)" || true
  [[ "$MASK_COUNT" =~ ^[0-9]+$ ]] \
    || die "no feature count from ${base}.fgb — refusing to report 'nothing to cut' on a read failure"
  log "masks intersecting this granule: $MASK_COUNT"
  [[ "$MASK_COUNT" -eq 0 ]] && return 0

  # Reprojected to 3857 on the way out, because everything downstream is. EPSG:3857 is not optional
  # anywhere in this pipeline: a linear lat/lng mask sits ~20 m off the shoreline at 44°N and reads
  # as the imagery being misregistered rather than as our bug (packages/core/src/webMercator.ts).
  stage fetch_masks ogr2ogr -f GeoJSON masks.geojson \
    -spat "$MINLNG" "$MINLAT" "$MAXLNG" "$MAXLAT" -spat_srs EPSG:4326 \
    -t_srs EPSG:3857 \
    "$src" \
    || die "could not read masks from ${base}.fgb"

  # The water polygons — the same bodies, unbuffered, holes intact. See `build_zones`.
  #
  # ⚠ **This clip can return FEWER features than the reveal clip, and that is correct.** The reveal is
  # a superset of the buffered water, so a lake just outside the granule bbox whose parking lot is
  # inside it intersects the reveal filter and not this one. That body genuinely has no water pixels
  # here; `build_zones` reconciles it back into `bodies.json` with null statistics rather than
  # dropping it, because PR 3 reads `bodies[]` as exact frame membership.
  local water_src="/vsis3/${R2_BUCKET}/${base}-water.fgb"
  WATER_COUNT=""
  WATER_COUNT="$(ogrinfo -so -al -spat "$MINLNG" "$MINLAT" "$MAXLNG" "$MAXLAT" "$water_src" 2>/dev/null \
    | sed -n 's/^Feature Count: //p' | head -1)" || true
  # Same reasoning as `MASK_COUNT` above: "no count" is a read failure, not zero. A silent zero here
  # would ship a frame whose every body carries null statistics and no indication why.
  [[ "$WATER_COUNT" =~ ^[0-9]+$ ]] \
    || die "no feature count from ${base}-water.fgb — refusing to measure nothing and call it a cut"
  log "water polygons intersecting this granule: $WATER_COUNT of $MASK_COUNT"

  if [[ "$WATER_COUNT" -gt 0 ]]; then
    stage fetch_water_masks ogr2ogr -f GeoJSON water.geojson \
      -spat "$MINLNG" "$MINLAT" "$MAXLNG" "$MAXLAT" -spat_srs EPSG:4326 \
      -t_srs EPSG:3857 \
      "$water_src" \
      || die "could not read water masks from ${base}-water.fgb"
  fi
}

# The projected extent the masks occupy, which is all of the granule worth warping.
#
# ⚠ **Takes every file whose geometry has to fit, not just the reveal.** On the radar path the zones
# are shifted by the geocode correction — up to ~450 m, sixteen 28 m pixels — while the reveal is only
# 60 m of buffer wide. An extent computed from the reveal alone would leave a lake near the edge of it
# with its corrected zone hanging off the raster, and the body would report a coverage shortfall that
# looks exactly like a granule edge.
mask_extent() {
  jq -s -r '
    [.[].features[].geometry | (if .type=="Polygon" then [.coordinates] else .coordinates end)[][][]]
    | (map(.[0]) | min), (map(.[1]) | min), (map(.[0]) | max), (map(.[1]) | max)
  ' "$@" | paste -sd' ' -
}

# Build `alpha.tif` — the reveal's soft edge — on a given extent at `$WARP_RES`.
#
# Shared by both missions, because the feather is a property of the *lake outline* rather than of the
# sensor: the same 240 ground metres of ramp, whether the pixels underneath came from a camera or a
# radar. A second copy would be a second chance for optical and radar frames to disagree about where a
# lake ends, which would show up as a seam wherever a scrubber crossed between them.
#
# ⚠ **Mercator metres are not ground metres**, and this is where that bites. Web Mercator inflates
# distance by 1/cos(latitude) — ~1.39x at 44°N — so feeding `gdal_proximity` a bare 240 would ramp over
# 240 *projected* metres, which is ~173 m on the ground: a 28% error that looks like a slightly tight
# edge rather than like a units bug.
# Web Mercator metres for a ground distance, at an extent's centre latitude.
#
# ⚠ **The single place this conversion lives.** Mercator inflates distance by 1/cos(φ) — ~1.39x at
# 44°N — so a bare ground figure handed to `gdal_proximity` or to a pixel offset is 28% short. It is
# needed by the feather, by the erosion and by the radar de-shift's padding, and three copies of one
# trig expression is three chances for one of them to be the old one.
project_ground_m() {
  awk -v g="$1" -v miny="$2" -v maxy="$3" 'BEGIN{
    pi=3.14159265358979; mw=20037508.342789244; cy=(miny+maxy)/2;
    lat=(2*atan2(exp((cy/mw)*pi),1)-pi/2)*180/pi;
    printf "%.1f", g/cos(lat*pi/180)
  }'
}

centre_lat_of() {
  awk -v miny="$1" -v maxy="$2" 'BEGIN{
    pi=3.14159265358979; mw=20037508.342789244; cy=(miny+maxy)/2;
    printf "%.6f", (2*atan2(exp((cy/mw)*pi),1)-pi/2)*180/pi
  }'
}

build_alpha() {
  local MINX="$1" MINY="$2" MAXX="$3" MAXY="$4"
  local centre_lat feather_projected
  centre_lat="$(centre_lat_of "$MINY" "$MAXY")"
  feather_projected="$(project_ground_m "$FEATHER_M" "$MINY" "$MAXY")"
  log "feather ${FEATHER_M} ground m -> ${feather_projected} projected m at ${centre_lat}°N"

  # 1. Burn the reveal shapes into a byte mask on exactly that grid.
  stage rasterize_mask gdal_rasterize -q -burn 255 -init 0 -ot Byte \
    -te "$MINX" "$MINY" "$MAXX" "$MAXY" -tr "$WARP_RES" "$WARP_RES" -co COMPRESS=DEFLATE \
    masks.geojson mask.tif \
    || die "gdal_rasterize failed"

  # 3. Distance from every pixel to the nearest revealed one. This is the feather, and it is a true
  #    ramp by ground distance rather than a blur — which is the whole reason the archive bakes alpha
  #    server-side instead of leaving it to a rasteriser (see imageryCanvas.ts's closing note).
  stage feather_proximity gdal_proximity -q mask.tif dist.tif -values 255 -distunits GEO \
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
}

# Build `zones.tif` + `zone-to-id.json` + `interior.tif` — what every zonal statistic joins on.
#
# Shared by both missions for the same reason `build_alpha` is: the zone raster is a property of the
# *mask geometry*, not of the sensor, and the optical and radar copies of these three commands had
# already drifted (one carried `-co TILED=YES`, the other hardcoded `14` where `$WARP_RES` belongs).
# A zone grid that disagrees with the image grid is the silent failure `zonal-clear.py` and
# `sar-zonal.py` both refuse to run into — so there is exactly one place it can be wrong.
#
# ## ⚠ The zones come from `water.geojson`, and using `masks.geojson` here was a bug for two months
#
# `masks.geojson` is the **reveal** — `revealShape`, so the lake buffered 60 m outward, unioned with
# the walk in and the parking, with island holes dropped. Burning that as the zone grid is what the
# first version of this function did, and it meant `clearPct`, `snowIcePct`, `waterPct`, `vhDb` and
# `vvDb` were measured over the lake *plus* a ring of shore, *plus* its islands, *plus* a trail
# corridor and a car park.
#
# The contamination is a fixed-width ring, so its share of a zone scales with perimeter over area:
# negligible on Champlain, **7x a circular 1-acre pond's own area** — 86% land. It reads as a
# plausible percentage either way, which is why nothing caught it. Consistent with the measurement
# recorded in `zonal-clear.py`: Mascoma at 98% clear reported 82.5% water, and a 60 m ring on ~16 km
# of shoreline is about the missing 17.5%.
#
# `-a zone` needs a numeric attribute, hence the index `jq` adds here: the corpus id is a string and
# cannot be burned into a raster.
build_zones() {
  local MINX="$1" MINY="$2" MAXX="$3" MAXY="$4"

  # `ZONE_SOURCE` is `water.geojson` except on the radar path, where it is the geocode-corrected copy
  # — see `geocode_zones`. It is a variable rather than a second function because everything below
  # here is identical and the two copies had already drifted once.
  jq -c '{type:"FeatureCollection", features:[.features | to_entries[] | .value * {properties: (.value.properties + {zone: (.key + 1)})}]}' \
    "$ZONE_SOURCE" > water-zoned.geojson || die "zone numbering failed"
  jq -c '[.features[] | {key: (.properties.zone|tostring), value: .properties.waterBodyId}] | from_entries' \
    water-zoned.geojson > zone-to-id.json || die "zone mapping failed"

  stage rasterize_zones gdal_rasterize -q -a zone -a_nodata 0 -init 0 -ot UInt32 \
    -te "$MINX" "$MINY" "$MAXX" "$MAXY" -tr "$WARP_RES" "$WARP_RES" \
    -co COMPRESS=DEFLATE -co TILED=YES \
    water-zoned.geojson zones.tif \
    || die "zone rasterize failed"

  build_interior "$MINY" "$MAXY"
}

# Where the zone polygons are read from. Always true positions — see `resolve_geocode`.
ZONE_SOURCE=water.geojson
GEOCODE_JSON=null
GEOCODE_ARGS=()

# ## The DEM-corrected geocode — put each lake's pixels back under its own polygon
#
# A GRD carries no map projection, only ground-control points computed at **one average scene
# height**. A lake above or below that reference lands displaced along range by `(h - h_ref)/tan(θ)`
# — and because Sentinel-1 is right-looking, ascending views a lake from one side and descending from
# the other, so the displacement flips between them. That is what made two islands in Mascoma jump
# east, west, east as a scrubber advanced through alternating passes.
#
# **Measured before it was wired in** (2026-08-25), per the rule the tiler swap established. Two real
# passes 24 h apart over Mascoma, range bearings 76° and 284°, both measuring +150 m of EPSG:3857
# easting = ~108 m on the ground:
#
#   ✅ **The direction is confirmed** — both positive along their own range, in nearly opposite ground
#      directions, which is the signature of a height effect rather than a polygon error. Un-negated,
#      the correction moves a lake from ~108 m out to ~270 m out, i.e. worse than not correcting.
#   ⚠ **The magnitude is approximate and consistently over** — predicted 162 m and 129 m against 108 m.
#      Correcting halves the per-pass error and cuts the disagreement BETWEEN passes by about two
#      thirds; it does not eliminate it. See `packages/core/src/sarGeocode.ts` for what was ruled out.
#
# ⚠ **The correction moves the PIXELS, not the masks, and it lands before anything else reads them.**
# `sar-deshift.py` rewrites each polarisation so every lake sits under its own polygon; afterwards the
# alpha, the zones, the statistics and the tiles all work at true positions with no offset threaded
# through any of them. A first version shifted the zone geometry instead — which fixed the numbers and
# left the picture displaced, so the frame disagreed with the basemap and the islands still moved.
#
# **And that is what lets a timeline mix orbit directions again.** PR 3 holds one direction per
# timeline precisely because the two disagreed about where a lake was. Corrected, they agree, and the
# radar cadence doubles.
resolve_geocode() {
  local href="$1" annotation_url

  # STAC's `schema-product-*` asset points at the RFI annotation, not the product one, so the path is
  # derived from the measurement href instead: `/measurement/iw-vh.tiff` -> `/annotation/iw-vh.xml`.
  annotation_url="$(sed 's#/measurement/#/annotation/#; s#\.tiff$#.xml#' <<<"$href")"
  if ! curl -fsSL --retry 3 "$annotation_url" -o annotation.xml; then
    log "no product annotation at $annotation_url — this pass stays uncorrected"
    return 0
  fi

  # ⚠ **Redirected to a file rather than captured with `$(stage …)`.** Command substitution runs
  # `stage` in a subshell, so its append to `STAGE_JSON` would be discarded and the step would cost
  # nothing according to the manifest — the one place the cost model is read from.
  # ⚠ **The whole grid, not a scene average.** Each lake interpolates its own reference height and
  # incidence from the points around it; averaging the grid made the correction worse than doing
  # nothing (325.6 m RMS against 96.5 m). See `local_reference` in `sar-deshift.py`.
  if ! stage sar_geocode sh -c \
      'python3 /usr/local/bin/sar-geocode.py annotation.xml --grid > geocode-grid.json'; then
    log "geolocation grid unreadable — this pass stays uncorrected"
    return 0
  fi
  GEOCODE_ARGS=(--grid geocode-grid.json)
  # The manifest records the scene summary, which is a fair description of the pass even though it is
  # not what any lake is corrected with.
  GEOCODE_JSON="$(jq -c '{headingDeg, sceneReferenceHeightM, sceneIncidenceDeg,
                          gridPoints: (.points | length)}' geocode-grid.json)"
  log "geocode: $GEOCODE_JSON"
}

# Widen the warp extent to cover where the pixels currently ARE, not only where they belong.
#
# ⚠ **Without this the correction silently truncates the lakes that need it most.** The de-shift
# fetches each body's pixels from up to ~450 m outside its own footprint, so an extent drawn around
# the masks alone leaves the outermost lakes reading partly from beyond the raster — and a body that
# came back half-empty would report a coverage shortfall indistinguishable from a granule edge.
#
# The pad is the largest correction any body under THIS granule actually needs, so a pass over a flat
# region pays nothing for one over the White Mountains.
geocode_pad() {
  [[ ${#GEOCODE_ARGS[@]} -gt 0 ]] || return 0
  local pad
  # The largest correction any body under THIS mask actually needs, computed from the same local
  # references the de-shift will use — not from the grid's extremes against every body, which is safe
  # and can double the area warped on a small granule.
  pad="$(project_ground_m \
    "$(python3 /usr/local/bin/sar-deshift.py masks.geojson --grid geocode-grid.json --plan)" \
    "$MINY" "$MAXY")"
  # One pixel of slack for the de-shift's rounding to whole pixels.
  pad="$(awk -v p="$pad" -v r="$WARP_RES" 'BEGIN{printf "%.1f", p + r}')"
  MINX="$(awk -v v="$MINX" -v p="$pad" 'BEGIN{printf "%.6f", v-p}')"
  MAXX="$(awk -v v="$MAXX" -v p="$pad" 'BEGIN{printf "%.6f", v+p}')"
  MINY="$(awk -v v="$MINY" -v p="$pad" 'BEGIN{printf "%.6f", v-p}')"
  MAXY="$(awk -v v="$MAXY" -v p="$pad" 'BEGIN{printf "%.6f", v+p}')"
  log "geocode pad ${pad} projected m (the largest correction any body here needs)"
}

# Put one polarisation's pixels back under their lakes, in place.
#
# ⚠ **Fails the job rather than carrying on uncorrected.** A silently un-de-shifted band produces
# statistics measured off the lake — the exact failure this path exists to remove — and nothing
# downstream can tell the difference, because a displaced lake still yields a plausible backscatter.
deshift_band() {
  local pol="$1" feather_projected="$2"
  [[ ${#GEOCODE_ARGS[@]} -gt 0 ]] || return 0

  stage "deshift_${pol}" sh -c "python3 /usr/local/bin/sar-deshift.py masks.geojson \
    ${pol}.tif ${pol}-deshifted.tif $(printf '%q ' "${GEOCODE_ARGS[@]}") \
    --feather-projected-m ${feather_projected} --per-body geometry-${pol}.json \
    > deshift-${pol}.json" \
    || die "de-shift failed for ${pol}"
  mv "${pol}-deshifted.tif" "${pol}.tif"
  log "de-shifted ${pol^^}: $(cat "deshift-${pol}.json")"
}

# ## `interior.tif` — the shoreline eroded off, because an edge pixel is not a lake pixel
#
# A pixel straddling the shoreline mixes water with bank, and standard practice in the lake-ice
# literature is to erode 1–2 pixels before classifying. N6g Lane 2 is the reason it is worth the extra
# proximity pass: its elimination rule turns on *"never observed frozen"*, and **a body too small to
# classify reads exactly like a body that never froze**. After erosion a 1-acre pond has under ten
# pixels left to vote with — so the honest artifact is not a cleaner percentage, it is a **stated
# denominator**, which is what an operator needs in front of them before confirming a removal.
#
# Measured on the synthetic fixture: a 3x3-pixel pond comes out of this with **exactly one** interior
# pixel. That is the whole of Lane 2's caution in one number, and it is now in the manifest rather
# than in a footnote.
#
# So this does not replace the full-zone statistic; it rides alongside it. `pixels` stays what the
# whole body reported and `interiorPixels` says how much of that was clear of the bank.
#
# ⚠ **Ground metres, not projected ones** — the same 1/cos(φ) inflation `build_alpha` corrects for,
# and getting it wrong here would erode 39% further at 44°N than intended, which on a small pond is
# the difference between a few voting pixels and none.
build_interior() {
  local MINY="$1" MAXY="$2"
  local centre_lat erode_projected far

  centre_lat="$(centre_lat_of "$MINY" "$MAXY")"
  erode_projected="$(project_ground_m "$EROSION_M" "$MINY" "$MAXY")"
  # Compute out to twice the threshold so a deep-interior pixel lands on the fill value strictly
  # ABOVE it. Filling at exactly the threshold would make the comparison a float-equality coin toss
  # on every pixel in the middle of every lake — i.e. it would be wrong on the largest bodies only.
  far="$(awk -v e="$erode_projected" 'BEGIN{printf "%.1f", e*2}')"
  EROSION_PROJECTED_M="$erode_projected"
  log "eroding ${EROSION_M} ground m -> ${erode_projected} projected m at ${centre_lat}°N"

  # Distance from each pixel to the nearest pixel OUTSIDE any zone, so a lake's own interior measures
  # its distance to the bank. `-use_input_nodata NO` is explicit rather than relied upon: `zones.tif`
  # declares 0 as nodata, and the zero pixels are precisely the targets this needs to find.
  stage erode_proximity gdal_proximity -q zones.tif interior.tif -values 0 -distunits GEO \
    -maxdist "$far" -nodata "$far" -use_input_nodata NO -ot Float32 -co COMPRESS=DEFLATE \
    || die "gdal_proximity (erosion) failed"
}

# Put every body the REVEAL clip found back into `bodies.json`, measured or not.
#
# ⚠ **PR 3 reads `bodies[]` as exact frame membership**, which is the whole reason the field replaced
# a bare count — so a body missing from this array is a lake with a hole in its timeline rather than
# an error anybody sees. The water clip can legitimately return fewer features than the reveal clip
# (see `fetch_masks`), and a body with no water pixels in this granule still belongs to the frame.
#
# Unmeasured goes out as `null`, never as 0 — "we did not measure it" and "we measured zero" are
# different claims and only one of them is a measurement. Same distinction `zonal-clear.py` draws.
reconcile_bodies() {
  local template="$1"
  jq -c --slurpfile measured bodies.json --argjson template "$template" '
      ($measured[0] | map({key: .waterBodyId, value: .}) | from_entries) as $m
      | [.features[].properties.waterBodyId | $m[.] // ($template + {waterBodyId: .})]
    ' masks.geojson > bodies-reconciled.json || die "body reconciliation failed"
  mv bodies-reconciled.json bodies.json
}

# ## NDSI — a second opinion where the scene classification is weakest
#
# `(green − swir16) / (green + swir16)`. Snow and ice are bright in the visible and very dark in the
# shortwave infrared; **cloud is bright in both.** That difference is the only thing that separates
# them, and true colour cannot do it — which is why a 22 Nov Morey frame read 99% clear through
# visible haze. This is the independent check on SCL's snow/cloud confusion (§C1).
#
# ⚠ **It will not find black ice, and should never be sold as though it might.** NDSI is a *snow*
# index built on the same brightness that misleads SCL: transparent ice over a dark bottom is dark in
# both bands and reads as water, exactly as it does in class 11. Its value is as a disagreement
# detector, not as a better ice classifier.
#
# **A statistic, not a frame.** No tiling, no PMTiles, no upload — two band warps and one windowed
# sweep. Tiling is 63% of a job and there is no product surface asking to look at an NDSI raster; the
# per-body number is what PR 4 and N6g want.
#
# ## ⚠⚠ The offset, which is the thing that would quietly ruin a nine-season backfill
#
# L2A reflectance is `DN * scale + offset`. Processing baseline **04.00 (2022-01-25)** introduced
# `BOA_ADD_OFFSET = -1000` — so `offset` is `-0.1` on recent granules and `0` on older ones, and a
# nine-season archive spans the change. The scale cancels in a normalised ratio; **the offset does
# not.** For typical snow it moves the denominator by about a quarter.
#
# Hardcoding either value would therefore introduce a step change in NDSI at January 2022 that looks
# exactly like a climate signal, in a series whose whole purpose is to compare seasons. So it is read
# per granule from STAC's `raster:bands`, and a granule that will not say is skipped rather than
# guessed at — `null` is recoverable, a wrong number that looks plausible is not.
measure_ndsi() {
  local MINX="$1" MINY="$2" MAXX="$3" MAXY="$4"
  local green_href swir_href band scale offset

  green_href="$(asset_href green)"
  swir_href="$(asset_href swir16)"
  if [[ -z "$green_href" || -z "$swir_href" ]]; then
    log "no green/swir16 pair on this granule — skipping NDSI"
    return 0
  fi

  local args=()
  for band in green swir16; do
    scale="$(jq -r --arg k "$band" '.assets[$k]["raster:bands"][0].scale // empty' granule.json)"
    offset="$(jq -r --arg k "$band" '.assets[$k]["raster:bands"][0].offset // empty' granule.json)"
    if [[ -z "$scale" || -z "$offset" ]]; then
      log "no raster:bands scale/offset for ${band} — skipping NDSI rather than assuming a baseline"
      return 0
    fi
    args+=("--${band}-scale" "$scale" "--${band}-offset" "$offset")
  done
  log "NDSI reflectance transform: green ${args[1]}/${args[3]}, swir16 ${args[5]}/${args[7]}"

  # Nearest, not bilinear, for swir16: it is 20 m native onto a 14 m grid, and interpolating it would
  # invent a shoreline gradient the sensor never resolved — the same reasoning as SCL, for a
  # different reason (there, invented classes; here, invented sub-pixel structure at the bank, which
  # is precisely where the erosion is trying to stop measuring).
  stage warp_green gdalwarp -q -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
    -tr "$WARP_RES" "$WARP_RES" -r bilinear -multi -co COMPRESS=DEFLATE -overwrite \
    "/vsicurl/${green_href}" green.tif || die "green warp failed"
  stage warp_swir gdalwarp -q -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
    -tr "$WARP_RES" "$WARP_RES" -r near -multi -co COMPRESS=DEFLATE -overwrite \
    "/vsicurl/${swir_href}" swir16.tif || die "swir16 warp failed"

  stage zonal_ndsi sh -c "python3 /usr/local/bin/zonal-ndsi.py zones.tif green.tif swir16.tif \
    zone-to-id.json ${args[*]} --interior interior.tif --erode-projected-m $EROSION_PROJECTED_M \
    > ndsi.json" || die "per-body NDSI failed"

  # Folded into the same per-body records rather than shipped as a parallel array, so a consumer
  # never has to join two lists that could disagree about length.
  jq -c --slurpfile ndsi ndsi.json '
      ($ndsi[0] | map({key: .waterBodyId, value: .}) | from_entries) as $n
      | map(. + ($n[.waterBodyId] // {} | del(.waterBodyId)))
    ' bodies.json > bodies-ndsi.json || die "NDSI merge failed"
  mv bodies-ndsi.json bodies.json
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

  read -r MINX MINY MAXX MAXY <<<"$(mask_extent masks.geojson)"
  log "mask extent (3857) $MINX $MINY $MAXX $MAXY"

  # 1. Warp the granule into 3857 over just the mask extent. 14 m/px is ~10 m on the ground here,
  #    which is Sentinel-2's native sample — upsampling would invent detail, downsampling would throw
  #    away the only resolution we have.
  log "warping $href"
  stage warp_visual gdalwarp -q -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
    -tr "$WARP_RES" "$WARP_RES" \
    -r bilinear -multi -co COMPRESS=DEFLATE -overwrite \
    "/vsicurl/${href}" scene.tif \
    || die "gdalwarp failed"

  # 2-4. The reveal, feathered — shared with the radar path, see `build_alpha`.
  build_alpha "$MINX" "$MINY" "$MAXX" "$MAXY"

  # 5. RGB + alpha into one four-band image. VRTs all the way, so nothing is copied until tiling.
  local i
  for i in 1 2 3; do
    gdal_translate -q -of VRT -b "$i" scene.tif "band${i}.vrt" || die "band $i split failed"
  done
  gdalbuildvrt -q -separate rgba.vrt band1.vrt band2.vrt band3.vrt alpha.tif || die "gdalbuildvrt failed"
  gdal_translate -q -of VRT -colorinterp red,green,blue,alpha rgba.vrt rgba_ci.vrt \
    || die "colorinterp assignment failed"

  # 6. SCL — ESA's per-pixel scene classification, and the number the product actually wants.
  #
  # ⚠ **Nearest neighbour, never bilinear.** SCL values are *class labels* (4 = vegetation, 6 = water,
  # 9 = high-probability cloud, 11 = snow/ice). Interpolating between class 8 and class 10 yields class
  # 9 — a different category, invented out of arithmetic. Every resample of this band is nearest.
  #
  # ⚠ **Onto the same grid as the mask**, via the identical `-te`/`-tr`, because the zonal statistic is
  # a per-pixel join. A half-pixel offset silently attributes one lake's cloud to its neighbour, and
  # the result still looks like a plausible percentage.
  local scl_href
  scl_href="$(asset_href scl)"
  if [[ -n "$scl_href" && "$WATER_COUNT" -gt 0 ]]; then
    log "warping SCL (20 m -> grid, nearest)"
    stage warp_scl gdalwarp -q -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
      -tr "$WARP_RES" "$WARP_RES" \
      -r near -multi -co COMPRESS=DEFLATE -overwrite \
      "/vsicurl/${scl_href}" scl.tif \
      || die "SCL warp failed"

    # Zones: each water polygon burned as its own integer, so one sweep can cross-tabulate class
    # against body — shared with the radar path, see `build_zones`.
    build_zones "$MINX" "$MINY" "$MAXX" "$MAXY"

    stage zonal_stats sh -c "python3 /usr/local/bin/zonal-clear.py zones.tif scl.tif zone-to-id.json \
      --interior interior.tif --erode-projected-m $EROSION_PROJECTED_M > bodies.json" \
      || die "zonal clear-fraction failed"

    # NDSI — the second opinion where SCL is weakest. Costs two band warps and no tiling; see
    # `measure_ndsi` for why it is a statistic rather than a frame, and for the offset that would
    # silently bias the early seasons of a nine-season backfill against the late ones.
    measure_ndsi "$MINX" "$MINY" "$MAXX" "$MAXY"

    reconcile_bodies "$OPTICAL_NULL_BODY"
    log "per-body clear fractions: $(jq 'length' bodies.json) bodies"
  else
    # ⚠ **An empty list would say "this frame contains no lakes", which is a different claim.**
    #
    # PR 3 reads `bodies[]` as exact frame membership — it is the whole reason the field replaced a
    # bare count. So a granule that ships `[]` while `bodyCount` says 672 makes every one of those 672
    # lakes silently invisible in the scrubber: not an error, just a timeline missing a date.
    #
    # Membership does not depend on SCL — the ids are right there in the mask clip. Only the
    # *statistics* do, so those go out as `null` ("unmeasured"), never as 0 ("we looked and saw
    # nothing"). Same distinction zonal-clear.py draws for a body with no valid pixels.
    if [[ "$WATER_COUNT" -eq 0 ]]; then
      log "no water polygons under this granule — membership without statistics"
    else
      log "no SCL asset on this granule — membership without clear fractions"
    fi
    printf '[]' > bodies.json
    reconcile_bodies "$OPTICAL_NULL_BODY"
  fi

  # ⚠ **Drop the statistics' intermediates before tiling, because RAM is the whole budget.**
  #
  # Measured 2026-08-25 on the corpus's largest granule (Champlain, 237.7 Mpixels): `tile_visual` took
  # **402.7s**, against ~0.2 s/Mpixel — about 48s — everywhere else in the same archive. Nothing in the
  # tiling path had changed; what changed was that the statistics now leave `zones.tif` (UInt32),
  # `interior.tif` (Float32), `green.tif` and `swir16.tif` behind them. At 237 Mpixels those are
  # roughly a gigabyte apiece, on a Machine with 2 GB — so the page cache holding `scene.tif` is
  # evicted and the tiler re-reads every block from disk.
  #
  # They have all been consumed by this point: `bodies.json` holds everything they were read for.
  # `scl.tif` survives only if it is about to become a frame.
  rm -f zones.tif interior.tif green.tif swir16.tif water-zoned.geojson dist.tif mask.tif \
    alpha_rgb.tif
  [[ "${EMIT_SCL_FRAME:-1}" == "1" ]] || rm -f scl.tif

  # 7. Tile the whole pyramid in one pass, pack it, convert it.
  #
  # ## Why `gdal raster tile` and not `gdal_translate -of MBTILES` + `gdaladdo`
  #
  # The old path wrote the base zoom with the MBTiles driver and then built seven overview levels with
  # `gdaladdo`. Measured 2026-08-24 on the corpus's largest granule (this one — Champlain,
  # S2C_18TXP_20260215, 923 bodies, 237.7 Mpixels), at four threads to match `shared-cpu-4x`:
  #
  #     gdal_translate -of MBTILES   50.6s  +  gdaladdo  24.3s  +  pmtiles  0.1s  =  75.0s
  #     gdal raster tile  28.6s  +  pack  0.1s  +  pmtiles  0.1s              =  28.9s
  #
  # **2.6x**, because this builds every zoom in one parallel sweep instead of a single-threaded base
  # pass followed by a separate overview pass. Tiling was 63% of a job, so this takes the median job
  # from ~114s to ~70s.
  #
  # It also deletes trap 12 outright: `gdaladdo` needed explicit power-of-two levels because it
  # derived a factor of 129 on a large extent and the MBTiles driver rejected it — a failure that hit
  # only the biggest granules. `--min-zoom/--max-zoom` states the range directly, so there is no
  # derived factor to be wrong.
  #
  # ## ⚠ The nodata handling here is load-bearing for correctness, not just for speed
  #
  # **The old path rendered lakes as solid black.** The alpha we burn comes from *mask geometry*, which
  # knows nothing about where the satellite was looking: the raster is the bounding box of every body
  # the granule touches, while the acquisition swath is a rotated quadrilateral inside it. Any lake in
  # a corner the swath misses got `gdalwarp`'s nodata black under an alpha saying **fully opaque**.
  # On this granule that was **843 of 3,213 tiles** — 26% of the output — including the whole northern
  # third of Lake Champlain as a black lake-shaped blob. It read as "this lake is black" rather than
  # "this lake was not photographed", the exact confusion `footprint` and §C4 exist to prevent.
  #
  # `gdal raster tile` honours the source's per-band nodata — which `scene.tif` inherits from Sentinel's
  # TCI (`NoData Value=0`) — and applies it **per pixel**, not merely per tile. So out-of-swath pixels
  # come out transparent whether or not the tile containing them is entirely blank. Verified by
  # building the same granule with the alpha explicitly clipped against a `-dstalpha` validity band:
  # **zero pixels differed.** That is why there is no separate alpha-clipping stage here.
  #
  # ⚠ **So do not swap this tiler back without restoring that property another way.** The old
  # `gdal_translate -of MBTILES` path reads band 4 as alpha and consults nothing else, which is
  # precisely how the black lakes got written.
  #
  # ## The zoom range is coupled to the warp above
  #
  # Step 1 warps at `-tr 14 14` (projected). Web Mercator z14 is 9.55 projected m/px — finer than the
  # source, so it preserves everything we paid to fetch; z13 is 19.1, which would throw resolution
  # away. z7 is the bottom of the range a scrubber is looked at across, including the founder's "no
  # zoom floor" where a skater pulls right out. **Change `-tr` and this range has to change with it.**
  #
  # ⚠ **`--convention tms` is not optional.** MBTiles numbers rows from the bottom; `gdal raster tile`
  # defaults to `xyz`, which numbers from the top. Packing xyz tiles into MBTiles yields an archive
  # that is *vertically mirrored* — every tile individually correct, the map upside down. It renders
  # rather than erroring, which is the worst way for it to be wrong.
  #
  # `--webviewer none` suppresses the leaflet/openlayers/mapml scaffolding the tiler writes by
  # default; we are packing tiles, not publishing a viewer.
  rm -rf tiles archive.mbtiles archive.pmtiles
  stage tile_visual gdal raster tile -q --input rgba_ci.vrt --output tiles \
    -f WEBP --co QUALITY=80 \
    --min-zoom 7 --max-zoom 14 \
    --convention tms --skip-blank --webviewer none \
    -r bilinear --overview-resampling average \
    || die "tiling failed"
  stage pack_visual python3 /usr/local/bin/tiles-to-mbtiles.py tiles archive.mbtiles \
    --format webp --name "$GRANULE_ID" \
    || die "MBTiles packing failed"
  stage pmtiles_visual sh -c 'pmtiles convert archive.mbtiles archive.pmtiles >/dev/null 2>&1' \
    || die "pmtiles convert failed"

  # SCL as its own *frame* is ON by default — founder call, 2026-08-25, reversing the 08-24 default.
  #
  # PR 3's band selector shows the classification alongside true colour, which is what §C1 argues makes
  # a band selector honest rather than decorative: a skater who wants to know what a claim was derived
  # *from* can look at it. That is a product reason, and it outranks the cost reason the flag was
  # originally set for. Set `EMIT_SCL_FRAME=0` to go back to statistics-only.
  #
  # §3's per-body clear fraction is the valuable half and always runs regardless; this is only the
  # raster. Note the "own the pixels" argument does not carry here — Copernicus keeps SCL for these
  # granule ids indefinitely, and the manifest's `bodies` array already saves the re-derivation cost.
  #
  # ⚠ **MEASURE THIS ON A DENSE GRANULE BEFORE COMMITTING A SEASON TO IT.** On 2026-08-24 tiling SCL
  # took a 923-body Champlain extent (11,532 x 20,608 px) past **17 minutes without finishing**,
  # against ~2 minutes for the same granule's true colour — while the season-wide average came out at
  # only +24% job time and +33% storage. Those two numbers describe the same change, and the gap
  # between them is the risk: ~18% of a season's granules sit on 1,000+ body tiles, so an average that
  # looks affordable can hide a tail that does not finish.
  #
  # That measurement also predates the tiler swap landed the same day (~2.6x on the visual path), so
  # it may already be stale in the good direction. Either way the rule from that swap applies — it was
  # prototyped on one granule before it touched a season, and that is what caught the black lakes.
  BANDS='["visual"]'
  if [[ -s scl.tif && "${EMIT_SCL_FRAME:-1}" == "1" ]]; then
    rm -rf scl-tiles scl.mbtiles scl.pmtiles
    # z13, not z14: SCL is 20 m native, so z13 (~13.7 ground m/px here) already exceeds the source.
    # Going a zoom deeper would generate 4x the tiles to encode detail the band does not contain.
    #
    # ⚠ **Nearest at every level, for the reason given at the SCL warp above** — these are class
    # labels, and averaging class 8 against class 10 invents class 9. That applies to the overview
    # pyramid exactly as it applies to the warp, which is why `--overview-resampling` is set here
    # rather than left at its default of `average`.
    #
    # PNG rather than WEBP: lossy compression on a label band is the same category of error as
    # interpolating one.
    log "tiling SCL (EMIT_SCL_FRAME on)"
    stage tile_scl gdal raster tile -q --input scl.tif --output scl-tiles \
      -f PNG --min-zoom 7 --max-zoom 13 \
      --convention tms --skip-blank --webviewer none \
      -r nearest --overview-resampling nearest \
      || die "SCL tiling failed"
    python3 /usr/local/bin/tiles-to-mbtiles.py scl-tiles scl.mbtiles \
      --format png --name "${GRANULE_ID}-scl" || die "SCL MBTiles packing failed"
    pmtiles convert scl.mbtiles scl.pmtiles >/dev/null 2>&1 || die "SCL pmtiles convert failed"
    BANDS='["visual","scl"]'
  fi

  # The manifest, because a raster cannot say when it was taken or how cloudy it was — and D84/C4
  # make the date content rather than a caption. Whatever reads this archive reads dates from here.
  #
  # `footprint` is the STAC item's own `geometry` — the acquisition polygon, which is where this frame
  # has pixels at all. Without it a scrubber cannot tell "this lake was not photographed that day"
  # from "it was photographed and looked like nothing", and has to show every frame and hope. Copied
  # here rather than looked up when the index is built, because it is a claim about the granule we
  # actually cut: ESA reprocesses, and a footprint fetched months later may describe a different one.
  #
  # ⚠ **`--slurpfile` for `bodies`, never `--argjson "$(cat …)"` — that fails only on the granules
  # that matter most, and only on Linux.**
  #
  # The limit is **`MAX_ARG_STRLEN`: 128 KiB for a single argument** on Linux (32 pages), which is a
  # separate and much lower ceiling than the ~2 MB total `ARG_MAX` everyone reaches for first. A
  # per-body entry measures **98 bytes** in a real manifest, so the manifest build dies above roughly
  # **1,342 bodies** with `jq: Argument list too long` → `FATAL: manifest build failed` → no frame in
  # the bucket.
  #
  # Measured 2026-08-24 on a 50-granule sample: **exactly the five granules with 1,767–2,277 bodies
  # failed**, and all 45 below the threshold succeeded. ~18% of a season's granules sit on 1,000+ body
  # tiles, so a backfill would have quietly lost its densest frames — over the regions holding the most
  # lakes — while reporting success everywhere else.
  #
  # ⚠ **It does not reproduce on macOS**, where a 255 KB argument passes cleanly. Anyone testing this
  # path locally will conclude it works. The container is Linux; only the container's answer counts.
  #
  # `--slurpfile` reads the file directly, so nothing crosses argv. It wraps the contents in an array,
  # hence `$bodies[0]` at the point of use.
  jq -n \
    --arg granule "$GRANULE_ID" \
    --arg captured "$CAPTURED_AT" \
    --arg season "$FRAME_SEASON" \
    --arg maskSeason "$MASK_SEASON" \
    --arg collection "$STAC_COLLECTION" \
    --argjson cloud "${CLOUD_PCT:-null}" \
    --argjson bodyCount "$MASK_COUNT" \
    --slurpfile bodies bodies.json \
    --argjson bands "$BANDS" \
    --argjson stageMs "$STAGE_JSON" \
    --argjson totalMs "$(( $(now_ms) - RUN_STARTED_MS ))" \
    --argjson pixels "$(( ( ${MAXX%.*} - ${MINX%.*} ) / 14 * ( ${MAXY%.*} - ${MINY%.*} ) / 14 ))" \
    --arg vmSize "${FLY_VM_SIZE_LABEL:-unknown}" \
    --argjson feather "$FEATHER_M" \
    --argjson erosionM "$EROSION_M" \
    --argjson footprint "$(jq -c '.geometry' granule.json)" \
    '{granuleId:$granule, capturedAt:$captured, cloudCoverPct:$cloud, season:$season,
      maskSeason:$maskSeason, collection:$collection, bodyCount:$bodyCount, bodies:$bodies[0],
      bands:$bands, featherMeters:$feather, erosionMeters:$erosionM, footprint:$footprint,
      cost:{stageMs:$stageMs, totalMs:$totalMs, gridPixels:$pixels, vmSize:$vmSize}}' \
    > manifest.json || die "manifest build failed"

  # Keyed by band, because a granule now yields more than one frame and `<granuleId>.pmtiles` could
  # only ever name one of them.
  local key_base="frames/${FRAME_SEASON}/${GRANULE_ID}"
  log "uploading $(du -h archive.pmtiles | cut -f1) -> r2:${R2_BUCKET}/${key_base}-visual.pmtiles"
  stage upload_visual rclone --config "$RCLONE_CONF" copyto archive.pmtiles \
    "r2:${R2_BUCKET}/${key_base}-visual.pmtiles" \
    --s3-no-check-bucket --s3-chunk-size=64M || die "R2 upload failed"
  if [[ -s scl.pmtiles ]]; then
    rclone --config "$RCLONE_CONF" copyto scl.pmtiles "r2:${R2_BUCKET}/${key_base}-scl.pmtiles" \
      --s3-no-check-bucket --s3-chunk-size=64M || die "R2 SCL upload failed"
  fi
  rclone --config "$RCLONE_CONF" copyto manifest.json "r2:${R2_BUCKET}/${key_base}.json" \
    --s3-no-check-bucket || die "R2 manifest upload failed"

  log "cut $MASK_COUNT bodies from $GRANULE_ID ($CAPTURED_AT, ${CLOUD_PCT:-?}% cloud)"
}

# --- The radar transform ---------------------------------------------------------------------------
#
# Sentinel-1's path is genuinely different from Sentinel-2's, not a variation on it:
#
#   * **No colour composite.** VV and VH are single-band intensity, so there is no RGB to assemble.
#   * **No map projection in the source.** A GRD sits in *radar* geometry and carries ground-control
#     points instead of a geotransform, so `-tps` does the geocoding.
#
#     ⚠ **This was assumed accurate enough without terrain correction, and it is not — 2026-08-25.**
#     The GCPs geocode at a reference height, so ground above it is displaced along the RANGE
#     direction by roughly `dh / tan(theta)` — ~140 m per 100 m of elevation error at IW incidence.
#     Sentinel-1 is right-looking, so ascending views from the east and descending from the west and
#     the shift flips sign between them. Watched live on Mascoma: two islands jumping east, west,
#     east as the scrubber advanced through alternating passes. "Over a lake it is flat" is true and
#     insufficient — what matters is the lake's height above the GCP reference, not its own flatness.
#     PR 3 mitigates by holding one orbit direction per timeline; the fix is a DEM-corrected geocode.
#     See the N6e plan's open question 8, and note it may share a cause with question 7.
#   * **The pixels are not the measurement.** They are detector counts; the calibration annotation is
#     what turns them into `sigma0`. See `sar-cal-lut.py` for why skipping it is a 1.5 dB error inside
#     a single scene, against a ~2 dB signal.
#   * **No cloud, ever.** Which is the entire reason it is here: optical loses ~75% of passes to
#     weather, and radar loses none.
transform_sar() {
  fetch_masks
  if [[ "$MASK_COUNT" -eq 0 ]]; then
    log "no corpus bodies under this pass — nothing to cut"
    return 0
  fi

  # ⚠ **The scene geometry is read before the extent is fixed.** `geocode_pad` needs it to know how
  # far outside the masks the de-shift will have to reach.
  local p href annotation_href=""
  for p in vh vv; do
    href="$(asset_href "$p")"
    [[ -n "$href" ]] || continue
    annotation_href="${href/s3:\/\/sentinel-s1-l1c\//https:\/\/sentinel-s1-l1c.s3.amazonaws.com\/}"
    break
  done
  [[ -n "$annotation_href" ]] && resolve_geocode "$annotation_href"

  read -r MINX MINY MAXX MAXY <<<"$(mask_extent masks.geojson)"
  geocode_pad
  log "mask extent (3857) $MINX $MINY $MAXX $MAXY at ${WARP_RES} m"

  # Needed by `deshift_band` before `build_alpha` gets to compute it for itself.
  local feather_projected
  feather_projected="$(project_ground_m "$FEATHER_M" "$MINY" "$MAXY")"

  # Both polarisations are cut. VH is the informative one for ice, but VV costs one more warp of a
  # granule already open, and their ratio is a standard discriminator we would otherwise have to come
  # back for — the same "own the pixels" argument that governs the optical side.
  local pols=() zonal_args=()
  local cal_href
  for p in vv vh; do
    href="$(asset_href "$p")"
    [[ -n "$href" ]] || continue
    # STAC gives these as `s3://` into a bucket that also serves anonymously over HTTPS, which is what
    # `/vsicurl/` wants. Measured 2026-08-24: readable without credentials, unlike its own scheme.
    href="${href/s3:\/\/sentinel-s1-l1c\//https:\/\/sentinel-s1-l1c.s3.amazonaws.com\/}"
    log "warping ${p^^}"
    stage "warp_${p}" gdalwarp -q -tps -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
      -tr "$WARP_RES" "$WARP_RES" -r bilinear -multi -co COMPRESS=DEFLATE -co TILED=YES -overwrite \
      "/vsicurl/${href}" "${p}.tif" \
      || die "${p} warp failed"

    # Put the pixels back under their lakes, before anything measures or renders them. Everything
    # downstream — alpha, zones, statistics, tiles — then works at true positions.
    #
    # ⚠ **Neither the calibration nor the noise LUT is de-shifted with it, and that is safe.** Both
    # are smooth in range: gain varies ~1.50 dB across a 275 km scene, so over a 450 m correction it
    # moves ~0.0025 dB. The one place the noise LUT is NOT smooth is the sub-swath seams, which sit
    # ~80 km apart — a shift of a few hundred metres can only mis-assign a body sitting essentially on
    # one, and the error there is bounded by the step itself. Warping either a second time would buy
    # thousandths of a decibel.
    deshift_band "$p" "$feather_projected"

    cal_href="$(jq -r --arg k "schema-calibration-${p}" '.assets[$k].href // empty' granule.json)"
    [[ -n "$cal_href" ]] || die "no calibration annotation for ${p} — refusing to ship uncalibrated"
    cal_href="${cal_href/s3:\/\/sentinel-s1-l1c\//https:\/\/sentinel-s1-l1c.s3.amazonaws.com\/}"
    curl -fsSL --retry 3 "$cal_href" -o "cal-${p}.xml" || die "calibration fetch failed for ${p}"
    stage "callut_${p}" python3 /usr/local/bin/sar-cal-lut.py "cal-${p}.xml" \
      "/vsicurl/${href}" "callut-${p}.tif" || die "calibration LUT build failed for ${p}"
    # The LUT is warped by the same transform as the image it calibrates, which is the whole reason it
    # was written out with scaled ground-control points rather than applied in radar geometry.
    #
    # ## ⚠ Warped COARSE, then resampled — because the gain has no fine structure to lose
    #
    # Projecting the LUT straight onto the imagery grid was **29.6% of a median radar job** (measured
    # across 50 granules), which is absurd for a surface that varies 1.50 dB smoothly across 275 km.
    # The thin-plate-spline is what costs; running it on a 1/8-scale grid and resampling up is
    # arithmetically the same answer for a fraction of the work: **28.0s -> ~1.2s**, verified against
    # the full-resolution result over 1,222 bodies at **max 0.022 dB, mean 0.0001 dB**.
    #
    # ⚠ **`-dstnodata`/`-srcnodata` are load-bearing, not tidiness.** Without them the resample
    # averages real gain against the zero fill outside the swath, and a body sitting on that edge gets
    # a corrupted gain — measured before the flags were added: one body at 7.6% coverage came out
    # **2.26 dB** wrong, which is larger than the entire signal this archive exists to detect. It would
    # have looked like that lake doing something interesting.
    stage "calwarp_${p}" gdalwarp -q -tps -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
      -tr "$(( WARP_RES * 8 ))" "$(( WARP_RES * 8 ))" -r bilinear -dstnodata 0 \
      -co COMPRESS=DEFLATE -overwrite "callut-${p}.tif" "a-${p}-coarse.tif" \
      || die "calibration warp failed for ${p}"
    # A *warped VRT* rather than a written raster: it resamples on read, windowed, so the full-grid
    # gain never exists on disk or in memory at once.
    gdalwarp -q -of VRT -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
      -tr "$WARP_RES" "$WARP_RES" -r bilinear -srcnodata 0 -dstnodata 0 \
      "a-${p}-coarse.tif" "a-${p}.vrt" || die "calibration resample failed for ${p}"

    # ## Thermal noise, by exactly the same route as the gain
    #
    # A GRD's DN is signal **plus the instrument's own noise**, and calibration does not remove it.
    # Measured NESZ for VH: median −25.2 dB on S1A, −28.0 dB on S1C, against lakes that sit at −20 to
    # −22 dB — so the floor is three to five decibels under the signal, and at the far edge of an S1A
    # swath it reaches −21.8 dB. It biases the DARK end hardest, which is where smooth ice lives.
    #
    # ⚠ **It is also the prime suspect for the S1A/S1C offset that currently forbids pooling
    # platforms** (open question 7). S1C's floor is 2.80 dB quieter, which on a −22 dB lake predicts a
    # −0.73 dB platform bias against the −0.52 dB measured ascending. If denoising collapses that, a
    # lake gets a 6-day look instead of a 12-day one.
    #
    # ⚠ **Fatal if missing, like calibration.** Shipping a frame with the noise left in is shipping a
    # measurement whose bias depends on which satellite took it and where in the swath the lake sat.
    noise_href="$(jq -r --arg k "schema-noise-${p}" '.assets[$k].href // empty' granule.json)"
    [[ -n "$noise_href" ]] || die "no noise annotation for ${p} — refusing to ship un-denoised"
    noise_href="${noise_href/s3:\/\/sentinel-s1-l1c\//https:\/\/sentinel-s1-l1c.s3.amazonaws.com\/}"
    curl -fsSL --retry 3 "$noise_href" -o "noise-${p}.xml" || die "noise fetch failed for ${p}"
    stage "noiselut_${p}" python3 /usr/local/bin/sar-noise-lut.py "noise-${p}.xml" \
      "/vsicurl/${href}" "noiselut-${p}.tif" --calibration "cal-${p}.xml" \
      || die "noise LUT build failed for ${p}"
    # Coarse-then-resample, for the reason the gain is: the noise surface is smooth in range and the
    # thin-plate-spline is what costs. ⚠ The one place it is NOT smooth is the sub-swath seams, which
    # `sar-noise-lut.py` bakes into the grid before this ever sees it.
    stage "noisewarp_${p}" gdalwarp -q -tps -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
      -tr "$(( WARP_RES * 8 ))" "$(( WARP_RES * 8 ))" -r bilinear -dstnodata 0 \
      -co COMPRESS=DEFLATE -overwrite "noiselut-${p}.tif" "n-${p}-coarse.tif" \
      || die "noise warp failed for ${p}"
    gdalwarp -q -of VRT -t_srs EPSG:3857 -te "$MINX" "$MINY" "$MAXX" "$MAXY" \
      -tr "$WARP_RES" "$WARP_RES" -r bilinear -srcnodata 0 -dstnodata 0 \
      "n-${p}-coarse.tif" "n-${p}.vrt" || die "noise resample failed for ${p}"

    pols+=("$p")
    zonal_args+=("${p}:${p}.tif:a-${p}.vrt:n-${p}.vrt")
  done
  [[ ${#pols[@]} -gt 0 ]] || die "no usable polarisation on $GRANULE_ID"

  # Per-body statistics, on the same grid — see `sar-zonal.py` for why the average is taken in linear
  # power rather than in decibels.
  #
  # ⚠ **The erosion matters more here than on the optical side, not less.** Forest is the classic
  # bright `VH` target — volume scattering inside a canopy puts energy into the cross-polarised
  # channel that smooth ice and calm water cannot — so a shoreline pixel sits ~10 dB above the lake,
  # against the ~2 dB of separation this measurement exists to detect. A ring of bank inside the zone
  # does not add noise to the ice signal; it swamps it, and it does so worst on small lakes.
  if [[ "$WATER_COUNT" -gt 0 ]]; then
    build_zones "$MINX" "$MINY" "$MAXX" "$MAXY"
    stage sar_zonal sh -c "python3 /usr/local/bin/sar-zonal.py zones.tif zone-to-id.json \
      $(printf '%s ' "${zonal_args[@]}") --interior interior.tif \
      --erode-projected-m $EROSION_PROJECTED_M > bodies.json" \
      || die "per-body radar statistics failed"
  else
    log "no water polygons under this pass — membership without statistics"
    printf '[]' > bodies.json
  fi
  # Fold the viewing geometry the de-shift already computed into each body's record. Both
  # polarisations see the same geometry, so the first file that exists answers for the frame.
  #
  # ⚠ **This is the field open question 7 says is missing.** `sigma0` varies with incidence, ice and
  # water have different angular responses, and without it a consumer cannot tell an instrument
  # difference from an ice change — which is why platform and orbit direction are still read-time
  # filters and the cadence is still 12-day rather than 6.
  local geometry_file=""
  for p in "${pols[@]}"; do
    [[ -s "geometry-${p}.json" ]] && { geometry_file="geometry-${p}.json"; break; }
  done
  if [[ -n "$geometry_file" ]]; then
    jq -c --slurpfile geom "$geometry_file" '
        ($geom[0] | map({key: .waterBodyId, value: .}) | from_entries) as $g
        | map(. + ($g[.waterBodyId] // {} | del(.waterBodyId)))
      ' bodies.json > bodies-geom.json || die "geometry merge failed"
    mv bodies-geom.json bodies.json
  fi

  reconcile_bodies "$SAR_NULL_BODY"
  log "per-body sigma0: $(jq 'length' bodies.json) bodies, pols ${pols[*]}"

  # ⚠ **The published frame is a picture, and the numbers above are the measurement.** `sigma0` is a
  # physical quantity with no natural colour; anything rendered is a choice of stretch. A FIXED range
  # is used rather than a per-scene one, because a scrubber compares dates — and a per-scene stretch
  # would make every frame look the same and the differences vanish, which is the one thing this
  # archive exists to show.
  #
  # ## ⚠ The window is now -29..-12, and -30..0 was spending most of the greyscale on nothing
  #
  # > **Founder, 2026-08-26:** *"I don't really know how to read it (it all looks like grey fuzz to
  # > me) so I'm not sure how helpful it will be to others either."*
  #
  # -30..0 dB is 30 dB across 256 levels, and `sar-zonal.py` measures the whole freeze-up signal at
  # **~2 dB** — about 17 grey levels, under 7% of the range. The measurement was real and the picture
  # threw it away. The fixed-stretch argument above is untouched by this: the same grey still means
  # the same backscatter on every frame in every season, which is what makes two dates comparable.
  # Only the range changed, and it changed to where the pixels actually are.
  #
  # Measured 2026-08-26 on the published archive, over ~340k and ~289k masked-in pixels of two frames
  # deliberately chosen to disagree — S1A on 1 Feb (midwinter, 10,157 bodies) and S1C on 9 Nov (open
  # water, different platform, different track):
  #
  #     percentile     p1      p5     p25     p50     p75     p95     p99
  #     1 Feb       -23.6   -22.8   -20.6   -17.5   -16.1   -14.5   -13.1
  #     9 Nov       -28.6   -27.8   -20.2   -18.0   -16.8   -15.3   -14.2
  #
  # The middles agree to within 0.4-0.8 dB — and in the right direction, February reading brighter,
  # which is the seasonal signal rather than noise. The tails are what set the window: November's
  # dark end is **calm open water returning specularly**, which is the single most diagnostic thing
  # radar shows us and must not be clipped away. So the range spans both frames' extremes with a
  # little headroom, and 17 dB across 256 levels is **1.76x the contrast** on everything a skater is
  # looking at.
  #
  # ⚠ Widening it back is a one-line change; the reason not to reach for a tighter window is in that
  # table. Anything above ~-13 dB is land and bright rough ice, and clipping it costs nothing — but
  # the -28 dB end is the picture, not the margin.
  local render="${pols[-1]}"
  log "rendering ${render^^} at a fixed -29..-12 dB stretch"
  stage render_db python3 /usr/local/bin/sar-render.py "${render}.tif" "a-${render}.vrt" \
    dn.tif --min-db -29 --max-db -12 || die "dB render failed"

  build_alpha "$MINX" "$MINY" "$MAXX" "$MAXY"
  gdalbuildvrt -q -separate rgba.vrt dn.tif dn.tif dn.tif alpha.tif || die "gdalbuildvrt failed"
  gdal_translate -q -of VRT -colorinterp red,green,blue,alpha rgba.vrt rgba_ci.vrt \
    || die "colorinterp assignment failed"

  rm -rf tiles archive.mbtiles archive.pmtiles
  stage tile_sar gdal raster tile -q --input rgba_ci.vrt --output tiles \
    -f WEBP --co QUALITY=80 --min-zoom 7 --max-zoom "$MAX_ZOOM" \
    --convention tms --skip-blank --webviewer none \
    -r bilinear --overview-resampling average || die "tiling failed"
  stage pack_sar python3 /usr/local/bin/tiles-to-mbtiles.py tiles archive.mbtiles \
    --format webp --name "$GRANULE_ID" || die "MBTiles packing failed"
  stage pmtiles_sar sh -c 'pmtiles convert archive.mbtiles archive.pmtiles >/dev/null 2>&1' \
    || die "pmtiles convert failed"

  # The manifest. Written separately from the optical one on purpose: the fields genuinely differ
  # (there is no cloud fraction; there *are* acquisition parameters a timeline must filter on), and
  # the optical block has just produced 4,381 frames — merging them to save a dozen lines would put
  # that at risk for no gain a reader benefits from.
  # ⚠ **`bands` is the list of frames PUBLISHED, not the list of polarisations measured.**
  #
  # `buildSeasonIndex` reads it as exactly that — one `IndexedFrame` per entry, keyed
  # `<granuleId>-<band>.pmtiles` — so listing both polarisations here while uploading only
  # `-${render}.pmtiles` puts a `-vv.pmtiles` entry into every radar season's index that 404s for
  # every client that follows it. Rendering is a *choice of one* channel (see the fixed-stretch note
  # above), so exactly one frame is published.
  #
  # Which polarisations were read is not lost: `polarizations` carries the STAC list, and
  # `bodies[].vvDb`/`.vhDb` carry the per-body measurement for each one that was cut.
  BANDS="$(jq -nc --arg band "$render" '[$band]')"
  jq -n \
    --arg granule "$GRANULE_ID" \
    --arg captured "$CAPTURED_AT" \
    --arg season "$FRAME_SEASON" \
    --arg maskSeason "$MASK_SEASON" \
    --arg collection "$STAC_COLLECTION" \
    --arg mission "s1" \
    --arg platform "$PLATFORM" \
    --arg band "$render" \
    --arg orbit "${ORBIT_STATE:-}" \
    --argjson relOrbit "${RELATIVE_ORBIT:-null}" \
    --argjson pols "${POLARISATIONS:-null}" \
    --argjson bodyCount "$MASK_COUNT" \
    --slurpfile bodies bodies.json \
    --argjson bands "$BANDS" \
    --argjson stageMs "$STAGE_JSON" \
    --argjson totalMs "$(( $(now_ms) - RUN_STARTED_MS ))" \
    --arg vmSize "${FLY_VM_SIZE_LABEL:-unknown}" \
    --argjson feather "$FEATHER_M" \
    --argjson resolutionM "$WARP_RES" \
    --argjson erosionM "$EROSION_M" \
    --argjson geocode "${GEOCODE_JSON:-null}" \
    --argjson deshift "$(cat "deshift-${render}.json" 2>/dev/null || echo null)" \
    --argjson footprint "$(jq -c '.geometry' granule.json)" \
    '{granuleId:$granule, capturedAt:$captured, cloudCoverPct:null, season:$season,
      maskSeason:$maskSeason, collection:$collection, mission:$mission, platform:$platform,
      band:$band, orbitDirection:(if $orbit == "" then null else $orbit end),
      relativeOrbit:$relOrbit, polarizations:$pols,
      bodyCount:$bodyCount, bodies:$bodies[0], bands:$bands, featherMeters:$feather,
      resolutionM:$resolutionM, erosionMeters:$erosionM,
      # ⚠ null means this frame was NOT geocode-corrected — an old image, or a missing annotation.
      # A consumer comparing frames across the archive has to be able to tell a corrected frame from
      # an uncorrected one, and the absence is the tell. `deshift.uncorrected` counts the bodies that
      # were placed without a height, which is the same question one body at a time.
      geocode:$geocode, deshift:$deshift,
      footprint:$footprint,
      cost:{stageMs:$stageMs, totalMs:$totalMs, vmSize:$vmSize}}' \
    > manifest.json || die "manifest build failed"

  local key_base="frames/${FRAME_SEASON}/${GRANULE_ID}"
  log "uploading $(du -h archive.pmtiles | cut -f1) -> r2:${R2_BUCKET}/${key_base}-${render}.pmtiles"
  stage upload_sar rclone --config "$RCLONE_CONF" copyto archive.pmtiles \
    "r2:${R2_BUCKET}/${key_base}-${render}.pmtiles" --s3-no-check-bucket --s3-chunk-size=64M \
    || die "R2 upload failed"
  rclone --config "$RCLONE_CONF" copyto manifest.json "r2:${R2_BUCKET}/${key_base}.json" \
    --s3-no-check-bucket || die "R2 manifest upload failed"

  log "cut $MASK_COUNT bodies from $GRANULE_ID ($CAPTURED_AT, ${ORBIT_STATE:-?})"
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
elif [[ "$MISSION" == s1 ]]; then
  transform_sar
else
  transform_granule
fi
