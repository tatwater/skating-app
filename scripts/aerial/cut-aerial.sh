#!/usr/bin/env bash
#
# Cut one work tile of the summer aerial into a shard (B05 §2.2).
#
#   cut-aerial <unit.json>                                  # on a Machine: the shard goes to R2
#   cut-aerial <unit.json> --local <dir>                    # anywhere: under <dir>/<its R2 keys>
#   cut-aerial <unit.json> --local <dir> --keep <workdir>   # …and every intermediate is kept
#
# One unit in (`src/tiles.ts`' `AerialWorkUnit`: the work tile, its cells, each cell's frames in the
# rule's order and its exact pixel extents, the tiler's chunks, the shard's keys), one shard out —
# the pack, its index and, **last**, its done record. Nothing here decides which frames: the unit
# did. Nothing here knows about Fly either (that is `spawn.sh`), so `docker run <image> cut-aerial
# <unit>` is the whole contract, as it is for the winter cutter.
#
# ## ⚠ Changing how a pixel is drawn means bumping `NAIP_TILING_VERSION`
#
# A rebuild re-cuts only the work tiles whose input hash changed, and the hash (core's
# `naipWorkTileInputHash`) sees the stacks and `NAIP_TILING_VERSION` — not the GDAL arguments below
# or `tiles.ts`' `TILE_SETTINGS`. Change a warp flag, the nodata rule, a resampling, the quality, the
# counts' grid, and the same stack draws different pixels while every work tile still reads as
# unchanged: a `--from-current` build would copy the old tiles beside new ones. So any such change
# bumps `NAIP_TILING_VERSION` in core (which re-cuts everything) in the same commit;
# `tiles.test.ts` fingerprints this file's GDAL lines and `TILE_SETTINGS` and fails until it does.
#
# ## The steps
#
# 1. **A SAS token** from Planetary Computer's anonymous endpoint. GDAL reads the COGs through
#    `/vsiaz/` with the token in `AZURE_STORAGE_SAS_TOKEN`, so no signed URL is ever on a command
#    line or in a file — and this script's stderr is filtered so GDAL's own error lines, which quote
#    the signed URL, never put a signature in `fly logs`.
#    ⚠ **The tokens live 15 minutes and the endpoint hands out the current one, however little of it
#    is left** (measured 2026-11-25: minted 03:23:19, expiring 03:38:20, served at 03:26 with 12
#    minutes left). A token fetched once per work tile dies mid-tile. So every read is preceded by
#    `sas_ensure`, which refetches when less than `AERIAL_SAS_MARGIN` seconds remain and, when the
#    endpoint still offers the dying one, waits for the next — and the tiler runs a chunk at a time
#    (16 to a work tile), each short enough to finish inside the margin.
# 2. **Resolve** each frame's COG by its STAC item (anonymous).
# 3. **Count** (§2.2 step 4): per cell, every frame warped to the counts' grid (pixel zoom 16) on the
#    cell's own pixels, its alpha materialized; `aerial-counts.py` counts each frame's pixels in the
#    rule's order — the pick first, each fallback only where everything above it is empty.
# 4. **Warp** (§2.2 step 1): per cell, a warped VRT of each frame that supplied any pixel — to
#    EPSG:3857 on the deepest zoom's grid, **on exactly the cell's pixels** (`-te`, the unit's
#    `extent`: the pixels whose centers are in the cell, so neighbors split an edge exactly), RGB
#    only, alpha from NAIP's 0,0,0 fill (the COGs declare no nodata; measured 2026-11-25),
#    `-r cubic`. A fallback the pick hides entirely is never read at full resolution.
# 5. **Mosaic** (§2.2 step 2): one VRT of those, per cell its lowest fallback first and its pick
#    last; `gdalbuildvrt` composes them through their alpha, so the pick wins wherever it has pixels.
# 6. **Tile** (§2.2 step 3): `gdal raster tile` per chunk, WebP q80, 512 px, `--skip-blank`, the
#    chunk's zoom down to the deepest; then the zooms above the chunks from the chunks' own top
#    tiles (no source read). Overviews are 2×2 averages (`tiles.ts`' `overviewResampling`).
# 7. **Pack** (§2.2 step 5): `tilesPackMain.ts pack` writes the pack, its index and the done record.
# 8. **Upload**: pack, index, then the done record — what "landed" means (`shard.ts`' `shardLanded`).
#    A pack with no done record behind it is outstanding, and the next round overwrites it.
#
# Every step is timed into the done record (`timings`); the source bytes GDAL read are logged.
set -euo pipefail

