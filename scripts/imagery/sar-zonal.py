#!/usr/bin/env python3
"""Per-body radar brightness from a calibrated Sentinel-1 pass (N6e PR 2, §C1).

    sar-zonal.py <zones.tif> <zone-to-id.json> <pol>:<dn.tif>:<a.tif> [<pol>:<dn.tif>:<a.tif> …]

Emits the radar counterpart of `zonal-clear.py`:

    [{"waterBodyId": "…", "vhDb": -21.4, "vvDb": -14.8, "coveragePct": 0.98, "pixels": 4107}, …]

## What the number means, and what it does not

`sigma0` is how much of the radar pulse came back, and it is a measure of **surface texture** rather
than colour or temperature. Smooth surfaces behave like mirrors and reflect away from the satellite,
so they read *dark*; rough surfaces scatter in all directions, so some returns and they read *bright*.

    calm open water    dark        smooth new ice     dark
    wind-roughened     brighter    snow-covered ice   brighter

**Which is why this cannot be read as "is there ice" on its own** — calm water and smooth ice sit in
the same place. What it is good for is *change*: measured across winter 2025-26, `VH` separates open
water from midwinter ice by about **2 dB** on lakes that actually freeze, while `VV` manages 0.6–0.8.
Lake Champlain, which barely freezes, moved 0.2–0.5 dB across the same season and served as an
accidental control.

⚠ **`VH` is the informative channel and it is not a preference.** A mirror-like bounce preserves the
pulse's orientation, so it returns in `VV`. Getting energy into the cross-polarised `VH` channel takes
the pulse bouncing around *inside* something — which ice does and open water does not.

## ⚠ Averaging happens in linear power, never in decibels

Decibels are logarithms, so averaging them yields a **geometric** mean — which is not the average
brightness of a lake, and is biased low by exactly the dark pixels a freeze-up series cares about.
This accumulates linear `sigma0` per body and converts once at the end:

    sigma0 = DN² / A²          mean over the body          dB = 10·log10(mean)

The difference is small on a uniform lake and grows with variance, which means it grows precisely
where a lake is half frozen — the case the number exists to catch.

## ⚠ Calibration is not optional

`A` is the per-pixel gain from the product's calibration annotation (see `sar-cal-lut.py`). Skipping
it leaves detector counts, and those carry a **1.50 dB gradient across a single scene** — measured, on
a real pass — against a signal of about 2 dB. Two lakes at opposite edges of one image would be
measured on different scales, and a lake's *position in the swath* would contaminate its ice reading
almost as much as freezing does. It would look like geography, not like a bug.

## ⚠ Windowed, for the reason `zonal-clear.py` is

A Sentinel-1 slice covers ~275 x 210 km — at native resolution that is a 175-megapixel grid, and the
zone array alone is 700 MB as UInt32 before numpy copies anything. Reading in row bands bounds memory
to one band regardless of how large the pass is.
"""

import argparse
import json
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

ROWS_PER_WINDOW = 512


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("zones")
    parser.add_argument("mapping")
    parser.add_argument("bands", nargs="+", help="pol:dn.tif:a.tif")
    args = parser.parse_args()

    zones_ds = gdal.Open(args.zones)
    width, height = zones_ds.RasterXSize, zones_ds.RasterYSize
    zones_band = zones_ds.GetRasterBand(1)

    with open(args.mapping) as handle:
        zone_to_id = {int(k): v for k, v in json.load(handle).items()}
    max_zone = max(zone_to_id) if zone_to_id else 0
    if max_zone == 0:
        json.dump([], sys.stdout)
        return 0

    # ⚠ **The Datasets are kept alive deliberately.** In GDAL's Python bindings a `Band` holds no
    # reference back to the `Dataset` it came from, so keeping only the band lets the dataset be
    # garbage-collected and the band becomes a dangling pointer. It does not fail at that moment; it
    # fails later, on first read, as `TypeError: in method 'Band_DataType_get'` — an error that names
    # neither the file nor the cause. Holding the datasets in the same tuple is what prevents it.
    channels = []
    keep_alive = []
    for spec in args.bands:
        pol, dn_path, a_path = spec.split(":", 2)
        dn = gdal.Open(dn_path)
        a = gdal.Open(a_path)
        keep_alive.extend((dn, a))
        for name, ds in ((dn_path, dn), (a_path, a)):
            if (ds.RasterXSize, ds.RasterYSize) != (width, height):
                # A per-pixel divide on mismatched grids applies one lake's gain to another and the
                # result still looks like a plausible brightness. Refuse.
                print(
                    f"grid mismatch: {name} is {ds.RasterXSize}x{ds.RasterYSize}, "
                    f"zones are {width}x{height}",
                    file=sys.stderr,
                )
                return 1
        channels.append((pol, dn.GetRasterBand(1), a.GetRasterBand(1)))

    linear = {pol: np.zeros(max_zone + 1) for pol, _, _ in channels}
    counts = {pol: np.zeros(max_zone + 1, dtype=np.int64) for pol, _, _ in channels}
    total = np.zeros(max_zone + 1, dtype=np.int64)

    for y in range(0, height, ROWS_PER_WINDOW):
        rows = min(ROWS_PER_WINDOW, height - y)
        zones = zones_band.ReadAsArray(0, y, width, rows)
        inside = zones > 0
        if not inside.any():
            continue
        total += np.bincount(zones[inside].astype(np.int64), minlength=max_zone + 1)

        for pol, dn_band, a_band in channels:
            dn = dn_band.ReadAsArray(0, y, width, rows)
            gain = a_band.ReadAsArray(0, y, width, rows)
            # A zero DN is outside the swath; a zero gain is outside the LUT's reach. Either way the
            # pixel abstains rather than contributing a fabricated value.
            usable = inside & (dn > 0) & (gain > 0)
            if not usable.any():
                continue
            z = zones[usable].astype(np.int64)
            sigma0 = (dn[usable].astype(np.float64) / gain[usable].astype(np.float64)) ** 2
            linear[pol] += np.bincount(z, weights=sigma0, minlength=max_zone + 1)
            counts[pol] += np.bincount(z, minlength=max_zone + 1)

    out = []
    for zone, water_body_id in sorted(zone_to_id.items()):
        entry: dict[str, object] = {"waterBodyId": water_body_id}
        seen = 0
        for pol, _, _ in channels:
            n = int(counts[pol][zone])
            seen = max(seen, n)
            # null, never a number, when nothing was visible — "we could not see it" and "it was dark"
            # are different claims and only one of them is a measurement.
            entry[f"{pol}Db"] = round(10 * np.log10(linear[pol][zone] / n), 3) if n > 0 else None
        t = int(total[zone])
        entry["coveragePct"] = round(seen / t, 4) if t > 0 else 0.0
        entry["pixels"] = seen
        out.append(entry)

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
