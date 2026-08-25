#!/usr/bin/env python3
"""Per-body scene classification from Sentinel-2's SCL band (N6e PR 2, §3).

    zonal-clear.py <zones.tif> <scl.tif> <zone-to-id.json>
                   [--interior <interior.tif> --erode-projected-m <m>] > bodies.json

Replaces the manifest's `bodies: 12` — a count that never said *which* twelve — with

    [{"waterBodyId": "...", "clearPct": 0.93, "coveragePct": 0.31,
      "snowIcePct": 0.88, "waterPct": 0.04, "pixels": 4107, "interiorPixels": 3140,
      "classHist": [...12...], "interiorClassHist": [...12...]}, ...]

## Why this is the highest-value number in the pipeline

**Cloud is per lake, not per granule.** `eo:cloud_cover` is one figure for a ~110 km square: a granule
70% clouded over the White Mountains can be perfectly clear over Champlain, and gating on the
granule-wide number throws away the good lake with the bad one. SCL knows where the cloud actually is.

**And it gives PR 3 exact frame membership.** A per-body timeline needs to know which frames contain
the body; a footprint answers "probably", a body list answers "yes, and it was 93% clear".

## ⚠ The zone raster is the WATER polygon, and it has not always been

Until 2026-08-25 `cut-granule.sh` burned the *reveal* shape here — the lake buffered 60 m outward,
unioned with the walk in and the parking, islands filled. Every number below was therefore measured
over a lake plus a ring of its shoreline, and the error scaled with perimeter over area: nothing on
Champlain, **7x a 1-acre pond's own area**. The frames already in R2 carry that denominator. See
`revealMasks.ts` for the full arithmetic and `build_zones` for the fix.

## The classes, and the two judgement calls

ESA's L2A scene classification, per pixel:

    0 no data        4 vegetation        8 cloud, medium probability
    1 saturated      5 not vegetated     9 cloud, high probability
    2 cast shadow    6 water            10 thin cirrus
    3 cloud shadow   7 unclassified     11 snow / ice

* **Class 2 (cast shadow) counts as obscured, not clear.** It is terrain shadow rather than cloud, so
  the ground is technically visible — but a lake in deep shadow cannot be read for ice, which is the
  only thing this number is used for. Calling it clear would inflate the figure exactly where the
  imagery is least useful.
* **`clearPct` is a fraction of VALID pixels, not of all pixels.** No-data and saturated pixels are
  excluded from the denominator entirely. A body half outside the granule would otherwise report ~50%
  clear when the half we can see is perfectly clear — punishing a frame for the shape of a swath.
  A body with no valid pixels at all reports `null`, never 0: "we cannot see it" is not "it is cloudy".

## ⚠ `coveragePct` — the reason a lake can appear in two granules and neither is wrong

Champlain spans several Sentinel tiles, and any body can be bisected by a granule edge. Each granule
sees only its own part, so `clearPct` alone is a claim about *the part this granule saw* while reading
exactly like a claim about the lake.

`coveragePct` is how much of the body this granule actually reached: the mask file returns whole
features, so the zone raster carries each body's **complete** footprint, while SCL is valid only where
the granule reaches. Their ratio is the coverage, and it is exact rather than inferred.

A consumer combining a date's frames should weight each `clearPct` by its `coveragePct` — that is what
makes "was Champlain clear on the 14th" answerable from parts, and what lets PR 3 draw the split-body
seam knowing which side came from which pass.

## `classHist` — the whole cross-tabulation, because the cheap moment does not come again

The four percentages above are a *reading* of the classification. The histogram is the classification.
It is one more `bincount` over arrays already in memory, and it costs no I/O and no extra granule read
— while **re-deriving any other reading of SCL means re-reading all 40,365 granules of a nine-season
backfill.** Everything above is recoverable from it: `valid = total - hist[0] - hist[1]`,
`clear = hist[4] + hist[5] + hist[6] + hist[7] + hist[11]`, and so is every question nobody has asked
yet — how much of the confusion is cirrus rather than opaque cloud, whether cast shadow should have
counted, what a stricter cloud rule would have said.

The derived fields stay alongside it because PR 3 already reads them and an additive field costs
nothing; see the plan's rule about contract changes versus additive ones.
"""

import argparse
import json
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

CLEAR = frozenset({4, 5, 6, 7, 11})
INVALID = frozenset({0, 1})

