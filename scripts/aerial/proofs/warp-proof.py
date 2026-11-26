#!/usr/bin/env python3
"""The warp proof's assertions and measurements (B05 §7.3), over `warp-proof.sh`'s work dirs.

    warp-proof.py <windows.json> <run dir> <report.json>

For each window, against the worker's kept intermediates (`cut-aerial --keep`):

- **tiling** — the cells' pixel extents partition the window: none overlaps another, none is left
  out;
- **cut** — every warp in the mosaic lies inside its own cell's extent, and none of its pixels lies
  outside it: no frame paints a neighbor;
- **coverage** — the mosaic's alpha is set on every pixel of the window the cells cover;
- **fall-through** (a window with a partial pick) — wherever the pick has a pixel the mosaic shows
  the pick, and wherever it hasn't the mosaic shows the fallback, and the fallback shows somewhere;
- **counts** — the frames the done record counts for each cell are exactly the frames visible on
  the deepest zoom's mosaic, with shares within two points of what is visible;
- **seams** — at each flight join, the two cells' frames, warped past the join into each other's
  ~300 m overlap, registered by phase correlation: a road crossing the join is continuous to within
  a pixel when the offset is at most one pixel each way;

and the measurements: time per step, source bytes, output tiles and bytes per zoom. Exits 1 if any
assertion fails. Reads the COGs again (the seam strips only) with the SAS token in the environment.
"""

import json
import math
import os
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

ORIGIN = -20037508.342789244


def read(path, bands=None):
    ds = gdal.Open(path)
    arr = ds.ReadAsArray() if bands is None else np.stack([ds.GetRasterBand(b).ReadAsArray() for b in bands])
    return ds, arr


def extent_px(extent, res):
    """An extent's pixel columns and rows on the grid, [x0, x1) and [y0, y1) from the origin."""
    return (
        round((extent[0] - ORIGIN) / res),
        round((extent[2] - ORIGIN) / res),
        round((extent[1] - ORIGIN) / res),
        round((extent[3] - ORIGIN) / res),
    )


def ds_extent(ds):
    gt = ds.GetGeoTransform()
    return [gt[0], gt[3] + gt[5] * ds.RasterYSize, gt[0] + gt[1] * ds.RasterXSize, gt[3]]


def phase_offset(a, b):
    """The (dx, dy) shift of b against a, in pixels, by phase correlation with a parabolic peak."""
    a = a - a.mean()
    b = b - b.mean()
    win = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    fa = np.fft.fft2(a * win)
    fb = np.fft.fft2(b * win)
    r = fa * np.conj(fb)
    r /= np.abs(r) + 1e-12
    c = np.fft.ifft2(r).real
    py, px = np.unravel_index(np.argmax(c), c.shape)

    def sub(cm, c0, cp):
        d = cm - 2 * c0 + cp
        return 0.0 if d == 0 else 0.5 * (cm - cp) / d

    h, w = c.shape
    dy = py + sub(c[(py - 1) % h, px], c[py, px], c[(py + 1) % h, px])
    dx = px + sub(c[py, (px - 1) % w], c[py, px], c[py, (px + 1) % w])
    if dy > h / 2:
        dy -= h
    if dx > w / 2:
        dx -= w
    peak = float(c[py, px])
    return float(dx), float(dy), peak


def ncc_shift(p, q, max_shift=8):
    """The shift of profile q against p maximizing normalized cross-correlation, sub-pixel."""
    best = (-2.0, 0)
    scores = {}
    for d in range(-max_shift, max_shift + 1):
        a = p[max(0, d) : len(p) + min(0, d)]
        b = q[max(0, -d) : len(q) + min(0, -d)]
        a = a - a.mean()
        b = b - b.mean()
        den = math.sqrt(float((a * a).sum() * (b * b).sum())) or 1.0
        scores[d] = float((a * b).sum()) / den
        if scores[d] > best[0]:
            best = (scores[d], d)
    peak, d = best
    if -max_shift < d < max_shift:
        cm, c0, cp = scores[d - 1], scores[d], scores[d + 1]
        den = cm - 2 * c0 + cp
        d = d + (0.5 * (cm - cp) / den if den != 0 else 0.0)
    return float(d), peak


