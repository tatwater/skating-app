#!/usr/bin/env python3
"""Per-body clear fraction from Sentinel-2's scene classification (N6e PR 2, §3).

    zonal-clear.py <zones.tif> <scl.tif> <zone-to-id.json> > bodies.json

Replaces the manifest's `bodies: 12` — a count that never said *which* twelve — with

    [{"waterBodyId": "...", "clearPct": 0.93, "coveragePct": 0.31, "pixels": 4107}, ...]

## Why this is the highest-value number in the pipeline

**Cloud is per lake, not per granule.** `eo:cloud_cover` is one figure for a ~110 km square: a granule
70% clouded over the White Mountains can be perfectly clear over Champlain, and gating on the
granule-wide number throws away the good lake with the bad one. SCL knows where the cloud actually is.

**And it gives PR 3 exact frame membership.** A per-body timeline needs to know which frames contain
the body; a footprint answers "probably", a body list answers "yes, and it was 93% clear".

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
"""

import json
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

CLEAR = frozenset({4, 5, 6, 7, 11})
INVALID = frozenset({0, 1})

# Rows read at a time. 512 rows of an 11,500-wide UInt32 band is ~23 MB, so peak memory is flat in the
# size of the granule rather than proportional to it.
ROWS_PER_WINDOW = 512


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 64

    zones_path, scl_path, mapping_path = sys.argv[1:4]

    zones_ds = gdal.Open(zones_path)
    scl_ds = gdal.Open(scl_path)
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

    with open(mapping_path) as handle:
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
    valid_counts = np.zeros(max_zone + 1, dtype=np.int64)
    clear_counts = np.zeros(max_zone + 1, dtype=np.int64)
    # Every pixel of the body's mask, whether or not the granule has data there. The denominator for
    # coverage, and the only way to tell a sliver of a lake from the whole thing.
    total_counts = np.zeros(max_zone + 1, dtype=np.int64)
    clear_lut = np.zeros(256, dtype=bool)
    valid_lut = np.ones(256, dtype=bool)
    for c in CLEAR:
        clear_lut[c] = True
    for c in INVALID:
        valid_lut[c] = False

    for y in range(0, height, ROWS_PER_WINDOW):
        rows = min(ROWS_PER_WINDOW, height - y)
        zones = zones_band.ReadAsArray(0, y, width, rows)
        inside = zones > 0
        if not inside.any():
            continue
        scl = scl_band.ReadAsArray(0, y, width, rows)
        z = zones[inside].astype(np.int64)
        s = scl[inside]
        # A lookup table rather than `np.isin`: SCL is a Byte band, so class membership is an index.
        v = valid_lut[s]
        total_counts += np.bincount(z, minlength=max_zone + 1)
        valid_counts += np.bincount(z[v], minlength=max_zone + 1)
        clear_counts += np.bincount(z[clear_lut[s] & v], minlength=max_zone + 1)

    out = []
    for zone, water_body_id in sorted(zone_to_id.items()):
        v = int(valid_counts[zone])
        c = int(clear_counts[zone])
        t = int(total_counts[zone])
        out.append(
            {
                "waterBodyId": water_body_id,
                # null, not 0 — "we cannot see it" is a different claim from "it is cloudy".
                "clearPct": round(c / v, 4) if v > 0 else None,
                # How much of this body the granule reached. 1.0 = the whole lake is in this frame;
                # 0.31 = a third of it, and this frame's clearPct describes only that third.
                "coveragePct": round(v / t, 4) if t > 0 else 0.0,
                "pixels": v,
            }
        )

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
