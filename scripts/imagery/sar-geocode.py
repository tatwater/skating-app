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

## Measured against a real ascending/descending pair — 2026-08-25

Two Sentinel-1 passes over Mascoma **24 hours apart** (ascending `…20260213T224345`, descending
`…20260212T105656`), whose range bearings are 76° and 284° — nearly opposite, which is why the
islands appeared to jump. For each, the lake mask was scanned along that pass's own range direction
to find where it covers the darkest pixels, i.e. where the water actually is in the product:

⚠ **The scan worked in EPSG:3857 metres; everything here is in GROUND metres.** Web Mercator inflates
by 1/cos(φ) = 1.382 at 43.65°N, so the measured +150 projected is ~108 on the ground.

    pass         this file says   negated    measured    error
    ascending      -162 m         +162 m     +108 m      54 m   (two pixels, OVER)
    descending     -129 m         +129 m     +108 m      20 m   (under one pixel, OVER)

**The direction is confirmed** — both passes positive along their own range, in nearly opposite ground
directions. Un-negated the correction lands ~270 m out, worse than not correcting at all. **The
magnitude is approximate and consistently over**, and one lake on two passes cannot say why.

## ⚠⚠ So mind which direction you are asking for

What this prints is the correction to apply to the **imagery** — *"where should these pixels be
drawn?"* A caller asking *"where ARE these pixels, so I can measure them?"* wants the **negation**,
because the product has already displaced them. `sar-deshift.py` does that negation, which is why it
owns it rather than leaving a minus sign at each call site. `packages/core/src/sarGeocode.ts` names
the two directions `geocodeOffsetMeters` and `maskOffsetMeters` for the same reason.

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



def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("annotation")
    parser.add_argument(
        "height",
        type=float,
        nargs="?",
        help="target surface height, metres above ellipsoid (omit with --grid)",
    )
    parser.add_argument(
        "--grid",
        action="store_true",
        help="emit the geolocation grid itself, for per-body interpolation",
    )
    parser.add_argument(
        "--look-right",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Sentinel-1 is right-looking; the flag exists so the assumption is visible",
    )
    args = parser.parse_args()

    root = ET.parse(args.annotation).getroot()
    points = grid_points(root)
    if not points:
        raise SystemExit(f"no geolocation grid points in {args.annotation}")

    # ⚠ **Scene averages, and they are the WRONG reference for any particular lake.** Kept because a
    # single figure is a useful thing to print, and because the calibration below is stated against
    # them — but nothing should geocode with them. See the `--grid` note.
    reference_height = sum(p["height"] for p in points) / len(points)
    incidence = sum(p["incidence"] for p in points) / len(points)
    heading = platform_heading(root, points)

    if args.grid:
        # ## Why the grid rather than a scene average — measured 2026-08-25
        #
        # The product is geocoded against **this grid**, whose points each carry their own terrain
        # height and incidence angle. A scene average is dominated by whatever the pass happened to
        # cover: measured across five real tracks over the same region, `referenceHeightM` ranged from
        # **7.9 m** (a pass mostly over the Gulf of Maine) to **369.6 m** (a pass over the White
        # Mountains) — a spread that says nothing about where any given lake sits.
        #
        # Against 10 lake-passes with a spread of elevations:
        #
        #     scene average h_ref + scene incidence   RMS residual 325.6 m   corr 0.28
        #     LOCAL h_ref + LOCAL incidence           RMS residual  44.7 m   corr 0.75
        #     no correction at all                    RMS residual  96.5 m
        #
        # ⚠ **The scene average was worse than not correcting**, which is the whole reason this mode
        # exists. Local incidence matters on its own too: it ranged 30.9°–44.8° across those lakes
        # while the scene mean sat at 38.6°, and `1/tan` changes by 60% over that span.
        json.dump(
            {
                "headingDeg": round(heading, 3),
                "sceneReferenceHeightM": round(reference_height, 2),
                "sceneIncidenceDeg": round(incidence, 3),
                "points": [
                    {
                        "lat": p["lat"],
                        "lng": p["lng"],
                        "heightM": p["height"],
                        "incidenceDeg": p["incidence"],
                    }
                    for p in points
                ],
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return

    if args.height is None:
        raise SystemExit("give a height, or --grid")

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
