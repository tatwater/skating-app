#!/usr/bin/env python3
"""What each frame supplies to one cell (B05 §2.2 step 4, D318) — the date index's input.

    aerial-counts.py <out.json> <itemId>=<alpha.tif> [<itemId>=<alpha.tif> ...]

The alphas are one cell's frames warped to the counts' grid (pixel zoom 16), each cut to the cell's
outline, all on the same extent, **in the rule's order: the pick first**. A frame's count is the
number of pixels where its alpha is set **and every frame before it is empty** — so a fallback under
a pick that covers the cell counts zero, and a frame that shows through a hole counts exactly the
hole. Any pixel counts. Writes `{ "<itemId>": <count>, ... }`, every frame named (zeros included;
`tilesPack.ts` drops them).

Python because the image already carries GDAL's bindings and numpy (the winter cutter's
`zonal-clear.py` uses the same), and this is one sweep over a few small arrays — a cross-tabulation
the GDAL CLI has no command for. It is exercised by `proofs/warp-proof.sh` on real frames, which
mutation-checks the stack-order rule; CI runs no Python.
"""

import json
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 64
    out_path, pairs = argv[1], argv[2:]
    taken = None
    shape = None
    counts = {}
    for pair in pairs:
        item_id, _, path = pair.partition("=")
        if not item_id or not path:
            print(f"aerial-counts: {pair!r} is not <itemId>=<alpha.tif>", file=sys.stderr)
            return 64
        if item_id in counts:
            print(f"aerial-counts: {item_id} given twice", file=sys.stderr)
            return 64
        ds = gdal.Open(path)
        alpha = ds.GetRasterBand(1).ReadAsArray() > 0
        if shape is None:
            shape = alpha.shape
            taken = np.zeros(shape, dtype=bool)
        elif alpha.shape != shape:
            print(f"aerial-counts: {path} is {alpha.shape}, the first was {shape}", file=sys.stderr)
            return 1
        # The stack's order: this frame supplies only where nothing above it already has.
        supplied = alpha & ~taken
        counts[item_id] = int(supplied.sum())
        taken |= alpha
    with open(out_path, "w") as f:
        json.dump(counts, f)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
