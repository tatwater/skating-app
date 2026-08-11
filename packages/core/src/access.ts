/**
 * Lake access: how you get onto the ice, as a set of pure rules (N6d / D72, D87, D143, D144).
 *
 * `putIns` has been a bare coordinate since Phase 4, and `directionsUrl` routes a car to it. For a
 * drive-up launch that is right; for a hike-in pond it hands a maps app a destination it cannot route
 * to, and the skater finds that out at the trailhead, in winter, an hour from home. This module holds
 * the vocabulary that fixes it — the approach classification, the association radii the OSM pass is
 * allowed to guess within, and the deterministic fallback label for a launch OSM never named.
 *
 * ## Why the thresholds are constants here rather than rows somewhere
 *
 * Every number below is a **product line**, not a measurement (D144). There is no dataset of where a
 * walk stops being a walk, so none of these can be fitted, and a database row would invite them to be
 * changed by whoever is annoyed by one this week. They live in code, move by founder call, and surface
 * read-only on the Phase 7b tuning page like every other constant in that family.
 *
 * The one exception is `PARKING_INFER_RADIUS_M`, which *is* a guess about geometry and *will* be
 * falsified by a dense state — see its own note.
 */

import { bearingDegrees, type LatLng } from './geometry';
import { compassPointFor } from './lakeGeometry';

/**
 * How you get from the car to the ice. Derived from a routed approach distance, with an operator
 * override for the cases where the number lies (a routed path that crosses private land, a lot whose
 * geometry puts its centroid on the far side of a building).
 */
export const APPROACH_KINDS = ['drive_up', 'short_walk', 'hike_in'] as const;
export type ApproachKind = (typeof APPROACH_KINDS)[number];

/**
 * At or under this, there is no approach worth a sentence — a pull-off and a bank.
 *
 * Set at 150 m rather than 0 because parking geometry is noisy: a lot is a polygon and we route from
 * its centroid, so a launch directly beside a lot routinely measures 40–120 m. Calling that a walk
 * would put a "short walk" chip on every drive-up boat ramp in the corpus, which is how a chip stops
 * meaning anything.
 */
export const DRIVE_UP_MAX_M = 150;

/**
 * Beyond this it is a hike, not a walk (D144).
 *
 * 800 m is roughly ten minutes in boots carrying skates, a chair and a shovel — the point where a trip
 * acquires a *decision* rather than a walk from the car. The founder's framing is the test: nobody
 * should discover this at the trailhead.
 */
export const SHORT_WALK_MAX_M = 800;

/**
 * Above this a human must **assert** `hike_in` rather than have it derived for them (D144).
 *
 * A mile, and it is the founder's own example of the lakes this phase exists for (*"you park at least a
 * mile from the ice"*). The asymmetry is what makes it a demand rather than a chip: everything else
 * here is derived from a routed distance and is wrong at worst by a category, but a **human-entered**
 * association at this range is the one input in this phase that costs its author nothing and costs a
 * stranger a night — mistyping a lot ten miles away sends someone to the wrong trailhead in the dark
 * (D72 amendment, ramification 4). Requiring the assertion means a long approach cannot be entered
 * silently: the author has to state the thing the chip will then tell everyone.
 */
export const HIKE_IN_ASSERT_M = 1600;

/**
 * How far the **OSM pass** will reach to guess that a lot serves a put-in with no human saying so.
 *
 * **This caps inference, never assertion** (D72 amendment). An operator or author may associate
 * parking with a body at any distance — a mile-away trailhead lot is not an edge case to tolerate, it
 * is the case the phase exists for.
 *
 * Unlike the three above, this one is a genuine guess about geometry rather than a product line, and
 * it should be eyeballed against one state's real output before a full run. Getting it wrong costs
 * some missed or spurious *inferences* and never a rejected human assertion, which is exactly the
 * bounded blast radius the amendment bought.
 */
export const PARKING_INFER_RADIUS_M = 250;

