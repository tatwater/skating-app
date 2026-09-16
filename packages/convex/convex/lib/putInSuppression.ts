/**
 * The one rule a moderator's `hide` applies (decision #7): **a hide is a coordinate, not a status.**
 *
 * Hiding a put-in writes a separate `hidden` row and leaves the visible one alone, so that the
 * suppression outlives however many reports re-derive the marker. The consequence every reader has
 * to honour is that filtering on `status === 'visible'` does *nothing* to a hidden launch — the
 * hidden row is a different row. A reader that wants the launches a moderator has not hidden must
 * test each visible coord against the hidden coords with this predicate.
 *
 * Lives in `lib/` rather than `putIns.ts` because `subAreas.ts` needs it and `putIns.ts` already
 * imports `subAreas.ts` for the bay stamp; one shared module beats a module cycle.
 */

import { DEFAULT_PUTIN_MERGE_METERS, haversineMeters, type LatLng } from '@skating/core';

/** A derived cluster or official marker within this distance of a `hidden` coord is suppressed. */
export const HIDE_SUPPRESS_METERS = DEFAULT_PUTIN_MERGE_METERS;

/**
 * Is `coord` within the suppression radius of any moderator-hidden coord?
 *
 * Exported because a hidden coordinate has to suppress its neighbours **everywhere the coordinate is
 * read**, not only in `putIns.listForBody`. The imagery reveal mask (`imageryMasks`) buffers put-ins
 * into the shape a satellite photograph is allowed to show through, so a marker this predicate would
 * hide on the map but not in the bake would reveal the ground anyway — the same suppression, defeated
 * by the slower path. And a bay's drive-time coordinate (`subAreas.subAreaDriveCoordFor`) is judged
 * from its best launch, so a hidden one banding the bay would steer the feed and the nearby fan-out
 * to an access point a moderator has said not to use.
 */
export function isSuppressed(coord: LatLng, hidden: readonly { coord: LatLng }[]): boolean {
  return hidden.some((h) => haversineMeters(coord, h.coord) <= HIDE_SUPPRESS_METERS);
}
