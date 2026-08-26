#!/usr/bin/env python3
"""Per-body NDSI from Sentinel-2's green and SWIR bands (N6e PR 2, §C1).

    zonal-ndsi.py <zones.tif> <green.tif> <swir16.tif> <zone-to-id.json>
                  --green-scale S --green-offset O --swir16-scale S --swir16-offset O
                  [--interior <interior.tif> --erode-projected-m <m>] > ndsi.json

Emits, per body:

    [{"waterBodyId": "…", "ndsiMean": 0.62, "ndsiPixels": 3140,
      "ndsiHist": [...40 bins over -1..1...]}, …]

## What it is for, and the one thing it is not for

`NDSI = (green - swir16) / (green + swir16)`. Snow and ice are bright in the visible and nearly black
in the shortwave infrared; **cloud is bright in both.** That asymmetry is the only optical way to
separate them, and it is why this is worth a second pair of band warps: it is an independent second
opinion exactly where ESA's scene classification is weakest. SCL's own documentation admits class 11
confuses with cloud, and a 22 Nov Morey frame read 99% clear through visible haze.

⚠ **It will not find black ice.** NDSI is a *snow* index built on the same brightness that misleads
SCL. Transparent ice over a dark bottom is dark in both bands and reads as water here exactly as it
does in class 11. Anyone reaching for this to solve the black-ice problem is reaching for the wrong
instrument — see N6g Lane 1, where the discriminator is radar texture rather than reflectance.

## ⚠⚠ Reflectance, not DN — and the offset is not a constant across the archive

L2A pixels are integers. Reflectance is `DN * scale + offset`, and processing **baseline 04.00
(2022-01-25)** introduced `BOA_ADD_OFFSET = -1000`, i.e. `offset = -0.1` at `scale = 0.0001`. Older
granules carry `offset = 0`.

In a normalised difference the **scale cancels and the offset does not**:

    NDSI = (G - S) / (G + S + 2*offset/scale)

For typical snow (G ≈ 8000 DN, S ≈ 1000 DN) that moves the denominator from 9000 to 7000 — a ~29%
change in the result. A nine-season backfill spans January 2022, so hardcoding either value would put
a **step change at the baseline switch that is indistinguishable from a climate signal**, in a series
whose entire purpose is comparing seasons to each other.

So both values are passed in per granule, read from STAC's `raster:bands`, and `cut-granule.sh` skips
NDSI entirely rather than assuming them. `null` is recoverable; a plausible wrong number is not.

## Why there is no NDSI raster

Tiling is ~63% of a granule job and nothing in the product asks to look at an NDSI image. The
per-body number is what PR 4's phenology and N6g want, so this reads the two bands windowed and emits
statistics — no intermediate raster on disk, no pyramid, no upload.
"""

import argparse
import json
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

ROWS_PER_WINDOW = 512

