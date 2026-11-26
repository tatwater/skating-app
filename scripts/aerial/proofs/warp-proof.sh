#!/usr/bin/env bash
#
# The local warp proof (B05 §7.3): the worker, `cut-aerial.sh`, run for real on three z14 windows of
# real NAIP frames, then `warp-proof.py`'s assertions over what it kept.
#
#   scripts/aerial/proofs/warp-proof.sh [<run dir>]     # default scripts/aerial/.scratch/warp-proof
#   ONLY=<window> …                                      # one window
#   SKIP_CUT=1 …                                         # the assertions again, over the last cut
#
# The windows (`windows.json`, hand-written manifests until the select stage lands):
#
# - **champlain-vt-ny** — Lake Champlain's north end at 73.375°W: New York 2024 at 0.6 m beside
#   Vermont 2025 at 0.3 m on a cell both states list (its stack is eight frames deep).
# - **jaffrey-72w** — the New Hampshire–Massachusetts strip at 72°W: the UTM 18 / 19 seam, New
#   Hampshire 2023 at 0.3 m on both sides, both cells listed by both states.
# - **maine-partial** — a Maine 2023 pick that doesn't cover its cell (an unflown strip, filled
#   0,0,0 in the COG), falling through to Maine 2021, beside a Maine 2018 cell.
#
# Needs GDAL 3.13 with its Python bindings and numpy (`AERIAL_PYTHON`, default Homebrew's
# python3.14), bash 5, jq, curl, and the package's `node_modules`. Reads Planetary Computer
# anonymously — a few hundred megabytes, which the run dir keeps only as small intermediates (the
# reads themselves stream). Writes nothing anywhere but the run dir. Exits with the assertions'
# status; `report.json` in the run dir holds the measurements.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
RUN="${1:-$PKG/.scratch/warp-proof}"
AERIAL_PYTHON="${AERIAL_PYTHON:-/opt/homebrew/opt/python@3.14/bin/python3.14}"
CUT_AERIAL="${CUT_AERIAL:-$PKG/cut-aerial.sh}"
TSX="$PKG/../../node_modules/.bin/tsx"

"$AERIAL_PYTHON" -I -c 'import numpy; from osgeo import gdal' \
  || { echo "warp-proof needs GDAL's Python bindings and numpy at $AERIAL_PYTHON" >&2; exit 1; }

# Signatures never reach the terminal (GDAL's errors quote the signed URL).
exec 3>&2
exec 2> >(awk '{ gsub(/sig=[^&[:space:]"]*/, "sig=REDACTED"); print; fflush() }' >&3)

mkdir -p "$RUN/units" "$RUN/work" "$RUN/out"
# A pinned-looking digest that names no image: a local run's done records never leave the run dir.
export AERIAL_IMAGE="local/warp-proof@sha256:$(printf '0%.0s' {1..64})"
export AERIAL_PACK="$TSX $PKG/src/tilesPackMain.ts"
export AERIAL_PYTHON

mapfile -t NAMES < <(jq -r '.windows[].name' "$HERE/windows.json")
for name in "${NAMES[@]}"; do
  [[ -n "${ONLY:-}" && "$name" != "$ONLY" ]] && continue
  [[ -n "${SKIP_CUT:-}" ]] && continue
  jq --arg n "$name" '.windows[] | select(.name == $n)
    | { campaign: "naip-pilot-20261125", pilot: "warp-proof", workTile, window,
        cells: [.cells[] | { key, outline, frames }] }' "$HERE/windows.json" > "$RUN/units/$name.spec.json"
  "$TSX" "$PKG/src/tilesPackMain.ts" unit --spec "$RUN/units/$name.spec.json" > "$RUN/units/$name.json"
  echo "══ $name"
  started="${EPOCHREALTIME}"
  bash "$CUT_AERIAL" "$RUN/units/$name.json" --local "$RUN/out" --keep "$RUN/work/$name"
  echo "   wall: $(awk -v a="$started" -v b="${EPOCHREALTIME}" 'BEGIN { printf "%.1f s", b - a }')"
done

# The seam strips read the COGs again: a fresh token in the environment, never on a command line.
sas() { curl -fsS https://planetarycomputer.microsoft.com/api/sas/v1/token/naip; }
body="$(sas)"
left=$(( $(jq -r '."msft:expiry" | fromdateiso8601' <<<"$body") - $(date +%s) ))
if (( left < 120 )); then sleep $(( left > 0 ? left + 2 : 2 )); body="$(sas)"; fi
AZURE_STORAGE_SAS_TOKEN="$(jq -r .token <<<"$body")"
export AZURE_STORAGE_SAS_TOKEN AZURE_STORAGE_ACCOUNT=naipeuwest GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
"$AERIAL_PYTHON" -I "$HERE/warp-proof.py" "$HERE/windows.json" "$RUN" "$RUN/report.json"
