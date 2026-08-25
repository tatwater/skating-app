#!/usr/bin/env python3
"""Per-body radar brightness from a calibrated Sentinel-1 pass (N6e PR 2, §C1).

    sar-zonal.py <zones.tif> <zone-to-id.json> <pol>:<dn.tif>:<a.tif> [<pol>:<dn.tif>:<a.tif> …]
                 [--interior <interior.tif> --erode-projected-m <m>]

Emits the radar counterpart of `zonal-clear.py`:

    [{"waterBodyId": "…", "vhDb": -21.4, "vvDb": -14.8, "coveragePct": 0.98, "pixels": 4107,
      "interiorVhDb": -22.9, "interiorPixels": 3140,
      "sigma0Hist": {"vh": [...45 bins over -35..10 dB...], "vv": [...]}}, …]

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

## ⚠ The shoreline has to come off, and here it matters more than anywhere else in the pipeline

Forest is the classic bright `VH` target: volume scattering inside a canopy puts energy into the
cross-polarised channel that a smooth surface cannot. Bank vegetation sits near **−13 dB** while
smooth ice and calm water sit near **−22**, against the **~2 dB** of season-long separation this
measurement exists to detect. A ring of shoreline inside the zone does not add noise to the ice
signal — it swamps it, and worst on the smallest lakes, where the ring is the largest share.

Until 2026-08-25 the zone raster was the *reveal* shape, so every figure this script produced carried
a 60 m band of bank, a trail corridor and a car park. The frames already in R2 carry that. The 2 dB
separation was measured through the contamination, which means the real separation is **larger** than
the number recorded above.

## `sigma0Hist` — because a mean cannot answer the question the archive was built for

The mean is one number for a whole lake, and it cannot distinguish a uniformly medium-rough surface
from one that is half glassy and half ridged. **That distinction is the entire premise of N6g Lane 1**
— smooth ice is specular and returns dark, so "40% of this lake sat below −22 dB" is a claim about
smoothness that "this lake averaged −20 dB" cannot make.

A histogram is one more `bincount` over arrays already in memory, and it subsumes every statistic
anyone might later want: mean, variance, any percentile, any specular-fraction threshold. Deriving
those afterwards means re-reading all 40,365 granules of a nine-season backfill. The bins are fixed
rather than per-scene for the same reason the rendered stretch is (see `cut-granule.sh`): a per-scene
range makes every frame look alike and the differences vanish.
"""

import argparse
import json
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

ROWS_PER_WINDOW = 512

# 1 dB bins from −35 to +10. The low end is below anything C-band returns from a lake (calm water
# bottoms out around −25 and the noise floor is near −27); the high end clears bright urban and
# double-bounce returns. Fixed edges, so two lakes, two dates and two seasons are comparable.
HIST_MIN_DB = -35.0
HIST_MAX_DB = 10.0
HIST_BINS = 45


