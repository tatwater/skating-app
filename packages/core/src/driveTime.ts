/**
 * Pure drive-time band classification (Phase 4). Turns a viewer's cached isochrone polygons + outer
 * radius (all derived from their PRIVATE `homeCoord`, D11) into a coarse `30 | 60 | 90 | null` band
 * for any lake point — the soft, quality-weighted distance signal that narrows the feed and gates
 * notifications. Kept framework-free in `@skating/core` so the Convex query and both clients classify
 * a body identically (D7/D40).
 *
 * Why polygons, not a membership table (decision #2): within 90 min of a NE home there can be
 * hundreds–thousands of bodies; materializing `userId × body × band` balloons per-user and goes stale
 * on every corpus change. A point-in-polygon test at read time auto-classifies any new body for free.
 *
 * The 60-min hosted-ORS cap is real: the public OpenRouteService isochrone API is hardcoded to a max
 * range of 3600 s for `driving-car`. So the **30 and 60 bands are true ORS isochrone polygons**, while
 * the **90 band is a uniform crow-flies radius fallback** (`outerRadiusMeters`) — an over-approximation
 * acceptable for the outer, aspirational "would I make a special trip?" ring. Self-hosted ORS for a
 * true 90-min isochrone is deferred (see roadmap Later/deferred).
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { haversineMeters, type LatLng, pointInPolygon } from './geometry';

/** The three drive-time bands, in minutes — matches the feed filter's radius options (decision #3). */
export const DRIVE_TIME_BANDS = [30, 60, 90] as const;
export type DriveTimeBand = (typeof DRIVE_TIME_BANDS)[number];

/** True when `value` is one of the three canonical band minutes (30/60/90). */
export function isDriveTimeBand(value: unknown): value is DriveTimeBand {
  return (DRIVE_TIME_BANDS as readonly unknown[]).includes(value);
}

/**
 * A viewer's cached drive-time geometry, all derived from their private home and stored on the
 * profile (schema `cachedIsochrones` + `outerRadiusMeters`). Every field is optional: a viewer with
 * no home set has none of these, and `bandForCoord` then returns `null` for every point.
 *  - `band30` / `band60`: ORS `driving-car` isochrone polygons (nested: band30 ⊂ band60).
 *  - `outerRadiusMeters`: the crow-flies radius standing in for the 90-min band.
 */
export interface DriveTimeBands {
  band30?: Polygon | MultiPolygon;
  band60?: Polygon | MultiPolygon;
  outerRadiusMeters?: number;
}

/**
 * The tightest band a point falls in, or `null` when it's beyond the outer radius (or the viewer has
 * no cached geometry). Checks inner-to-outer so a point inside both the 30 and 60 polygons classifies
 * as 30 (bands nest). The 90 test is a crow-flies radius from `home`, so `home` is required to resolve
 * the outer band; the polygon bands are self-positioned and don't need it.
 */
export function bandForCoord(
  point: LatLng,
  bands: DriveTimeBands,
  home?: LatLng,
): DriveTimeBand | null {
  if (bands.band30 && pointInPolygon(point, bands.band30)) return 30;
  if (bands.band60 && pointInPolygon(point, bands.band60)) return 60;
  if (
    bands.outerRadiusMeters !== undefined &&
    home !== undefined &&
    isWithinRadius(home, point, bands.outerRadiusMeters)
  ) {
    return 90;
  }
  return null;
}

/** Is `point` within `radiusMeters` (crow-flies) of `center`? The 90-band primitive. */
export function isWithinRadius(center: LatLng, point: LatLng, radiusMeters: number): boolean {
  return haversineMeters(center, point) <= radiusMeters;
}

/** The ORS isochrone ranges we request (seconds): the 30- and 60-min bands. 60 is the hosted cap. */
export const ORS_BAND_RANGES_SEC = { band30: 1800, band60: 3600 } as const;

/**
 * Conservative effective driving speed for the crow-flies 90-min band (decision #2). Rural NE
 * effective speed ≪ highway, and a crow-flies ring already *over*-approximates reach (ignores roads /
 * mountains / water crossings), so we start low. Tunable.
 */
export const OUTER_BAND_SPEED_MPH = 45;
const METERS_PER_MILE = 1609.344;

/** Crow-flies radius (metres) for the outer band: `speed × minutes`. The 90-min fallback ring. */
export function outerBandRadiusMeters(
  minutes: number,
  speedMph: number = OUTER_BAND_SPEED_MPH,
): number {
  return speedMph * (minutes / 60) * METERS_PER_MILE;
}

/** The subset of an ORS isochrone `FeatureCollection` we read: features tagged with their range (s). */
export interface OrsIsochroneResponse {
  features?: {
    properties?: { value?: number };
    geometry?: Polygon | MultiPolygon;
  }[];
}

/**
 * Pull the 30/60-min band polygons out of an OpenRouteService isochrone response (`driving-car`,
 * `range_type: time`, ranges 1800/3600 s). Matches each feature by its `properties.value` (the range
 * in seconds) rather than array order, so a reordered response still classifies correctly. A missing
 * band (ORS omitted it, or the geometry was absent) is simply left off — `bandForCoord` treats an
 * absent polygon as "not in that band." Pure so it's tested without a live ORS call.
 */
export function parseOrsIsochrones(response: OrsIsochroneResponse): {
  band30?: Polygon | MultiPolygon;
  band60?: Polygon | MultiPolygon;
} {
  const out: { band30?: Polygon | MultiPolygon; band60?: Polygon | MultiPolygon } = {};
  for (const feature of response.features ?? []) {
    const value = feature.properties?.value;
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (value === ORS_BAND_RANGES_SEC.band30) out.band30 = geometry;
    else if (value === ORS_BAND_RANGES_SEC.band60) out.band60 = geometry;
  }
  return out;
}

/**
 * Does a lake's band satisfy a `radiusMinutes` filter — i.e. is it *within* the selected radius?
 * A `null` band (beyond the outer ring, or no home set) never satisfies a radius filter. Bands nest,
 * so "within 60" accepts 30 and 60 but not 90. Distance is a HARD filter (unlike the include-unknown
 * optional attributes); favorites are exempt from it entirely (applied by the caller, not here).
 */
export function bandWithinRadius(
  band: DriveTimeBand | null,
  radiusMinutes: DriveTimeBand,
): boolean {
  return band !== null && band <= radiusMinutes;
}
