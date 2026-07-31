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

import { formatDepthFeet } from './units';

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
 * A depth is *shallow* at or below this mean depth. 3 m is the **conventional** shallow/polymictic
 * boundary in limnology: such a basin mixes to the bottom, so it sheds heat fast enough to take first ice
 * and warms fast enough to go out first.
 *
 * Left at the convention deliberately (founder call, 2026-07-30) rather than tuned by taste — it is the
 * one number here with outside support, and moving it drags `SHALLOW_MAX_DEPTH_M` with it, since that is
 * derived *from* this. Change it when real data says to, not before.
 */
export const SHALLOW_MEAN_DEPTH_M = 3;

/**
 * The max-depth fallback, used only when a body has no mean depth — **the common case**, since LAGOS-US
 * carries roughly three times more maxima than means and GLOBathy gives *only* a max.
 *
 * **7 m is the middle of a wide band, not a derived number, and it is deliberately on the generous side.**
 * It comes from `SHALLOW_MEAN_DEPTH_M / 0.4`, using a typical basin mean:max ratio — but that ratio
 * (Hutchinson's volume development, `Dv = 3 × mean/max`) runs from ~0.33 for a cone to ~0.6 for a
 * flat-bottomed basin, which puts the honest range at **5–9 m**. Worse, it varies *with the thing being
 * classified*: flat shallow ponds sit at the high end, so a genuinely shallow pond often has a max nearer
 * 5–6 m. On that alone 7 m over-classifies.
 *
 * **The errors are asymmetric, and that is why it stays high.** Under D69 being shallow only amplifies the
 * *thaw* term, so a false positive makes a `refreeze_healed`/`rotten` warning linger and prompts a ridge
 * recheck sooner — costs bounded by the never-hide rule and the map's opacity floor. A false negative
 * loses the signal outright on a lake that deserved it. Cheap error, expensive error: lean generous.
 *
 * The false negative has a named shape worth remembering: a broad shallow sheet with one deep hole or a
 * dredged channel — mean 2 m, max 9 m — reads as not shallow. Two things already catch it, and they are
 * the reason this is a limitation rather than a hole: a mean **always wins** when we have one, and a
 * moderator's `shallow_bay_early_thaw` flag overrides the number entirely.
 *
 * **How this gets settled, rather than argued (founder call, 2026-07-30).** LAGOS-US DEPTH holds ~6,137
 * lakes with *both* a mean and a max — a labelled validation set. Once the ETL has run, fit the max cutoff
 * that best reproduces the `mean ≤ 3 m` classification on our region's own lakes, and test whether
 * *relative depth* (max as a fraction of basin width, computable from the area every source carries)
 * separates "broad shallow sheet" from "small deep hole" well enough to earn its complexity. Step 6 of
 * `scripts/lake-depth/README.md` is where that check actually happens.
 */
export const SHALLOW_MAX_DEPTH_M = 7;

/**
 * Upper sanity bound on a stored depth, in metres. The deepest lake in our five states is Seneca at
 * ~188 m, so 400 m is roughly double anything real here.
 *
 * **A backstop, not a unit detector** — and worth being precise about, because it is tempting to claim
 * more. A chart in feet reads ~3.3× too deep, which this only catches on genuinely deep lakes: 618 ft
 * typed for Seneca sails through, while 200 ft typed for a 60 m lake is indistinguishable from a real
 * number. It stops the transcription slip that turns a pond into a trench; it cannot stop a units mistake
 * in general, which is why the operator UI labels its field in both units instead of relying on this.
 */
export const MAX_PLAUSIBLE_DEPTH_M = 400;

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

// A `resolveDepth(candidates)` helper lived here until the review of 2026-07-31. It was written when
// the plan had the transform resolving the ladder locally; the join moved server-side mid-build, and
// `waterBodies.applyDepthLadder` — which resolves the ladder *against what is already stored*, one
// measurement at a time — is the surviving implementation. Keeping a second one would have been the
// duplicate that `applyDepthLadder`'s own docstring says it exists to prevent.

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

/** A body's depth, ready to render: the numbers, their attribution, and whether any is an estimate. */
export interface DepthDisplay {
  /** e.g. `"mean ~13 ft · max 59 ft"` — a `~` marks a modelled value. */
  text: string;
  /** Sources named, deduped, in ladder order. */
  caption: string;
  /** Whether any shown value is modelled (so the caller can style the caption as a caveat). */
  hasEstimate: boolean;
}

export interface LakeDepthRecord extends LakeDepths {
  meanDepthSource?: DepthSource;
  maxDepthSource?: DepthSource;
  /** Evidence behind an `operator` depth — a citation, shown in place of the rung's generic label. */
  depthSourceNote?: string;
}

/**
 * Render a body's depth for a skater, **framed by where each number came from** (D68, founder call).
 *
 * The framing rule is the whole point and it is one line of logic: a measured depth reads plainly, a
 * modelled one carries a `~` and the caption says the sources. A 90 m-DEM estimate and a depth-sounder
 * transect are both useful and are not the same claim (D3), and since mean and max routinely arrive from
 * different rungs, the mark has to be **per value** rather than per lake.
 *
 * Returns `null` when there is nothing to show — which is most of the corpus, and the caller should
 * render nothing rather than "unknown". A depth we don't have is not a fact about the lake.
 *
 * A value with no source is treated as absent: provenance is what makes it displayable at all.
 */
export function describeLakeDepth(body: LakeDepthRecord): DepthDisplay | null {
  const parts: string[] = [];
  const sources: DepthSource[] = [];
  let hasEstimate = false;

  const add = (label: string, value?: number, source?: DepthSource) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0 || source === undefined)
      return;
    const estimated = !isMeasuredDepthSource(source);
    if (estimated) hasEstimate = true;
    parts.push(`${label} ${estimated ? '~' : ''}${formatDepthFeet(value)}`);
    if (!sources.includes(source)) sources.push(source);
  };
  add('mean', body.meanDepthM, body.meanDepthSource);
  add('max', body.maxDepthM, body.maxDepthSource);
  if (parts.length === 0) return null;

  sources.sort((a, b) => DEPTH_SOURCE_RANK[a] - DEPTH_SOURCE_RANK[b]);
  // A moderator's note replaces the `operator` rung's own label, which is the point of collecting it:
  // "NH Fish & Game, 1998 chart" is checkable and "entered by a moderator" is attribution in name only.
  // Absent, the generic label stands — which is honest, since we then genuinely don't know the basis.
  const note = body.depthSourceNote?.trim();
  const attribution = sources
    .map((s) => (s === 'operator' && note ? note : DEPTH_SOURCE_LABELS[s]))
    .join(', ');
  return {
    text: parts.join(' · '),
    caption: hasEstimate
      ? `Depth: ${attribution}. ~ is a modeled estimate.`
      : `Depth: ${attribution}.`,
    hasEstimate,
  };
}
