/**
 * Lake depth: the provenance ladder, the shallow classifier, and the display framing (D68/D69, N6a).
 *
 * **Why a ladder rather than a source.** No single dataset gives us lake depth. Some of what exists is
 * measured (a state agency's depth-sounder transects; LAGOS-US DEPTH's ~65 compiled monitoring sources)
 * and some is modelled (HydroLAKES' `Depth_avg` = volume/area off a 90 m DEM; GLOBathy's `Dmax` from a
 * random forest). A modelled depth is perfectly adequate as a volatility signal and must **not** be
 * rendered like a survey, so every stored depth carries where it came from — and because LAGOS-US holds
 * 17,675 maxima against 6,137 means, a body routinely carries a measured max next to a modelled mean.
 * Provenance is therefore **per measurement**, never per body (D68).
 *
 * **Why shallowness is a boolean.** The decay consumer (D69) needs one bit, and it has to be a bit,
 * because the manual `shallow_bay_early_thaw` `bodyFeature` — which is how a local flags a pond nobody
 * has ever sounded — carries no number and feeds the same input. That flag is permanent infrastructure,
 * not a stand-in: 73% of the corpus sits below every global source's area floor, and small ponds are
 * exactly where "goes out early" is most predictive.
 *
 * The thresholds here are the tunable-magnitude kind (like `HAZARD_DECAY`): the *direction* is locked by
 * physics, the numbers are defaults to refit. Surfaced read-only on the Phase 7b tuning page.
 */

/**
 * Where a stored depth came from, best first. The order **is** the precedence ladder (D68) — see
 * `DEPTH_SOURCE_RANK`, which derives from this array so the two can never disagree.
 *
 *  - `operator`            — typed into the per-lake editor by a moderator: a state-agency survey read
 *                            off a chart, or local knowledge. Beats every automated rung and is never
 *                            overwritten by an import.
 *  - `state_agency`        — bulk-loaded from a state bathymetry dataset (deferred to N6b, where those
 *                            datasets are fetched for their contours anyway).
 *  - `lagos_us`            — LAGOS-US DEPTH v1.0: *observed* depth compiled from ~65 sources, lakes > 1 ha.
 *  - `hydrolakes_reported` — HydroLAKES `Depth_avg` where `Vol_src` is 1 or 2, i.e. derived from a
 *                            **reported** volume rather than the geostatistical model. Splitting this out
 *                            is free and treating all of HydroLAKES as modelled would discard real data.
 *  - `hydrolakes_modeled`  — HydroLAKES `Depth_avg` where `Vol_src` is 3 (modelled volume ÷ area).
 *  - `globathy`            — GLOBathy `Dmax`, a random forest over shoreline length / area / volume /
 *                            elevation / watershed area, validated at 1,503 waterbodies *globally*.
 *  - `osm_tag`             — an OSM `depth`/`maxdepth` tag. Last not because tags are untrustworthy but
 *                            because inland coverage is near-zero and the tag's datum and units are
 *                            unverifiable per-feature; a real one is usually nautical.
 */
export const DEPTH_SOURCES = [
  'operator',
  'state_agency',
  'lagos_us',
  'hydrolakes_reported',
  'hydrolakes_modeled',
  'globathy',
  'osm_tag',
] as const;

export type DepthSource = (typeof DEPTH_SOURCES)[number];

/** Precedence rank, 0 = best. Derived from `DEPTH_SOURCES` order so there is one ordering, not two. */
export const DEPTH_SOURCE_RANK: Record<DepthSource, number> = Object.fromEntries(
  DEPTH_SOURCES.map((source, i) => [source, i]),
) as Record<DepthSource, number>;

/**
 * Sources whose numbers come from someone putting an instrument in the water. Drives the display
 * framing (D3): a measured depth reads plainly and names its source, a modelled one reads as an estimate.
 * `osm_tag` counts — a mapper read it off something — while every global rung does not.
 */
const MEASURED_DEPTH_SOURCES = new Set<DepthSource>([
  'operator',
  'state_agency',
  'lagos_us',
  'osm_tag',
]);

export function isMeasuredDepthSource(source: DepthSource): boolean {
  return MEASURED_DEPTH_SOURCES.has(source);
}

/**
 * A depth is *shallow* at or below this mean depth. 3 m is the conventional shallow/polymictic boundary:
 * such a basin mixes to the bottom, so it sheds heat fast enough to take first ice and warms fast enough
 * to go out first. Tunable default (D69).
 */
export const SHALLOW_MEAN_DEPTH_M = 3;

/**
 * The max-depth fallback, used only when a body has no mean depth — **the common case**, since LAGOS-US
 * carries roughly three times more maxima than means. 7 m ≈ `SHALLOW_MEAN_DEPTH_M / 0.4`, the usual
 * mean:max ratio for a lake basin.
 *
 * The known weakness, recorded rather than hidden: a shallow pond with one deep hole has a max that
 * misrepresents the sheet. That errs toward *not* calling a body shallow, which under D69 means not
 * amplifying a thaw response — the conservative direction is the other one, so this is a real limitation
 * and the reason a mean depth always wins when we have one.
 */
export const SHALLOW_MAX_DEPTH_M = 7;

export interface LakeDepths {
  meanDepthM?: number;
  maxDepthM?: number;
}

/**
 * Whether a body's depth makes it shallow. **Mean wins when present** (it describes the sheet; a max
 * describes one point). Unknown depth is **not** shallow — fail-open in the sense that matters here:
 * absent data must not silently apply a decay amplifier, and the `shallow_bay_early_thaw` `bodyFeature`
 * is the path for a body we have no number for. Non-finite or non-positive values are treated as absent.
 */
export function isShallowDepth(depths: LakeDepths): boolean {
  const mean = depths.meanDepthM;
  if (typeof mean === 'number' && Number.isFinite(mean) && mean > 0) {
    return mean <= SHALLOW_MEAN_DEPTH_M;
  }
  const max = depths.maxDepthM;
  if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
    return max <= SHALLOW_MAX_DEPTH_M;
  }
  return false;
}

/** One source's offer of a depth, as the ETL assembles them per body. */
export interface DepthCandidate {
  valueM: number;
  source: DepthSource;
}

/**
 * Resolve the ladder: the best-ranked candidate with a usable value, or `undefined`. Ties keep the
 * **first** candidate at that rank, so a caller's own ordering survives (two `lagos_us` rows for one
 * body means the join matched twice and the transform should have deduped, not that we should pick
 * arbitrarily — but picking stably beats picking by whichever way `sort` went).
 *
 * A non-finite or non-positive depth is dropped rather than ranked. A zero depth is not a shallow lake,
 * it is a missing measurement written as 0 — a distinction several of these sources do not make for us.
 */
export function resolveDepth(candidates: readonly DepthCandidate[]): DepthCandidate | undefined {
  let best: DepthCandidate | undefined;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.valueM) || candidate.valueM <= 0) continue;
    if (
      best === undefined ||
      DEPTH_SOURCE_RANK[candidate.source] < DEPTH_SOURCE_RANK[best.source]
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Short human label per source, for the display caption and the operator editor. */
export const DEPTH_SOURCE_LABELS: Record<DepthSource, string> = {
  operator: 'entered by a moderator',
  state_agency: 'state survey',
  lagos_us: 'LAGOS-US DEPTH',
  hydrolakes_reported: 'HydroLAKES (reported volume)',
  hydrolakes_modeled: 'HydroLAKES (modeled)',
  globathy: 'GLOBathy (modeled)',
  osm_tag: 'OpenStreetMap',
};
