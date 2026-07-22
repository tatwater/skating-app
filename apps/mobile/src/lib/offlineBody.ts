/**
 * Pure offline body-resolution logic (F2 Layer 2) — kept free of the `expo-sqlite` glue (see
 * `bodyCache.ts`) so it's unit-testable, and reusable by the eventual Phase 9 hazard capture.
 *
 * The app caches the reference data of recently-viewed lakes on-device; offline, a device GPS fix
 * resolves *which* lake the skater is on/near via the shared `@skating/core` buffered ranker — so a
 * report captured with no signal still binds to the right body without a network round-trip.
 */

import { type LatLng, nearestBodyForPoint } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

/**
 * Parking/approach buffer (metres) for GPS→lake auto-select — so opening the app offline from the
 * car still resolves the lake (S1: access/put-ins are a dominant concern). Mirrors the server-side
 * `AUTOSELECT_BUFFER_M` in `waterBodies.resolveBodyForCoord`; tunable (Phase 7 admin controls, D37).
 */
export const AUTOSELECT_BUFFER_M = 300;

/** Reference data cached on-device for a recently-viewed body — enough to GPS-resolve it offline. */
export interface CachedBody {
  waterBodyId: string;
  name: string;
  states: string[];
  polygon: Polygon | MultiPolygon;
  centroid: LatLng;
  surfaceAreaSqM: number;
  cachedAt: number;
}

/**
 * Resolve a GPS coord to a cached body via the shared buffered ranker (inside-or-within-buffer,
 * smaller-area tie-break). Returns the body id + name, or null when none is near. Pure — the sqlite
 * load happens in `bodyCache.ts`.
 */
export function nearestCachedBody(
  rows: readonly CachedBody[],
  coord: LatLng,
  bufferMeters: number = AUTOSELECT_BUFFER_M,
): { waterBodyId: string; name: string } | null {
  const match = nearestBodyForPoint(
    coord,
    rows.map((r) => ({ ref: r, polygon: r.polygon, surfaceAreaSqM: r.surfaceAreaSqM })),
    bufferMeters,
  );
  return match ? { waterBodyId: match.waterBodyId, name: match.name } : null;
}