def register(a, b, res, block=512, min_peak=0.6):
    """Register the two flights over the same ground — the strip both frames cover past the join —
    by their profiles: a straight feature crossing the join (a road, a hedgerow, a shore) is a step
    in the along-join profile (rows averaged across the strip) and must sit at the same row in both;
    the across-join profile does the same for the other axis. Block by block down the strip; the
    median of the blocks whose correlation is clear. Tone and season differ between flights, which
    is why profiles of edges and not a 2-D correlation of texture."""
    def norm(x):
        return (x - x.mean()) / (x.std() or 1.0)

    dys, dxs = [], []
    for y0 in range(0, a.shape[0] - block + 1, block):
        pa, pb = a[y0 : y0 + block], b[y0 : y0 + block]
        dy, py = ncc_shift(norm(pa.mean(axis=1)), norm(pb.mean(axis=1)))
        dx, px = ncc_shift(norm(pa.mean(axis=0)), norm(pb.mean(axis=0)))
        if py >= min_peak:
            dys.append(dy)
        if px >= min_peak:
            dxs.append(dx)
    med = lambda v: round(float(np.median(v)), 2) if v else None
    return {"dx_px": med(dxs), "dy_px": med(dys), "confident_blocks": min(len(dys), len(dxs)),
            "blocks": a.shape[0] // block, "dx_blocks": len(dxs), "dy_blocks": len(dys)}


def save_seam_png(rgb, col, path, half=256):
    """A 512-px crop of the mosaic centered on the join, for a person to look at."""
    h = rgb.shape[1]
    x0 = max(0, col - half)
    y0 = max(0, h // 2 - half)
    crop = rgb[:, y0 : y0 + 2 * half, x0 : x0 + 2 * half]
    drv = gdal.GetDriverByName("MEM").Create("", crop.shape[2], crop.shape[1], 3, gdal.GDT_Byte)
    for i in range(3):
        drv.GetRasterBand(i + 1).WriteArray(crop[i])
    gdal.GetDriverByName("PNG").CreateCopy(path, drv)


def main(argv):
    windows = json.load(open(argv[1]))["windows"]
    run = argv[2]
    report = {"windows": [], "failures": []}

    def check(name, ok, detail):
        entry = {"check": name, "ok": bool(ok), "detail": detail}
        cur["checks"].append(entry)
        if not ok:
            report["failures"].append(f"{cur['name']}: {name}: {detail}")

    only = os.environ.get("ONLY")
    for spec in windows:
        name = spec["name"]
        if only and name != only:
            continue
        wdir = os.path.join(run, "work", name)
        unit = json.load(open(os.path.join(run, "units", f"{name}.json")))
        cur = {"name": name, "window": unit["window"], "checks": []}
        res = unit["resolution"]
        wx0, wx1, wy0, wy1 = extent_px(unit["bounds"], res)
        width, height = wx1 - wx0, wy1 - wy0

        # tiling: the cells' extents partition the window.
        cells = {c["key"]: c for c in unit["cells"]}
        counts_in = np.zeros((height, width), dtype=np.int16)
        for c in unit["cells"]:
            x0, x1, y0, y1 = extent_px(c["extent"], res)
            counts_in[wy1 - y1 : wy1 - y0, x0 - wx0 : x1 - wx0] += 1
        check("tiling", int((counts_in > 1).sum()) == 0 and int((counts_in == 0).sum()) == 0,
              f"{int((counts_in > 1).sum())} pixels in two cells, {int((counts_in == 0).sum())} in none")
        cell_index = {c["key"]: i for i, c in enumerate(unit["cells"], start=1)}
        cell_of_px = np.zeros((height, width), dtype=np.int16)
        for c in unit["cells"]:
            x0, x1, y0, y1 = extent_px(c["extent"], res)
            cell_of_px[wy1 - y1 : wy1 - y0, x0 - wx0 : x1 - wx0] = cell_index[c["key"]]

        # The mosaic's layers, bottom to top, as the worker listed them.
        layer_paths = [l.strip() for l in open(os.path.join(wdir, "mosaic.txt")) if l.strip()]
        layers = []  # (cell, rank, frame id, alpha on the window grid, rgb or None)
        painted = 0
        outside = []
        for p in layer_paths:
            base = os.path.basename(p)[: -len(".vrt")]
            cell, rank = base.rsplit("-", 1)
            rank = int(rank)
            frame = cells[cell]["frames"][rank]
            ds, arr = read(p)
            ex = ds_extent(ds)
            lx0, lx1, ly0, ly1 = extent_px(ex, res)
            cx0, cx1, cy0, cy1 = extent_px(cells[cell]["extent"], res)
            if lx0 < cx0 or lx1 > cx1 or ly0 < cy0 or ly1 > cy1:
                outside.append(f"{cell}-{rank} extent leaves its cell")
            # Place it on the window grid (clipped), alpha and RGB.
            alpha = np.zeros((height, width), dtype=bool)
            rgb = np.zeros((3, height, width), dtype=np.uint8)
            gx0, gx1 = max(lx0, wx0), min(lx1, wx1)
            gy0, gy1 = max(ly0, wy0), min(ly1, wy1)
            sub = arr[:, ly1 - gy1 : ly1 - gy0, gx0 - lx0 : gx1 - lx0]
            alpha[wy1 - gy1 : wy1 - gy0, gx0 - wx0 : gx1 - wx0] = sub[3] > 0
            rgb[:, wy1 - gy1 : wy1 - gy0, gx0 - wx0 : gx1 - wx0] = sub[:3]
            painted += int((alpha & (cell_of_px != cell_index[cell])).sum())
            layers.append((cell, rank, frame, alpha, rgb))
        check("cut", painted == 0 and not outside,
              f"{painted} pixels painted outside their cell; {outside or 'every warp inside its cell'}")

        # The mosaic itself.
        mds, marr = read(os.path.join(wdir, "mosaic.vrt"))
        mex = ds_extent(mds)
        mx0, mx1, my0, my1 = extent_px(mex, res)
        m_alpha = np.zeros((height, width), dtype=bool)
        m_rgb = np.zeros((3, height, width), dtype=np.uint8)
        m_alpha[wy1 - my1 : wy1 - my0, mx0 - wx0 : mx1 - wx0] = marr[3] > 0
        m_rgb[:, wy1 - my1 : wy1 - my0, mx0 - wx0 : mx1 - wx0] = marr[:3]
        holes = int((~m_alpha & (cell_of_px > 0)).sum())
        check("coverage", holes == 0, f"{holes} transparent pixels inside the cells (of {int((cell_of_px > 0).sum())})")

        # Which layer shows at each pixel: the topmost with alpha (the mosaic's order).
        shown = np.full((height, width), -1, dtype=np.int16)
        for i, (_, _, _, alpha, _) in enumerate(layers):
            shown[alpha] = i
        # The mosaic shows that layer's own pixels.
        mismatch = 0
        for i, (_, _, _, _, rgb) in enumerate(layers):
            sel = shown == i
            mismatch += int((m_rgb[:, sel] != rgb[:, sel]).any(axis=0).sum())
        check("composition", mismatch == 0, f"{mismatch} pixels where the mosaic is not its top layer's")

        if spec.get("fallThrough"):
            cell = spec["fallThrough"]
            pick = cells[cell]["frames"][0]
            pick_layers = [i for i, l in enumerate(layers) if l[0] == cell and l[1] == 0]
            fb_layers = [i for i, l in enumerate(layers) if l[0] == cell and l[1] > 0]
            if not pick_layers or not fb_layers:
                check("fall-through", False, f"{cell}: the mosaic holds no pick or no fallback")
            else:
                pa = layers[pick_layers[0]][3]
                in_cell = cell_of_px == cell_index[cell]
                pick_wrong = int((pa & in_cell & (shown != pick_layers[0])).sum())
                through = int((~pa & in_cell & np.isin(shown, fb_layers)).sum())
                uncovered = int((~pa & in_cell & ~np.isin(shown, fb_layers)).sum())
                check("fall-through", pick_wrong == 0 and through > 0 and uncovered == 0,
                      f"{cell}: pick {pick} hidden on {pick_wrong} of its pixels; a fallback shows through on "
                      f"{through} pixels; {uncovered} of the pick's holes not filled")

        # counts: the done record's frames per cell are exactly the visible ones.
        done = json.load(open(os.path.join(wdir, "shard", "shard.done.json")))
        bad = []
        shares = {}
        for c in unit["cells"]:
            in_cell = cell_of_px == cell_index[c["key"]]
            total = int(in_cell.sum())
            vis = {}
            for i, l in enumerate(layers):
                if l[0] == c["key"]:
                    n = int((in_cell & (shown == i)).sum())
                    if n > 0:
                        vis[l[2]] = n
            counted = done["cellCounts"].get(c["key"], {})
            if set(vis) != set(counted):
                bad.append(f"{c['key']}: counted {sorted(counted)} but visible {sorted(vis)}")
            ctot = sum(counted.values()) or 1
            for f in vis:
                a = vis[f] / max(total, 1)
                b = counted.get(f, 0) / ctot
                shares[f"{c['key']}:{f}"] = [round(a, 4), round(b, 4)]
                if abs(a - b) > 0.02:
                    bad.append(f"{c['key']}:{f}: visible share {a:.3f}, counted {b:.3f}")
        check("counts", not bad, bad or "every cell's counted frames are exactly the visible ones")
        cur["shares"] = shares

        # seams: register the two flights across each join.
        seams = []
        for s in spec.get("seams", []):
            west, east = cells[s["west"]], cells[s["east"]]
            # The flight each side shows at the join: the layer most often on top along the column
            # beside it.
            def frame_at(cell, col):
                ids = shown[:, col]
                ids = ids[(ids >= 0) & (cell_of_px[:, col] == cell_index[cell["key"]])]
                if len(ids) == 0:
                    return cell["frames"][0]
                return layers[int(np.bincount(ids).argmax())][2]
            jx = round((west["extent"][2] - ORIGIN) / res) - wx0
            fw, fe = frame_at(west, jx - 1), frame_at(east, jx)
            join_x = west["extent"][2]
            half = 128 * res
            ymin, ymax = unit["bounds"][1], unit["bounds"][3]
            strips = []
            for f in (fw, fe):
                src = layer_src(wdir, cells, f)
                out = gdal.Warp("", src, format="MEM", dstSRS="EPSG:3857",
                                outputBounds=[join_x - half, ymin, join_x + half, ymax],
                                xRes=res, yRes=res, resampleAlg="cubic", srcBands=[1, 2, 3],
                                srcNodata="0 0 0", warpOptions=["UNIFIED_SRC_NODATA=YES"])
                strips.append(out.ReadAsArray().astype(np.float64).mean(axis=0))
            a, b = strips
            ok_rows = (a > 0) & (b > 0)
            rows = np.where(ok_rows.all(axis=1))[0]
            if len(rows) < 64:
                seams.append({"join": s["what"], "error": "too little overlap to register"})
                report["failures"].append(f"{name}: seams: too little overlap at {s['what']}")
                continue
            a2, b2 = a[rows[0] : rows[-1] + 1], b[rows[0] : rows[-1] + 1]
            entry = {"join": s["what"], "west": fw, "east": fe, **register(a2, b2, res)}
            seams.append(entry)
            # An axis is assessed only where at least two blocks register clearly (a featureless
            # forest has no edge across the join to register); a join must be assessed on at least
            # one axis, and every assessed axis must be within a pixel.
            assessed = {ax: entry[f"{ax}_px"] for ax in ("dx", "dy") if entry[f"{ax}_blocks"] >= 2}
            entry["assessed"] = sorted(assessed)
            if not assessed:
                report["failures"].append(f"{name}: seams: {s['what']}: too few features to register")
            for ax, v in assessed.items():
                if abs(v) > 1:
                    report["failures"].append(f"{name}: seams: {s['what']} {ax} {v} px")
            save_seam_png(m_rgb, jx, os.path.join(run, f"seam-{name}.png"))
        cur["seams"] = seams

        # Measurements.
        timings = done["timings"]
        sb = int(open(os.path.join(wdir, "source-bytes")).read().strip())
        idx = json.load(open(os.path.join(wdir, "shard", "shard.idx.json")))
        tiles_by_zoom = {}
        for z in sorted(os.listdir(os.path.join(wdir, "tiles"))):
            if not z.isdigit():
                continue
            sizes = []
            for x in os.listdir(os.path.join(wdir, "tiles", z)):
                for y in os.listdir(os.path.join(wdir, "tiles", z, x)):
                    if y.endswith(".webp"):
                        sizes.append(os.path.getsize(os.path.join(wdir, "tiles", z, x, y)))
            sizes.sort()
            tiles_by_zoom[z] = {"tiles": len(sizes), "bytes": sum(sizes),
                                "mean": round(sum(sizes) / len(sizes)) if sizes else 0,
                                "p10": sizes[len(sizes) // 10] if sizes else 0,
                                "p90": sizes[(len(sizes) * 9) // 10] if sizes else 0}
        # A tile's water share at the deepest zoom, read from its pixels: dark, flat water vs land.
        cur["measure"] = {"timings_ms": timings, "source_bytes": sb, "tiles": len(idx["entries"]),
                          "pack_bytes": done["bytes"], "by_zoom": tiles_by_zoom,
                          "frames_shown": len(layers),
                          "frames_in_stacks": sum(len(c["frames"]) for c in unit["cells"])}
        report["windows"].append(cur)

    json.dump(report, open(argv[3], "w"), indent=2)
    for w in report["windows"]:
        print(f"== {w['name']} ({w['window']})")
        for c in w["checks"]:
            print(f"  {'ok  ' if c['ok'] else 'FAIL'} {c['check']}: {c['detail']}")
        for s in w.get("seams", []):
            print(f"  seam {s}")
        m = w["measure"]
        print(f"  {m['frames_shown']} of {m['frames_in_stacks']} frames shown; {m['source_bytes']} source bytes; "
              f"{m['tiles']} tiles, {m['pack_bytes']} bytes; timings {m['timings_ms']}")
        for z, row in m["by_zoom"].items():
            print(f"    z{z}: {row}")
    if report["failures"]:
        print("FAILED:")
        for f in report["failures"]:
            print(f"  {f}")
        return 1
    print("all checks passed")
    return 0


def layer_src(wdir, cells, frame):
    """The /vsiaz/ path of a frame, read back from the worker's counts VRT for it
    (`count/<cell>/<rank + 1>.vrt`) — the item id doesn't spell the COG's name (a reprocessed
    frame's id carries a second date its file doesn't)."""
    import re
    for cell in cells.values():
        if frame in cell["frames"]:
            rank = cell["frames"].index(frame)
            text = open(os.path.join(wdir, "count", cell["key"], f"{rank + 1}.vrt")).read()
            m = re.search(r"<SourceDataset[^>]*>([^<]+)</SourceDataset>", text)
            if m:
                return m.group(1)
    raise SystemExit(f"no counts VRT names {frame}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