/**
 * How close an OSM access feature must be to a body's shoreline to attach to it.
 *
 * Tight on purpose, and it can afford to be: a slipway, beach or pier is *on* the water by
 * definition, so the only slack needed is the disagreement between OSM's shoreline and ours (we
 * simplify to ~5 m, and post-N7 a body's outline may come from NHD rather than OSM at all). A loose
 * radius here does not find more launches, it finds the *wrong lake* — which is the one failure mode
 * that produces a wrong answer instead of no answer.
 */
export const PUTIN_SHORE_RADIUS_M = 30;

/**
 * The approach kind implied by a distance, or `undefined` when there is no distance to imply one
 * from.
 *
 * `undefined` rather than a default is deliberate and it is the same discipline D68 applies to depth:
 * *"no parking is associated, so we cannot tell you about the walk"* and *"you can drive up"* are
 * different statements, and defaulting the first to the second would tell a skater they can park at
 * the ice on every one of the ~25k bodies OSM has never heard of. A missing approach renders as
 * nothing at all.
 */
export function approachKindFor(approachMeters: number | undefined): ApproachKind | undefined {
  if (approachMeters === undefined || !Number.isFinite(approachMeters) || approachMeters < 0) {
    return undefined;
  }
  if (approachMeters <= DRIVE_UP_MAX_M) return 'drive_up';
  if (approachMeters <= SHORT_WALK_MAX_M) return 'short_walk';
  return 'hike_in';
}

/**
 * The kind actually shown: an operator's override wins over the derived value, always.
 *
 * Kept as one function rather than resolved at each call site because "which one wins" is exactly the
 * kind of rule that gets re-implemented slightly differently on the third screen — the same reasoning
 * that put the depth ladder in one place.
 */
export function resolveApproachKind(
  approachMeters: number | undefined,
  override: ApproachKind | undefined,
): ApproachKind | undefined {
  return override ?? approachKindFor(approachMeters);
}

/**
 * Must a human explicitly assert `hike_in` for an association at this distance (D144)?
 *
 * Answers a **UI gate**, not a validation rule — the mutation still stores what it is told, because
 * refusing the write would make a legitimate mile-away trailhead unenterable. What this changes is
 * that the author has to say the words rather than have them inferred.
 */
export function requiresHikeInAssertion(approachMeters: number | undefined): boolean {
  return approachMeters !== undefined && approachMeters > HIKE_IN_ASSERT_M;
}

/**
 * Is a walk long enough to be worth telling a skater about before they drive?
 *
 * The chip's predicate, shared by the map card, the drawer and the feed card so the three cannot
 * disagree about which lakes are hike-in — which they would, since each has its own reason to round.
 */
export function isHikeIn(kind: ApproachKind | undefined): boolean {
  return kind === 'hike_in';
}

/**
 * A deterministic fallback name for a launch OSM never named — *"North launch"*, *"ESE launch"*.
 *
 * **Deterministic is the whole requirement.** It is re-derived on every re-import and therefore never
 * drifts, it needs no storage, and it happens to match how skaters already talk about a lake's ends.
 * The bearing is taken off the body's interior point rather than its `centroid`, because `centroid` is
 * Turf's `pointOnFeature` and lands *on the shoreline* — a launch measured against a point already on
 * the shore gives a bearing that is noise.
 *
 * Returns a 16-point compass name so a lake with several launches gets distinguishable labels; a
 * four-point version collides constantly on the long, narrow bodies this region is made of.
 */
export function compassSideLabel(point: LatLng, interiorPoint: LatLng): string {
  return `${compassPointFor(bearingDegrees(interiorPoint, point))} launch`;
}

/**
 * The name to show for a put-in: OSM's, if OSM had one, else the derived compass label.
 *
 * A single resolver so no surface can accidentally render a blank where a label was available — and
 * so the *absence* of a stored name is never mistaken for the absence of a lake to measure against.
 * When there is no interior point to take a bearing from (a body whose geometry never loaded), the
 * answer is `undefined` and the caller falls back to whatever it says for an unnamed marker, rather
 * than to a compass point computed from nothing.
 */
export function resolvePutInName(
  storedName: string | undefined,
  point: LatLng,
  interiorPoint: LatLng | undefined,
): string | undefined {
  const trimmed = storedName?.trim();
  if (trimmed) return trimmed;
  return interiorPoint ? compassSideLabel(point, interiorPoint) : undefined;
}
