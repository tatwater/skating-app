#!/usr/bin/env python3
"""Pack a tile directory into an MBTiles file (N6e PR 2, §4).

    tiles-to-mbtiles.py <tile-dir> <out.mbtiles> [--format webp] [--name <str>]

## Why this file exists at all

`gdal raster tile` is the fast tiler — it builds the whole z7–z14 pyramid in one parallel pass, where
`gdal_translate -of MBTILES` writes only the base zoom and then needs `gdaladdo` for the rest. On the
corpus's largest granule (Champlain, 923 bodies, 237 Mpixels) that is **28.6s against 75.0s**, measured
2026-08-24 at four threads to match `shared-cpu-4x`.

The catch is a format gap and nothing more: `gdal raster tile --output` is always a *directory*, and
`pmtiles convert` reads only MBTiles. So this walks the one into the other.

**MBTiles is a SQLite file**, not a format needing a library: a `tiles` table of
`(zoom_level, tile_column, tile_row, tile_data)` plus a `metadata` table of key/value strings. That is
the whole specification we depend on, which is why this is thirty lines of `sqlite3` rather than a new
dependency in the image.

## ⚠ The tile directory must be written with `--convention tms`

**MBTiles numbers rows from the bottom (TMS); XYZ numbers them from the top.** `gdal raster tile`
defaults to `xyz`, so a caller who forgets the flag gets an archive that is *vertically mirrored* —
every tile individually correct, the map as a whole upside down. That failure renders as lakes in
plausible-looking wrong places rather than as an error, so this file refuses to guess: it copies `y`
through untouched and documents the requirement here.

A flip could be done here instead, but then the convention would live in two places and the one that
is wrong would still produce a rendering rather than a crash.

## What is deliberately not here

No re-encoding, no re-tiling, no validation of tile contents. Bytes on disk go into the blob column
unchanged, so this step is I/O and nothing else — which is what keeps it a rounding error next to the
tiling it follows.
"""

import argparse
import math
import os
import sqlite3
import sys


def tile_bounds(zoom: int, min_x: int, max_x: int, min_y_tms: int, max_y_tms: int):
    """WGS84 `left, bottom, right, top` covering a TMS tile range, as the MBTiles spec wants it."""
    n = 1 << zoom

    def lon(x: int) -> float:
        return x / n * 360.0 - 180.0

    def lat_from_xyz(y_xyz: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y_xyz / n))))

    # TMS counts from the bottom, so the *largest* TMS row is the northernmost.
    top = lat_from_xyz(n - 1 - max_y_tms)
    bottom = lat_from_xyz(n - 1 - min_y_tms + 1)
    return lon(min_x), bottom, lon(max_x + 1), top


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tile_dir")
    parser.add_argument("out")
    parser.add_argument("--format", default="webp", help="tile format recorded in metadata")
    parser.add_argument("--name", default=None, help="metadata name (defaults to the output stem)")
    args = parser.parse_args()

    suffix = f".{args.format}"
    if os.path.exists(args.out):
        os.unlink(args.out)

    db = sqlite3.connect(args.out)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute(
        "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, "
        "tile_row INTEGER, tile_data BLOB)"
    )
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")

    # ⚠ **Inserted in batches, never accumulated.** Holding every tile's bytes in one list before a
    # single `executemany` makes peak memory the size of the whole pyramid — and the pyramid is
    # driven by where the lakes are, with nothing capping it. On the box this actually runs on
    # (`FLY_VM_MEMORY=2048`, of which `GDAL_CACHEMAX` has already claimed 410 MB) that is the one
    # allocation in this file that can OOM, and an OOM here arrives as `Killed` with no message —
    # after the expensive tiling stage has already been paid for.
    #
    # A batch is bounded work: the blobs are handed to SQLite and released.
    BATCH = 512
    pending: list[tuple[int, int, int, sqlite3.Binary]] = []
    total = 0
    zooms: set[int] = set()
    # Per-zoom extents, so bounds can be taken from the deepest zoom — the one that actually
    # circumscribes the data. An overview zoom's tiles are coarser and would round the box outward.
    extent: dict[int, list[int]] = {}
    for dirpath, _, files in os.walk(args.tile_dir):
        for filename in files:
            if not filename.endswith(suffix):
                continue
            try:
                y = int(filename[: -len(suffix)])
                x = int(os.path.basename(dirpath))
                z = int(os.path.basename(os.path.dirname(dirpath)))
            except ValueError:
                # Not a z/x/y.ext triple — a stray file, not a tile. Skipped rather than guessed at.
                continue
            with open(os.path.join(dirpath, filename), "rb") as handle:
                pending.append((z, x, y, sqlite3.Binary(handle.read())))
            total += 1
            if len(pending) >= BATCH:
                db.executemany("INSERT INTO tiles VALUES (?, ?, ?, ?)", pending)
                pending.clear()
            zooms.add(z)
            box = extent.get(z)
            if box is None:
                extent[z] = [x, x, y, y]
            else:
                box[0] = min(box[0], x)
                box[1] = max(box[1], x)
                box[2] = min(box[2], y)
                box[3] = max(box[3], y)

    if pending:
        db.executemany("INSERT INTO tiles VALUES (?, ?, ?, ?)", pending)
        pending.clear()

    if total == 0:
        print(f"no {suffix} tiles under {args.tile_dir}", file=sys.stderr)
        return 1

    # The spec's index, and the one every reader looks a tile up by.
    db.execute(
        "CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)"
    )

    min_zoom, max_zoom = min(zooms), max(zooms)
    left, bottom, right, top = tile_bounds(max_zoom, *extent[max_zoom])
    meta = {
        "name": args.name or os.path.splitext(os.path.basename(args.out))[0],
        "type": "overlay",
        "version": "1",
        "description": "N6e freeze-up archive frame",
        "format": args.format,
        "minzoom": str(min_zoom),
        "maxzoom": str(max_zoom),
        "bounds": f"{left:.6f},{bottom:.6f},{right:.6f},{top:.6f}",
        "center": f"{(left + right) / 2:.6f},{(bottom + top) / 2:.6f},{max_zoom}",
    }
    db.executemany("INSERT INTO metadata VALUES (?, ?)", list(meta.items()))
    db.commit()
    db.close()

    print(
        f"{total} tiles, z{min_zoom}-z{max_zoom} -> {args.out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
