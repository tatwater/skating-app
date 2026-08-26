#!/usr/bin/env python3
"""Move each lake's pixels back under its own polygon (N6e open question 8).

    sar-deshift.py <reveal.geojson> <in.tif> <out.tif>
                   --grid <grid.json> --feather-projected-m M [--no-look-right]

`grid.json` is `sar-geocode.py <annotation.xml> --grid`.

Emits `{"corrected": 41, "uncorrected": 3, "offSwath": 2, "invalidGeometry": 0,
"maxShiftPx": 14}`.

## What this is for

A GRD carries no map projection — only a **geolocation grid**, whose points each record the terrain
height and incidence angle the product was geocoded at. A lake above or below its local grid height is
drawn displaced along range by `(h - h_ref)/tan(θ)`, and because Sentinel-1 is right-looking, ascending
views a lake from one side and descending from the other, so **the displacement flips between them**.
That is what made two islands in Mascoma jump east, west, east as a scrubber advanced through
alternating passes.

⚠ **`h_ref` is LOCAL to the lake, and a scene average is not a usable stand-in.** Measured across five
real tracks, the scene-average height ranged 7.9 m (a pass mostly over the Gulf of Maine) to 369.6 m
(one over the White Mountains) — a spread describing the pass's coverage rather than any lake under it.
Correcting with it was **worse than not correcting**: 287.4 m RMS against 116.2 m for doing nothing.
With local values it is **42.1 m**, at a correlation of 0.90 over 21 lake-passes. See
`local_reference`.

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


# How many geolocation grid points to blend. The grid is spaced every ~10–20 km, so a handful of
# neighbours spans the terrain a lake actually sits in. Measured over 10 lake-passes: k=3 gave 53.7 m
# RMS, k=6 44.4 m, k=12 44.1 m — it plateaus, and 8 is on the flat part.
GRID_NEIGHBOURS = 8


def local_reference(points, lat: float, lng: float) -> tuple[float, float]:
    """Terrain height and incidence angle at one lake, from the geolocation grid around it.

    ⚠ **Never the scene average.** The product is geocoded against the grid, whose points each carry
    their own height and incidence. A scene average is dominated by whatever the pass covered —
    measured across five real tracks over one region it ranged from 7.9 m (mostly ocean) to 369.6 m
    (the White Mountains). Using it made the correction **worse than not correcting**: 325.6 m RMS
    against 96.5 m for doing nothing, versus 44.7 m for the local values.

    Inverse-distance-squared over the nearest few, which is enough for a surface this smooth and
    avoids a triangulation the container has no library for.
    """
    scale = math.cos(math.radians(lat))
    nearest = sorted(
        points,
        key=lambda p: (p["lat"] - lat) ** 2 + ((p["lng"] - lng) * scale) ** 2,
    )[:GRID_NEIGHBOURS]

    weights = []
    for p in nearest:
        d2 = (p["lat"] - lat) ** 2 + ((p["lng"] - lng) * scale) ** 2
        # A lake sitting exactly on a grid point would divide by zero; it also needs no interpolation.
        if d2 <= 1e-18:
            return float(p["heightM"]), float(p["incidenceDeg"])
        weights.append(1.0 / d2)

    total = sum(weights)
    height = sum(p["heightM"] * w for p, w in zip(nearest, weights)) / total
    incidence = sum(p["incidenceDeg"] * w for p, w in zip(nearest, weights)) / total
    return height, incidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("reveal")
    parser.add_argument("source", nargs="?")
    parser.add_argument("out", nargs="?")
    parser.add_argument(
        "--plan",
        action="store_true",
        help="print the largest correction any body under this mask needs, in GROUND metres, "
             "and exit — the caller sizes its warp extent from it",
    )
    parser.add_argument("--grid", required=True, help="`sar-geocode.py <ann> --grid` output")
    parser.add_argument("--feather-projected-m", type=float, default=0.0)
    parser.add_argument(
        "--per-body",
        help="write per-body geometry (incidence, reference height, applied offset) as JSON",
    )
    parser.add_argument("--look-right", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    if args.plan:
        # ## Sizing the warp extent, exactly rather than generously
        #
        # The de-shift fetches each body's pixels from outside its own footprint, so the raster has to
        # be wider than the masks. Bounding that by the grid's extremes over all bodies is safe and
        # badly over-generous — on a small granule it can double the area warped. Every term needed
        # for the real answer is already here, so this computes the actual per-body shifts and
        # reports the largest.
        with open(args.grid) as handle:
            grid = json.load(handle)
        with open(args.reveal) as handle:
            features = json.load(handle).get("features", [])
        worst = 0.0
        for feature in features:
            elevation = (feature.get("properties") or {}).get("elevationM")
            geometry = feature.get("geometry")
            if elevation is None or not geometry:
                continue
            g = ogr.CreateGeometryFromJson(json.dumps(geometry))
            minx, maxx, miny, maxy = g.GetEnvelope()
            lat = latitude_of((miny + maxy) / 2)
            reference, incidence = local_reference(grid["points"], lat, (minx + maxx) / 2 / MW * 180.0)
            worst = max(worst, abs(float(elevation) - reference) / math.tan(math.radians(incidence)))
        print(round(worst, 1))
        return 0

    if not args.source or not args.out:
        parser.error("give <source> and <out>, or --plan")
    if args.feather_projected_m <= 0:
        parser.error("--feather-projected-m is required for a real run")

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

    with open(args.grid) as handle:
        grid = json.load(handle)
    points = grid["points"]
    bearing = math.radians(grid["headingDeg"] + (90.0 if args.look_right else -90.0))

    corrected = uncorrected = off_swath = invalid_geometry = 0
    max_shift_px = 0
    # ## Why the viewing geometry is recorded per body and not just per scene
    #
    # `sigma0` genuinely varies with incidence angle — physics, not calibration error — and ice and
    # water have *different* angular responses, so an offset fitted on open water is wrong for ice.
    # N6e open question 7 names "incidence-angle differences the manifest does not currently record"
    # as a prime suspect for the S1A/S1C disagreement that forbids pooling platforms.
    #
    # It is computed here anyway, per body, to place the pixels. Recording it costs one dict.
    per_body: list[dict] = []

    for feature in features:
        geometry = feature.get("geometry")
        if not geometry:
            continue
        geom = ogr.CreateGeometryFromJson(json.dumps(geometry))
        # The feather moves with the lake, or there would be a visible step partway up the ramp
        # where corrected pixels met uncorrected ones.
        #
        # ⚠ **GEOS throws on a self-intersecting ring, and one bad lake must not lose the granule.**
        # `TopologyException: side location conflict` on a corpus polygon killed a calibration run
        # outright; here the same throw would abort a job that had already paid for its granule read.
        # `MakeValid` fixes the ordinary case, and a body that still will not buffer falls back to its
        # unbuffered shape — the feather ring around it stays uncorrected, which is a cosmetic loss on
        # one lake rather than a lost frame.
        try:
            buffered = geom.Buffer(args.feather_projected_m)
        except RuntimeError:
            try:
                buffered = geom.MakeValid().Buffer(args.feather_projected_m)
            except RuntimeError:
                buffered = None
        if buffered is None or buffered.IsEmpty():
            invalid_geometry += 1
            buffered = geom
        geom = buffered
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
            lat = latitude_of((miny + maxy) / 2)
            lng = (minx + maxx) / 2 / MW * 180.0
            # Per lake, from the grid around it — see `local_reference`. The scene average that
            # stood here made the correction worse than doing nothing.
            reference, incidence = local_reference(points, lat, lng)
            magnitude = -(float(elevation) - reference) / math.tan(math.radians(incidence))
            inflation = 1.0 / math.cos(math.radians(lat))
            east = magnitude * math.sin(bearing) * inflation
            north = magnitude * math.cos(bearing) * inflation
            d_col = int(round(east / gt[1]))
            d_row = int(round(north / gt[5]))
            has_height = True
            geometry_row = {
                "waterBodyId": (feature.get("properties") or {}).get("waterBodyId"),
                "incidenceDeg": round(incidence, 3),
                "geocodeReferenceHeightM": round(reference, 1),
                # What was actually applied, in whole pixels — so a frame can be audited or undone
                # rather than trusted. Ground metres, not the projected ones the shift was made in.
                #
                # ⚠ **Both components in the same frame.** `gt[5]` is already negative on a north-up
                # raster, so `d_row * gt[5]` IS the northing — negating it as well made `north` point
                # the opposite way from `east`, which is the one thing a recorded offset must never
                # do: an auditor undoing this row would have moved the lake twice as far north as it
                # ever went.
                "geocodeShiftM": {
                    "east": round(d_col * gt[1] / inflation, 1),
                    "north": round(d_row * gt[5] / inflation, 1),
                },
            }

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
            per_body.append(geometry_row)
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
    if args.per_body:
        with open(args.per_body, "w") as handle:
            json.dump(per_body, handle)
    json.dump(
        {
            "corrected": corrected,
            "uncorrected": uncorrected,
            "offSwath": off_swath,
            # Bodies whose reveal would not buffer, so their feather ring stayed uncorrected. Should
            # be zero; a nonzero count is a corpus geometry problem worth chasing, not a cutter one.
            "invalidGeometry": invalid_geometry,
            "maxShiftPx": max_shift_px,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
