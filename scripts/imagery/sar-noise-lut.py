#!/usr/bin/env python3
"""Turn Sentinel-1's noise annotation into a raster that can be warped (N6e PR 2, §C1).

    sar-noise-lut.py <noise.xml> <grd-url-or-path> <out.tif> [--calibration cal.xml]

Sibling of `sar-cal-lut.py`, and it writes the same shape of artifact for the same reason: a small
GCP-referenced raster that `gdalwarp -tps` can put on the imagery's grid.

## What thermal noise is, and why it lands on exactly the pixels this archive cares about

A GRD's digital numbers are **signal plus the instrument's own noise**. Calibration converts DN to
`sigma0`; it does not remove the noise, so what comes out is

    measured = true + NESZ          (in linear power, not decibels)

**NESZ is the noise-equivalent sigma0 — the brightness the sensor reports for a target that returns
nothing.** Measured on real annotations, VH:

    S1A   median -25.15 dB   p75 -23.85   worst across swath -21.84
    S1C   median -27.96 dB   p75 -26.67   worst across swath -25.04

⚠ **Our lakes measure −20 to −22 dB.** That is three to five decibels above the floor, and at the far
edge of an S1A swath the floor *reaches* −21.8 dB. The bias is compressive and it is worst where the
signal is darkest:

    true -22 dB  ->  measured -20.29   (+1.71)
    true -26 dB  ->  measured -22.55   (+3.45)

Which is precisely backwards for this archive. Smooth, specular ice — the dark tail, the entire premise
of [N6g](../../plans/phase-N6g-imagery-research.md)'s black-ice lane — is the part the noise floor
corrupts most. Without this correction, `sigma0Hist`'s dark bins hold instrument noise rather than
smooth ice, and "40% of this lake sat below −22 dB" is a statement about the sensor.

## ⚠ It is also a prime suspect for the S1A/S1C disagreement that halves the cadence

**S1C's noise floor is 2.80 dB quieter than S1A's.** Left in, that produces a *platform-dependent*
bias on dark targets: on a lake at a true −22 dB it predicts **−0.73 dB** between the two. The archive
measures an S1A−S1C offset of **−0.52 dB ascending** (`sar-cal-lut.py`, and N6e open question 7).

That is close enough to be worth testing rather than assumed, and the test is cheap: denoise, then
re-measure the offset. If it collapses, platforms can be pooled and a lake gets a 6-day look instead of
a 12-day one — which is the difference the phase doc says freeze-up happens on the timescale of.

## The two LUTs, and why the total is their product

IPF ≥ 2.9 splits the noise into a range profile and an azimuth scaling:

* **`noiseRangeVectorList`** — the shape across the swath, on the same sparse grid the calibration LUT
  uses (measured: 27 lines x 652 samples, one shared pixel grid).
* **`noiseAzimuthVectorList`** — one vector **per sub-swath** (IW1/IW2/IW3), each covering a block of
  range samples, scaling the profile along track. Measured values run 1.000–1.137, so it is a modest
  multiplier on top of the range term rather than a second big one.

    noise(x, y) = noiseRangeLut(x, y) x noiseAzimuthLut(y, subswath containing x)

⚠ **The sub-swath boundaries are why the azimuth term cannot be skipped as "small".** It is
discontinuous at the seams between IW1/IW2/IW3, so dropping it leaves steps *across* a wide scene —
and a step that falls inside a big lake reads as ice structure rather than as an instrument boundary.
"""

import argparse
import sys
import xml.etree.ElementTree as ET

import numpy as np
from osgeo import gdal

gdal.UseExceptions()


def read_range_lut(root: ET.Element) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """`(lines, pixels, noise)` — the range noise grid, as arrays."""
    vectors = root.findall(".//noiseRangeVectorList/noiseRangeVector")
    if not vectors:
        raise SystemExit("no noiseRangeVector elements — is this a noise annotation?")

    lines, rows, pixels = [], [], None
    for vector in vectors:
        columns = np.fromstring(vector.findtext("pixel", ""), sep=" ")
        lut = np.fromstring(vector.findtext("noiseRangeLut", ""), sep=" ")
        if columns.size == 0 or lut.size != columns.size:
            raise SystemExit("noiseRangeVector missing or ragged pixel/noiseRangeLut")
        if pixels is None:
            pixels = columns
        # Asserted rather than assumed, exactly as `sar-cal-lut.py` does: a ragged grid would shear
        # the noise floor across the swath, which is smooth, plausible, and invisible in the output.
        elif not np.array_equal(columns, pixels):
            raise SystemExit("noiseRangeVectors disagree about their pixel grid — cannot grid them")
        lines.append(float(vector.findtext("line", "0")))
        rows.append(lut)
    return np.asarray(lines), np.asarray(pixels), np.vstack(rows)


