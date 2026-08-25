#!/usr/bin/env python3
"""Re-place a GRD's ground-control points for a surface at a known height (N6e open question 8).

    sar-geocode.py <annotation.xml> <target-height-m> [--look-right]

Prints the scene's geocoding parameters as JSON, plus the east/north offset a surface at
`target-height-m` needs to be corrected by:

    {"referenceHeightM": 132.4, "incidenceDeg": 38.9, "headingDeg": 349.7,
     "offsetEastM": 108.7, "offsetNorthM": -19.9}

## What is wrong, and why a lake is the easy case

A GRD carries no map projection. It carries **ground-control points**, computed by projecting radar
geometry onto an ellipsoid at a *single average scene height*. Everything at that height lands
correctly; everything else is displaced along **range** by `(h - h_ref) / tan(theta)` — about 140 m
per 100 m of height error at IW incidence.

Sentinel-1 is right-looking, so ascending views a lake from the east and descending from the west,
and **the displacement flips sign between them**. That is what made two islands in Mascoma appear to
jump east, then west, then east again while a skater scrubbed through alternating passes on
2026-08-25.

Full terrain correction resamples every pixel against a DEM, because real ground varies in height.
**A lake does not.** It is flat at a height the corpus already knows, which collapses the per-pixel
warp into one offset — trigonometry instead of a SNAP dependency and a DEM download per scene.

⚠ **So this corrects lakes, and only lakes.** The water is right and the hillside behind it is as
wrong as it ever was. That is the correct trade for an archive whose entire subject is frozen water,
and it is written here so nobody later reads these frames as terrain-corrected imagery.

## ⚠ This mirrors `packages/core/src/sarGeocode.ts`, which is where the tests are

The geometry is specified and unit-tested in TypeScript — including the sign convention, which is the
part that would look plausible while doubling the error. This file is the same arithmetic where the
pipeline can reach it. **If you change one, change both**, and check the TS tests still describe what
this does.

## ✅ Measured against a real ascending/descending pair — 2026-08-25

Two Sentinel-1 passes over Mascoma **24 hours apart** (ascending `…20260213T224345`, descending
`…20260212T105656`), whose range bearings are 76° and 284° — nearly opposite, which is why the
islands appeared to jump. For each, the lake mask was scanned along that pass's own range direction
to find where it covers the darkest pixels, i.e. where the water actually is in the product:

    pass         this file says   negated    measured    error
    ascending      -162 m         +162 m     +150 m      12 m   (under half a pixel)
    descending     -129 m         +129 m     +150 m      21 m   (under one pixel)

Against the un-negated figures the errors are **312 m and 279 m** — about eleven pixels.

## ⚠⚠ So mind which direction you are asking for

What this prints is the correction to apply to the **imagery** — *"where should these pixels be
drawn?"* A caller asking *"where ARE these pixels, so I can measure them?"* wants the **negation**,
because the product has already displaced them. `--shift` below does that negation, which is why it
exists rather than leaving a minus sign at the call site. `packages/core/src/sarGeocode.ts` names the
two directions `geocodeOffsetMeters` and `maskOffsetMeters` for the same reason.

Choosing wrong does not halve the correction. It **doubles the error**, and what comes out is still a
perfectly plausible backscatter number.
"""

import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET

# Metres per degree of latitude. Near enough constant for corrections of a few hundred metres, and
# far more precision than the input height carries.
METRES_PER_DEG_LAT = 111_132.0


def grid_points(root: ET.Element) -> list[dict[str, float]]:
    """Every geolocation grid point, as the annotation records them."""
    points = []
    for node in root.iter("geolocationGridPoint"):
        try:
            points.append(
                {
                    "lat": float(node.findtext("latitude", "")),
                    "lng": float(node.findtext("longitude", "")),
                    "height": float(node.findtext("height", "")),
                    "incidence": float(node.findtext("incidenceAngle", "")),
                    "line": float(node.findtext("line", "")),
                    "pixel": float(node.findtext("pixel", "")),
                }
            )
        except (TypeError, ValueError):
            continue
    return points


def platform_heading(root: ET.Element, points: list[dict[str, float]]) -> float:
    """Heading in degrees clockwise from north.

    Preferred from the annotation's own `platformHeading`. Falls back to deriving it from the grid —
    the direction of increasing `line` at constant `pixel` *is* the flight direction — because a
    fallback that reads the same geometry a second way is worth more than a hard failure here.
    """
    stated = root.findtext(".//platformHeading")
    if stated:
        try:
            return float(stated) % 360.0
        except ValueError:
            pass

    near = sorted(points, key=lambda p: (p["pixel"], p["line"]))
    if len(near) < 2:
        raise SystemExit("cannot determine platform heading: too few grid points")
    a, b = near[0], near[-1]
    d_lat = b["lat"] - a["lat"]
    d_lng = (b["lng"] - a["lng"]) * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    return math.degrees(math.atan2(d_lng, d_lat)) % 360.0


MW = 20037508.342789244