# ESA defines 0–11 and nothing else. Anything outside that is counted separately rather than folded
# into a neighbour, because a silently-clamped class 12 would land in "snow / ice".
NUM_CLASSES = 12

# ## The two classes worth keeping apart, and why they are counted here rather than derived later
#
# `clearPct` folds **snow/ice (11)** and **water (6)** into the same bucket — both are "we could see
# the lake" — which answers *whether the frame is usable* and says nothing about *what was there*.
# Those are different questions, and the second one is the whole point of a freeze-up archive.
#
# ⚠ **This is a measurement, not a verdict, and the gap is wide.** SCL's class 11 is "snow / ice" —
# it does not separate lake ice from snow lying on it, and ESA's own documentation notes the class
# confuses with cloud. It cannot see thickness, and D147 is explicit that 10 m imagery cannot see a
# pressure ridge. So this records what the classifier said, at a stated date, and every downstream
# claim stays bounded by D150: report the observation and its source, never a verdict on skating.
SNOW_ICE = 11
WATER = 6

# Rows read at a time. 512 rows of an 11,500-wide UInt32 band is ~23 MB, so peak memory is flat in the
# size of the granule rather than proportional to it.
ROWS_PER_WINDOW = 512


def ratio(numerator: int, denominator: int) -> float | None:
    """A fraction, or `null` when there was nothing to divide by.

    Never 0 on an empty denominator: "we could not see it" and "we saw none of it" are different
    claims, and only the second is a measurement.
    """
    return round(numerator / denominator, 4) if denominator > 0 else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("zones")
    parser.add_argument("scl")
    parser.add_argument("mapping")
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
    scl_ds = gdal.Open(args.scl)
    width, height = zones_ds.RasterXSize, zones_ds.RasterYSize
    if (width, height) != (scl_ds.RasterXSize, scl_ds.RasterYSize):
        # The whole statistic is a per-pixel join; a grid mismatch silently attributes one lake's
        # cloud to another. Refuse rather than produce a plausible wrong number.
        print(
            f"grid mismatch: zones {width}x{height} vs "
            f"scl {scl_ds.RasterXSize}x{scl_ds.RasterYSize} — "
            "SCL must be warped onto the same grid as the mask",
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
            print(
                f"grid mismatch: interior {interior_ds.RasterXSize}x{interior_ds.RasterYSize} "
                f"vs zones {width}x{height}",
                file=sys.stderr,
            )
            return 1

    with open(args.mapping) as handle:
        zone_to_id = {int(k): v for k, v in json.load(handle).items()}
    max_zone = max(zone_to_id) if zone_to_id else 0
    if max_zone == 0:
        json.dump([], sys.stdout)
        return 0

    # ⚠ **Windowed, because the whole-array version does not fit.**
    #
    # A granule's mask extent reaches ~11,500 x 20,600 px — 237 million pixels. As UInt32 the zone
    # array alone is 950 MB before numpy makes a single boolean copy of it, and the first real run
    # died with `Killed` on a 2 GB Machine. Reading in row bands bounds memory to one band regardless
    # of how large the extent gets, which matters because extent is driven by where the lakes are and
    # nothing caps it.
    #
    # The statistic is unaffected: bincount over bands and bincount over the whole array sum to the
    # same totals.
    zones_band = zones_ds.GetRasterBand(1)
    scl_band = scl_ds.GetRasterBand(1)
    interior_band = interior_ds.GetRasterBand(1) if interior_ds else None

    zone_slots = max_zone + 1
    # One row per zone, one column per class. `bincount` on `zone * 12 + class` fills it in a single
    # pass — the same trick as the four counters it replaces, done once instead of four times.
    hist = np.zeros(zone_slots * NUM_CLASSES, dtype=np.int64)
    interior_hist = np.zeros(zone_slots * NUM_CLASSES, dtype=np.int64)
    # Every pixel of the body's mask, whether or not the granule has data there. The denominator for
    # coverage, and the only way to tell a sliver of a lake from the whole thing.
    total_counts = np.zeros(zone_slots, dtype=np.int64)
    interior_totals = np.zeros(zone_slots, dtype=np.int64)
    out_of_range = 0

    for y in range(0, height, ROWS_PER_WINDOW):
        rows = min(ROWS_PER_WINDOW, height - y)
        zones = zones_band.ReadAsArray(0, y, width, rows)
        inside = zones > 0
        if not inside.any():
            continue
        scl = scl_band.ReadAsArray(0, y, width, rows)

        if interior_band is not None:
            distance = interior_band.ReadAsArray(0, y, width, rows)
            deep = inside & (distance >= args.erode_projected_m)
        else:
            deep = None

        z = zones[inside].astype(np.int64)
        s = scl[inside].astype(np.int64)
        known = s < NUM_CLASSES
        out_of_range += int((~known).sum())

        total_counts += np.bincount(z, minlength=zone_slots)
        hist += np.bincount(
            z[known] * NUM_CLASSES + s[known], minlength=zone_slots * NUM_CLASSES
        )

        if deep is not None:
            dz = zones[deep].astype(np.int64)
            ds = scl[deep].astype(np.int64)
            dknown = ds < NUM_CLASSES
            interior_totals += np.bincount(dz, minlength=zone_slots)
            interior_hist += np.bincount(
                dz[dknown] * NUM_CLASSES + ds[dknown], minlength=zone_slots * NUM_CLASSES
            )

    if out_of_range:
        # Not fatal — the frame is still worth having — but it means SCL held a value ESA does not
        # define, and a reader of `classHist` should know its rows do not sum to `pixels`.
        print(f"warning: {out_of_range} pixels outside SCL classes 0-11", file=sys.stderr)

    hist = hist.reshape(zone_slots, NUM_CLASSES)
    interior_hist = interior_hist.reshape(zone_slots, NUM_CLASSES)

    out = []
    for zone, water_body_id in sorted(zone_to_id.items()):
        counts = hist[zone]
        total = int(total_counts[zone])
        valid = int(counts.sum() - counts[0] - counts[1])
        clear = int(sum(counts[c] for c in CLEAR))

        interior_counts = interior_hist[zone]
        interior_valid = int(
            interior_counts.sum() - interior_counts[0] - interior_counts[1]
        )

        entry = {
            "waterBodyId": water_body_id,
            "clearPct": ratio(clear, valid),
            # How much of this body the granule reached. 1.0 = the whole lake is in this frame;
            # 0.31 = a third of it, and this frame's clearPct describes only that third.
            "coveragePct": round(valid / total, 4) if total > 0 else 0.0,
            # ⚠ **Both over `valid`, the same denominator as `clearPct` — deliberately not over
            # each other.** A ratio like `ice / (ice + water)` ("of the lake we could actually
            # see, how much was frozen") is the figure a chart wants, but storing only the ratio
            # throws away how much was seen at all, and a lake 90% under cloud would then report
            # the same confident number as one in full view. Keeping both raw against `valid`
            # lets a consumer form that ratio *and* know what it rests on; the reverse is not
            # recoverable.
            # ⚠ **`snowIcePct`, not `icePct`, and the name is the whole point.** SCL's class 11
            # finds *bright* frozen surfaces. Black ice is transparent — the light comes back off
            # the dark bottom — so it is classified as **water**, and a lake somebody skated can
            # read 2% here. Measured: Mascoma Lake, 22 Dec 2025, 98% clear, 2.3% "ice", 82.5%
            # water; the founder skated its full length the next morning. The name has to say
            # snow, because the number does.
            "snowIcePct": ratio(int(counts[SNOW_ICE]), valid),
            "waterPct": ratio(int(counts[WATER]), valid),
            "pixels": valid,
            "classHist": [int(v) for v in counts],
        }

        if interior_band is not None:
            # ⚠ **The count is the point, not the cleaner percentage.** N6g Lane 2 eliminates bodies
            # on "never observed frozen", and a body too small to classify reads exactly like a body
            # that never froze — so the rule needs to know how many pixels actually voted. After
            # eroding the bank a 1-acre pond has under ten; a 50-acre lake has around a hundred.
            entry["interiorPixels"] = interior_valid
            # How big the eroded body is *at all*, independent of this frame — a property of the
            # geometry rather than of the pass. It is what separates "this granule only caught a
            # corner of the lake" from "this lake is too small to ever be classified", and Lane 2's
            # area floor has to be set against the second.
            entry["interiorTotalPixels"] = int(interior_totals[zone])
            entry["interiorSnowIcePct"] = ratio(
                int(interior_counts[SNOW_ICE]), interior_valid
            )
            entry["interiorWaterPct"] = ratio(int(interior_counts[WATER]), interior_valid)
            entry["interiorClassHist"] = [int(v) for v in interior_counts]

        out.append(entry)

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
