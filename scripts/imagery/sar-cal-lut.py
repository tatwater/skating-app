#!/usr/bin/env python3
"""Turn Sentinel-1's calibration annotation into a raster that can be warped (N6e PR 2, §C1).

    sar-cal-lut.py <calibration.xml> <grd-url-or-path> <out.tif>

## What calibration is, and why skipping it quietly ruins the measurement

A Sentinel-1 GRD product does not contain backscatter. It contains **digital numbers** — detector
counts — and turning those into the physical quantity (`sigma0`, radar brightness) needs a per-pixel
gain the product ships alongside it:

    sigma0 = DN² / A²        so, in decibels:        dB = 20·log10(DN) − 20·log10(A)

`A` is not a constant. It varies across the swath because the radar looks at the near edge and the far
edge from very different angles.

**Measured on a real scene** (`S1A_IW_GRDH_1SDV_20260213T224345`, VH): `A` runs from 558.4 to 663.4 —
a spread of **1.50 dB across one image**. Set that beside the thing we are trying to detect: open water
separates from midwinter ice by about **2 dB**. So an uncalibrated scene carries a gradient nearly as
large as the entire signal, and two lakes at opposite edges of the same pass are measured on different
scales. It reads as a spatial pattern in the data — lakes on one side of the region behaving unlike
lakes on the other — which is the kind of artifact that gets explained rather than debugged.

Cross-platform, the same problem again: uncalibrated, S1A reads **+1.01 dB (VV)** and **+2.17 dB (VH)**
above S1C on the same track. Calibration is what lets two satellites be one time series, which is the
difference between a ~12-day and a ~6-day cadence over a lake.

## Why a raster, rather than applying the gain directly

The gain is defined on a sparse grid in **radar geometry** — 27 rows × 649 columns for a scene that is
25,898 × 16,686 pixels. Our imagery lives in Web Mercator. Applying `A` in radar geometry means
holding the whole 432-megapixel scene, which does not fit the machines this pipeline runs on.

So instead this writes the LUT out **at its own tiny resolution** with the source's ground-control
points attached, scaled into the small grid's coordinates. `gdalwarp -tps` can then project it onto
exactly the grid the imagery lands on, and the division happens there. The LUT is a smooth function of
range, so interpolating it from 649 columns loses nothing — the alternative resamples the same surface
through a much more expensive route to reach the same numbers.
"""

import argparse
import sys
import xml.etree.ElementTree as ET

import numpy as np
from osgeo import gdal

gdal.UseExceptions()


def read_lut(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """`(lines, pixels, sigma)` — the calibration grid, as arrays."""
    root = ET.parse(path).getroot()
    vectors = root.findall(".//calibrationVector")
    if not vectors:
        raise SystemExit(f"{path}: no calibrationVector elements — is this a calibration annotation?")

    lines, rows, pixels = [], [], None
    for vector in vectors:
        line = vector.findtext("line")
        pixel_text = vector.findtext("pixel")
        sigma_text = vector.findtext("sigmaNought")
        if line is None or pixel_text is None or sigma_text is None:
            raise SystemExit("calibrationVector missing line/pixel/sigmaNought")
        columns = np.fromstring(pixel_text, sep=" ")
        sigma = np.fromstring(sigma_text, sep=" ")
        if pixels is None:
            pixels = columns
        # ⚠ Every vector is asserted to share one pixel grid rather than assumed to. The format does
        # not require it, and a ragged grid would silently shear the gain across the swath — a smooth,
        # entirely plausible error that no output would look wrong because of.
        elif columns.shape != pixels.shape or not np.array_equal(columns, pixels):
            raise SystemExit("calibrationVectors disagree about their pixel grid — cannot grid them")
        lines.append(float(line))
        rows.append(sigma)
    return np.asarray(lines), np.asarray(pixels), np.vstack(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("calibration", help="calibration-iw-*.xml")
    parser.add_argument("source", help="the GRD the GCPs come from (/vsicurl/ url is fine)")
    parser.add_argument("out", help="output GeoTIFF, GCP-referenced, one Float32 band")
    args = parser.parse_args()

    lines, pixels, sigma = read_lut(args.calibration)
    rows, cols = sigma.shape

    source = gdal.Open(args.source)
    gcps = source.GetGCPs()
    if not gcps:
        raise SystemExit(f"{args.source} carries no GCPs — a GRD in radar geometry should")
    src_w, src_h = source.RasterXSize, source.RasterYSize
    projection = source.GetGCPProjection()
    source = None

    # The LUT grid spans the source's full extent, so a GCP at source pixel `p` sits at column
    # `p / src_w * cols` here. Scaling the control points is what lets a 649x27 raster be warped by
    # the same transform as the image it calibrates.
    scaled = []
    for g in gcps:
        scaled.append(
            gdal.GCP(g.GCPX, g.GCPY, g.GCPZ, g.GCPPixel / src_w * cols, g.GCPLine / src_h * rows, g.Info, g.Id)
        )

    driver = gdal.GetDriverByName("GTiff")
    out = driver.Create(args.out, cols, rows, 1, gdal.GDT_Float32, options=["COMPRESS=DEFLATE"])
    out.SetGCPs(scaled, projection)
    out.GetRasterBand(1).WriteArray(sigma.astype(np.float32))
    out.GetRasterBand(1).FlushCache()
    out = None

    span_db = 20 * np.log10(sigma.max() / sigma.min())
    print(
        f"[sar-cal-lut] {rows}x{cols} grid, sigmaNought {sigma.min():.1f}–{sigma.max():.1f} "
        f"({span_db:.2f} dB across the scene) -> {args.out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
