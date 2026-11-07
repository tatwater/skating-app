#!/usr/bin/env bash
#
# Tile the built contour set — and, when built, the filled depth bands — into one `.pmtiles` overlay
# and (optionally) upload it (A06b; bands B03 §2, see BANDS.md).
#
#   scripts/bathymetry/tile.sh                      # tile only
#   scripts/bathymetry/tile.sh --upload dev/bathymetry-20260801.pmtiles
#
# Input is `.scratch/build/contours.geojsonl`, written by `pnpm --filter @skating/bathymetry
# build-contours`, plus `.scratch/build/bands.geojsonl` from `build-bands` when it exists. Output is
# `.scratch/build/bathymetry.pmtiles`: layer `bathymetry` (lines) and, with bands, `bathymetry_bands`.
#
# ## The tiling parameters, and why each one is what it is
#
# * `--maximum-zoom=14` — **contours are detail-view furniture (D81)**, so the only zoom that has to
#   look right is the one a drawer opens at. Tiling past 14 multiplies the artifact for detail nobody
#   requests; z14 is ~9 m/px at our latitude, finer than the 25 m grid the surfaces were solved on, so
#   there is no resolution left to serve anyway.
# * `--minimum-zoom=9` — a hard floor rather than the mechanism. D81 keeps contours off the browse map
#   entirely; this exists because a drawer can be open while the camera is zoomed out, and a whole
#   state's isobaths at z5 is a lot of tile for a picture nobody can read.
# * `--drop-densest-as-needed` — NOT `--drop-fraction-as-needed`. Both keep tiles under the limit, but
#   this one drops whole features from the densest tiles rather than thinning everywhere, so a sparse
#   lake keeps every line it has. The alternative degrades the lakes that need help least.
# * **Simplification is left ON below max zoom.** An earlier version disabled it outright, on the
#   argument that "at the zoom the drawer uses, the line we drew is the line we mean." That argument
#   only holds at z14 — which tippecanoe already exempts from simplification by default — and below it
#   the flag was retaining detail nobody can see, on 19.9 M vertices. It also over-claimed: the traced
#   line carries a vertex per grid-cell crossing, and one Champlain contour arrives with **164,325** of
#   them. That is raster stair-step at the solve resolution, not bathymetry. At z14 a pixel is ~9 m and
#   the grid the surfaces were solved on is 25–145 m, so nothing below a cell was ever meaningful.
# * `--layer=bathymetry` — the client adds this source on drawer-open and filters it by `bodyId`.
#
# ## The bands layer, and why its flags differ from the lines'
#
# * `--layer=bathymetry_bands` — a second layer in the SAME archive, so a client that already mounts
#   the contour source adds a fill against a second `source-layer` and needs no second URL.
# * `--detect-shared-borders` — adjacent bands share an edge, and simplifying each polygon on its own
#   moves that edge two different ways, opening slivers of nothing between bands at low zoom.
# * **Nothing is dropped**: no `--drop-*-as-needed`, and `--no-tile-size-limit`. A dropped line is a
#   missing ring; a dropped band is a hole in the lake that reads as a different depth. The bands are
#   one feature per band per lake, so the tiles stay small without it (sizes measured in BANDS.md).
# * `tile-join -pk` merges the two, again without its own size-limit dropping.
#
# Prereqs: tippecanoe + pmtiles (brew install tippecanoe pmtiles).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="$HERE/.scratch/build/contours.geojsonl"
BANDS="$HERE/.scratch/build/bands.geojsonl"
MBTILES="$HERE/.scratch/build/bathymetry.mbtiles"
LINES_MBTILES="$HERE/.scratch/build/bathymetry.lines.mbtiles"
BANDS_MBTILES="$HERE/.scratch/build/bathymetry.bands.mbtiles"
OUT="$HERE/.scratch/build/bathymetry.pmtiles"
command -v tippecanoe >/dev/null || { echo "tippecanoe not found — brew install tippecanoe" >&2; exit 1; }
command -v tile-join >/dev/null || { echo "tile-join not found — brew install tippecanoe" >&2; exit 1; }
command -v pmtiles >/dev/null || { echo "pmtiles not found — brew install pmtiles" >&2; exit 1; }
[ -f "$IN" ] || { echo "no $IN — run: pnpm --filter @skating/bathymetry build-contours" >&2; exit 1; }
echo "[bathymetry] tiling $(wc -l < "$IN" | tr -d ' ') contour lines…"
rm -f "$MBTILES" "$LINES_MBTILES" "$BANDS_MBTILES" "$OUT"
tippecanoe \
  --output="$LINES_MBTILES" \
  --layer=bathymetry \
  --name="Skating bathymetry (A06b)" \
  --attribution="State agency bathymetry — see the lake drawer for the surveying agency" \
  --minimum-zoom=9 \
  --maximum-zoom=14 \
  --drop-densest-as-needed \
  --no-tiny-polygon-reduction \
  --preserve-input-order \
  --quiet \
  "$IN"
if [ -s "$BANDS" ]; then
  echo "[bathymetry] tiling $(wc -l < "$BANDS" | tr -d ' ') depth-band polygons…"
  tippecanoe \
    --output="$BANDS_MBTILES" \
    --layer=bathymetry_bands \
    --minimum-zoom=9 \
    --maximum-zoom=14 \
    --detect-shared-borders \
    --no-tile-size-limit \
    --no-tiny-polygon-reduction \
    --quiet \
    "$BANDS"
  tile-join \
    --output="$MBTILES" \
    --name="Skating bathymetry (A06b, bands B03)" \
    --attribution="State agency bathymetry — see the lake drawer for the surveying agency" \
    -pk \
    --quiet \
    "$LINES_MBTILES" "$BANDS_MBTILES"
  rm -f "$LINES_MBTILES" "$BANDS_MBTILES"
else
  echo "[bathymetry] no $BANDS — lines only (run build-bands for the filled bands)"
  mv "$LINES_MBTILES" "$MBTILES"
fi
pmtiles convert "$MBTILES" "$OUT"
rm -f "$MBTILES"
echo "[bathymetry] wrote $OUT ($(du -h "$OUT" | cut -f1))"
if [ "${1:-}" = "--upload" ]; then
  KEY="${2:-}"
  [ -n "$KEY" ] || { echo "usage: tile.sh --upload <r2-key>" >&2; exit 1; }
  # Reuses the basemap's upload lane deliberately: same bucket, same public base URL, same rclone
  # remote. The contour overlay is served to browsers by range-read exactly like the basemap, so it
  # belongs in the PUBLIC bucket — unlike `.raw/`, which is third-party source data and is mirrored
  # to a private one (see mirror-r2.sh).
  "$HERE/../basemap/upload-r2.sh" "$OUT" "$KEY"
fi
