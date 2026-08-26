#!/usr/bin/env python3
"""Per-body radar brightness from a calibrated Sentinel-1 pass (N6e PR 2, §C1).

    sar-zonal.py <zones.tif> <zone-to-id.json> <pol>:<dn.tif>:<a.tif>[:<noise.tif>] […]
                 [--interior <interior.tif> --erode-projected-m <m>]

Emits the radar counterpart of `zonal-clear.py`:

    [{"waterBodyId": "…", "vhDb": -21.4, "vvDb": -14.8, "coveragePct": 0.98, "pixels": 4107,
      "interiorVhDb": -22.9, "interiorPixels": 3140,
      "sigma0Hist": {"vh": [...45 bins over -35..10 dB...], "vv": [...]}}, …]

## What the number means, and what it does not

`sigma0` is how much of the radar pulse came back, and it is a measure of **surface texture** rather
than color or temperature. Smooth surfaces behave like mirrors and reflect away from the satellite,
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

## ⚠ Thermal noise is subtracted in POWER, before the division, and it is not optional either

A GRD's digital numbers are signal **plus the instrument's own noise**, and calibration does not
remove it:

    measured = true + NESZ          (linear power)

Measured NESZ for VH is a median of −25.2 dB on S1A and −28.0 dB on S1C, while our lakes sit at −20 to
−22 dB. So the floor is three to five decibels under the signal, and at the far edge of an S1A swath it
**reaches −21.8 dB**. Left in, a lake at a true −22 dB reads −20.3, and one at −26 dB reads −22.6 — a
compressive bias that is worst exactly where smooth ice lives. See `sar-noise-lut.py`.

⚠ **The subtraction is signed and stays signed until the mean is taken.** Speckle puts individual
pixels below the floor, and `max(0, …)` per pixel would bias every dark body upward — reintroducing
the error in a form that looks careful. Summing signed power over a body and converting once at the
end is unbiased; a body whose mean still lands at or below zero has no measurable return, which is
reported as `null` and counted in `belowNoiseFloorPct` rather than dressed up as a number.

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
    """Mean linear power to decibels, or `null` when there is nothing to take a logarithm of.

    ⚠ **Two different nulls, and they mean the same thing here on purpose.** `n == 0` is "we could not
    see it"; a mean at or below zero after noise subtraction is "we saw it and it returned nothing
    measurably above the instrument's own floor". Both are honestly `null` — the alternative is
    clamping to some very negative decibel figure, which would read as a spectacularly smooth lake.
    `belowNoiseFloorPct` is what distinguishes them for a reader who cares.
    """
    if n <= 0:
        return None
    mean = linear_sum / n
    return round(10 * float(np.log10(mean)), 3) if mean > 0 else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("zones")
    parser.add_argument("mapping")
    parser.add_argument(
        "--id-key",
        default="waterBodyId",
        help="what to call the id in the output. `subAreaId` for the sub-area sweep, so a bay's id "
             "never travels under a body's field name",
    )
    parser.add_argument("bands", nargs="+", help="pol:dn.tif:a.tif[:noise.tif]")
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
        parts = spec.split(":")
        if len(parts) == 3:
            pol, dn_path, a_path = parts
            noise_path = None
        elif len(parts) == 4:
            pol, dn_path, a_path, noise_path = parts
        else:
            print(f"band spec must be pol:dn:a[:noise], got {spec!r}", file=sys.stderr)
            return 64
        dn = gdal.Open(dn_path)
        a = gdal.Open(a_path)
        noise = gdal.Open(noise_path) if noise_path else None
        keep_alive.extend((dn, a))
        if noise is not None:
            keep_alive.append(noise)
        grids = [(dn_path, dn), (a_path, a)] + ([(noise_path, noise)] if noise else [])
        for name, ds in grids:
            if (ds.RasterXSize, ds.RasterYSize) != (width, height):
                # A per-pixel divide on mismatched grids applies one lake's gain to another and the
                # result still looks like a plausible brightness. Refuse.
                print(
                    f"grid mismatch: {name} is {ds.RasterXSize}x{ds.RasterYSize}, "
                    f"zones are {width}x{height}",
                    file=sys.stderr,
                )
                return 1
        channels.append((pol, dn.GetRasterBand(1), a.GetRasterBand(1),
                         noise.GetRasterBand(1) if noise else None))

    zone_slots = max_zone + 1
    linear = {pol: np.zeros(zone_slots) for pol, *_ in channels}
    counts = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, *_ in channels}
    inner_linear = {pol: np.zeros(zone_slots) for pol, *_ in channels}
    inner_counts = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, *_ in channels}
    # Pixels whose power went non-positive once the noise was subtracted — "at or under the floor".
    #
    # ⚠ **Counted over BOTH populations, because the two statistics that need it differ.** `vhDb` is a
    # full-zone figure; `sigma0Hist` and `interiorVhDb` are interior-only, and the interior is several
    # decibels darker because the bright bank is gone — so a far larger share of it sits at the floor.
    # Measured on a real pass: full-zone median 0.000 while the interior histogram put **21.7% of its
    # pixels in the bottom bin**. Reporting only the full-zone number would leave a reader of the
    # histogram with no warning at all about the very bin most likely to be mistaken for smooth ice.
    below_floor = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, *_ in channels}
    inner_below_floor = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, *_ in channels}
    # ## The body's own noise floor, which is where its histogram stops meaning anything
    #
    # ⚠ **Subtraction does not make the dark end trustworthy, it makes it unbiased.** A pixel whose
    # true return is a few percent of the noise comes out positive, tiny, and enormously negative in
    # decibels — so it lands in the bottom bins looking like exceptionally smooth ice. Measured on a
    # real pass: **15.6% of interior pixels in the bottom bin, while only ~0% were actually below
    # zero.** The two are not the same thing and neither is smoothness.
    #
    # NESZ varies across the swath by several decibels and between platforms by nearly three, so
    # there is no constant a reader could apply instead. Recording it per body is what lets "40% of
    # this lake sat below −22 dB" be checked against "and this lake's floor is −25.2 dB".
    noise_linear = {pol: np.zeros(zone_slots) for pol, *_ in channels}
    noise_counts = {pol: np.zeros(zone_slots, dtype=np.int64) for pol, *_ in channels}
    hist = {pol: np.zeros(zone_slots * HIST_BINS, dtype=np.int64) for pol, *_ in channels}
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

        for pol, dn_band, a_band, noise_band in channels:
            dn = dn_band.ReadAsArray(0, y, width, rows)
            gain = a_band.ReadAsArray(0, y, width, rows)
            # Read once per window, not once per subset. The full-zone and interior passes below both
            # want it, and this loop is bounded by I/O rather than by arithmetic — a second read of
            # the same window doubled the noise raster's share of it for nothing.
            noise = noise_band.ReadAsArray(0, y, width, rows) if noise_band is not None else None
            # A zero DN is outside the swath; a zero gain is outside the LUT's reach. Either way the
            # pixel abstains rather than contributing a fabricated value.
            usable = inside & (dn > 0) & (gain > 0)
            if not usable.any():
                continue
            z = zones[usable].astype(np.int64)
            power = dn[usable].astype(np.float64) ** 2
            if noise_band is not None:
                # ⚠ **Signed, and it stays signed.** Speckle puts individual pixels below the floor;
                # clamping each one at zero would bias every dark body upward, which is the same error
                # this correction exists to remove, wearing a more careful-looking hat. The sum is
                # unbiased and only the final mean has to be positive.
                power = power - noise[usable].astype(np.float64)
                below_floor[pol] += np.bincount(z[power <= 0], minlength=zone_slots)
            sigma0 = power / gain[usable].astype(np.float64) ** 2
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
            inner_power = dn[inner_usable].astype(np.float64) ** 2
            if noise is not None:
                inner_power = inner_power - noise[inner_usable].astype(np.float64)
            inner_sigma0 = inner_power / gain[inner_usable].astype(np.float64) ** 2
            inner_linear[pol] += np.bincount(iz, weights=inner_sigma0, minlength=zone_slots)
            inner_counts[pol] += np.bincount(iz, minlength=zone_slots)
            if noise is not None:
                inner_below_floor[pol] += np.bincount(
                    iz[inner_power <= 0], minlength=zone_slots
                )
                # The floor expressed in the same units as the measurement: noise power over gain.
                # Off the window read once above — this is the third consumer of it in one iteration,
                # and re-reading the raster per consumer is what the single `noise` local is for.
                nesz = (
                    noise[inner_usable].astype(np.float64)
                    / gain[inner_usable].astype(np.float64) ** 2
                )
                noise_linear[pol] += np.bincount(iz, weights=nesz, minlength=zone_slots)
                noise_counts[pol] += np.bincount(iz, minlength=zone_slots)

            # ⚠ **Per-pixel dB here, unlike every mean in this file.** Averaging decibels is the
            # error the module docstring exists to warn about — but *binning* them is not averaging,
            # it is classifying each pixel by its own brightness, which is exactly the distribution
            # a specular-fraction question asks about. The mean stays linear; only the bin edges are
            # logarithmic.
            # ⚠ A denoised pixel can be non-positive, which has no logarithm. Those go in the
            # bottom bin — "at or under the noise floor" is where they belong, and the count is also
            # reported on its own as `belowNoiseFloorPct` so nobody reads the bin as smooth ice.
            with np.errstate(divide="ignore", invalid="ignore"):
                pixel_db = np.where(
                    inner_sigma0 > 0, 10 * np.log10(np.maximum(inner_sigma0, 1e-12)), HIST_MIN_DB
                )
            pixel_db = np.clip(pixel_db, HIST_MIN_DB, HIST_MAX_DB)
            bins = np.minimum(
                ((pixel_db - HIST_MIN_DB) / bin_width).astype(np.int64), HIST_BINS - 1
            )
            hist[pol] += np.bincount(iz * HIST_BINS + bins, minlength=zone_slots * HIST_BINS)

    shaped = {pol: hist[pol].reshape(zone_slots, HIST_BINS) for pol, *_ in channels}

    out = []
    for zone, water_body_id in sorted(zone_to_id.items()):
        entry: dict[str, object] = {args.id_key: water_body_id}
        seen = 0
        inner_seen = 0
        for pol, *_ in channels:
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
        if any(nb is not None for *_, nb in channels):
            # How much of this body returned nothing above the noise floor. A high figure is not a
            # smooth lake — it is a lake the instrument cannot measure, and N6g Lane 1 has to be able
            # to tell those apart before it calls anything specular.
            entry["belowNoiseFloorPct"] = {
                pol: (round(int(below_floor[pol][zone]) / int(counts[pol][zone]), 4)
                      if int(counts[pol][zone]) > 0 else None)
                for pol, *_ in channels
            }
        if interior_band is not None:
            entry["interiorPixels"] = inner_seen
            entry["interiorTotalPixels"] = int(inner_total[zone])
            entry["sigma0Hist"] = (
                {pol: [int(v) for v in shaped[pol][zone]] for pol, *_ in channels}
                if inner_seen > 0
                else None
            )
            if any(nb is not None for *_, nb in channels):
                # ⚠ **The figure that belongs beside `sigma0Hist`, because it covers the same pixels.**
                # The bottom bin holds everything at or under the floor, so without this a reader sees
                # a dark mode and no reason to distrust it.
                entry["neszDb"] = {
                    pol: db(noise_linear[pol][zone], int(noise_counts[pol][zone]))
                    for pol, *_ in channels
                }
                entry["interiorBelowNoiseFloorPct"] = {
                    pol: (round(int(inner_below_floor[pol][zone]) / int(inner_counts[pol][zone]), 4)
                          if int(inner_counts[pol][zone]) > 0 else None)
                    for pol, *_ in channels
                }
        out.append(entry)

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
