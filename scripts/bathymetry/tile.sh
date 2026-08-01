#!/usr/bin/env bash
#
# Tile the built contour set into a `.pmtiles` overlay and (optionally) upload it (N6b).
#
#   scripts/bathymetry/tile.sh                      # tile only
#   scripts/bathymetry/tile.sh --upload dev/bathymetry-20260801.pmtiles
#
# Input is `.scratch/build/contours.geojsonl`, written by `pnpm --filter @skating/bathymetry
# build-contours`. Output is `.scratch/build/bathymetry.pmtiles`.
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
# * `--no-tiny-polygon-reduction` / `--no-line-simplification` at max zoom (`-ps`) — at the zoom the
#   drawer actually uses, the line we drew is the line we mean. Simplification there would be a second
#   cartographic opinion layered on the smoothing pass that `grdfilter` already applied deliberately.
# * `--layer=bathymetry` — the client adds this source on drawer-open and filters it by `bodyId`.
#
# Prereqs: tippecanoe + pmtiles (brew install tippecanoe pmtiles).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="$HERE/.scratch/build/contours.geojsonl"
MBTILES="$HERE/.scratch/build/bathymetry.mbtiles"
OUT="$HERE/.scratch/build/bathymetry.pmtiles"

command -v tippecanoe >/dev/null || { echo "tippecanoe not found — brew install tippecanoe" >&2; exit 1; }
command -v pmtiles >/dev/null || { echo "pmtiles not found — brew install pmtiles" >&2; exit 1; }
[ -f "$IN" ] || { echo "no $IN — run: pnpm --filter @skating/bathymetry build-contours" >&2; exit 1; }

echo "[bathymetry] tiling $(wc -l < "$IN" | tr -d ' ') contour lines…"
rm -f "$MBTILES" "$OUT"

tippecanoe \
  --output="$MBTILES" \
  --layer=bathymetry \
  --name="Skating bathymetry (N6b)" \
  --attribution="State agency bathymetry — see the lake drawer for the surveying agency" \
  --minimum-zoom=9 \
  --maximum-zoom=14 \
  --drop-densest-as-needed \
  --no-line-simplification \
  --no-tiny-polygon-reduction \
  --preserve-input-order \
  --quiet \
  "$IN"

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
