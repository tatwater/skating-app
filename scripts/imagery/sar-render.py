#!/usr/bin/env python3
"""Turn calibrated radar backscatter into a picture (N6e PR 2, §C1).

    sar-render.py <dn.tif> <a.tif> <out.tif> [--min-db -30] [--max-db 0]

## ⚠ The stretch is FIXED, and that is the whole design

`sigma0` is a physical quantity with no natural colour, so any image of it is a choice of mapping from
decibels to grey. The tempting choice is a per-scene stretch — take each pass's own minimum and
maximum and spread them across the full range — because it makes every individual frame look its best.

**It would also destroy the archive's only purpose.** A freeze-up scrubber exists to compare *dates*.
Normalising each frame to its own extremes makes every frame look about the same and hides exactly the
between-date change the whole thing was built to show: a lake that darkened by 2 dB when it froze
would be re-brightened by the stretch, and the difference would vanish into the rendering.

So the mapping is a constant. −30 dB to 0 dB spans open water (dark) through bright land at C-band, it
is the same on every frame in every season, and two frames a month apart can be compared by eye
because the same grey means the same backscatter.

## What this does not do

**It does not decide anything.** The grey is a picture; the measurement is `sar-zonal.py`'s per-body
`sigma0`, computed from the same two rasters before either was stretched to eight bits. Nothing
downstream should read pixels back out of this to recover a number — the numbers already exist, at
full precision, in the manifest.

Windowed, so memory stays flat in the size of a pass (a slice is ~175 megapixels at native
resolution).
"""

import argparse
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

ROWS_PER_WINDOW = 512


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("dn")
    parser.add_argument("gain")
    parser.add_argument("out")
    parser.add_argument("--min-db", type=float, default=-30.0)
    parser.add_argument("--max-db", type=float, default=0.0)
    args = parser.parse_args()

    dn_ds = gdal.Open(args.dn)
    gain_ds = gdal.Open(args.gain)
    width, height = dn_ds.RasterXSize, dn_ds.RasterYSize
    if (gain_ds.RasterXSize, gain_ds.RasterYSize) != (width, height):
        print(
            f"grid mismatch: gain is {gain_ds.RasterXSize}x{gain_ds.RasterYSize}, "
            f"image is {width}x{height}",
            file=sys.stderr,
        )
        return 1
    if args.max_db <= args.min_db:
        print("--max-db must exceed --min-db", file=sys.stderr)
        return 1

    driver = gdal.GetDriverByName("GTiff")
    out_ds = driver.Create(args.out, width, height, 1, gdal.GDT_Byte, options=["COMPRESS=DEFLATE", "TILED=YES"])
    out_ds.SetGeoTransform(dn_ds.GetGeoTransform())
    out_ds.SetProjection(dn_ds.GetProjection())

    dn_band, gain_band, out_band = (
        dn_ds.GetRasterBand(1),
        gain_ds.GetRasterBand(1),
        out_ds.GetRasterBand(1),
    )
    span = args.max_db - args.min_db

    for y in range(0, height, ROWS_PER_WINDOW):
        rows = min(ROWS_PER_WINDOW, height - y)
        dn = dn_band.ReadAsArray(0, y, width, rows).astype(np.float32)
        gain = gain_band.ReadAsArray(0, y, width, rows).astype(np.float32)
        usable = (dn > 0) & (gain > 0)
        grey = np.zeros(dn.shape, np.uint8)
        if usable.any():
            sigma0 = (dn[usable] / gain[usable]) ** 2
            db = 10 * np.log10(sigma0)
            scaled = np.clip((db - args.min_db) / span, 0, 1)
            # 1..255, reserving 0 for "no data". Otherwise the darkest genuine water is
            # indistinguishable from outside the swath, and the alpha channel is the only thing left
            # saying which — a distinction the black-lake bug already cost us once on the optical side.
            grey[usable] = (1 + scaled * 254).astype(np.uint8)
        out_band.WriteArray(grey, 0, y)

    out_band.SetNoDataValue(0)
    out_band.FlushCache()
    out_ds = None
    print(f"[sar-render] {width}x{height}, {args.min_db:.0f}..{args.max_db:.0f} dB -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