# Associative arrays, `$EPOCHREALTIME` and `wait` on a process substitution are bash 5.
if (( BASH_VERSINFO[0] < 5 )); then
  echo "cut-aerial needs bash 5+ (this is ${BASH_VERSION})" >&2
  exit 1
fi

# **Every line of stderr loses its SAS signature before it is written.** GDAL's HTTP warnings quote
# the whole signed URL (`HTTP response code on https://…?st=…&sig=…: 403`, seen 2026-11-25), and a
# Machine's stderr is `fly logs`. `awk` rather than `sed -u`, which BSD sed doesn't have.
exec 3>&2
exec 2> >(awk '{ gsub(/sig=[^&[:space:]"]*/, "sig=REDACTED"); print; fflush() }' >&3)
REDACT_PID=$!

log() { echo "[cut-aerial] $*" >&2; }
die() { echo "[cut-aerial] FATAL: $*" >&2; exit 1; }

UNIT="${1:-}"
if [[ -z "$UNIT" || "$UNIT" == --* ]]; then
  echo "usage: cut-aerial <unit.json> [--local <dir>] [--keep <workdir>]" >&2
  exit 64
fi
shift
LOCAL=""
KEEP=""
while (( $# > 0 )); do
  case "$1" in
    --local) LOCAL="${2:?--local needs a directory}"; shift 2 ;;
    --keep) KEEP="${2:?--keep needs a directory}"; shift 2 ;;
    *) echo "cut-aerial: unknown argument $1" >&2; exit 64 ;;
  esac
done
[[ -f "$UNIT" ]] || die "no unit file at $UNIT"
UNIT="$(cd "$(dirname "$UNIT")" && pwd)/$(basename "$UNIT")"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The TypeScript half and the counts helper: the image's paths by default, the repo's for a local run.
AERIAL_PACK="${AERIAL_PACK:-/app/scripts/aerial/node_modules/.bin/tsx /app/scripts/aerial/src/tilesPackMain.ts}"
AERIAL_COUNTS="${AERIAL_COUNTS:-$HERE/aerial-counts.py}"
AERIAL_PYTHON="${AERIAL_PYTHON:-python3}"
AERIAL_SAS_MARGIN="${AERIAL_SAS_MARGIN:-180}"
PC_STAC="${PC_STAC:-https://planetarycomputer.microsoft.com/api/stac/v1}"
PC_SAS="${PC_SAS:-https://planetarycomputer.microsoft.com/api/sas/v1/token/naip}"

