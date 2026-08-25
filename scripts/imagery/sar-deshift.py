#!/usr/bin/env python3
"""Move each lake's pixels back under its own polygon (N6e open question 8).

    sar-deshift.py <reveal.geojson> <in.tif> <out.tif>
                   --reference-height M --incidence DEG --heading DEG
                   --feather-projected-m M [--no-look-right]

Emits `{"corrected": 41, "uncorrected": 3, "offSwath": 2, "maxShiftPx": 14}`.

## What this is for

A GRD carries no map projection — only ground-control points computed at **one average scene height**.
A lake above or below that reference is drawn displaced along range by `(h - h_ref)/tan(θ)`, and
because Sentinel-1 is right-looking, ascending views a lake from one side and descending from the
other, so **the displacement flips between them**. That is what made two islands in Mascoma jump east,
west, east as a scrubber advanced through alternating passes.

This reads each body's pixels from where the product actually put them and writes them where the body
actually is. Afterwards every other stage — the alpha, the zones, the statistics, the tiles — works at
true positions with no offset anywhere, which is the point: **the correction happens once, before the
mask is cut, rather than being threaded through everything downstream.**

## Why it is a per-body block copy, and why that is legitimate

⚠ **A single per-granule shift cannot work.** Measured on the ascending Mascoma pass: a sea-level lake
needs 429 m of correction and a 600 m lake needs 298 m *the other way*, inside the same scene — a
750 m spread, **27 pixels**. Any one shift is wrong for most of the lakes under it.

But the published frame is masked to disjoint per-lake patches anyway (D146: imagery is content scoped
to a body), so each patch can carry its own translation. Offsets are rounded to whole pixels, which
makes this a pure block copy with **no resampling** — a half-pixel of rounding against 150–450 m of
correction.

⚠ **Exact for the water, approximate for the ring around it.** A lake is flat at a known height, so a
single translation is the complete correction for its surface. The land inside the feather is *not* at
the lake's height, and it gets moved by the lake's offset regardless — so the shoreline stays attached
to its lake (which is what matters, and what stops the islands moving), while the hillside behind it is
as wrong as it ever was. Same trade `sarGeocode.ts` states: this corrects lakes, and only lakes.

⚠ **The calibration LUT is deliberately NOT de-shifted.** Gain varies ~1.50 dB across a 275 km scene,
so over a 450 m correction it moves by about **0.0025 dB** — four orders of magnitude below the ~2 dB
signal. Shifting it would cost a second pass to buy nothing measurable.

## ⚠ Everything outside a reveal is written as nodata, on purpose

The alpha would mask it away regardless, so nothing is lost — and it makes the tiler's `--skip-blank`
skip far more tiles, which is smaller and faster. The hazard is that a bug in the geometry would blank
the whole frame silently, so this **refuses to write an output in which no body was placed at all**.
"""

import argparse
import json
import math
import sys

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()

MW = 20037508.342789244


