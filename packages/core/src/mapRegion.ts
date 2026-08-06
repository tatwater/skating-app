/**
 * Where our data lives, as one set of numbers both apps read.
 *
 * This used to be `NORTHEAST_MAX_BOUNDS`, duplicated in each app's `waterMap.ts`, and it did two
 * jobs that have now come apart. It was the **fence** MapLibre would not let you pan out of, and it
 * was the **extent** used to decide whether a device fix is somewhere we can say anything about. The
 * fence is gone: with a whole-planet overview archive beneath the map there is a world to look at,
 * and a user who wanders to Australia is offered a way back rather than prevented from leaving.
 * What remains is the extent, which is what these numbers always actually described.
 *
 * The numbers themselves moved with the change. The old southern edge was 41.2°N — the downstate
 * clip, chosen when the basemap was a rectangle and New York City sat outside it. New York now
 * renders in full (founder, 2026-08-05), so the extent is the true five-state bounding box, taken
 * from the TIGER union in `scripts/admin-areas/src/buildRegion.ts`. The corpus still stops at I-84;
 * that is a fact about the water we store, not about the map, and it lives in the ETL.
 */

import { type BBox, bboxIntersects } from './geometry';

/**
 * The five states' bounding box: New York's western line to Maine's eastern tip, Long Island's south
 * shore to northern Maine. Rounded outward from the TIGER union so it can only ever be generous.
 */
export const REGION_BOUNDS: BBox = {
  minLng: -79.8,
  minLat: 40.4,
  maxLng: -66.8,
  maxLat: 47.5,
};

/** The same box as MapLibre's south-west/north-east corner pair, which is what cameras take. */
export const REGION_BOUNDS_CORNERS: [[number, number], [number, number]] = [
  [REGION_BOUNDS.minLng, REGION_BOUNDS.minLat],
  [REGION_BOUNDS.maxLng, REGION_BOUNDS.maxLat],
];

/** Whether a coordinate falls inside the region — the "can we say anything about here?" test. */
export function isInRegion(
  coord: { lat: number; lng: number },
  region: BBox = REGION_BOUNDS,
): boolean {
  return (
    coord.lng >= region.minLng &&
    coord.lng <= region.maxLng &&
    coord.lat >= region.minLat &&
    coord.lat <= region.maxLat
  );
}

/**
 * Whether the region has left the screen entirely — the cue to offer a way back.
 *
 * A plain bbox intersection, deliberately: *any* sliver of the five states on screen and the user
 * still has their bearings, so nothing is offered. Zoomed all the way out the region is a few
 * pixels, but it is on screen and they can see where they are; pan to Kansas and it is not, and they
 * cannot. Offering the way home at the moment home stops being visible is the same rule a person
 * would apply.
 */
export function isRegionOffscreen(viewport: BBox, region: BBox = REGION_BOUNDS): boolean {
  return !bboxIntersects(viewport, region);
}