def shift_geojson(path: str, out_path: str, reference: float, incidence: float, heading: float,
                  look_right: bool) -> tuple[int, int]:
    """Translate every feature onto the pixels that actually depict it.

    Reads a **EPSG:3857** FeatureCollection (what `ogr2ogr -t_srs EPSG:3857` writes) and moves each
    feature by `maskOffsetMeters` for its own `elevationM` — the NEGATION of what this script prints,
    per the module note.

    ⚠ **Per feature, not per granule, and the spread is the reason.** Measured on the ascending
    Mascoma pass: a sea-level lake needs 429 m and a 600 m lake needs 298 m the *other* way, inside
    one scene — a 750 m spread, 27 pixels. Any single per-granule shift is therefore wrong for most
    of the lakes under it. Per-feature costs nothing because they are rasterised individually anyway.

    ⚠ **Web Mercator metres are not ground metres**, the same 1/cos(φ) inflation the feather corrects
    for. A bare ground offset applied in 3857 would under-shift by 28% at 44°N — which reads as the
    correction being slightly too weak rather than as a units bug.

    Returns (shifted, skipped). A feature with no `elevationM` is passed through untouched: the
    correction needs a height, and sea level is a real height rather than a stand-in for "unknown".
    """
    with open(path) as handle:
        collection = json.load(handle)

    per_metre = 1.0 / math.tan(math.radians(incidence))
    bearing = math.radians(heading + (90.0 if look_right else -90.0))
    shifted = skipped = 0

    for feature in collection.get("features", []):
        elevation = (feature.get("properties") or {}).get("elevationM")
        geometry = feature.get("geometry")
        if elevation is None or not geometry:
            skipped += 1
            continue

        # Negated: this is where the pixels ARE, not where they should be drawn.
        magnitude = -(float(elevation) - reference) * per_metre
        east = magnitude * math.sin(bearing)
        north = magnitude * math.cos(bearing)

        # Latitude from the feature's own northing, so the inflation is right for this lake rather
        # than for the granule's centre — they can differ by two degrees across a 250 km pass.
        ys = [c for c in _coords(geometry["coordinates"], 1)]
        lat = math.degrees(2 * math.atan(math.exp((sum(ys) / len(ys)) / MW * math.pi)) - math.pi / 2)
        inflation = 1.0 / math.cos(math.radians(lat))

        geometry["coordinates"] = _translate(
            geometry["coordinates"], east * inflation, north * inflation
        )
        shifted += 1

    with open(out_path, "w") as handle:
        json.dump(collection, handle)
    return shifted, skipped


def _coords(node, index: int):
    """Every coordinate's `index`-th component, at any nesting depth."""
    if node and isinstance(node[0], (int, float)):
        yield node[index]
        return
    for child in node:
        yield from _coords(child, index)


def _translate(node, dx: float, dy: float):
    if node and isinstance(node[0], (int, float)):
        return [node[0] + dx, node[1] + dy, *node[2:]]
    return [_translate(child, dx, dy) for child in node]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("annotation")
    parser.add_argument(
        "height",
        type=float,
        nargs="?",
        help="target surface height, metres above ellipsoid (omit when using --shift)",
    )
    parser.add_argument(
        "--shift",
        nargs=2,
        metavar=("IN.geojson", "OUT.geojson"),
        help="translate each feature onto its own pixels, using its elevationM",
    )
    parser.add_argument(
        "--look-right",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Sentinel-1 is right-looking; the flag exists so the assumption is visible",
    )
    args = parser.parse_args()
    if args.height is None and not args.shift:
        parser.error("give a height, or --shift IN OUT")

    root = ET.parse(args.annotation).getroot()
    points = grid_points(root)
    if not points:
        raise SystemExit(f"no geolocation grid points in {args.annotation}")

    # The reference the GCPs were computed at, and the look angle at scene centre. Both are averages
    # over the grid: incidence varies across the swath by several degrees, and using mid-swath rather
    # than per-point keeps this a single translation, which is the whole reason it is cheap.
    reference_height = sum(p["height"] for p in points) / len(points)
    incidence = sum(p["incidence"] for p in points) / len(points)
    heading = platform_heading(root, points)

    if args.shift:
        shifted, skipped = shift_geojson(
            args.shift[0], args.shift[1], reference_height, incidence, heading, args.look_right
        )
        json.dump(
            {
                "referenceHeightM": round(reference_height, 2),
                "incidenceDeg": round(incidence, 3),
                "headingDeg": round(heading, 3),
                "shifted": shifted,
                "skipped": skipped,
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return

    delta = args.height - reference_height
    magnitude = delta / math.tan(math.radians(incidence))

    # Range is 90 degrees from heading, on the look side. The product draws a surface above the
    # reference as displaced TOWARD the sensor, so correcting pushes it back out along range.
    range_bearing = heading + (90.0 if args.look_right else -90.0)
    east = magnitude * math.sin(math.radians(range_bearing))
    north = magnitude * math.cos(math.radians(range_bearing))

    json.dump(
        {
            "referenceHeightM": round(reference_height, 2),
            "incidenceDeg": round(incidence, 3),
            "headingDeg": round(heading, 3),
            "targetHeightM": args.height,
            "offsetEastM": round(east, 2),
            "offsetNorthM": round(north, 2),
            "metresPerDegLat": METRES_PER_DEG_LAT,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
