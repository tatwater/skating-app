#!/usr/bin/env python3
"""
Mascoma Lake -> layered SVG, for design work in Figma.

This is a *port*, not a redraw. Every shape comes from the same artifacts the app ships:

  * basemap   scripts/basemap/.scratch/northeast-20260805.pmtiles   (== the dev VITE_PMTILES_URL)
  * contours  scripts/bathymetry/.scratch/build/contours.geojsonl   (source of the bathymetry pmtiles)
  * shoreline waterBodies row relation/4056603, via `convex run waterBodies:get`
  * paint     @protomaps/basemaps `layers('protomaps', namedFlavor('dark'))` + the app's own
              WATER_PALETTE / CONTOUR_PALETTE

## Target width drives zoom, and that is the whole design

Vector-tile roads are *lines whose weight is the stroke*, not geometry -- so you cannot thin them to
a flat 1px without destroying the highway > major > minor hierarchy. What you can do is ask the
question the app already answers: "what does this look like at the zoom where the frame is N pixels
wide?" Protomaps' own width expressions are functions of zoom, so evaluating them at that zoom thins
every road *proportionally to its class* and keeps the hierarchy intact.

So: pick a size, and the script derives the matching zoom, reads geometry from the tile zoom nearest
it, and evaluates every paint expression there. The mobile export is not the desktop one shrunk --
it is the app at z13.2, with the strokes, label density and generalisation that implies.

Sizes are given as **how wide the lake itself should be**, not the canvas: the lake is 33.9% of the
frame, the rest being the 3 mi buffer, so a 400px lake lands on a 1181px canvas.

Run `python3 build_svg.py --lake-width 640` for a one-off size.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from collections import defaultdict

from osgeo import gdal, ogr

gdal.UseExceptions()

# --------------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------------

ROOT = "/Users/teagan/Code/skating"
HERE = os.path.join(ROOT, "exports/mascoma")
SRC = os.path.join(HERE, "src")

PMTILES = os.path.join(ROOT, "scripts/basemap/.scratch/northeast-20260805.pmtiles")
CONTOURS = os.path.join(SRC, "mascoma-contours.geojsonl")
BODY = os.path.join(SRC, "mascoma-body.json")
STYLE = os.path.join(SRC, "protomaps-dark-style.json")

BUFFER_MILES = 3.0
MAX_TILE_ZOOM = 14        # the archive's max zoom

# name, LAKE width in px, contour step (2 == keep only every 20 ft).
#
# Sized by the lake, not the canvas, because that is the dimension you design to -- the lake is
# only 33.9% of the frame's width, the other two thirds being the 3 mi buffer. A 400px lake means
# a 1181px canvas. Scale depends only on zoom, so the buffer changes the canvas and nothing else.
PRESETS = [("mobile", 400, 1), ("desktop", 1000, 1)]

# The app's own palette, dark theme (apps/web/src/lib/waterMap.ts, apps/web/src/lib/contourMap.ts).
WATER_FILL = "#3a6ea5"
WATER_OUTLINE = "#9ecae1"
# `water-outline` is line-width 1 at rest and 2.5 when selected/favorited. Contours only render
# with the drawer open (D81), and open means selected -- so 2.5 is the state that pairs with them.
LAKE_OUTLINE_WIDTH = 2.5
# CONTOUR_PALETTE.dark -- note this INVERTS vs light: shallow is dim, deep is bright.
CONTOUR_SHALLOW = "#155671"   # ice[800]
CONTOUR_DEEP = "#63e0f9"      # ice[300]
CONTOUR_OPACITY = 0.75
# contourWidthExpression(): interpolate linear on zoom, 11 -> 0.5, 14 -> 1.1, 17 -> 1.6
CONTOUR_WIDTH_STOPS = [(11, 0.5), (14, 1.1), (17, 1.6)]

SIMPLIFY_PX = 0.25        # geometry tolerance, in output pixels
MIN_RING_PX = 6.0         # drop contour rings shorter than this at the target size

R = 6378137.0
WORLD = 2 * math.pi * R

LABEL_LAYERS = {
    "water_waterway_label", "roads_labels_minor", "earth_label_islands", "water_label_lakes",
    "roads_labels_major", "places_subplace", "places_region", "places_locality",
}

# Who wins a collision. Deliberately by importance, not by MapLibre's placement order (which is
# style order, and would let a minor road name beat a town). Lower number wins.
LABEL_PRIORITY = {
    "places_locality": 0, "places_region": 1, "water_label_lakes": 2, "places_subplace": 3,
    "roads_labels_major": 4, "earth_label_islands": 5, "roads_labels_minor": 6,
    "water_waterway_label": 7,
}
LABEL_PAD = 2.0        # px of breathing room around each label box
LABEL_OCCLUSION = 0.5  # drop a label with more than this fraction of its box under the lake


# --------------------------------------------------------------------------------------------
# MapLibre expression / filter evaluation
# --------------------------------------------------------------------------------------------


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _lerp_color(a, b, t):
    def hx(c):
        c = c.lstrip("#")
        if len(c) == 3:
            c = "".join(ch * 2 for ch in c)
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    ca, cb = hx(a), hx(b)
    return "#%02x%02x%02x" % tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))


def interp_stops(stops, z):
    if z <= stops[0][0]:
        return stops[0][1]
    if z >= stops[-1][0]:
        return stops[-1][1]
    for i in range(len(stops) - 1):
        x0, y0 = stops[i]
        x1, y1 = stops[i + 1]
        if x0 <= z <= x1:
            return y0 + (y1 - y0) * (z - x0) / (x1 - x0)
    return stops[-1][1]


def ev(e, props, gtype, zoom):
    """Evaluate a MapLibre expression (modern) or legacy filter node."""
    if not isinstance(e, list):
        return e
    if not e:
        return None
    op = e[0]

    if op == "literal":
        return e[1]
    if op == "zoom":
        return zoom
    if op == "geometry-type":
        return gtype
    if op == "get":
        return props.get(ev(e[1], props, gtype, zoom))
    if op == "has":
        key = ev(e[1], props, gtype, zoom) if isinstance(e[1], list) else e[1]
        return key in props and props[key] is not None
    if op == "!has":
        return not (e[1] in props and props[e[1]] is not None)
    if op == "!":
        return not ev(e[1], props, gtype, zoom)
    if op == "all":
        return all(ev(x, props, gtype, zoom) for x in e[1:])
    if op == "any":
        return any(ev(x, props, gtype, zoom) for x in e[1:])
    if op == "none":
        return not any(ev(x, props, gtype, zoom) for x in e[1:])

    if op in ("==", "!=", "<", ">", "<=", ">="):
        # Legacy: ["==", "kind", "park"]. Modern: ["==", ["get","kind"], "park"].
        if isinstance(e[1], str):
            left = gtype if e[1] == "$type" else props.get(e[1])
            right = e[2]
        else:
            left = ev(e[1], props, gtype, zoom)
            right = ev(e[2], props, gtype, zoom)
        if op == "==":
            return left == right
        if op == "!=":
            return left != right
        ln, rn = _num(left), _num(right)
        if ln is None or rn is None:
            return False
        return {"<": ln < rn, ">": ln > rn, "<=": ln <= rn, ">=": ln >= rn}[op]

    if op in ("in", "!in"):
        if isinstance(e[1], str):
            val = gtype if e[1] == "$type" else props.get(e[1])
            hit = val in e[2:]
        else:
            val = ev(e[1], props, gtype, zoom)
            hit = val in (ev(e[2], props, gtype, zoom) or [])
        return hit if op == "in" else not hit

    if op == "case":
        i = 1
        while i + 1 < len(e):
            if ev(e[i], props, gtype, zoom):
                return ev(e[i + 1], props, gtype, zoom)
            i += 2
        return ev(e[-1], props, gtype, zoom) if len(e) % 2 == 0 else None

    if op == "match":
        val = ev(e[1], props, gtype, zoom)
        i = 2
        while i + 1 < len(e):
            labels = e[i] if isinstance(e[i], list) else [e[i]]
            if val in labels:
                return ev(e[i + 1], props, gtype, zoom)
            i += 2
        return ev(e[-1], props, gtype, zoom)

    if op == "coalesce":
        for x in e[1:]:
            v = ev(x, props, gtype, zoom)
            if v is not None:
                return v
        return None

    if op == "step":
        val = _num(ev(e[1], props, gtype, zoom))
        out = ev(e[2], props, gtype, zoom)
        i = 3
        while i + 1 < len(e):
            if val is not None and val >= _num(e[i]):
                out = ev(e[i + 1], props, gtype, zoom)
            i += 2
        return out

    if op == "interpolate":
        interp = e[1]
        base = float(interp[1]) if isinstance(interp, list) and interp[0] == "exponential" else 1.0
        val = _num(ev(e[2], props, gtype, zoom))
        stops = [(float(e[i]), ev(e[i + 1], props, gtype, zoom)) for i in range(3, len(e), 2)]
        if val is None or not stops:
            return stops[0][1] if stops else None
        if val <= stops[0][0]:
            return stops[0][1]
        if val >= stops[-1][0]:
            return stops[-1][1]
        for i in range(len(stops) - 1):
            x0, y0 = stops[i]
            x1, y1 = stops[i + 1]
            if x0 <= val <= x1:
                if x1 == x0:
                    return y0
                t = ((val - x0) / (x1 - x0) if base == 1.0
                     else (base ** (val - x0) - 1) / (base ** (x1 - x0) - 1))
                if isinstance(y0, str) and y0.startswith("#"):
                    return _lerp_color(y0, y1, t)
                n0, n1 = _num(y0), _num(y1)
                return y0 if n0 is None or n1 is None else n0 + (n1 - n0) * t
        return stops[-1][1]

    if op == "to-number":
        v = _num(ev(e[1], props, gtype, zoom))
        return v if v is not None else 0
    if op == "to-string":
        return str(ev(e[1], props, gtype, zoom))
    if op == "concat":
        return "".join(str(ev(x, props, gtype, zoom) or "") for x in e[1:])
    return None


def paint_of(layer, key, props, gtype, zoom, default=None):
    p = layer.get("paint", {})
    if key not in p:
        return default
    v = ev(p[key], props, gtype, zoom)
    return default if v is None else v


def layer_visible(layer, zoom):
    """MapLibre layer zoom gate: minzoom inclusive, maxzoom exclusive.

    Not optional. 23 of these 71 layers carry a gate, and the `_early`/`_late` road casing pairs
    are split at exactly z12 -- ignore it and every major road gets both casings at once.
    """
    if "minzoom" in layer and zoom < layer["minzoom"]:
        return False
    if "maxzoom" in layer and zoom >= layer["maxzoom"]:
        return False
    return True


# --------------------------------------------------------------------------------------------
# Projection + frame
# --------------------------------------------------------------------------------------------


def lonlat_to_3857(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def deg_per_metre(lat):
    """Ellipsoidal degree lengths, so '3 miles' is 3 ground miles and not 3 mercator miles."""
    p = math.radians(lat)
    return (111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p),
            111412.84 * math.cos(p) - 93.5 * math.cos(3 * p))


body = json.load(open(BODY))["body"]
bb = body["bbox"]
mlat, mlon = deg_per_metre((bb["minLat"] + bb["maxLat"]) / 2)
pad = BUFFER_MILES * 1609.344

MIN_LNG, MAX_LNG = bb["minLng"] - pad / mlon, bb["maxLng"] + pad / mlon
MIN_LAT, MAX_LAT = bb["minLat"] - pad / mlat, bb["maxLat"] + pad / mlat

X0, Y0 = lonlat_to_3857(MIN_LNG, MIN_LAT)
X1, Y1 = lonlat_to_3857(MAX_LNG, MAX_LAT)
SPAN_X, SPAN_Y = X1 - X0, Y1 - Y0
# The lake's own bbox width in 3857 units -- what the presets are measured against.
LAKE_SPAN_X = R * math.radians(bb["maxLng"] - bb["minLng"])

clip_ring = ogr.Geometry(ogr.wkbLinearRing)
for cx, cy in [(X0, Y0), (X1, Y0), (X1, Y1), (X0, Y1), (X0, Y0)]:
    clip_ring.AddPoint_2D(cx, cy)
CLIP = ogr.Geometry(ogr.wkbPolygon)
CLIP.AddGeometry(clip_ring)

# Set per preset.
MPP = 1.0
W = H = 0.0


def px(x, y):
    return ((x - X0) / MPP, (Y1 - y) / MPP)


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def ring_d(pts, close):
    out, prev = [], None
    for x, y in pts:
        p = px(x, y)
        q = (round(p[0], 2), round(p[1], 2))
        if q == prev:
            continue
        prev = q
        out.append(("M" if not out else "L") + f"{fmt(p[0])},{fmt(p[1])}")
    if not out:
        return ""
    if close and len(out) > 2:
        out.append("Z")
    return "".join(out)


def geom_d(g, close):
    if g is None or g.IsEmpty():
        return ""
    t = ogr.GT_Flatten(g.GetGeometryType())
    if t == ogr.wkbPoint:
        return ""
    if t in (ogr.wkbLineString, ogr.wkbLinearRing):
        return ring_d([g.GetPoint_2D(i) for i in range(g.GetPointCount())], close)
    return "".join(geom_d(g.GetGeometryRef(i), close) for i in range(g.GetGeometryCount()))


# --------------------------------------------------------------------------------------------
# Read the basemap, once per tile zoom
# --------------------------------------------------------------------------------------------

style = json.load(open(STYLE))
NEEDED = {l.get("source-layer") for l in style if l.get("source-layer")}
_cache: dict[int, dict] = {}


def read_basemap(tile_zoom):
    if tile_zoom in _cache:
        return _cache[tile_zoom]
    print(f"  reading tiles at z{tile_zoom} ...")
    ds = gdal.OpenEx(PMTILES, gdal.OF_VECTOR, open_options=[f"ZOOM_LEVEL={tile_zoom}"])
    out = defaultdict(list)
    for i in range(ds.GetLayerCount()):
        lyr = ds.GetLayer(i)
        if lyr.GetName() not in NEEDED:
            continue
        lyr.SetSpatialFilterRect(X0, Y0, X1, Y1)
        for feat in lyr:
            g = feat.GetGeometryRef()
            if g is None:
                continue
            g = g.Clone()
            try:
                if not g.Within(CLIP):
                    g = g.Intersection(CLIP)
            except Exception:
                continue
            if g is None or g.IsEmpty():
                continue
            t = ogr.GT_Flatten(g.GetGeometryType())
            gtype = ("Point" if t in (ogr.wkbPoint, ogr.wkbMultiPoint)
                     else "LineString" if t in (ogr.wkbLineString, ogr.wkbMultiLineString)
                     else "Polygon")
            props = {k: v for k, v in feat.items().items() if v is not None}
            out[lyr.GetName()].append((props, g, gtype))
    ds = None
    _cache[tile_zoom] = out
    return out


# --------------------------------------------------------------------------------------------
# Emit
# --------------------------------------------------------------------------------------------


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def sid(s):
    return re.sub(r"[^A-Za-z0-9_.-]", "-", s)


def label_text(props):
    for k in ("name:en", "name", "pgf:name"):
        v = props.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def line_anchor(g):
    best, blen = None, -1.0
    stack = [g]
    while stack:
        p = stack.pop()
        if ogr.GT_Flatten(p.GetGeometryType()) == ogr.wkbLineString:
            if p.GetPointCount() >= 2 and p.Length() > blen:
                blen, best = p.Length(), p
        else:
            stack.extend(p.GetGeometryRef(i) for i in range(p.GetGeometryCount()))
    if best is None:
        return None
    pts = [px(*best.GetPoint_2D(i)) for i in range(best.GetPointCount())]
    total = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    if total <= 0:
        return None
    half, run = total / 2, 0.0
    for i in range(len(pts) - 1):
        seg = math.dist(pts[i], pts[i + 1])
        if run + seg >= half:
            t = (half - run) / seg if seg else 0
            x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t
            y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
            ang = math.degrees(math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]))
            ang = ang - 180 if ang > 90 else ang + 180 if ang < -90 else ang
            return x, y, ang, total
        run += seg
    return None


def lake_occluder():
    """The lake polygon in output-pixel space, as a label obstacle.

    App layers draw above the basemap (see `basemapLayers.ts`), so the water fill covers any
    basemap label under it -- MapLibre's symbol collision never sees a fill drawn later. Faithful,
    but it renders as clipped text, so a label the lake would swallow is dropped instead.
    """
    poly = body["polygon"]
    polys = poly["coordinates"] if poly["type"] == "MultiPolygon" else [poly["coordinates"]]
    mp = ogr.Geometry(ogr.wkbMultiPolygon)
    for p in polys:
        og = ogr.Geometry(ogr.wkbPolygon)
        for r in p:
            ring = ogr.Geometry(ogr.wkbLinearRing)
            for c in r:
                ring.AddPoint_2D(*px(*lonlat_to_3857(c[0], c[1])))
            og.AddGeometry(ring)
        mp.AddGeometry(og)
    return mp


def box_geom(b):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for x, y in [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3]), (b[0], b[1])]:
        ring.AddPoint_2D(x, y)
    g = ogr.Geometry(ogr.wkbPolygon)
    g.AddGeometry(ring)
    return g


def basemap_groups(zoom, feats, tol, occluder=None):
    parts_by_lid, widths, cands = {}, {}, []
    for layer in style:
        lid, ltype, srcl = layer["id"], layer["type"], layer.get("source-layer")

        if ltype == "background":
            c = paint_of(layer, "background-color", {}, "Polygon", zoom, "#000000")
            parts_by_lid[lid] = [
                f'<rect x="0" y="0" width="{fmt(W)}" height="{fmt(H)}" fill="{c}"/>']
            continue

        if not layer_visible(layer, zoom) or not srcl or srcl not in feats:
            continue
        if ltype == "symbol" and lid not in LABEL_LAYERS:
            continue

        parts = []

        if ltype == "fill":
            buckets = defaultdict(list)
            for props, g, gtype in feats[srcl]:
                if gtype != "Polygon" or not ev(layer.get("filter", True), props, gtype, zoom):
                    continue
                d = geom_d(g.SimplifyPreserveTopology(tol) if tol > 0 else g, True)
                if not d:
                    continue
                buckets[(paint_of(layer, "fill-color", props, gtype, zoom, "#000"),
                         round(float(paint_of(layer, "fill-opacity", props, gtype, zoom, 1)), 3))].append(d)
            for (c, op), ds_ in buckets.items():
                if op <= 0.001:
                    continue
                oa = "" if op >= 0.999 else f' fill-opacity="{fmt(op)}"'
                parts.append(f'<path d="{"".join(ds_)}" fill="{c}"{oa} fill-rule="evenodd"/>')

        elif ltype == "line":
            casing = "line-gap-width" in layer.get("paint", {})
            buckets = defaultdict(list)
            for props, g, gtype in feats[srcl]:
                if gtype == "Point" or not ev(layer.get("filter", True), props, gtype, zoom):
                    continue
                w = float(paint_of(layer, "line-width", props, gtype, zoom, 1) or 0)
                gap = float(paint_of(layer, "line-gap-width", props, gtype, zoom, 0) or 0)
                # MapLibre draws a gap-width line as two strokes either side of the centreline.
                # One stroke of gap + 2*width beneath the fill layer is the same picture.
                eff = (gap + 2 * w) if casing else w
                if eff <= 0:
                    continue
                d = geom_d(g.SimplifyPreserveTopology(tol) if tol > 0 else g, gtype == "Polygon")
                if not d:
                    continue
                dash = layer.get("paint", {}).get("line-dasharray")
                if isinstance(dash, list) and dash and isinstance(dash[0], str):
                    dash = ev(dash, props, gtype, zoom)
                # dasharray is in units of line width, not pixels.
                ds_str = (",".join(fmt(float(x) * eff) for x in dash)
                          if isinstance(dash, list) and dash else "")
                op = round(float(paint_of(layer, "line-opacity", props, gtype, zoom, 1)), 3)
                buckets[(paint_of(layer, "line-color", props, gtype, zoom, "#000"),
                         round(eff, 3), op, ds_str)].append(d)
            for (c, w, op, ds_str), ds_ in buckets.items():
                widths[lid] = max(widths.get(lid, 0), w)
                oa = "" if op >= 0.999 else f' stroke-opacity="{fmt(op)}"'
                da = f' stroke-dasharray="{ds_str}"' if ds_str else ""
                parts.append(f'<path d="{"".join(ds_)}" fill="none" stroke="{c}" '
                             f'stroke-width="{fmt(w)}" stroke-linecap="round" '
                             f'stroke-linejoin="round"{oa}{da}/>')

        elif ltype == "symbol":
            # Gather only; placement is decided globally below, since labels collide across
            # layers ("Mascoma Lake" vs "Enfield Shaker Historic District") and not within one.
            lay = layer.get("layout", {})
            placement = lay.get("symbol-placement", "point")
            seen = {}
            for props, g, gtype in feats[srcl]:
                if not ev(layer.get("filter", True), props, gtype, zoom):
                    continue
                txt = label_text(props)
                if not txt:
                    continue
                size = float(ev(lay.get("text-size", 12), props, gtype, zoom) or 12)
                if placement == "line":
                    a = line_anchor(g)
                    if a is None:
                        continue
                    x, y, ang, total = a
                    if total < len(txt) * size * 0.55:
                        continue
                    if seen.get(txt, -1) >= total:   # MVT splits roads per tile; keep the longest
                        continue
                    seen[txt] = total
                    cands[:] = [c for c in cands if not (c["lid"] == lid and c["txt"] == txt)]
                    cands.append(dict(lid=lid, txt=txt, x=x, y=y, ang=ang, size=size))
                else:
                    c = g.Centroid()
                    x, y = px(c.GetX(), c.GetY())
                    key = (txt, round(x), round(y))
                    if key in seen:
                        continue
                    seen[key] = True
                    cands.append(dict(lid=lid, txt=txt, x=x, y=y, ang=None, size=size))

        if parts:
            parts_by_lid[lid] = parts

    # ---- global label collision -------------------------------------------------------------
    # MapLibre drops a label whose box hits one already placed. Without this, a small frame piles
    # four names on the same lake. Priority is by importance rather than by MapLibre's placement
    # order, which is the more useful behaviour for a mockup.
    style_by_id = {l["id"]: l for l in style}
    boxes, keep, occluded = [], [], 0
    for c in sorted(cands, key=lambda c: (LABEL_PRIORITY.get(c["lid"], 9), -c["size"])):
        w = len(c["txt"]) * c["size"] * 0.52 + LABEL_PAD
        h = c["size"] * 1.15 + LABEL_PAD
        if c["ang"]:
            a = math.radians(c["ang"])
            w, h = (abs(w * math.cos(a)) + abs(h * math.sin(a)),
                    abs(w * math.sin(a)) + abs(h * math.cos(a)))
        box = (c["x"] - w / 2, c["y"] - h / 2, c["x"] + w / 2, c["y"] + h / 2)
        if any(not (box[2] < b[0] or box[0] > b[2] or box[3] < b[1] or box[1] > b[3])
               for b in boxes):
            continue
        if occluder is not None:
            bg = box_geom(box)
            area = bg.GetArea()
            if area > 0:
                try:
                    if bg.Intersection(occluder).GetArea() / area > LABEL_OCCLUSION:
                        occluded += 1
                        continue
                except Exception:
                    pass
        boxes.append(box)
        keep.append(c)

    for c in keep:
        layer = style_by_id[c["lid"]]
        lay = layer.get("layout", {})
        color = paint_of(layer, "text-color", {}, "Point", zoom, "#fff")
        halo = paint_of(layer, "text-halo-color", {}, "Point", zoom, None)
        halo_w = float(paint_of(layer, "text-halo-width", {}, "Point", zoom, 0) or 0)
        halo_attr = (f' stroke="{halo}" stroke-width="{fmt(halo_w * 2)}" paint-order="stroke"'
                     f' stroke-linejoin="round"') if halo and halo_w > 0 else ""
        it = ' font-style="italic"' if "Italic" in json.dumps(lay.get("text-font", []) or []) else ""
        tf = (f' transform="rotate({fmt(c["ang"])} {fmt(c["x"])} {fmt(c["y"])})"'
              if c["ang"] is not None else "")
        parts_by_lid.setdefault(c["lid"], []).append(
            f'<text x="{fmt(c["x"])}" y="{fmt(c["y"])}"{tf} fill="{color}"{halo_attr} '
            f'font-family="Noto Sans, Inter, sans-serif"{it} '
            f'font-size="{fmt(c["size"])}" text-anchor="middle" '
            f'dominant-baseline="central">{esc(c["txt"])}</text>')

    print(f"    labels: {len(keep)} placed, "
          f"{len(cands) - len(keep) - occluded} dropped on collision, "
          f"{occluded} swallowed by the lake")

    out = []
    for layer in style:                       # reassemble in the style's own draw order
        p = parts_by_lid.get(layer["id"])
        if p:
            out.append(f'<g id="{sid(layer["id"])}" data-name="{esc(layer["id"])}">'
                       + "".join(p) + "</g>")
    return out, widths


def lake_groups(zoom, step, tol):
    poly = body["polygon"]
    polys = poly["coordinates"] if poly["type"] == "MultiPolygon" else [poly["coordinates"]]
    d = "".join(ring_d([lonlat_to_3857(c[0], c[1]) for c in r], True) for p in polys for r in p)

    lake = (f'<g id="Mascoma-Lake" data-name="Mascoma Lake">'
            f'<g id="Mascoma-Lake-fill" data-name="Fill">'
            f'<path d="{d}" fill="{WATER_FILL}" fill-rule="evenodd"/></g>'
            f'<g id="Mascoma-Lake-shoreline" data-name="Shoreline">'
            f'<path d="{d}" fill="none" stroke="{WATER_OUTLINE}" '
            f'stroke-width="{fmt(LAKE_OUTLINE_WIDTH)}" stroke-linejoin="round"/></g></g>')

    by_depth = defaultdict(list)
    for line in open(CONTOURS):
        if line.strip():
            f = json.loads(line)
            by_depth[f["properties"]["depthFt"]].append(f)

    interval = min(by_depth) if by_depth else 10
    depths = sorted(d_ for d_ in by_depth if d_ % (interval * step) == 0)
    top = max(by_depth) if by_depth else 1
    cw = interp_stops(CONTOUR_WIDTH_STOPS, zoom)

    groups, kept, dropped = [], 0, 0
    for depth in depths:
        # contourColorExpression: 0 -> shallow, maxDepthFt -> deep, scaled to THIS lake. The ramp
        # spans the lake's full depth even when `step` drops levels, so colours stay comparable.
        color = _lerp_color(CONTOUR_SHALLOW, CONTOUR_DEEP, min(1.0, depth / max(1, top)))
        rings = []
        for f in by_depth[depth]:
            g = f["geometry"]
            lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
            for ln in lines:
                pts = [lonlat_to_3857(c[0], c[1]) for c in ln]
                scr = [px(*p) for p in pts]
                length = sum(math.dist(scr[i], scr[i + 1]) for i in range(len(scr) - 1))
                if length < MIN_RING_PX:      # sub-pixel shoreline slivers, pure clutter
                    dropped += 1
                    continue
                if tol > 0:
                    lg = ogr.Geometry(ogr.wkbLineString)
                    for p in pts:
                        lg.AddPoint_2D(*p)
                    lg = lg.Simplify(tol)
                    pts = [lg.GetPoint_2D(i) for i in range(lg.GetPointCount())]
                dd = ring_d(pts, False)
                if dd:
                    rings.append(dd)
        if not rings:
            continue
        kept += len(rings)
        paths = "".join(
            f'<path id="Depth-{int(depth)}ft-{i + 1:02d}" d="{dd}" fill="none" stroke="{color}" '
            f'stroke-width="{fmt(cw)}" stroke-linecap="round" stroke-linejoin="round" '
            f'stroke-opacity="{CONTOUR_OPACITY}"/>' for i, dd in enumerate(rings))
        groups.append(f'<g id="Depth-{int(depth)}ft" data-name="{int(depth)} ft">{paths}</g>')

    print(f"    contours: {len(groups)} levels {[int(d_) for d_ in depths]}, "
          f"{kept} rings kept, {dropped} sub-{MIN_RING_PX:g}px slivers dropped, "
          f"stroke {cw:.2f}px")
    return [lake, '<g id="Bathymetry" data-name="Bathymetry">' + "".join(groups) + "</g>"]


def svg(groups):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(W)}" height="{fmt(H)}" '
            f'viewBox="0 0 {fmt(W)} {fmt(H)}">\n'
            f'<!-- Mascoma Lake, {BUFFER_MILES} mi buffer. (c) OpenStreetMap contributors '
            f'(Protomaps dark). Bathymetry: NH GRANIT. -->\n'
            + "\n".join(groups) + "\n</svg>\n")


# --------------------------------------------------------------------------------------------

ap = argparse.ArgumentParser()
ap.add_argument("--lake-width", type=float, help="one-off: how wide the lake itself should be, px")
ap.add_argument("--contour-step", type=int, default=1)
args = ap.parse_args()

jobs = ([("custom", args.lake_width, args.contour_step)] if args.lake_width else PRESETS)

for name, lake_w, step in jobs:
    MPP = LAKE_SPAN_X / lake_w
    W, H = SPAN_X / MPP, SPAN_Y / MPP
    # The zoom at which the app would draw this frame at this pixel width.
    zoom = math.log2(WORLD / (256 * MPP))
    tile_zoom = max(0, min(MAX_TILE_ZOOM, round(zoom)))
    tol = SIMPLIFY_PX * MPP

    print(f"\n{name}: lake {lake_w:.0f}px on a {W:.0f} x {H:.0f} canvas "
          f"-> paint z{zoom:.2f}, tiles z{tile_zoom}")
    feats = read_basemap(tile_zoom)
    bm, widths = basemap_groups(zoom, feats, tol, lake_occluder())
    lk = lake_groups(zoom, step, tol)

    for road in ("roads_highway", "roads_major", "roads_minor", "roads_other"):
        if road in widths:
            print(f"    {road:16s} {widths[road]:5.2f}px")

    wrapped = ['<g id="Basemap" data-name="Basemap">' + "".join(bm) + "</g>"]
    for fn, groups in (("composite", wrapped + lk), ("basemap", bm), ("lake", lk)):
        p = os.path.join(HERE, f"mascoma-{fn}-{name}.svg")
        with open(p, "w") as fh:
            fh.write(svg(groups))
        print(f"    {os.path.basename(p):34s} {os.path.getsize(p) / 1024:7.0f} KB")
