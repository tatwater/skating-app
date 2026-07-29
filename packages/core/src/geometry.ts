/**
 * Pure geospatial geometry helpers (D5/D36) — the math behind dedup, viewport, and
 * proximity queries. Kept framework-free in `@skating/core` so it's unit-testable in
 * isolation and reusable from a Convex query later (Turf is pure JS; no `"use node"`).
 *
 * Coordinate conventions:
 *  - Domain points/boxes use `{ lat, lng }` / `{ minLat, … }`, matching the Convex
 *    `latLng` / `bbox` validators.
 *  - GeoJSON geometries use `[lng, lat]` positions (the spec order) — these helpers do
 *    the conversion so callers never juggle axis order.
 */

import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import buffer from '@turf/buffer';
import { feature, featureCollection } from '@turf/helpers';
import intersect from '@turf/intersect';
import pointOnFeature from '@turf/point-on-feature';
import truncate from '@turf/truncate';
import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson';

/** A geographic point — mirrors the Convex `latLng` validator. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** An axis-aligned bounding box — mirrors the Convex `bbox` validator. */
export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * Do two bounding boxes overlap (touching edges count)? The cheap prefilter before any
 * precise polygon test — and the intended basis for **viewport** queries: a water body
 * is "in view" when its `bbox` intersects the map viewport, NOT merely when its centroid
 * is inside (a large lake can fill the screen with its centroid off-screen). See D5.
 */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  return (
    a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat
  );
}

/** The bounding box of a polygon / multipolygon / line — e.g. to fill `waterBodies.bbox`. */
export function polygonBBox(geom: Polygon | MultiPolygon | LineString): BBox {
  const positions: Position[] =
    geom.type === 'LineString'
      ? geom.coordinates
      : geom.type === 'Polygon'
        ? geom.coordinates.flat()
        : geom.coordinates.flat(2);

  let minLat = Number.POSITIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  // GeoJSON positions are always `[lng, lat, …]`; cast past noUncheckedIndexedAccess.
  for (const [lng, lat] of positions as [number, number][]) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, minLng, maxLat, maxLng };
}

/** Is a point inside a polygon / multipolygon? (A point on the boundary counts as inside.) */
export function pointInPolygon(point: LatLng, polygon: Polygon | MultiPolygon): boolean {
  return booleanPointInPolygon([point.lng, point.lat], polygon);
}

/** Mean Earth radius in metres (matches Turf's WGS84 mean radius). */
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * Great-circle (crow-flies) distance between two points in metres — the shared radius primitive
 * behind the Phase-4 90-min drive band (a uniform crow-flies fallback, since hosted ORS caps
 * isochrones at 60 min) and put-in clustering. Uses the haversine formula on the WGS84 mean radius,
 * which is exact enough at drive-time / lake scale and dependency-free.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The point `distanceMeters` away from `origin` along `bearingDeg` (degrees clockwise from north) —
 * the **inverse** of the equirectangular projection `toLocalMetres` uses, so a point projected out and
 * measured back with `haversineMeters` round-trips to sub-1% at the sub-km scale this serves. Feeds the
 * Phase 9.5 on-ice directional projection (walk the skater's course forward, test each step against a
 * hazard footprint); dependency-free, matching the rest of this file's flat-earth-around-the-point math.
 */
export function destinationPoint(
  origin: LatLng,
  bearingDeg: number,
  distanceMeters: number,
): LatLng {
  const bearing = bearingDeg * DEG;
  const east = distanceMeters * Math.sin(bearing);
  const north = distanceMeters * Math.cos(bearing);
  return {
    lat: origin.lat + north / (EARTH_RADIUS_M * DEG),
    lng: origin.lng + east / (EARTH_RADIUS_M * Math.cos(origin.lat * DEG) * DEG),
  };
}

/**
 * Project a GeoJSON `[lng, lat]` position into local metres relative to `origin`
 * (equirectangular / flat-earth around the origin). Exact enough at lake / parking-lot
 * scale — sub-1% distance error out to several km, far tighter than the ~300 m buffer this
 * feeds — and dependency-free, so `distanceToPolygonMeters` doesn't pull a new Turf module.
 */
function toLocalMetres([lng, lat]: readonly [number, number], origin: LatLng): [number, number] {
  return [
    (lng - origin.lng) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG),
    (lat - origin.lat) * DEG * EARTH_RADIUS_M,
  ];
}

