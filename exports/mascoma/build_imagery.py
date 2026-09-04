#!/usr/bin/env python3
"""
Mascoma Lake, 22 December 2025 — the freeze-up frame, as a transparent PNG on the SVG's canvas.

Source: `S2B_18TYP_20251222_0_L2A-visual.pmtiles` from the N6e freeze-up archive
(`VITE_IMAGERY_ARCHIVE_URL`), season `winter-2025-26`. Sentinel-2B, 2025-12-22T15:50:59Z, 2.9% cloud.

**The feather is already in the pixels.** The archive bakes its own alpha server-side —
`featherMeters: 240`, `erosionMeters: 20`, via the cutter's `feather_proximity` stage (`SENTINEL_MASK_METERS`,
which is 60/240 and *not* the aerial tier's 20/80: at a 10 m ground sample a 20 m buffer is two
pixels, so the aerial numbers would read as a hard edge). So this script does not compute a feather.
It mosaics the tiles, resamples onto the SVG's frame, and optionally narrows the reveal to Mascoma.

Frame and canvas sizes are identical to `build_svg.py`, so the PNG drops straight under the SVG.

  python3 build_imagery.py              # both presets, Mascoma only
  python3 build_imagery.py --all-bodies # every revealed body in frame (the app's viewport-wide look)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess

import numpy as np
from osgeo import gdal, ogr

gdal.UseExceptions()

ROOT = "/Users/teagan/Code/skating"
HERE = os.path.join(ROOT, "exports/mascoma")
SRC = os.path.join(HERE, "src")
ARCHIVE = os.path.join(SRC, "mascoma-visual.pmtiles")
BODY = os.path.join(SRC, "mascoma-body.json")

CAPTURED = "20251222"
BUFFER_MILES = 3.0
ZOOM = 14                      # the archive's max zoom
TILE_PX = 256

# Matches build_svg.py's PRESETS: (name, lake width px).
PRESETS = [("mobile", 400), ("desktop", 1000)]

# How far past Mascoma's own shoreline the single-body clip reaches, in ground metres. Must clear
# the baked feather (240 m) or we would cut into the gradient the archive just spent a stage making.
CLIP_REACH_M = 360.0
CLIP_SOFTEN_M = 60.0           # soften that cut, so a neighbour poking in does not end on a hard line

R = 6378137.0
WORLD = 2 * math.pi * R


def lonlat_to_3857(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def deg_per_metre(lat):
    p = math.radians(lat)
    return (111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p),
            111412.84 * math.cos(p) - 93.5 * math.cos(3 * p))


# ── Frame: identical arithmetic to build_svg.py ──────────────────────────────────────────────
body = json.load(open(BODY))["body"]
bb = body["bbox"]
mid_lat = (bb["minLat"] + bb["maxLat"]) / 2
mlat, mlon = deg_per_metre(mid_lat)
pad = BUFFER_MILES * 1609.344

MIN_LNG, MAX_LNG = bb["minLng"] - pad / mlon, bb["maxLng"] + pad / mlon
MIN_LAT, MAX_LAT = bb["minLat"] - pad / mlat, bb["maxLat"] + pad / mlat
X0, Y0 = lonlat_to_3857(MIN_LNG, MIN_LAT)
X1, Y1 = lonlat_to_3857(MAX_LNG, MAX_LAT)
SPAN_X, SPAN_Y = X1 - X0, Y1 - Y0
LAKE_SPAN_X = R * math.radians(bb["maxLng"] - bb["minLng"])

# Mercator inflates distance by 1/cos(lat); a ground metre is fewer 3857 units than it looks.
GROUND_TO_MERC = 1.0 / math.cos(math.radians(mid_lat))


# ── Mosaic the z14 tiles that cover the frame ────────────────────────────────────────────────

def tile_span(z):
    return WORLD / (2 ** z)


def mosaic():
    ts = tile_span(ZOOM)
    n = 2 ** ZOOM
    tx0 = max(0, int((X0 + WORLD / 2) // ts))
    tx1 = min(n - 1, int((X1 + WORLD / 2) // ts))
    ty0 = max(0, int((WORLD / 2 - Y1) // ts))
    ty1 = min(n - 1, int((WORLD / 2 - Y0) // ts))
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    print(f"  mosaic {cols}x{rows} tiles at z{ZOOM} "
          f"({cols * TILE_PX}x{rows * TILE_PX}px, {ts / TILE_PX:.2f} m/px in 3857)")

    buf = np.zeros((rows * TILE_PX, cols * TILE_PX, 4), dtype=np.uint8)
    got = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            out = subprocess.run(["pmtiles", "tile", ARCHIVE, str(ZOOM), str(tx), str(ty)],
                                 capture_output=True)
            if out.returncode != 0 or not out.stdout:
                continue          # a tile the granule never covered: leave it transparent
            vp = f"/vsimem/t_{ZOOM}_{tx}_{ty}.webp"
            gdal.FileFromMemBuffer(vp, out.stdout)
            try:
                ds = gdal.Open(vp)
                arr = ds.ReadAsArray()          # (bands, h, w)
                ds = None
                if arr is None:
                    continue
                if arr.ndim == 2:
                    arr = np.stack([arr] * 3 + [np.full_like(arr, 255)])
                if arr.shape[0] == 3:
                    arr = np.concatenate([arr, np.full((1,) + arr.shape[1:], 255, np.uint8)])
                r0 = (ty - ty0) * TILE_PX
                c0 = (tx - tx0) * TILE_PX
                buf[r0:r0 + TILE_PX, c0:c0 + TILE_PX] = np.transpose(arr[:4], (1, 2, 0))
                got += 1
            finally:
                gdal.Unlink(vp)
    print(f"  {got} tiles with pixels, {cols * rows - got} empty")

    gt = (-WORLD / 2 + tx0 * ts, ts / TILE_PX, 0,
          WORLD / 2 - ty0 * ts, 0, -ts / TILE_PX)
    return buf, gt


def to_mem(arr, gt):
    h, w, b = arr.shape
    ds = gdal.GetDriverByName("MEM").Create("", w, h, b, gdal.GDT_Byte)
    ds.SetGeoTransform(gt)
    ds.SetProjection('EPSG:3857')
    srs = gdal.osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    ds.SetProjection(srs.ExportToWkt())
    for i in range(b):
        ds.GetRasterBand(i + 1).WriteArray(arr[:, :, i])
    return ds


def box_blur(a, radius):
    """Separable box blur via cumulative sums — a stand-in for a gaussian, no scipy needed."""
    if radius < 1:
        return a
    k = int(radius) * 2 + 1
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (int(radius) + 1, int(radius))
        p = np.pad(a, pad, mode="edge")
        c = np.cumsum(p, axis=axis, dtype=np.float64)
        if axis == 0:
            a = (c[k:, :] - c[:-k, :]) / k
        else:
            a = (c[:, k:] - c[:, :-k]) / k
    return a


def mascoma_clip(width, height):
    """A soft-edged selection around Mascoma, so neighbouring ponds drop out of the frame.

    Hard-edged at `CLIP_REACH_M` would be safe on distance alone — the nearest revealed water is
    over a kilometre off — but the outlet channel runs continuously off the lake's north-west tip,
    and a hard cut across it reads as a torn edge. Softening costs one blur.
    """
    poly = body["polygon"]
    polys = poly["coordinates"] if poly["type"] == "MultiPolygon" else [poly["coordinates"]]
    mp = ogr.Geometry(ogr.wkbMultiPolygon)
    for p in polys:
        og = ogr.Geometry(ogr.wkbPolygon)
        ring = ogr.Geometry(ogr.wkbLinearRing)          # outer ring only, as the mask does
        for c in p[0]:
            ring.AddPoint_2D(*lonlat_to_3857(c[0], c[1]))
        og.AddGeometry(ring)
        mp.AddGeometry(og)
    grown = mp.Buffer(CLIP_REACH_M * GROUND_TO_MERC)

    drv = ogr.GetDriverByName("Memory")
    src = drv.CreateDataSource("clip")
    srs = gdal.osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    lyr = src.CreateLayer("clip", srs=srs, geom_type=ogr.wkbPolygon)
    f = ogr.Feature(lyr.GetLayerDefn())
    f.SetGeometry(grown)
    lyr.CreateFeature(f)

    rast = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Byte)
    rast.SetGeoTransform((X0, SPAN_X / width, 0, Y1, 0, -SPAN_Y / height))
    rast.SetProjection(srs.ExportToWkt())
    gdal.RasterizeLayer(rast, [1], lyr, burn_values=[255])
    m = rast.ReadAsArray().astype(np.float32) / 255.0
    return np.clip(box_blur(m, max(1, round(CLIP_SOFTEN_M / (SPAN_X / width * math.cos(
        math.radians(mid_lat)))))), 0, 1)


ap = argparse.ArgumentParser()
ap.add_argument("--all-bodies", action="store_true",
                help="keep every revealed body in frame, not just Mascoma")
args = ap.parse_args()

print(f"frame {SPAN_X:.0f} x {SPAN_Y:.0f} (3857 m)")
raw, gt = mosaic()
native_w = SPAN_X / (tile_span(ZOOM) / TILE_PX)
print(f"  native frame resolution: {native_w:.0f} px wide")

# Premultiply before resampling. The archive's transparent pixels are not necessarily black, and
# resampling RGB independently of alpha drags whatever they hold into the fade as a dark fringe.
rgba = raw.astype(np.float32)
a = rgba[:, :, 3:4] / 255.0
rgba[:, :, :3] *= a
src_ds = to_mem(np.clip(rgba, 0, 255).astype(np.uint8), gt)

for name, lake_w in PRESETS:
    mpp = LAKE_SPAN_X / lake_w
    W, H = round(SPAN_X / mpp), round(SPAN_Y / mpp)
    alg = "lanczos" if W < native_w else "cubic"
    print(f"\n{name}: {W} x {H} px, lake {lake_w}px "
          f"({'down' if W < native_w else 'up'}sampling from {native_w:.0f}, {alg})")

    warped = gdal.Warp("", src_ds, format="MEM", outputBounds=(X0, Y0, X1, Y1),
                       width=W, height=H, resampleAlg=alg, dstAlpha=False)
    out = warped.ReadAsArray().astype(np.float32)      # (4, H, W)
    out = np.transpose(out, (1, 2, 0))

    alpha = out[:, :, 3:4] / 255.0
    if not args.all_bodies:
        alpha = alpha * mascoma_clip(W, H)[:, :, None]
    rgb = np.divide(out[:, :, :3], np.where(alpha > 0, alpha, 1),
                    out=np.zeros_like(out[:, :, :3]), where=alpha > 0)

    final = np.concatenate([np.clip(rgb, 0, 255), np.clip(alpha * 255, 0, 255)], axis=2)
    final = final.astype(np.uint8)

    mem = gdal.GetDriverByName("MEM").Create("", W, H, 4, gdal.GDT_Byte)
    for i in range(4):
        mem.GetRasterBand(i + 1).WriteArray(final[:, :, i])
    mem.GetRasterBand(4).SetColorInterpretation(gdal.GCI_AlphaBand)

    suffix = "-allbodies" if args.all_bodies else ""
    path = os.path.join(HERE, f"mascoma-ice-{CAPTURED}-{name}{suffix}.png")
    gdal.GetDriverByName("PNG").CreateCopy(path, mem)
    cover = float((final[:, :, 3] > 0).mean()) * 100
    print(f"  {os.path.basename(path):40s} {os.path.getsize(path) / 1024:7.0f} KB, "
          f"{cover:.1f}% of canvas has pixels")
