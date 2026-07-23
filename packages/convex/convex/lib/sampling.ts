/**
 * Weather sample-point selection (Phase 10 / D56 §5). Shared by the decay cron, conditions auto-fill,
 * contradiction check, and the drawer-open strip so **all four resolve a body/hazard to the exact same
 * point** — the guarantee behind the "one window → one cache entry → strip & decay agree" claim. Lives
 * here (not in `hazardWeather.ts`) so `weather.ts` can import it without a cycle.
 *
 * v1 samples every body at its centroid; the escape hatch is `waterBodies.weatherSamplePoints[]` for the
 * few genuinely multi-cell giants (Champlain ~200 km), where a hazard/report picks its nearest point.
 */

import type { Doc } from '../_generated/dataModel';

/** Squared degree distance — fine for picking the nearest of a handful of sample points at lake scale. */
function distSq(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

/** The nearest weather sample point to `target` — the body's centroid by default (D56 §5). */
export function nearestSamplePoint(
  body: Doc<'waterBodies'>,
  target: { lat: number; lng: number },
): { lat: number; lng: number } {
  const points = body.weatherSamplePoints?.length ? body.weatherSamplePoints : [body.centroid];
  let best = points[0] ?? body.centroid;
  let bestD = distSq(best, target);
  for (const p of points) {
    const d = distSq(p, target);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Center of a hazard's footprint bbox — its representative point for nearest-sample-point selection. */
export function hazardCenter(hazard: Doc<'hazards'>): { lat: number; lng: number } {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}
