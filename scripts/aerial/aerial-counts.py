#!/usr/bin/env python3
"""What each frame supplies to one cell (B05 §2.2 step 4, D318) — the date index's input — and
where a frame must be drawn that the counts' grid can't see.

    aerial-counts.py <job.json>

The job (`cut-aerial.sh`'s `count_cell` writes it): `frames`, the cell's frames **in the rule's
order, the pick first**, each `{ id, alpha, src }` — its alpha warped to the counts' grid (pixel
zoom 16) over the cell's `countWindow` (its counted pixels and a ring of one more, `pad`), and its
source for a read at the deepest zoom; `extent` and `res`, the cell's pixels on the deepest zoom's
grid; `warp`, the deepest zoom's warp settings; and where to write `counts` and `windows`.

**The counts.** A frame's count is the number of the cell's counted pixels (the ring is not counted)
where its alpha is set **and every frame before it is empty** — so a fallback under a pick that
covers the cell counts zero, and a frame that shows through a hole counts exactly the hole. Any
pixel counts. Writes `{ "<itemId>": <count>, ... }`, every frame named (zeros included;
`tilesPack.ts` drops them).

**The strip the counts' grid can't see.** A counts' pixel is about 2.4 m; its alpha is a sample at
its center. Where an upper frame's data stops between two centers — short of the cell's edge, or at
a seam with another — the deepest zoom (0.6 m) has pixels that no frame above fills, and the frame
below that would fill them counts zero and would never be drawn: a transparent strip up to four
deepest-zoom pixels wide. So, per frame that counts zero, the **band** where it might: counts'
pixels within one of its own data and within two of the edge of every shown frame above it (an
eroded alpha, the ring read rather than guessed, so a frame that runs past the cell is no edge).
Over that band only, the frame and the shown frames above it are warped at the deepest zoom with
`cut-aerial.sh`'s own arguments, and wherever it has a pixel none of them has, it supplies the cell:
its count is those pixels in counts' units (at least one), and it is drawn **only in the band's
windows** (`windows`: `{ "<itemId>": [[minX, minY, maxX, maxY], ...] }`, written only when some
frame has one), so it is read only there. A band is usually empty — where a pick covers its cell
with its 300 m of overlap, there is no edge at all — and a check, when there is one, reads a few
megabytes of source along it.

Python because the image already carries GDAL's bindings and numpy (the winter cutter's
`zonal-clear.py` uses the same), and this is a sweep over a few small arrays — a cross-tabulation
the GDAL CLI has no command for. It is exercised by `proofs/warp-proof.sh` on real frames, which
mutation-checks the stack-order rule, and by `src/aerialCounts.test.ts` on synthetic ones where GDAL
is installed; CI runs no Python.
"""

import json
import math
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

# The band: within this many counts' pixels of a shown frame's edge, and of the frame's own data.
EDGE = 2
NEAR = 1
# The band's windows: at most this many counts' pixels a side (about 1.2 km), each its own warp.
BLOCK = 512


def shifted_all(mask, r):
    """Erode `mask` by `r` pixels (a square), the outside replicating the edge."""
    p = np.pad(mask, r, mode="edge")
    out = np.ones_like(mask)
    h, w = mask.shape
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            out &= p[dy : dy + h, dx : dx + w]
    return out


def shifted_any(mask, r):
    """Dilate `mask` by `r` pixels (a square)."""
    p = np.pad(mask, r, mode="constant", constant_values=False)
    out = np.zeros_like(mask)
    h, w = mask.shape
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            out |= p[dy : dy + h, dx : dx + w]
    return out


def deep_alpha(src, box, res, warp):
    """The frame's alpha on the deepest zoom's grid over `box` — `cut-aerial.sh`'s `warp`, in memory."""
    opts = ["-of", "MEM", "-t_srs", "EPSG:3857", "-te", *(repr(float(v)) for v in box),
            "-tr", repr(float(res)), repr(float(res)),
            "-srcnodata", warp["srcNodata"], "-wo", "UNIFIED_SRC_NODATA=YES"]
    for b in warp["bands"]:
        opts += ["-srcband", str(b)]
    opts += ["-dstalpha", "-r", warp["resampling"]]
    ds = gdal.Warp("", src, options=opts)
    return ds.GetRasterBand(len(warp["bands"]) + 1).ReadAsArray() > 0


def inside(box, within):
    """`box` clipped to `within`, or None."""
    x0, y0 = max(box[0], within[0]), max(box[1], within[1])
    x1, y1 = min(box[2], within[2]), min(box[3], within[3])
    return (x0, y0, x1, y1) if x0 < x1 and y0 < y1 else None


