/**
 * Which place a body's weather panel is about (A06h / open question 5).
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
 * ## The rule (founder call, 2026-11-07 — reversing 2026-09-11)
 *
 * **A lake opens on the whole lake, with a switcher.** The effective sub-area is:
 *
 * 1. the route's `?sub=` (`focusSubAreaId`) when it names a live bay of this body — a search hit or
 *    a switcher tap, both explicit;
 * 2. else `null`: the whole lake, and the panel reads the lake's own anchor. A `?sub=` naming a bay
 *    delisted since the link was made, or another lake's, lands here too.
 *
 * The 2026-09-11 call pre-selected a giant's most prominent bay (highest `displayScore`) instead.
 * The web tab was built to the whole-lake default, and the founder kept that (2026-11-07) so web
 * and mobile open a lake on the same place: nothing is pre-chosen for the skater, and a bay is
 * always one they asked for.
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
  removed?: boolean;
}

/**
 * The bay a body's weather should be about, or `null` for the whole lake: the focused bay when it
 * is a live one of these, and nothing implicit otherwise.
 */
export function resolveWeatherSubArea<T extends WeatherSubAreaCandidate>(
  subAreas: readonly T[] | undefined,
  focusSubAreaId: string | undefined,
): T | null {
  if (!subAreas || !focusSubAreaId) return null;
  return subAreas.find((s) => s._id === focusSubAreaId && s.removed !== true) ?? null;
}

/**
 * The point a body's weather is sampled at when nothing more specific is asked for — the same
 * fallback chain `nearestSamplePoint` uses on the server, lifted here so the map can compute a
 * body's *filter* cell from the row `listInViewport` already gave it (D166): the filter tier does
 * not band by elevation, so the key is purely positional and the client can own the lookup.
 * The server's `defaultSampleAnchor` delegates here; two chains would be two cells for one lake.
 */
export function bodyWeatherAnchor(body: {
  interiorPoint?: { lat: number; lng: number };
  representativePoint?: { lat: number; lng: number };
  centroid: { lat: number; lng: number };
}): { lat: number; lng: number } {
  return body.interiorPoint ?? body.representativePoint ?? body.centroid;
}

/**
 * The point a sub-area's weather is sampled at.
 *
 * `representativePoint` when A02 stored one, else the deprecated `centroid` — both are the same
 * on-water `pointOnFeature` basis (D48), and a sub-area has no `interiorPoint` because the polygon
 * is a bay rather than a whole lake and the shoreline failure that forced `interiorPoint` onto bodies
 * (a crescent's bbox center landing on land) is far rarer on a compact bay. Deliberately one chain,
 * here, so the registry's sub-area pass and the panel's read cannot key two cells for one bay.
 */
export function subAreaWeatherPoint(subArea: {
  representativePoint?: { lat: number; lng: number } | undefined;
  centroid: { lat: number; lng: number };
}): { lat: number; lng: number } {
  return subArea.representativePoint ?? subArea.centroid;
}
