/**
 * Which place a body's weather panel is about (N6h / open question 5).
 *
 * ## The problem this solves
 *
 * A body-level weather panel has no target. Lake Champlain is 170 km end to end and carries zero
 * `weatherSamplePoints`, so PR 1's panel read one point near the middle and — honestly — said so.
 * But the ten named bays people actually skate (Malletts Bay is 26 mentions in the Google Group
 * corpus, Button Bay 32) land in ten distinct Tier-A cells, and **not one of them is the cell that
 * reading came from.** The reading was not merely coarse; it described a spot that is not any of
 * the destinations.
 *
 * ## The rule (founder call, 2026-09-11)
 *
 * **A giant opens pre-selected on its most prominent bay, with a switcher.** The effective sub-area
 * is:
 *
 * 1. the route's `?sub=` (`focusSubAreaId`) when it names a live bay of this body — a search hit or
 *    a switcher tap, both explicit;
 * 2. else the highest-`displayScore` bay — *implicitly*, and the caller must never write that
 *    default back to the URL, or opening a lake would be a navigation;
 * 3. else `null`: a body with no bays is its own place, and the panel reads its anchor.
 *
 * `displayScore` rather than area: it is N2's D49 curve over area *plus* curation, so a curated
 * Malletts Bay beats a larger, unloved reach — which is the point of having curated at all.
 *
 * ## Why this is one function in core
 *
 * Both clients resolve it, the server validates what they send, and the spread's tap targets rely
 * on the same "which bay is selected" answer. Two resolutions is how the picker and the panel end up
 * describing different places. Everything here is pure and takes the projection `subAreas.listForBody`
 * already returns, so neither client has a second query to make.
 */

export interface WeatherSubAreaCandidate {
  _id: string;
  name: string;
  displayScore: number;
  removed?: boolean;
}

/**
 * The bay a body's weather should be about, or `null` for a body that is its own place.
 * Deterministic on ties (higher score, then name) so two renders cannot pick two bays.
 */
export function resolveWeatherSubArea<T extends WeatherSubAreaCandidate>(
  subAreas: readonly T[] | undefined,
  focusSubAreaId: string | undefined,
): T | null {
  if (!subAreas || subAreas.length === 0) return null;
  const live = subAreas.filter((s) => s.removed !== true);
  if (live.length === 0) return null;
  if (focusSubAreaId) {
    const focused = live.find((s) => s._id === focusSubAreaId);
    if (focused) return focused;
  }
  let best = live[0] as T;
  for (const s of live) {
    if (s.displayScore > best.displayScore) best = s;
    else if (s.displayScore === best.displayScore && s.name.localeCompare(best.name) < 0) best = s;
  }
  return best;
}

/**
 * The point a sub-area's weather is sampled at.
 *
 * `representativePoint` when N2 stored one, else the deprecated `centroid` — both are the same
 * on-water `pointOnFeature` basis (D48), and a sub-area has no `interiorPoint` because the polygon
 * is a bay rather than a whole lake and the shoreline failure that forced `interiorPoint` onto bodies
 * (a crescent's bbox centre landing on land) is far rarer on a compact bay. Deliberately one chain,
 * here, so the registry's sub-area pass and the panel's read cannot key two cells for one bay.
 */
export function subAreaWeatherPoint(subArea: {
  representativePoint?: { lat: number; lng: number } | undefined;
  centroid: { lat: number; lng: number };
}): { lat: number; lng: number } {
  return subArea.representativePoint ?? subArea.centroid;
}