def main(argv):
    if len(argv) != 2:
        print("usage: aerial-counts.py <job.json>", file=sys.stderr)
        return 64
    job = json.load(open(argv[1]))
    frames, pad, res, extent = job["frames"], int(job["pad"]), float(job["res"]), job["extent"]
    if len({f["id"] for f in frames}) != len(frames):
        print("aerial-counts: a frame is given twice", file=sys.stderr)
        return 64

    alphas, gt, shape = [], None, None
    for f in frames:
        ds = gdal.Open(f["alpha"])
        alpha = ds.GetRasterBand(1).ReadAsArray() > 0
        if shape is None:
            shape, gt = alpha.shape, ds.GetGeoTransform()
        elif alpha.shape != shape:
            print(f"aerial-counts: {f['alpha']} is {alpha.shape}, the first was {shape}", file=sys.stderr)
            return 1
        alphas.append(alpha)
    h, w = shape
    inner = np.zeros(shape, dtype=bool)
    inner[pad : h - pad, pad : w - pad] = True

    # The counts, on the counted pixels: each frame only where nothing above it already has.
    counts, taken = {}, np.zeros(shape, dtype=bool)
    for f, alpha in zip(frames, alphas):
        counts[f["id"]] = int((alpha & ~taken & inner).sum())
        taken |= alpha

    # Which counts' pixels hold some of the cell's deepest-zoom pixels (the ring may, in part).
    cx, cy = gt[1], -gt[5]
    def box_of(r0, c0, r1, c1):
        return (gt[0] + c0 * cx, gt[3] - r1 * cy, gt[0] + c1 * cx, gt[3] - r0 * cy)
    cols = np.array([inside(box_of(0, c, 1, c + 1), (extent[0], -1e18, extent[2], 1e18)) is not None
                     for c in range(w)])
    rows = np.array([inside(box_of(r, 0, r + 1, 1), (-1e18, extent[1], 1e18, extent[3])) is not None
                     for r in range(h)])
    cell = rows[:, None] & cols[None, :]

    # The strips: per frame that counts zero, below the frames that show.
    windows = {}
    shown_full = []  # the frames drawn so far, above the next: (index, its windows or None)
    covered = np.zeros(shape, dtype=bool)  # where a shown frame's data surely covers, eroded
    for k, (f, alpha) in enumerate(zip(frames, alphas)):
        if counts[f["id"]] > 0:
            shown_full.append((k, None))
            covered |= shifted_all(alpha, EDGE)
            continue
        band = shifted_any(alpha, NEAR) & ~covered & cell
        if not band.any():
            continue
        found, n = [], 0
        for r0 in range(0, h, BLOCK):
            for c0 in range(0, w, BLOCK):
                sub = band[r0 : r0 + BLOCK, c0 : c0 + BLOCK]
                if not sub.any():
                    continue
                rr, cc = np.nonzero(sub)
                win = inside(box_of(r0 + rr.min(), c0 + cc.min(), r0 + rr.max() + 1, c0 + cc.max() + 1), extent)
                if win is None:
                    continue
                mine = deep_alpha(f["src"], win, res, job["warp"])
                above = np.zeros_like(mine)
                for j, wins in shown_full:
                    if wins is None:
                        above |= deep_alpha(frames[j]["src"], win, res, job["warp"])
                        continue
                    for b in wins:
                        part = inside(b, win)
                        if part is None:
                            continue
                        a = deep_alpha(frames[j]["src"], part, res, job["warp"])
                        oy = round((win[3] - part[3]) / res)
                        ox = round((part[0] - win[0]) / res)
                        above[oy : oy + a.shape[0], ox : ox + a.shape[1]] |= a
                supplied = int((mine & ~above).sum())
                if supplied > 0:
                    found.append([float(v) for v in win])
                    n += supplied
        if n > 0:
            # In counts' pixels, at least one: a frame that supplies a pixel is a date the cell shows.
            counts[f["id"]] = max(1, math.ceil(n * (res / cx) ** 2))
            windows[f["id"]] = found
            shown_full.append((k, [tuple(b) for b in found]))
            # Drawn only in its windows, it covers only there for the frames below it.
            mask = np.zeros(shape, dtype=bool)
            for b in found:
                c0, c1 = math.floor((b[0] - gt[0]) / cx + 1e-9), math.ceil((b[2] - gt[0]) / cx - 1e-9)
                r0, r1 = math.floor((gt[3] - b[3]) / cy + 1e-9), math.ceil((gt[3] - b[1]) / cy - 1e-9)
                mask[max(r0, 0) : r1, max(c0, 0) : c1] = True
            covered |= shifted_all(alpha, EDGE) & mask

    with open(job["counts"], "w") as fh:
        json.dump(counts, fh)
        fh.write("\n")
    if windows:
        with open(job["windows"], "w") as fh:
            json.dump(windows, fh)
            fh.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