def latitude_of(northing: float) -> float:
    """Web Mercator northing back to latitude, for the 1/cos(φ) inflation."""
    return math.degrees(2 * math.atan(math.exp(northing / MW * math.pi)) - math.pi / 2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("reveal")
    parser.add_argument("source")
    parser.add_argument("out")
    parser.add_argument("--reference-height", type=float, required=True)
    parser.add_argument("--incidence", type=float, required=True)
    parser.add_argument("--heading", type=float, required=True)
    parser.add_argument("--feather-projected-m", type=float, required=True)
    parser.add_argument("--look-right", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    src = gdal.Open(args.source)
    gt = src.GetGeoTransform()
    width, height = src.RasterXSize, src.RasterYSize
    band = src.GetRasterBand(1)

    driver = gdal.GetDriverByName("GTiff")
    dst = driver.Create(
        args.out, width, height, 1, band.DataType,
        options=["COMPRESS=DEFLATE", "TILED=YES"],
    )
    dst.SetGeoTransform(gt)
    dst.SetProjection(src.GetProjection())
    dst_band = dst.GetRasterBand(1)
    dst_band.SetNoDataValue(0)

    with open(args.reveal) as handle:
        features = json.load(handle).get("features", [])

    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    per_metre = 1.0 / math.tan(math.radians(args.incidence))
    bearing = math.radians(args.heading + (90.0 if args.look_right else -90.0))

    corrected = uncorrected = off_swath = 0
    max_shift_px = 0

    for feature in features:
        geometry = feature.get("geometry")
        if not geometry:
            continue
        geom = ogr.CreateGeometryFromJson(json.dumps(geometry))
        # The feather moves with the lake, or there would be a visible step partway up the ramp
        # where corrected pixels met uncorrected ones.
        geom = geom.Buffer(args.feather_projected_m)
        if geom.IsEmpty():
            continue

        minx, maxx, miny, maxy = geom.GetEnvelope()

        elevation = (feature.get("properties") or {}).get("elevationM")
        if elevation is None:
            # No height, no correction — but the lake still belongs in the frame. Copying it
            # unshifted preserves exactly the behaviour this script replaces, rather than making a
            # body disappear because the corpus is missing a number.
            d_col = d_row = 0
            has_height = False
        else:
            # ⚠ **Negated.** `sar-geocode.py` prints where the pixels SHOULD BE DRAWN; this needs
            # where they ARE, so it can go and fetch them. See `maskOffsetMeters` in core — the
            # wrong direction here does not halve the correction, it doubles the error.
            magnitude = -(float(elevation) - args.reference_height) * per_metre
            inflation = 1.0 / math.cos(math.radians(latitude_of((miny + maxy) / 2)))
            east = magnitude * math.sin(bearing) * inflation
            north = magnitude * math.cos(bearing) * inflation
            d_col = int(round(east / gt[1]))
            d_row = int(round(north / gt[5]))
            has_height = True

        # Destination window: where this body is on the map.
        x0 = max(0, int(math.floor((minx - gt[0]) / gt[1])))
        x1 = min(width, int(math.ceil((maxx - gt[0]) / gt[1])) + 1)
        y0 = max(0, int(math.floor((maxy - gt[3]) / gt[5])))
        y1 = min(height, int(math.ceil((miny - gt[3]) / gt[5])) + 1)
        if x1 <= x0 or y1 <= y0:
            # Outside this raster entirely — the mask file is clipped to the granule footprint, not
            # to the warp extent, so this is ordinary rather than a problem.
            continue

        # Source window: where the product drew it. Clipped independently, and the overlap between
        # the two clips is what actually gets copied — a body near the swath edge contributes the
        # part of itself that exists rather than nothing.
        sx0, sx1 = x0 + d_col, x1 + d_col
        sy0, sy1 = y0 + d_row, y1 + d_row
        cx0, cx1 = max(0, sx0), min(width, sx1)
        cy0, cy1 = max(0, sy0), min(height, sy1)
        if cx1 <= cx0 or cy1 <= cy0:
            off_swath += 1
            continue

        patch = band.ReadAsArray(cx0, cy0, cx1 - cx0, cy1 - cy0)

        # Rasterise this body alone over the destination window, so only its own pixels are written
        # and a neighbouring lake at a different elevation cannot be dragged along with it.
        mem = gdal.GetDriverByName("MEM").Create("", x1 - x0, y1 - y0, 1, gdal.GDT_Byte)
        mem.SetGeoTransform((gt[0] + x0 * gt[1], gt[1], 0, gt[3] + y0 * gt[5], 0, gt[5]))
        mem.SetProjection(src.GetProjection())
        vector = ogr.GetDriverByName("MEM").CreateDataSource("")
        layer = vector.CreateLayer("body", srs=srs)
        shape = ogr.Feature(layer.GetLayerDefn())
        shape.SetGeometry(geom)
        layer.CreateFeature(shape)
        gdal.RasterizeLayer(mem, [1], layer, burn_values=[1])
        inside = mem.GetRasterBand(1).ReadAsArray() > 0

        # ⚠ **Counted here, where pixels are actually written — not at the top of the loop.**
        # Counting intent rather than effect would report `corrected: 4` on a run that placed one
        # body, and `corrected` is the field an operator reads to confirm the correction happened.
        if has_height:
            corrected += 1
            max_shift_px = max(max_shift_px, abs(d_col), abs(d_row))
        else:
            uncorrected += 1

        # Line the clipped source up with the destination window it came from.
        target = np.zeros_like(inside, dtype=patch.dtype)
        target[cy0 - sy0 : cy0 - sy0 + (cy1 - cy0), cx0 - sx0 : cx0 - sx0 + (cx1 - cx0)] = patch

        existing = dst_band.ReadAsArray(x0, y0, x1 - x0, y1 - y0)
        # Written under the body's own mask, so overlapping feathers of two neighbouring lakes do
        # not blank each other out — whichever is processed later wins only where it actually is.
        dst_band.WriteArray(np.where(inside, target, existing), x0, y0)

    if corrected == 0 and uncorrected == 0:
        # Everything outside a reveal is nodata, so an empty run writes a blank frame that looks
        # exactly like a granule over open ocean. Refuse instead.
        print("no bodies placed — refusing to write a blank frame", file=sys.stderr)
        return 1

    dst.FlushCache()
    json.dump(
        {
            "corrected": corrected,
            "uncorrected": uncorrected,
            "offSwath": off_swath,
            "maxShiftPx": max_shift_px,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