/** Distance from `(px,py)` to segment `a–b`, all in local metres. Handles a zero-length edge. */
function segmentDistanceMetres(
  px: number,
  py: number,
  [ax, ay]: [number, number],
  [bx, by]: [number, number],
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distance in metres from `point` to the nearest edge of `polygon` — **`0` when the point is
 * inside** (boundary counts as inside, per `pointInPolygon`). The proximity primitive behind
 * offline body auto-select (F2), the map-open "you're at this lake" framing, and Phase 9 hazard
 * binding: a skater standing in the parking lot is *near* the lake though not *on* it, so a plain
 * `pointInPolygon` would miss them.
 *
 * Uses a local equirectangular projection around the query point (see `toLocalMetres`), so it's
 * pure/dependency-free and accurate far beyond the buffer distances that consume it.
 */
export function distanceToPolygonMeters(point: LatLng, polygon: Polygon | MultiPolygon): number {
  if (pointInPolygon(point, polygon)) return 0;
  const rings: Position[][] =
    polygon.type === 'Polygon' ? polygon.coordinates : polygon.coordinates.flat(1);
  let min = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    const local = (ring as [number, number][]).map((c) => toLocalMetres(c, point));
    for (let i = 0; i + 1 < local.length; i++) {
      const d = segmentDistanceMetres(
        0,
        0,
        local[i] as [number, number],
        local[i + 1] as [number, number],
      );
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Is `point` inside `polygon` **or within `bufferMeters` of it** — a tunable parking/approach
 * radius so opening the app offline from the car still resolves the lake (S1: access/put-ins are a
 * dominant concern). Convenience over `distanceToPolygonMeters`; rank multiple hits by that distance.
 */
export function pointNearPolygon(
  point: LatLng,
  polygon: Polygon | MultiPolygon,
  bufferMeters: number,
): boolean {
  return distanceToPolygonMeters(point, polygon) <= bufferMeters;
}

/** A body considered for point→lake resolution: an opaque `ref` + the geometry to test against. */
export interface BodyCandidate<T> {
  ref: T;
  polygon: Polygon | MultiPolygon;
  surfaceAreaSqM: number;
}

/**
 * Resolve a GPS point to the lake it's on / nearest to, within `bufferMeters` — the shared ranker
 * behind offline auto-select (mobile, over the on-device body cache) and the flush-time coord→body
 * resolver (Convex, over geospatially-nearby bodies). Ranks by distance ascending (a point *inside*
 * a polygon is distance 0), tie-breaking on **smaller area** so a nested inlet / small lake wins
 * over the big body it sits within (most specific). Returns `null` when nothing is within the
 * buffer. Kept pure so both callers share one contract and it's unit-testable.
 */
export function nearestBodyForPoint<T>(
  point: LatLng,
  candidates: readonly BodyCandidate<T>[],
  bufferMeters: number,
): T | null {
  let best: { ref: T; distance: number; area: number } | null = null;
  for (const c of candidates) {
    const distance = distanceToPolygonMeters(point, c.polygon);
    if (distance > bufferMeters) continue;
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && c.surfaceAreaSqM < best.area)
    ) {
      best = { ref: c.ref, distance, area: c.surfaceAreaSqM };
    }
  }
  return best?.ref ?? null;
}

/**
 * A representative point *guaranteed to lie on the water body's surface* (Turf
 * `pointOnFeature`) — the **on-water** point stored as `waterBodies.centroid` (D48).
 *
 * NOT the area centroid: the centroid of a crescent / horseshoe / ring-shaped lake can
 * land on dry land in the concavity, which would break both the geospatial point index
 * and D20's "fit the map to this lake." `pointOnFeature` always returns a point within the
 * polygon (in the area of a Polygon, on one of the parts of a MultiPolygon), so a skater
 * tapping the map or a "nearest body" query never resolves to a point off the water.
 *
 * **MultiPolygon:** the point lands on *one* component. That's fine for the point index
 * because the public viewport query (`waterBodies.listInViewport`) keys off **bbox
 * intersection** — the stored `bbox` spans every component, so a viewport near any part
 * returns the body. The single point is representative/framing only; a future
 * nearest-point query over multipart bodies would want per-component points (not needed now).
 *
 * **Throws** on degenerate geometry (a collapsed ring `pointOnFeature` can't place a point
 * on). The Convex `create` path only sees validator-checked shapes, but the OSM ETL sees raw
 * data — it must guard **per feature** (log + skip) so one bad polygon can't abort the batch.
 */
export function representativePoint(geom: Polygon | MultiPolygon): LatLng {
  // GeoJSON positions are `[lng, lat]`; cast past noUncheckedIndexedAccess.
  const [lng, lat] = pointOnFeature(feature(geom)).geometry.coordinates as [number, number];
  return { lat, lng };
}

/** Surface area of a water body's polygon in square metres (geodesic; wraps `@turf/area`). */
export function surfaceAreaSqM(geom: Polygon | MultiPolygon): number {
  return area(feature(geom));
}

/**
 * Intersection-over-union of two polygons, in `[0, 1]` (`0` = disjoint, `1` = identical).
 * The dedup similarity metric for area-like water bodies (D36). Uses geodesic areas, so
 * the ratio is projection-independent; union area comes from inclusion–exclusion
 * (`area(A) + area(B) − area(A∩B)`), avoiding a separate, failure-prone union call.
 *
 * Coordinates are truncated to ~9 decimals (~0.1 mm) first: sub-epsilon float noise
 * (e.g. `0.01` vs `0.010000000000000002`) makes the polygon clipper choke on
 * near-coincident edges with an "unable to complete output ring" error — and
 * near-coincident is *exactly* the near-duplicate case dedup exists to catch (D36).
 */
export function polygonIoU(a: Polygon | MultiPolygon, b: Polygon | MultiPolygon): number {
  const fa = truncate(feature(a), { precision: 9 });
  const fb = truncate(feature(b), { precision: 9 });
  const shared = intersect(featureCollection([fa, fb]));
  const sharedArea = shared ? area(shared) : 0;
  if (sharedArea === 0) return 0;
  return sharedArea / (area(fa) + area(fb) - sharedArea);
}

/**
 * Does a closed ring cross itself?
 *
 * Written for hazard polygon authoring (N5b): a ring tapped out on a phone can easily come back as a
 * bowtie, and a bowtie's buffered footprint is not a statement about where the hazard is — it is two
 * lobes joined at a point nobody stood on. terra-draw prevents this on web; the tap-to-place path on
 * mobile has no such engine, and the server has no client at all it can trust, so the predicate has to
 * live somewhere both can call.
 *
 * Tested in raw lng/lat rather than a local projection on purpose: self-intersection is a
 * **topological** property, and at lake scale the planar approximation cannot flip a crossing into a
 * non-crossing. Projecting first would cost accuracy nowhere and a dependency somewhere.
 *
 * Adjacent segments share an endpoint by construction — including the closing pair — so they are
 * skipped rather than reported as touching. Collinear overlap *is* reported: a ring that doubles back
 * along its own edge encloses no area there and is the same lie as a crossing.
 */
export function ringSelfIntersects(ring: readonly Position[]): boolean {
  // A ring is closed, so its last position repeats its first; the segment list is one shorter.
  const n = ring.length - 1;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    // Start at i+2: segment i and i+1 share a vertex legitimately.
    for (let j = i + 2; j < n; j++) {
      // The first and last segments also share a vertex (the ring's closure point).
      if (i === 0 && j === n - 1) continue;
      if (
        segmentsIntersect(
          ring[i] as [number, number],
          ring[i + 1] as [number, number],
          ring[j] as [number, number],
          ring[j + 1] as [number, number],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Twice the signed area of triangle `o→a→b`; sign gives which side of `o→a` the point `b` is on. */
function orient(
  [ox, oy]: readonly [number, number],
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Is collinear point `q` within the bounding box of segment `p–r`? */
function withinSegmentBox(
  [px, py]: readonly [number, number],
  [qx, qy]: readonly [number, number],
  [rx, ry]: readonly [number, number],
): boolean {
  return (
    qx >= Math.min(px, rx) &&
    qx <= Math.max(px, rx) &&
    qy >= Math.min(py, ry) &&
    qy <= Math.max(py, ry)
  );
}

/** Do segments `p1–p2` and `p3–p4` share any point? (CLRS, including the collinear-touch cases.) */
function segmentsIntersect(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && withinSegmentBox(p3, p1, p4)) return true;
  if (d2 === 0 && withinSegmentBox(p3, p2, p4)) return true;
  if (d3 === 0 && withinSegmentBox(p1, p3, p2)) return true;
  if (d4 === 0 && withinSegmentBox(p1, p4, p2)) return true;
  return false;
}

/**
 * Similarity of two lines by buffering each to `bufferMeters` and taking the IoU of the
 * resulting ribbons. Rivers/reaches are compared this way rather than by raw IoU (D36):
 * two stretches of the same river overlap as buffered corridors even though the
 * center-lines never coincide exactly. Requires valid, distinct-point lines — `buffer`
 * throws on a degenerate line rather than returning empty, so no undefined-guard needed.
 */
export function bufferedLineOverlap(a: LineString, b: LineString, bufferMeters: number): number {
  const ribbonA = buffer(feature(a), bufferMeters, { units: 'meters' }) as Feature<
    Polygon | MultiPolygon
  >;
  const ribbonB = buffer(feature(b), bufferMeters, { units: 'meters' }) as Feature<
    Polygon | MultiPolygon
  >;
  return polygonIoU(ribbonA.geometry, ribbonB.geometry);
}
