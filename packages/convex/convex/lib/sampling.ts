/**
 * Weather sample-point selection (Phase 10 / D56 §5). Shared by the decay cron, conditions auto-fill,
 * contradiction check, and the drawer-open strip so **all four resolve a body/hazard to the exact same
 * point** — the guarantee behind the "one window → one cache entry → strip & decay agree" claim. Lives
 * here (not in `hazardWeather.ts`) so `weather.ts` can import it without a cycle.
 *
 * v1 samples every body at one derived point; the escape hatch is `waterBodies.weatherSamplePoints[]` for
 * the few genuinely multi-cell giants (Champlain ~200 km), where a hazard/report picks its nearest point.
 *
 * **That derived point is `interiorPoint`, not `centroid` (N6c).** `centroid` is Turf's
 * `pointOnFeature`, which falls back to a point on the **shoreline** whenever the bbox centre lands
 * outside the polygon — true of any curved or narrow lake, and measured at **30.7 km** off mid-lake for
 * Champlain. Against Open-Meteo's 2–25 km grid that is one to several cells wrong, on an input the D56
 * decay math is supposed to be reproducible from. Every *other* `centroid` consumer wants the old
 * behaviour (you drive to a shore, and a shore is in the shore's town), which is why this is a second
 * field rather than a correction to the first.
 */

import { type WeatherCell, type WeatherTier, weatherCellFor } from '@skating/core';
import type { Doc } from '../_generated/dataModel';

/** Squared degree distance — fine for picking the nearest of a handful of sample points at lake scale. */
function distSq(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

/**
 * The nearest weather sample point to `target` — the body's derived interior point by default
 * (D56 §5), falling back to `centroid` for any body not yet re-imported with one.
 */
export function nearestSamplePoint(
  body: Doc<'waterBodies'>,
  target: { lat: number; lng: number },
): { lat: number; lng: number } {
  const fallback = body.interiorPoint ?? body.representativePoint ?? body.centroid;
  const points = body.weatherSamplePoints?.length ? body.weatherSamplePoints : [fallback];
  let best = points[0] ?? fallback;
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

/**
 * The point to sample when there is no anchor to be near (N6c B5b).
 *
 * The weather-since strip always has one — a report's put-in, a hazard's centre — because it is
 * *about* something that happened somewhere. A body-level forward forecast is about the lake, so it
 * samples the lake: the same interior point every other consumer falls back to, which on a
 * multi-sample-point giant like Champlain resolves to whichever stored point is nearest mid-lake.
 *
 * Deliberately the same fallback chain as `nearestSamplePoint`'s, in the same order — two places
 * deciding "which point represents this body" by different rules is how the fetch profile ended up
 * casting rays from the shoreline.
 */
export function defaultSampleAnchor(body: Doc<'waterBodies'>): { lat: number; lng: number } {
  return body.interiorPoint ?? body.representativePoint ?? body.centroid;
}

/**
 * **The one place a body becomes a weather cell (N6h / D152).**
 *
 * Four independent consumers reach Open-Meteo through `resolveWeatherSince` — the drawer strip, the
 * hazard decay cron, the bounty reopen gate and the contradiction settle — and Phase 10 §5's
 * strip↔decay consistency invariant depends on all four resolving the *same* body to the *same*
 * cache entry. Before N6h that agreement was a convention: each site called `nearestSamplePoint` and
 * then, separately, the key function. Adding an elevation band to the key made that convention
 * dangerous, because a site that resolved the point but forgot the elevation would key into a
 * *different, valid-looking* entry and fork the cache silently — the strip describing one window
 * while the decay applied another.
 *
 * So the cell is the unit that travels, not a loose pair of coordinates. `resolveWeatherSince` and
 * `resolveForecast` take a `WeatherCell`, which can only come from here, which means the four cannot
 * disagree without deleting this function.
 *
 * `target` is the thing the weather is *about* — a report's put-in, a hazard's centre — used to pick
 * among a giant's `weatherSamplePoints`. Omit it for a body-level question and it falls back to
 * `defaultSampleAnchor`.
 */
export function bodyWeatherCell(
  body: Doc<'waterBodies'>,
  tier: WeatherTier,
  target?: { lat: number; lng: number },
): WeatherCell {
  const point = nearestSamplePoint(body, target ?? defaultSampleAnchor(body));
  // ⚠ The body's own elevation, not the sample point's. On a multi-point giant those differ in
  // principle; in practice a lake surface is level, which is exactly why one elevation per body is
  // the right model and why `elevationM` lives on the body rather than on each sample point.
  return weatherCellFor(tier, point.lat, point.lng, body.elevationM);
}

/** Center of a hazard's footprint bbox — its representative point for nearest-sample-point selection. */
export function hazardCenter(hazard: Doc<'hazards'>): { lat: number; lng: number } {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}