# NDSI is bounded by [-1, 1] by construction, so the bin edges are fixed rather than data-derived —
# which is what makes a histogram comparable between two lakes, two dates and two seasons. 0.05 per
# bin: fine enough to place the ~0.4 threshold the snow literature uses, coarse enough that 40 ints
# per body is a rounding error beside a 19 GB season.
HIST_BINS = 40
HIST_MIN = -1.0
HIST_MAX = 1.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("zones")
    parser.add_argument("green")
    parser.add_argument("swir16")
    parser.add_argument("mapping")
    parser.add_argument("--green-scale", type=float, required=True)
    parser.add_argument("--green-offset", type=float, required=True)
    parser.add_argument("--swir16-scale", type=float, required=True)
    parser.add_argument("--swir16-offset", type=float, required=True)
    parser.add_argument("--interior")
    parser.add_argument("--erode-projected-m", type=float)
    args = parser.parse_args()

    zones_ds = gdal.Open(args.zones)
    green_ds = gdal.Open(args.green)
    swir_ds = gdal.Open(args.swir16)
    width, height = zones_ds.RasterXSize, zones_ds.RasterYSize

    # A per-pixel ratio on mismatched grids divides one lake's green by another's SWIR and still
    # returns a number in [-1, 1]. Refuse, for the reason `zonal-clear.py` refuses.
    for name, ds in (("green", green_ds), ("swir16", swir_ds)):
        if (ds.RasterXSize, ds.RasterYSize) != (width, height):
            print(
                f"grid mismatch: {name} is {ds.RasterXSize}x{ds.RasterYSize}, "
                f"zones are {width}x{height}",
                file=sys.stderr,
            )
            return 1

    interior_ds = None
    if args.interior:
        if args.erode_projected_m is None:
            print("--interior needs --erode-projected-m", file=sys.stderr)
            return 64
        interior_ds = gdal.Open(args.interior)
        if (interior_ds.RasterXSize, interior_ds.RasterYSize) != (width, height):
            print("grid mismatch: interior vs zones", file=sys.stderr)
            return 1

    with open(args.mapping) as handle:
        zone_to_id = {int(k): v for k, v in json.load(handle).items()}
    max_zone = max(zone_to_id) if zone_to_id else 0
    if max_zone == 0:
        json.dump([], sys.stdout)
        return 0

    zones_band = zones_ds.GetRasterBand(1)
    green_band = green_ds.GetRasterBand(1)
    swir_band = swir_ds.GetRasterBand(1)
    interior_band = interior_ds.GetRasterBand(1) if interior_ds else None

    zone_slots = max_zone + 1
    total = np.zeros(zone_slots)
    counts = np.zeros(zone_slots, dtype=np.int64)
    hist = np.zeros(zone_slots * HIST_BINS, dtype=np.int64)
    bin_width = (HIST_MAX - HIST_MIN) / HIST_BINS

    for y in range(0, height, ROWS_PER_WINDOW):
        rows = min(ROWS_PER_WINDOW, height - y)
        zones = zones_band.ReadAsArray(0, y, width, rows)
        inside = zones > 0
        if not inside.any():
            continue

        # ⚠ **Statistics over the eroded body only, unlike `zonal-clear.py`.** There, the full-zone
        # figure is what tells a consumer whether a *frame* is usable, so both are kept. Here the
        # number exists to describe the lake surface, and a shoreline pixel is the single worst thing
        # to average into a snow index — bank vegetation and bare ground sit at NDSI values that
        # neither snow nor water occupies.
        if interior_band is not None:
            distance = interior_band.ReadAsArray(0, y, width, rows)
            inside = inside & (distance >= args.erode_projected_m)
            if not inside.any():
                continue

        g_raw = green_band.ReadAsArray(0, y, width, rows)
        s_raw = swir_band.ReadAsArray(0, y, width, rows)
        # Both bands declare `nodata: 0`, which is also outside the swath. A pixel missing either
        # band abstains rather than contributing a ratio built from one.
        usable = inside & (g_raw > 0) & (s_raw > 0)
        if not usable.any():
            continue

        g = g_raw[usable].astype(np.float64) * args.green_scale + args.green_offset
        s = s_raw[usable].astype(np.float64) * args.swir16_scale + args.swir16_offset
        denominator = g + s
        # The offset can push a dark pixel's reflectance negative, so the denominator can reach zero
        # in a way raw DN never could. Those pixels abstain; NDSI is undefined there, not extreme.
        ok = denominator != 0
        if not ok.any():
            continue

        z = zones[usable][ok].astype(np.int64)
        ndsi = np.clip((g[ok] - s[ok]) / denominator[ok], HIST_MIN, HIST_MAX)

        total += np.bincount(z, weights=ndsi, minlength=zone_slots)
        counts += np.bincount(z, minlength=zone_slots)
        # `HIST_BINS - 1` catches exactly +1.0, which would otherwise index one past the last bin.
        bins = np.minimum(((ndsi - HIST_MIN) / bin_width).astype(np.int64), HIST_BINS - 1)
        hist += np.bincount(z * HIST_BINS + bins, minlength=zone_slots * HIST_BINS)

    hist = hist.reshape(zone_slots, HIST_BINS)

    out = []
    for zone, water_body_id in sorted(zone_to_id.items()):
        n = int(counts[zone])
        out.append(
            {
                "waterBodyId": water_body_id,
                # null rather than 0 — an unmeasured lake and a lake at NDSI 0 are different claims,
                # and 0 is a perfectly ordinary value for open water.
                "ndsiMean": round(total[zone] / n, 4) if n > 0 else None,
                "ndsiPixels": n,
                "ndsiHist": [int(v) for v in hist[zone]] if n > 0 else None,
            }
        )

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
