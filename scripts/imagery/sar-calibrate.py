#!/usr/bin/env python3
"""Measure where Sentinel-1 actually puts a lake, so the geocode model can be checked (N6e).

    sar-calibrate.py <water.fgb> --granules g1,g2,… --lakes 12 [--out fits.json]

For every (lake, pass) pair it finds the 2-D offset at which the lake's own polygon best explains the
radar image, and reports that beside what `sarGeocode`'s flat-lake model predicts. The output is a
table to fit a correction against — this script measures, it does not decide.

## Why a 2-D search and not a scan along range

The model says the displacement is **purely along range**. That is a claim, and searching only along
range would assume it rather than test it. A 2-D peak also reports the cross-range component, which
should come out near zero if the physics is right and is a loud signal if it is not.

## The estimator, and why the obvious one does not work

*"Shift the polygon until the pixels inside it are darkest"* works on a narrow lake and fails on a
wide one: move a 15 km lake by 200 m and almost every pixel inside it is still water, so the curve is
flat and the minimum is noise. Measured that way, Lake Winnipesaukee reported an offset of −1 m where
the model wanted 250, purely because the estimator had nothing to grip.

So the score is a **contrast** across the shoreline:

    score(dx, dy) = mean_dB(ring just OUTSIDE the polygon) − mean_dB(inside the polygon)

At the true offset the inside is water and the ring is land, which maximises it. That depends only on
the boundary, so it is as sharp for Champlain as for a farm pond.

⚠ **The ring is built from the WATER polygon, never the reveal.** The reveal is already buffered 60 m
outward and unioned with the walk in and the parking, so a ring outside *it* starts 60 m into the
woods and the estimator has no shoreline to find.

## ⚠ Calibrate on open water, apply to winter

The geometry is a property of the orbit and the terrain, not of the season, so any date measures it.
But the *estimator* needs the lake to be darker than its surroundings, and a snow-covered frozen lake
is not reliably darker than forest. Summer and autumn passes give the cleanest shoreline contrast;
pairs whose peak contrast is weak or inverted are reported and dropped rather than fitted.

Cross-correlation via FFT, so a full ±420 m search at half-pixel steps is one transform rather than
3,721 rasterisations.
"""

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr

sys.path.insert(0, str(Path(__file__).parent))
from importlib.util import module_from_spec, spec_from_file_location

_spec = spec_from_file_location("sar_deshift", Path(__file__).parent / "sar-deshift.py")
_deshift = module_from_spec(_spec)
_spec.loader.exec_module(_deshift)
local_reference = _deshift.local_reference

gdal.UseExceptions()
gdal.PushErrorHandler("CPLQuietErrorHandler")

MW = 20037508.342789244
STAC = "https://earth-search.aws.element84.com/v1"
# Finer than the 28 m the archive warps at: this is locating a peak, not measuring brightness, and
# half-pixel steps are what distinguish a 50 m residual from a 70 m one.
GRID_M = 14.0
SEARCH_M = 420.0
# How far outside the shoreline the comparison ring reaches. Wide enough to clear the mixed pixels at
# the bank, narrow enough to still be the lake's own surroundings rather than the next valley.
RING_M = 170.0


def merc(lon: float, lat: float) -> tuple[float, float]:
    return lon * MW / 180.0, MW / 180.0 * math.degrees(
        math.log(math.tan((90 + lat) * math.pi / 360))
    )


def latitude_of(northing: float) -> float:
    return math.degrees(2 * math.atan(math.exp(northing / MW * math.pi)) - math.pi / 2)


