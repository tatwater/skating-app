/**
 * Where a track started, as a put-in (A10 §7.1 / D198): the GPS start snaps to the nearest known
 * A06d put-in only inside `PUT_IN_SNAP_METERS`; outside it the sheet asks. Nearest-snap with no
 * bound pulls a start in an unmapped cove onto the launch in the next bay, and A06d's coverage is
 * good but not complete — inside a constant, snap; otherwise it is the skater's choice.
 *
 * The same distance orders the put-in picker (nearest first) and the no-track hazard list (§6 (d),
 * nearest to the chosen put-in first), so one rule answers "which is closest" everywhere.
 */

import { haversineMeters, type LatLng } from './geometry';

/** The snap radius — 150 m to start, tuned on real tracks after a season (open at scoping #2). */
export const PUT_IN_SNAP_METERS = 150;

export interface SnappablePutIn {
  id: string;
  coord: LatLng;
}

/** The put-ins nearest to `from`, ascending, with the distance each is at. */
export function putInsByDistance<T extends SnappablePutIn>(
  putIns: readonly T[],
  from: LatLng,
): (T & { meters: number })[] {
  return putIns
    .map((p) => ({ ...p, meters: haversineMeters(from, p.coord) }))
    .sort((a, b) => a.meters - b.meters);
}

/**
 * The put-in a start point snaps to, or `null` when none is inside the radius. Ties (two launches
 * at the same distance) go to the first in the list, which is the server's order.
 */
export function snapPutIn<T extends SnappablePutIn>(
  putIns: readonly T[],
  start: LatLng,
  radiusMeters: number = PUT_IN_SNAP_METERS,
): (T & { meters: number }) | null {
  const [nearest] = putInsByDistance(putIns, start);
  return nearest !== undefined && nearest.meters <= radiusMeters ? nearest : null;
}
