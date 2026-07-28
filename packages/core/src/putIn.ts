/**
 * Pure put-in helpers (Phase 4, decision #7). Put-in markers give a lake a *routable* access point —
 * a report `point` can be dropped mid-lake / on the ice, so it is NOT itself a put-in. These helpers
 * (1) cluster nearby report points into candidate access markers, (2) snap a coord to the nearest
 * shore/road edge, and (3) build a platform directions deep link. Kept framework-free in
 * `@skating/core` so the Convex `putIns` derivation and both clients agree (D7/D40).
 *
 * Directions always target a put-in coord, NEVER the on-water `centroid` — the centroid is a
 * guaranteed on-water point (D48), so routing there drives you into the middle of the lake.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { haversineMeters, type LatLng } from './geometry';

/** Reports within this crow-flies distance collapse into one put-in marker (same access point). */
export const DEFAULT_PUTIN_MERGE_METERS = 150;

/**
 * A report point feeding the clusterer, optionally carrying when that skate ended.
 *
 * `at` is optional so every existing caller passing bare coords still type-checks, and so the one
 * consumer that needs dates doesn't force them on the ones that don't.
 */
export type PutInPoint = LatLng & { at?: number };

/** A derived put-in candidate: a representative coord, how many report points fed it, and its age. */
export interface PutInCluster {
  coord: LatLng;
  reportCount: number;
  /**
   * The **newest** `at` among the member points — "when somebody last got on the ice here".
   *
   * Newest rather than oldest, and surfaced rather than kept internal, because a put-in is a claim
   * that people access the lake at this spot, and an access point can go stale in ways ice never
   * does: land changes hands, a gate appears, a pull-off is posted. A marker derived from one 2023
   * report should not render with the same confidence as one skaters used last week, and the only way
   * a viewer can tell is if we say. Absent when no member point carried a date.
   */
  lastUsedAt?: number;
}

/**
 * Greedily cluster report points into put-in candidates: each point joins the first existing cluster
 * within `mergeMeters` of its running centroid, else seeds a new one. Order-dependent (documented) but
 * deterministic for a given input — fine for *approximate* derived markers, which a moderator can hide
 * and an admin can override with an `official` pin. Returns clusters in first-seen order.
 */
export function clusterPutIns(
  points: readonly PutInPoint[],
  mergeMeters: number = DEFAULT_PUTIN_MERGE_METERS,
): PutInCluster[] {
  const clusters: { coord: LatLng; count: number; lastUsedAt?: number }[] = [];
  for (const point of points) {
    const hit = clusters.find((c) => haversineMeters(c.coord, point) <= mergeMeters);
    if (hit) {
      // Running mean so the marker settles at the centroid of its member points.
      const n = hit.count + 1;
      hit.coord = {
        lat: (hit.coord.lat * hit.count + point.lat) / n,
        lng: (hit.coord.lng * hit.count + point.lng) / n,
      };
      hit.count = n;
      if (point.at !== undefined && (hit.lastUsedAt === undefined || point.at > hit.lastUsedAt)) {
        hit.lastUsedAt = point.at;
      }
    } else {
      clusters.push({
        coord: { lat: point.lat, lng: point.lng },
        count: 1,
        ...(point.at !== undefined ? { lastUsedAt: point.at } : {}),
      });
    }
  }
  return clusters.map((c) => ({
    coord: c.coord,
    reportCount: c.count,
    ...(c.lastUsedAt !== undefined ? { lastUsedAt: c.lastUsedAt } : {}),
  }));
}

/** Mean Earth radius in metres (matches `geometry.ts` / Turf's WGS84 mean radius). */
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Project a `[lng, lat]` position into local metres relative to `origin` (equirectangular). */
function toLocal([lng, lat]: readonly [number, number], origin: LatLng): [number, number] {
  return [
    (lng - origin.lng) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG),
    (lat - origin.lat) * DEG * EARTH_RADIUS_M,
  ];
}

/** Inverse of `toLocal`: local metres back to a `{ lat, lng }` relative to `origin`. */
function fromLocal([x, y]: [number, number], origin: LatLng): LatLng {
  return {
    lat: origin.lat + y / (DEG * EARTH_RADIUS_M),
    lng: origin.lng + x / (DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG)),
  };
}

/** Closest point (local metres) on segment `a–b` to the origin `(0,0)`; handles a zero-length edge. */
function closestOnSegment(
  [ax, ay]: [number, number],
  [bx, by]: [number, number],
): { point: [number, number]; dist: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
  const point: [number, number] = [ax + t * dx, ay + t * dy];
  return { point, dist: Math.hypot(point[0], point[1]) };
}

/**
 * Snap `coord` to the nearest point on the polygon's boundary (shore / road edge) — the derived
 * put-in refinement: a mid-lake report point moves to the shore where you'd actually park. Uses a
 * local equirectangular projection around `coord`, so it's pure and dependency-free. Returns `coord`
 * unchanged if the polygon has no usable edge (degenerate input).
 */
export function snapToEdge(coord: LatLng, polygon: Polygon | MultiPolygon): LatLng {
  const rings = polygon.type === 'Polygon' ? polygon.coordinates : polygon.coordinates.flat(1);
  let best: { point: [number, number]; dist: number } | null = null;
  for (const ring of rings) {
    const local = (ring as [number, number][]).map((c) => toLocal(c, coord));
    for (let i = 0; i + 1 < local.length; i++) {
      const candidate = closestOnSegment(
        local[i] as [number, number],
        local[i + 1] as [number, number],
      );
      if (best === null || candidate.dist < best.dist) best = candidate;
    }
  }
  return best === null ? coord : fromLocal(best.point, coord);
}

/** Target platform for a directions deep link. */
export type DirectionsPlatform = 'ios' | 'android' | 'web';

/**
 * Platform-aware directions deep link to `coord` (decision #7): Apple Maps on iOS, Google Maps
 * elsewhere. The destination must be a put-in coord, never the on-water centroid. Coordinates are
 * emitted `lat,lng` (both providers' order).
 */
export function directionsUrl(coord: LatLng, platform: DirectionsPlatform): string {
  const dest = `${coord.lat},${coord.lng}`;
  if (platform === 'ios') return `https://maps.apple.com/?daddr=${dest}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}