def db(linear_sum: float, n: int) -> float | None:
    """Mean linear power to decibels, or `null` when nothing was visible."""
    return round(10 * float(np.log10(linear_sum / n)), 3) if n > 0 else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("zones")
    parser.add_argument("mapping")
    parser.add_argument("bands", nargs="+", help="pol:dn.tif:a.tif")
    parser.add_argument(
        "--interior",
        help="distance-to-bank raster from `build_interior`; enables the eroded statistics",
    )
    parser.add_argument(
        "--erode-projected-m",
        type=float,
        help="how far from the bank a pixel must sit to count as interior, in PROJECTED metres",
    )
    args = parser.parse_args()

    zones_ds = gdal.Open(args.zones)
    width, height = zones_ds.RasterXSize, zones_ds.RasterYSize
    zones_band = zones_ds.GetRasterBand(1)

    interior_ds = None
    if args.interior:
        if args.erode_projected_m is None:
            print("--interior needs --erode-projected-m", file=sys.stderr)
            return 64
        interior_ds = gdal.Open(args.interior)
        if (interior_ds.RasterXSize, interior_ds.RasterYSize) != (width, height):
            print(
                f"grid mismatch: interior {interior_ds.RasterXSize}x"
                f"{interior_ds.RasterYSize}, zones are {width}x{height}",
                file=sys.stderr,
            )
            return 1
    interior_band = interior_ds.GetRasterBand(1) if interior_ds else None

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

    zone_slots = max_zone + 1
    linear = {pol: np.zeros(zone_slots) for pol, _, _ in channels}
    counts = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, _, _ in channels}
    inner_linear = {pol: np.zeros(zone_slots) for pol, _, _ in channels}
    inner_counts = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, _, _ in channels}
    hist = {pol: np.zeros(zone_slots * HIST_BINS, dtype=np.int64) for pol, _, _ in channels}
    total = np.zeros(zone_slots, dtype=np.int64)
    inner_total = np.zeros(zone_slots, dtype=np.int64)
    bin_width = (HIST_MAX_DB - HIST_MIN_DB) / HIST_BINS

    for y in range(0, height, ROWS_PER_WINDOW):
        rows = min(ROWS_PER_WINDOW, height - y)
        zones = zones_band.ReadAsArray(0, y, width, rows)
        inside = zones > 0
        if not inside.any():
            continue
        total += np.bincount(zones[inside].astype(np.int64), minlength=zone_slots)

        if interior_band is not None:
            distance = interior_band.ReadAsArray(0, y, width, rows)
            deep = inside & (distance >= args.erode_projected_m)
            inner_total += np.bincount(zones[deep].astype(np.int64), minlength=zone_slots)
        else:
            deep = None

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
            linear[pol] += np.bincount(z, weights=sigma0, minlength=zone_slots)
            counts[pol] += np.bincount(z, minlength=zone_slots)

            if deep is None:
                continue
            # The histogram is built over the eroded body only. A shoreline pixel at −13 dB would
            # otherwise put a second mode in every small lake's distribution and read as roughness.
            inner_usable = deep & (dn > 0) & (gain > 0)
            if not inner_usable.any():
                continue
            iz = zones[inner_usable].astype(np.int64)
            inner_sigma0 = (
                dn[inner_usable].astype(np.float64) / gain[inner_usable].astype(np.float64)
            ) ** 2
            inner_linear[pol] += np.bincount(iz, weights=inner_sigma0, minlength=zone_slots)
            inner_counts[pol] += np.bincount(iz, minlength=zone_slots)

            # ⚠ **Per-pixel dB here, unlike every mean in this file.** Averaging decibels is the
            # error the module docstring exists to warn about — but *binning* them is not averaging,
            # it is classifying each pixel by its own brightness, which is exactly the distribution
            # a specular-fraction question asks about. The mean stays linear; only the bin edges are
            # logarithmic.
            pixel_db = np.clip(
                10 * np.log10(inner_sigma0), HIST_MIN_DB, HIST_MAX_DB
            )
            bins = np.minimum(
                ((pixel_db - HIST_MIN_DB) / bin_width).astype(np.int64), HIST_BINS - 1
            )
            hist[pol] += np.bincount(iz * HIST_BINS + bins, minlength=zone_slots * HIST_BINS)

    shaped = {pol: hist[pol].reshape(zone_slots, HIST_BINS) for pol, _, _ in channels}

    out = []
    for zone, water_body_id in sorted(zone_to_id.items()):
        entry: dict[str, object] = {"waterBodyId": water_body_id}
        seen = 0
        inner_seen = 0
        for pol, _, _ in channels:
            n = int(counts[pol][zone])
            seen = max(seen, n)
            # null, never a number, when nothing was visible — "we could not see it" and "it was dark"
            # are different claims and only one of them is a measurement.
            entry[f"{pol}Db"] = db(linear[pol][zone], n)
            if interior_band is None:
                continue
            inner_n = int(inner_counts[pol][zone])
            inner_seen = max(inner_seen, inner_n)
            entry[f"interior{pol.capitalize()}Db"] = db(inner_linear[pol][zone], inner_n)
        t = int(total[zone])
        entry["coveragePct"] = round(seen / t, 4) if t > 0 else 0.0
        entry["pixels"] = seen
        if interior_band is not None:
            entry["interiorPixels"] = inner_seen
            entry["interiorTotalPixels"] = int(inner_total[zone])
            entry["sigma0Hist"] = (
                {pol: [int(v) for v in shaped[pol][zone]] for pol, _, _ in channels}
                if inner_seen > 0
                else None
            )
        out.append(entry)

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