def azimuth_scaling(root: ET.Element, lines: np.ndarray, pixels: np.ndarray) -> np.ndarray:
    """The per-sub-swath azimuth multiplier, evaluated on the range grid.

    Returns ones where no vector covers a cell — a missing block is a reason to leave the range term
    alone, never a reason to invent a scaling for it.
    """
    scaling = np.ones((lines.size, pixels.size), dtype=np.float64)
    vectors = root.findall(".//noiseAzimuthVectorList/noiseAzimuthVector")
    if not vectors:
        # IPF < 2.9 carries no azimuth term at all. The range LUT is then the whole noise.
        print("[sar-noise-lut] no azimuth vectors — range term only", file=sys.stderr)
        return scaling

    covered = np.zeros_like(scaling, dtype=bool)
    for vector in vectors:
        lut = np.fromstring(vector.findtext("noiseAzimuthLut", ""), sep=" ")
        at = np.fromstring(vector.findtext("line", ""), sep=" ")
        if lut.size == 0 or at.size != lut.size:
            continue
        first_sample = int(vector.findtext("firstRangeSample", "0"))
        last_sample = int(vector.findtext("lastRangeSample", "0"))
        first_line = float(vector.findtext("firstAzimuthLine", "0"))
        last_line = float(vector.findtext("lastAzimuthLine", "0"))

        in_range = (pixels >= first_sample) & (pixels <= last_sample)
        in_azimuth = (lines >= first_line) & (lines <= last_line)
        if not in_range.any() or not in_azimuth.any():
            continue
        # `np.interp` clamps outside the vector's own line span, which is what we want at the ends.
        column = np.interp(lines[in_azimuth], at, lut)
        scaling[np.ix_(in_azimuth, in_range)] = column[:, None]
        covered[np.ix_(in_azimuth, in_range)] = True

    if not covered.all():
        print(
            f"[sar-noise-lut] {(~covered).sum()} of {covered.size} grid cells have no azimuth "
            "vector — left at 1.0",
            file=sys.stderr,
        )
    return scaling


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("noise", help="noise-iw-*.xml")
    parser.add_argument("source", help="the GRD the GCPs come from (/vsicurl/ url is fine)")
    parser.add_argument("out", help="output GeoTIFF, GCP-referenced, one Float32 band")
    parser.add_argument(
        "--calibration",
        help="calibration-iw-*.xml — only to report NESZ in dB, never used in the output",
    )
    args = parser.parse_args()

    root = ET.parse(args.noise).getroot()
    lines, pixels, noise = read_range_lut(root)
    noise = noise * azimuth_scaling(root, lines, pixels)
    rows, cols = noise.shape

    source = gdal.Open(args.source)
    gcps = source.GetGCPs()
    if not gcps:
        raise SystemExit(f"{args.source} carries no GCPs — a GRD in radar geometry should")
    src_w, src_h = source.RasterXSize, source.RasterYSize
    projection = source.GetGCPProjection()
    source = None

    # Same GCP rescaling as the calibration LUT: the grid spans the source's full extent, so a control
    # point at source pixel `p` sits at column `p / src_w * cols` here.
    scaled = [
        gdal.GCP(
            g.GCPX, g.GCPY, g.GCPZ,
            g.GCPPixel / src_w * cols, g.GCPLine / src_h * rows, g.Info, g.Id,
        )
        for g in gcps
    ]

    driver = gdal.GetDriverByName("GTiff")
    out = driver.Create(args.out, cols, rows, 1, gdal.GDT_Float32, options=["COMPRESS=DEFLATE"])
    out.SetGCPs(scaled, projection)
    out.GetRasterBand(1).WriteArray(noise.astype(np.float32))
    out.GetRasterBand(1).FlushCache()
    out = None

    report = f"[sar-noise-lut] {rows}x{cols} grid, noise power {noise.min():.1f}–{noise.max():.1f}"
    if args.calibration:
        cal = ET.parse(args.calibration).getroot().find(".//calibrationVector")
        cpix = np.fromstring(cal.findtext("pixel", ""), sep=" ")
        csig = np.fromstring(cal.findtext("sigmaNought", ""), sep=" ")
        gain = np.interp(pixels, cpix, csig)
        with np.errstate(divide="ignore", invalid="ignore"):
            nesz = 10 * np.log10(noise / gain**2)
        nesz = nesz[np.isfinite(nesz)]
        if nesz.size:
            report += (
                f"; NESZ {np.percentile(nesz, 25):.2f}/{np.median(nesz):.2f}/"
                f"{np.percentile(nesz, 75):.2f} dB (p25/median/p75)"
            )
    print(f"{report} -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