def scene_params(annotation: Path) -> dict:
    """Reference height, incidence and heading, from `sar-geocode.py`."""
    out = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "sar-geocode.py"), str(annotation), "0"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def fetch_pass(granule_id: str, work: Path) -> dict | None:
    """STAC item, VH href and product annotation for one pass."""
    item_path = work / f"{granule_id}.json"
    if not item_path.exists():
        r = subprocess.run(
            ["curl", "-fsSL", f"{STAC}/collections/sentinel-1-grd/items/{granule_id}"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"  ! {granule_id}: STAC lookup failed", file=sys.stderr)
            return None
        item_path.write_text(r.stdout)
    item = json.loads(item_path.read_text())
    if "vh" not in item.get("assets", {}):
        print(f"  ! {granule_id}: no VH (probably an HH/HV product)", file=sys.stderr)
        return None

    href = item["assets"]["vh"]["href"].replace(
        "s3://sentinel-s1-l1c/", "https://sentinel-s1-l1c.s3.amazonaws.com/"
    )
    annotation = work / f"{granule_id}-iw-vh.xml"
    if not annotation.exists():
        url = href.replace("/measurement/", "/annotation/").replace(".tiff", ".xml")
        if subprocess.run(["curl", "-fsSL", url, "-o", str(annotation)]).returncode != 0:
            print(f"  ! {granule_id}: no annotation", file=sys.stderr)
            return None

    return {
        "granuleId": granule_id,
        "href": href,
        "orbit": item["properties"].get("sat:orbit_state"),
        "relativeOrbit": item["properties"].get("sat:relative_orbit"),
        "datetime": item["properties"].get("datetime"),
        "footprint": item["geometry"],
        **scene_params(annotation),
        "grid": json.loads(subprocess.run(
            [sys.executable, str(Path(__file__).parent / "sar-geocode.py"), str(annotation), "--grid"],
            capture_output=True, text=True, check=True).stdout),
    }


def best_offset(image: np.ndarray, inside: np.ndarray, ring: np.ndarray, search_px: int):
    """The (dx, dy) in pixels maximising ring-minus-inside contrast, by FFT cross-correlation.

    Shifting the *mask* over a fixed image is a correlation, so every candidate offset is evaluated in
    one transform instead of one rasterisation each. Invalid pixels are handled by correlating the
    validity mask too and dividing — which is what keeps a lake at the swath edge from reporting a
    confident peak built on four pixels.
    """
    valid = image > 0
    logimage = np.zeros_like(image, dtype=np.float64)
    logimage[valid] = 20 * np.log10(image[valid])

    # ⚠ **The transform must be sized for a LINEAR correlation, not for the search window.**
    #
    # Correlating two `h x w` arrays produces `2h-1` by `2w-1` lags. Sizing the FFT any smaller wraps
    # the result around, and the wrap does not look like an error — it looks like a peak. The first
    # version used `h + 2*search_px`, and every descending lake came back at ~360 m along and ~200 m
    # across regardless of its elevation, with a healthy 3–6 dB prominence behind it. The giveaway was
    # that the answers were identical rather than that they were wrong.
    h, w = image.shape
    shape = (2 * h - 1, 2 * w - 1)
    fim = np.fft.rfft2(logimage * valid, shape)
    fva = np.fft.rfft2(valid.astype(np.float64), shape)

    def means(mask: np.ndarray):
        fm = np.fft.rfft2(mask[::-1, ::-1].astype(np.float64), shape)
        total = np.fft.irfft2(fim * fm, shape)
        count = np.fft.irfft2(fva * fm, shape)
        return total, count

    inside_total, inside_count = means(inside)
    ring_total, ring_count = means(ring)

    # Lag (dy, dx) sits at [h-1+dy, w-1+dx] in the full correlation. Slice out the search window,
    # recentred so index (search_px, search_px) is zero offset.
    sl = (
        slice(h - 1 - search_px, h + search_px),
        slice(w - 1 - search_px, w + search_px),
    )
    it, ic = inside_total[sl], inside_count[sl]
    rt, rc = ring_total[sl], ring_count[sl]

    # Demand most of each mask be backed by real pixels, or a sliver at the swath edge wins on noise.
    enough = (ic > 0.6 * inside.sum()) & (rc > 0.6 * ring.sum())
    score = np.full(it.shape, -np.inf)
    ok = enough & (ic > 0) & (rc > 0)
    score[ok] = rt[ok] / rc[ok] - it[ok] / ic[ok]
    if not np.isfinite(score).any():
        return None

    flat = int(np.argmax(score))
    dy, dx = np.unravel_index(flat, score.shape)
    peak = float(score[dy, dx])
    finite = score[np.isfinite(score)]
    return {
        "dxPx": int(dx) - search_px,
        "dyPx": int(dy) - search_px,
        "contrastDb": peak,
        # How far the peak stands above the typical offset — a flat map means the estimator had
        # nothing to grip and the answer should not be fitted.
        "prominenceDb": peak - float(np.median(finite)),
    }


def rasterise(geom: ogr.Geometry, gt, width: int, height: int, projection: str) -> np.ndarray:
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    mem = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Byte)
    mem.SetGeoTransform(gt)
    mem.SetProjection(projection)
    src = ogr.GetDriverByName("MEM").CreateDataSource("")
    layer = src.CreateLayer("l", srs=srs)
    feature = ogr.Feature(layer.GetLayerDefn())
    feature.SetGeometry(geom)
    layer.CreateFeature(feature)
    gdal.RasterizeLayer(mem, [1], layer, burn_values=[1])
    return mem.GetRasterBand(1).ReadAsArray() > 0


