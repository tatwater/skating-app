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

import area from '@turf/area'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import buffer from '@turf/buffer'
import { feature, featureCollection } from '@turf/helpers'
import intersect from '@turf/intersect'
import truncate from '@turf/truncate'
import type { Feature, LineString, MultiPolygon, Polygon, Position } from 'geojson'

/** A geographic point — mirrors the Convex `latLng` validator. */
export interface LatLng {
  lat: number
  lng: number
}

/** An axis-aligned bounding box — mirrors the Convex `bbox` validator. */
export interface BBox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
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
  )
}

/** The bounding box of a polygon / multipolygon / line — e.g. to fill `waterBodies.bbox`. */
export function polygonBBox(geom: Polygon | MultiPolygon | LineString): BBox {
  const positions: Position[] =
    geom.type === 'LineString'
      ? geom.coordinates
      : geom.type === 'Polygon'
        ? geom.coordinates.flat()
        : geom.coordinates.flat(2)

  let minLat = Number.POSITIVE_INFINITY
  let minLng = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  // GeoJSON positions are always `[lng, lat, …]`; cast past noUncheckedIndexedAccess.
  for (const [lng, lat] of positions as [number, number][]) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
  }
  return { minLat, minLng, maxLat, maxLng }
}

/** Is a point inside a polygon / multipolygon? (A point on the boundary counts as inside.) */
export function pointInPolygon(point: LatLng, polygon: Polygon | MultiPolygon): boolean {
  return booleanPointInPolygon([point.lng, point.lat], polygon)
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
  const fa = truncate(feature(a), { precision: 9 })
  const fb = truncate(feature(b), { precision: 9 })
  const shared = intersect(featureCollection([fa, fb]))
  const sharedArea = shared ? area(shared) : 0
  if (sharedArea === 0) return 0
  return sharedArea / (area(fa) + area(fb) - sharedArea)
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
  >
  const ribbonB = buffer(feature(b), bufferMeters, { units: 'meters' }) as Feature<
    Polygon | MultiPolygon
  >
  return polygonIoU(ribbonA.geometry, ribbonB.geometry)
}