# The image that cuts is part of the record (A06e's lesson: a run records the code that produced
# it), and only a digest names one image forever.
AERIAL_IMAGE="${AERIAL_IMAGE:-}"
[[ "$AERIAL_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] \
  || die "AERIAL_IMAGE must name the image by digest (…@sha256:<64 hex>)"

# Checked by name before anything is read: a Machine that finds a missing secret after paying for
# the reads wasted the expensive half of its run.
if [[ -z "$LOCAL" ]]; then
  for var in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT R2_BUCKET; do
    [[ -n "${!var:-}" ]] || die "missing required secret: $var"
  done
fi

command -v jq >/dev/null || die "jq is not installed"
[[ "$(jq -r .version "$UNIT")" == "1" ]] || die "unit version $(jq -r .version "$UNIT"), this worker reads 1"
WORK_TILE="$(jq -r .workTile "$UNIT")"
WINDOW="$(jq -r .window "$UNIT")"
RES="$(jq -r .resolution "$UNIT")"
CRES="$(jq -r .countResolution "$UNIT")"
TILE_SIZE="$(jq -r .settings.tileSize "$UNIT")"
QUALITY="$(jq -r .settings.quality "$UNIT")"
RESAMPLING="$(jq -r .settings.resampling "$UNIT")"
OVERVIEW_RESAMPLING="$(jq -r .settings.overviewResampling "$UNIT")"
SRC_NODATA="$(jq -r .settings.srcNodata "$UNIT")"
mapfile -t BANDS < <(jq -r '.settings.bands[]' "$UNIT")
mapfile -t CELLS < <(jq -r '.cells[].key' "$UNIT")
log "work tile $WORK_TILE (window $WINDOW): ${#CELLS[@]} cells, $(jq '.chunks | length' "$UNIT") chunks"

if [[ -n "$KEEP" ]]; then
  W="$KEEP"; rm -rf "$W"; mkdir -p "$W"
else
  W="$(mktemp -d "${AERIAL_WORKDIR:-/data}/aerial.XXXXXX")"
fi
# On any exit: drop the scratch (unless kept), then let the redactor drain before the status is
# re-raised — bash doesn't wait for a process substitution, and on a failing run the last lines
# are the ones worth keeping (run-corpus.sh's lesson).
finish() {
  local status=$?
  [[ -z "$KEEP" ]] && rm -rf "$W"
  exec 2>&3
  wait "$REDACT_PID" 2>/dev/null || true
  exit "$status"
}
trap finish EXIT
mkdir -p "$W/count" "$W/counts" "$W/warp" "$W/stats" "$W/shard" "$W/tiles" "$W/overview"

# --- Timing -----------------------------------------------------------------------------------------
declare -A TIMINGS=()
now_ms() { local t="${EPOCHREALTIME/./}"; echo $(( t / 1000 )); }
# step <name> <command…> — runs it, adds its milliseconds to <name>, keeps its exit status.
step() {
  local name="$1"; shift
  local started status=0
  started="$(now_ms)"
  "$@" || status=$?
  TIMINGS[$name]=$(( ${TIMINGS[$name]:-0} + $(now_ms) - started ))
  return $status
}

# A GDAL read, with the bytes it fetched written to its own stats file (GDAL prints them on stdout
# at exit). Every source read goes through here, so their sum is every byte the work tile read.
STATS_N=0
gdal_read() {
  STATS_N=$((STATS_N + 1))
  CPL_VSIL_SHOW_NETWORK_STATS=YES "$@" > "$W/stats/$STATS_N.txt"
}

# GDAL's remote-read tuning, the winter cutter's settings.
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_MULTIPLEX=YES GDAL_HTTP_VERSION=2 \
  GDAL_HTTP_MAX_RETRY="${GDAL_HTTP_MAX_RETRY:-5}" GDAL_HTTP_RETRY_DELAY="${GDAL_HTTP_RETRY_DELAY:-2}" \
  VSI_CACHE=TRUE VSI_CACHE_SIZE="${VSI_CACHE_SIZE:-268435456}"

# --- 1. The SAS token ---------------------------------------------------------------------------------
SAS_EXPIRES=0
sas_fetch() {
  local body
  body="$(curl -fsS --retry 3 --retry-delay 2 "$PC_SAS")" || return 1
  AZURE_STORAGE_SAS_TOKEN="$(jq -r '.token // empty' <<<"$body")"
  SAS_EXPIRES="$(jq -r '."msft:expiry" // empty | fromdateiso8601' <<<"$body")"
  [[ -n "$AZURE_STORAGE_SAS_TOKEN" && -n "$SAS_EXPIRES" ]] || return 1
  export AZURE_STORAGE_SAS_TOKEN
}
# sas_ensure — a token with at least AERIAL_SAS_MARGIN seconds left, or a failure. The endpoint
# serves its current token until it expires, so when that one is too short the only way to a longer
# one is to wait it out.
sas_ensure() {
  local left
  left=$(( SAS_EXPIRES - $(date +%s) ))
  (( left >= AERIAL_SAS_MARGIN )) && return 0
  sas_fetch || return 1
  left=$(( SAS_EXPIRES - $(date +%s) ))
  (( left >= AERIAL_SAS_MARGIN )) && return 0
  log "the SAS token has ${left}s left; waiting for the next"
  sleep $(( left > 0 ? left + 2 : 2 ))
  sas_fetch || return 1
  left=$(( SAS_EXPIRES - $(date +%s) ))
  (( left >= AERIAL_SAS_MARGIN )) || { log "a fresh SAS token has only ${left}s"; return 1; }
}
step sas sas_ensure || die "no usable SAS token from Planetary Computer"

# --- 2. Resolve each frame's COG -------------------------------------------------------------------
declare -A SRC=()
ACCOUNT=""
resolve() {
  local id href
  for id in $(jq -r '[.cells[].frames[]] | unique | .[]' "$UNIT"); do
    href="$(curl -fsS --retry 3 --retry-delay 2 "$PC_STAC/collections/naip/items/$id" \
      | jq -r '.assets.image.href // empty')" || { log "STAC lookup failed for $id"; return 1; }
    [[ "$href" =~ ^https://([a-z0-9]+)\.blob\.core\.windows\.net/(.+\.tif)$ ]] \
      || { log "$id: its image is not a blob COG"; return 1; }
    if [[ -z "$ACCOUNT" ]]; then ACCOUNT="${BASH_REMATCH[1]}"
    elif [[ "$ACCOUNT" != "${BASH_REMATCH[1]}" ]]; then log "$id is in a second storage account"; return 1; fi
    SRC[$id]="/vsiaz/${BASH_REMATCH[2]}"
  done
}
step resolve resolve || die "could not resolve the unit's frames"
export AZURE_STORAGE_ACCOUNT="$ACCOUNT"
log "resolved ${#SRC[@]} frames"

# warp <cell> <itemId> <extent field> <res> <resampling> <out.vrt> — the frame on exactly the cell's
# pixels (the unit's extent), which is the cut: no cutline (see `tiles.ts`' `pixelExtent`).
# ⚠ Any change to these arguments (or the tiler's below) that draws different pixels from the same
# stack bumps NAIP_TILING_VERSION in core — see the header; `tiles.test.ts` holds the fingerprint.
warp() {
  local cell="$1" id="$2" field="$3" res="$4" resampling="$5" out="$6" te srcbands=()
  read -r -a te < <(jq -r --arg k "$cell" \
    ".cells[] | select(.key == \$k) | .${field} | map(tostring) | join(\" \")" "$UNIT")
  for b in "${BANDS[@]}"; do srcbands+=(-srcband "$b"); done
  sas_ensure || return 1
  gdalwarp -q -overwrite -of VRT -t_srs EPSG:3857 -te "${te[@]}" -tr "$res" "$res" \
    -srcnodata "$SRC_NODATA" -wo UNIFIED_SRC_NODATA=YES "${srcbands[@]}" -dstalpha \
    -r "$resampling" "${SRC[$id]}" "$out"
}

# --- 3. Count, per cell, on the counts' grid --------------------------------------------------------
count_cell() {
  local cell="$1" id i=0 pairs=() alpha_band=$(( ${#BANDS[@]} + 1 ))
  mkdir -p "$W/count/$cell"
  for id in $(jq -r --arg k "$cell" '.cells[] | select(.key == $k) | .frames[]' "$UNIT"); do
    i=$((i + 1))
    warp "$cell" "$id" countExtent "$CRES" near "$W/count/$cell/$i.vrt" || return 1
    sas_ensure || return 1
    gdal_read gdal_translate -q -b "$alpha_band" -co COMPRESS=DEFLATE \
      "$W/count/$cell/$i.vrt" "$W/count/$cell/$i-alpha.tif" || return 1
    pairs+=("$id=$W/count/$cell/$i-alpha.tif")
  done
  "$AERIAL_PYTHON" "$AERIAL_COUNTS" "$W/counts/$cell.json" "${pairs[@]}"
}
for cell in "${CELLS[@]}"; do
  step count count_cell "$cell" || die "counting $cell failed"
done

# --- 4–5. Warp what shows, and mosaic it, the pick last ---------------------------------------------
mapfile -t LAYERS < <($AERIAL_PACK layers --unit "$UNIT" --counts "$W/counts")
: > "$W/mosaic.txt"
warp_layers() {
  local line cell id rank
  for line in "${LAYERS[@]}"; do
    IFS=$'\t' read -r cell id rank <<<"$line"
    warp "$cell" "$id" extent "$RES" "$RESAMPLING" "$W/warp/$cell-$rank.vrt" || return 1
    echo "$W/warp/$cell-$rank.vrt" >> "$W/mosaic.txt"
  done
}
step warp warp_layers || die "a warp failed"
log "${#LAYERS[@]} frames show, of $(jq '[.cells[].frames[]] | length' "$UNIT") in the stacks"

# --- 6. Tile, a chunk at a time, then the zooms above the chunks ------------------------------------
tile_chunk() {
  local i="$1" zmin zmax minx maxx miny maxy
  read -r zmin zmax minx maxx miny maxy < <(jq -r --argjson i "$i" \
    '.chunks[$i] | "\(.zooms.min) \(.zooms.max) \(.range.minX) \(.range.maxX) \(.range.minY) \(.range.maxY)"' "$UNIT")
  sas_ensure || return 1
  gdal_read gdal raster tile -q --format WEBP --co "QUALITY=$QUALITY" --tile-size "$TILE_SIZE" \
    --min-zoom "$zmin" --max-zoom "$zmax" --min-x "$minx" --max-x "$maxx" --min-y "$miny" --max-y "$maxy" \
    --skip-blank --webviewer none --resampling "$RESAMPLING" --overview-resampling "$OVERVIEW_RESAMPLING" \
    --convention xyz "$W/mosaic.vrt" "$W/tiles"
}
# The zooms above the chunks, from the chunks' top tiles placed by their bounds — local files only.
tile_overview() {
  local zmin zmax tile minx miny maxx maxy n=0
  read -r zmin zmax < <(jq -r '.overview.zooms | "\(.min) \(.max)"' "$UNIT")
  : > "$W/overview.txt"
  while read -r tile minx miny maxx maxy; do
    [[ -f "$W/tiles/$tile.webp" ]] || continue   # --skip-blank: an empty chunk wrote no tile
    n=$((n + 1))
    gdal_translate -q -of VRT -a_srs EPSG:3857 -a_ullr "$minx" "$maxy" "$maxx" "$miny" \
      "$W/tiles/$tile.webp" "$W/overview/$n.vrt" || return 1
    echo "$W/overview/$n.vrt" >> "$W/overview.txt"
  done < <(jq -r '.overview.from[] | "\(.tile) \(.bounds | map(tostring) | join(" "))"' "$UNIT")
  (( n > 0 )) || return 0
  # `-addalpha`: an opaque tile is written without an alpha band, a ragged one with.
  gdalbuildvrt -q -addalpha -input_file_list "$W/overview.txt" "$W/overview.vrt" || return 1
  if (( zmax > zmin )); then
    gdal raster tile -q --format WEBP --co "QUALITY=$QUALITY" --tile-size "$TILE_SIZE" \
      --min-zoom $(( zmin + 1 )) --max-zoom "$zmax" --skip-blank --webviewer none \
      --resampling "$OVERVIEW_RESAMPLING" --overview-resampling "$OVERVIEW_RESAMPLING" \
      --convention xyz "$W/overview.vrt" "$W/tiles" || return 1
  fi
  top_tile "$W/overview.vrt" "$zmin"
}
# The window's own tile, always written — no `--skip-blank`, so a few pixels that average to nothing
# at this zoom still leave a (transparent) tile: the assembler builds the shallow zooms from it.
top_tile() {
  local src="$1" z="$2"
  gdal raster tile -q --format WEBP --co "QUALITY=$QUALITY" --tile-size "$TILE_SIZE" \
    --min-zoom "$z" --max-zoom "$z" --webviewer none \
    --resampling "$OVERVIEW_RESAMPLING" --overview-resampling "$OVERVIEW_RESAMPLING" \
    --convention xyz "$src" "$W/tiles"
}
if (( ${#LAYERS[@]} > 0 )); then
  step mosaic gdalbuildvrt -q -input_file_list "$W/mosaic.txt" "$W/mosaic.vrt" || die "the mosaic failed"
  CHUNKS="$(jq '.chunks | length' "$UNIT")"
  for (( c = 0; c < CHUNKS; c++ )); do
    # One retry with a fresh token: a chunk that loses its token mid-run fails rather than
    # half-writing (GDAL refuses the read), so running it again is safe.
    step tile tile_chunk "$c" || { log "chunk $c failed; once more with a fresh token"; SAS_EXPIRES=0; step tile tile_chunk "$c"; } \
      || die "tiling chunk $c failed"
  done
  if [[ "$(jq -r '.overview != null' "$UNIT")" == "true" ]]; then
    step overview tile_overview || die "the overview zooms failed"
  elif [[ -n "$(find "$W/tiles" -name '*.webp' -print -quit)" && ! -f "$W/tiles/$WINDOW.webp" ]]; then
    # A window that is its own chunk (a proof's) whose top tile `--skip-blank` dropped.
    sas_ensure || die "no usable SAS token"
    step overview gdal_read top_tile "$W/mosaic.vrt" "${WINDOW%%/*}" || die "the window's own tile failed"
  fi
else
  # Every cell's frames missed the window (a corner touch, a hole with no fallback): an honest,
  # empty shard, so the work tile lands rather than being retried forever.
  log "nothing of any frame falls in this window: an empty shard"
fi

# --- 7. Pack --------------------------------------------------------------------------------------
timings_json() {
  local k json="{}"
  for k in "${!TIMINGS[@]}"; do
    json="$(jq -c --arg k "$k" --argjson v "${TIMINGS[$k]}" '. + {($k): $v}' <<<"$json")"
  done
  printf '%s\n' "$json" > "$W/timings.json"
}
timings_json
$AERIAL_PACK pack --unit "$UNIT" --tiles "$W/tiles" --counts "$W/counts" \
  --timings "$W/timings.json" --out "$W/shard" --image "$AERIAL_IMAGE" >&2 || die "packing failed"
# Each stats file holds one or more `Network statistics:` JSON blocks (a spawned tiler's children
# print their own); the top-level GET total of each is what that process fetched.
SOURCE_BYTES="$(for f in "$W"/stats/*.txt; do [[ -s "$f" ]] && awk '/^Network statistics:/ { on = 1; next } on' "$f"; done \
  | jq -s 'map(.methods.GET.downloaded_bytes // 0) | add // 0')"
echo "$SOURCE_BYTES" > "$W/source-bytes"
log "source bytes read: $SOURCE_BYTES"
log "timings (ms): $(cat "$W/timings.json")"

# --- 8. Upload, the done record last -----------------------------------------------------------------
PACK_KEY="$(jq -r .keys.pack "$UNIT")"
INDEX_KEY="$(jq -r .keys.index "$UNIT")"
DONE_KEY="$(jq -r .keys.done "$UNIT")"
if [[ -n "$LOCAL" ]]; then
  put() { mkdir -p "$(dirname "$LOCAL/$2")" && cp "$1" "$LOCAL/$2"; }
else
  # Written at run time from the secrets, never baked into the image (the winter cutter's rule).
  RCLONE_CONF="$W/rclone.conf"
  ( umask 077; cat > "$RCLONE_CONF" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = ${R2_ENDPOINT}
region = auto
acl = private
EOF
  )
  # `--s3-no-check-bucket`: bucket-scoped R2 tokens 403 on the HeadBucket probe (the imagery README).
  put() { rclone --config "$RCLONE_CONF" copyto "$1" "r2:${R2_BUCKET}/$2" --s3-no-check-bucket --retries 3; }
fi
put "$W/shard/shard.pack" "$PACK_KEY" || die "uploading the pack failed"
put "$W/shard/shard.idx.json" "$INDEX_KEY" || die "uploading the index failed"
put "$W/shard/shard.done.json" "$DONE_KEY" || die "uploading the done record failed"
log "landed $WORK_TILE: $(jq -r '"\(.tiles) tiles, \(.bytes) bytes"' "$W/shard/shard.done.json")"