def self_test() -> int:
    """Recover a known shift from a synthetic lake, and refuse to run if it cannot.

    ⚠ **This exists because the estimator's first version was wrong in a way that looked right.** An
    undersized FFT wrapped the correlation around, and the result was a confident 3–6 dB peak in the
    same place for every lake. Nothing in the output said so; only comparing lakes to each other did.
    A ground truth we construct ourselves is the cheapest thing that would have caught it.
    """
    rng = np.random.default_rng(20260825)
    h = w = 220
    yy, xx = np.mgrid[0:h, 0:w]

    for truth_dy, truth_dx in ((0, 0), (7, -11), (-19, 23), (25, 25)):
        # A dark elliptical "lake" on bright "land", with speckle, in linear DN.
        lake = ((yy - h / 2) / 46) ** 2 + ((xx - w / 2) / 34) ** 2 <= 1.0
        # The image holds the lake displaced by (truth_dy, truth_dx) — what a GRD does.
        moved = np.roll(np.roll(lake, truth_dy, axis=0), truth_dx, axis=1)
        image = np.where(moved, 60.0, 240.0) * rng.lognormal(0, 0.25, (h, w))

        ring = np.zeros_like(lake)
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                ring |= np.roll(np.roll(lake, dy, axis=0), dx, axis=1)
        ring &= ~lake

        found = best_offset(image, lake, ring, search_px=40)
        if found is None:
            print("self-test: no peak found", file=sys.stderr)
            return 1
        if (found["dyPx"], found["dxPx"]) != (truth_dy, truth_dx):
            print(
                f"self-test FAILED: planted ({truth_dy}, {truth_dx}), "
                f"recovered ({found['dyPx']}, {found['dxPx']})",
                file=sys.stderr,
            )
            return 1
        print(f"  recovered ({truth_dy:>3}, {truth_dx:>3}) exactly, "
              f"prominence {found['prominenceDb']:.2f} dB", file=sys.stderr)

    print("self-test OK", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("water", nargs="?", help="the bake's -water.fgb")
    parser.add_argument("--granules", help="comma-separated Sentinel-1 ids")
    parser.add_argument("--self-test", action="store_true", help="prove the estimator, then exit")
    parser.add_argument("--lakes", type=int, default=12)
    parser.add_argument("--min-acres", type=float, default=40)
    parser.add_argument("--max-acres", type=float, default=6000)
    parser.add_argument("--out", default="sar-fits.json")
    parser.add_argument("--work", default=None)
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if not args.water or not args.granules:
        parser.error("give a water.fgb and --granules, or --self-test")

    # Never measure with an estimator that has not just proved it can find a shift it was given.
    if self_test() != 0:
        return 1

    work = Path(args.work or tempfile.mkdtemp(prefix="sar-cal-"))
    work.mkdir(parents=True, exist_ok=True)
    print(f"scratch: {work}", file=sys.stderr)

    passes = [p for p in (fetch_pass(g.strip(), work) for g in args.granules.split(",")) if p]
    if not passes:
        print("no usable passes", file=sys.stderr)
        return 1
    for p in passes:
        print(f"  {p['granuleId'][:32]}  {p['orbit']:<10} track {p['relativeOrbit']:<4}"
              f" h_ref {p['referenceHeightM']:>6.1f}  inc {p['incidenceDeg']:.2f}", file=sys.stderr)

    # ## Choosing lakes: elevation spread first, because that is the variable under test
    #
    # The model's whole content is `(h - h_ref)/tan θ`, so a calibration set clustered at one height
    # cannot separate a wrong height from a wrong tangent. Bodies are bucketed by elevation and taken
    # round-robin, largest first within each bucket, so the set spans the range rather than the mode.
    ds = ogr.Open(args.water)
    layer = ds.GetLayer()

    # ⚠ **The bake writes lat/lng; everything here is projected.** `cut-granule.sh` reprojects on the
    # way out of the FlatGeobuf (`ogr2ogr -t_srs EPSG:3857`) and this has to do the same, or the
    # envelope handed to `gdalwarp -te` is in degrees and `GetArea()` returns square degrees — which
    # silently filtered out every lake rather than failing.
    source_srs = layer.GetSpatialRef()
    target_srs = osr.SpatialReference()
    target_srs.ImportFromEPSG(3857)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    if source_srs:
        source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    to3857 = osr.CoordinateTransformation(source_srs, target_srs) if source_srs else None

    candidates = []
    for feature in layer:
        elevation = feature.GetField("elevationM")
        if elevation is None:
            continue
        geom = feature.GetGeometryRef()
        if geom is None:
            continue
        geom = geom.Clone()
        if to3857 and not source_srs.IsSame(target_srs):
            geom.Transform(to3857)
        minx, maxx, miny, maxy = geom.GetEnvelope()
        lat = latitude_of((miny + maxy) / 2)
        # Web Mercator area is inflated by 1/cos(φ) in each axis; undo both to get ground acres.
        acres = geom.GetArea() * math.cos(math.radians(lat)) ** 2 / 4046.86
        if not (args.min_acres <= acres <= args.max_acres):
            continue
        candidates.append({
            "name": feature.GetField("name") or "(unnamed)",
            "elevationM": float(elevation),
            "acres": acres,
            "wkb": geom.ExportToWkb(),
            "centre": ((minx + maxx) / 2, (miny + maxy) / 2),
        })

    buckets: dict[int, list] = {}
    for c in candidates:
        buckets.setdefault(int(c["elevationM"] // 100), []).append(c)
    for b in buckets.values():
        b.sort(key=lambda c: -c["acres"])
    chosen, i = [], 0
    while len(chosen) < args.lakes and any(buckets.values()):
        for key in sorted(buckets):
            if buckets[key] and len(chosen) < args.lakes:
                chosen.append(buckets[key].pop(0))
        i += 1
        if i > 100:
            break
    print(f"{len(chosen)} lakes, elevations "
          f"{min(c['elevationM'] for c in chosen):.0f}–{max(c['elevationM'] for c in chosen):.0f} m",
          file=sys.stderr)

    search_px = int(round(SEARCH_M / GRID_M))
    fits = []
    for lake in chosen:
        geom = ogr.CreateGeometryFromWkb(lake["wkb"])
        # ⚠ A self-intersecting OSM ring makes GEOS throw `side location conflict`, and one bad lake
        # took a whole 45-lake run down with it. Repair, then skip rather than abort.
        try:
            ring_geom = geom.Buffer(RING_M).Difference(geom)
        except RuntimeError:
            try:
                geom = geom.MakeValid()
                ring_geom = geom.Buffer(RING_M).Difference(geom)
            except RuntimeError:
                print(f"  ! {lake['name'][:24]}: unbuildable ring, skipping", file=sys.stderr)
                continue
        minx, maxx, miny, maxy = geom.GetEnvelope()
        pad = SEARCH_M + RING_M + 2 * GRID_M
        te = (minx - pad, miny - pad, maxx + pad, maxy + pad)

        for p in passes:
            footprint = ogr.CreateGeometryFromJson(json.dumps(p["footprint"]))
            cx, cy = lake["centre"]
            point = ogr.CreateGeometryFromJson(json.dumps({
                "type": "Point",
                "coordinates": [cx / MW * 180.0, latitude_of(cy)],
            }))
            if not footprint.Contains(point):
                continue

            tif = work / f"{lake['name'][:20].replace('/', '_')}-{p['granuleId'][:24]}.tif"
            if not tif.exists():
                rc = subprocess.run([
                    "gdalwarp", "-q", "-tps", "-t_srs", "EPSG:3857",
                    "-te", *[str(v) for v in te], "-tr", str(GRID_M), str(GRID_M),
                    "-r", "bilinear", "-overwrite", f"/vsicurl/{p['href']}", str(tif),
                ]).returncode
                if rc != 0:
                    continue
            raster = gdal.Open(str(tif))
            gt = raster.GetGeoTransform()
            image = raster.GetRasterBand(1).ReadAsArray().astype(np.float64)
            inside = rasterise(geom, gt, raster.RasterXSize, raster.RasterYSize, raster.GetProjection())
            ring = rasterise(ring_geom, gt, raster.RasterXSize, raster.RasterYSize, raster.GetProjection())
            if inside.sum() < 40 or ring.sum() < 40:
                continue

            found = best_offset(image, inside, ring, search_px)
            if found is None:
                continue

            inflation = 1.0 / math.cos(math.radians(latitude_of(cy)))
            east_ground = found["dxPx"] * GRID_M / inflation
            north_ground = -found["dyPx"] * GRID_M / inflation
            bearing = math.radians(p["headingDeg"] + 90.0)
            along = east_ground * math.sin(bearing) + north_ground * math.cos(bearing)
            across = east_ground * math.cos(bearing) - north_ground * math.sin(bearing)
            # What the pipeline actually applies: the local grid reference at this lake. The
            # scene average is kept alongside only to show how much worse it is.
            h_local, i_local = local_reference(p["grid"]["points"], latitude_of(cy), cx / MW * 180.0)
            predicted = (h_local - lake["elevationM"]) / math.tan(math.radians(i_local))
            predicted_scene = (p["referenceHeightM"] - lake["elevationM"]) / math.tan(
                math.radians(p["incidenceDeg"])
            )

            fits.append({
                "lake": lake["name"], "acres": round(lake["acres"], 1),
                "elevationM": round(lake["elevationM"], 1),
                "granuleId": p["granuleId"], "orbit": p["orbit"],
                "relativeOrbit": p["relativeOrbit"],
                "referenceHeightM": p["referenceHeightM"], "incidenceDeg": p["incidenceDeg"],
                "headingDeg": p["headingDeg"],
                "measuredAlongM": round(along, 1), "measuredAcrossM": round(across, 1),
                "predictedAlongM": round(predicted, 1),
                "predictedSceneAvgM": round(predicted_scene, 1),
                "localHeightM": round(h_local, 1), "localIncidenceDeg": round(i_local, 2),
                "residualM": round(along - predicted, 1),
                "contrastDb": round(found["contrastDb"], 3),
                "prominenceDb": round(found["prominenceDb"], 3),
            })
            print(f"  {lake['name'][:22]:24}{lake['elevationM']:>7.0f} m  {p['orbit'][:4]:<5}"
                  f" along {along:>7.1f}  across {across:>7.1f}  pred {predicted:>7.1f}"
                  f"  resid {along-predicted:>7.1f}  prom {found['prominenceDb']:>5.2f}", file=sys.stderr)

    Path(args.out).write_text(json.dumps(fits, indent=2))
    print(f"\n{len(fits)} fits -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
