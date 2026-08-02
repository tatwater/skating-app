/**
 * The derived lake caption (N6c Workstream C) — one or two sentences per body, generated from our
 * own numbers, telling a skater what the stats *mean*.
 *
 * ## The four rules, all load-bearing
 *
 * **1. Generated, never written (D70).** Assembled here so web and mobile render identically and
 * the whole thing is unit-testable. No per-lake prose exists anywhere in the system to go stale,
 * and nothing is adapted from anyone else's write-ups — the prose is ours because the template is
 * ours. This is the answer to the failure mode D70 names: a hand-curated atlas whose sentences are
 * all still there, still plausible, and unfalsifiable, because nobody can tell which are still true.
 *
 * **2. Physics and history only. Never prediction (D3).** *"Deep lakes lose heat slowly and
 * typically freeze weeks after nearby shallow ponds"* is ours to say — it is a property of water.
 * *"This will be frozen by mid-January"* is not. Every tendency clause below is written about the
 * *class* of lake, in the present tense, and none of them mentions this year. A caption feels
 * casual in a way that invites over-claiming, which is exactly why the rule is stated here rather
 * than left to whoever edits the strings next.
 *
 * **3. Every clause traces to a stored number, and every clause is optional.** No depth ⇒ no depth
 * clause. Most of the 116,070 will render one clause or none, and that is the correct outcome
 * rather than a coverage failure to paper over with hedged filler.
 *
 * **4. Provenance discipline carries through from N6a (D68).** A modelled depth's clause must read
 * as an estimate. If the number is a 90 m-DEM guess, the sentence built on it cannot sound like a
 * depth-sounder transect.
 *
 * ## Units
 *
 * Imperial throughout, per **D25** — *store metric internally, display imperial*. There is no
 * metric display mode in this product. (The N6c plan's illustrative caption mixes acres and miles
 * with "91 m" and "8 km"; that was a drafting slip, not a second convention.)
 */

import {
  type DepthSource,
  isMeasuredDepthSource,
  isShallowDepth,
  type LakeDepths,
} from './lakeDepth';
import {
  axisCompassLabel,
  COMPASS_POINTS_16,
  type CompassPoint16,
  FETCH_BEARING_STEP_DEG,
} from './lakeGeometry';
import { type DecileBlock, isBottomDecile, isTopDecile } from './regionStats';
import { metersToMiles, roundTo, sqMetersToAcres } from './units';
import { mostExposedSector } from './windRose';

/**
 * Below this fetch, the wind-exposure clause is omitted.
 *
 * ~0.6 miles. Fetch is a statement about *open water*, and on a pond this size the answer is
 * "there isn't any" in every direction — a clause naming the most exposed bearing would imply a
 * distinction the geometry cannot support.
 */
export const MIN_FETCH_CLAUSE_M = 1000;

/** The state-relative comparison basis a caption reads (one state's `regionStats.metrics`). */
export interface CaptionBasis {
  maxDepthM?: DecileBlock;
  meanDepthM?: DecileBlock;
  elevationM?: DecileBlock;
  surfaceAreaSqM?: DecileBlock;
  longAxisM?: DecileBlock;
}

/** Everything a caption may draw on. Every field optional — see rule 3. */
export interface CaptionInput extends LakeDepths {
  meanDepthSource?: DepthSource;
  maxDepthSource?: DepthSource;
  surfaceAreaSqM?: number;
  elevationM?: number;
  shorelineM?: number;
  longAxisM?: number;
  shortAxisM?: number;
  longAxisBearingDeg?: number;
  fetchProfileM?: number[];
  /** Winter wind-frequency rose, 16 sectors summing to 1 (see `windRose.ts`). */
  windRose?: number[];
  /** The state whose deciles `basis` describes, for the comparison's wording ("in Vermont"). */
  stateName?: string;
  basis?: CaptionBasis;
}

/** Full state names for the comparison clauses. A caption says "Vermont", never "VT". */
export const STATE_NAMES: Record<string, string> = {
  VT: 'Vermont',
  NH: 'New Hampshire',
  ME: 'Maine',
  MA: 'Massachusetts',
  NY: 'New York',
};

/** Acres with thousands separators, whole for anything over an acre. */
function formatAcres(sqm: number): string {
  const acres = sqMetersToAcres(sqm);
  if (acres < 1) return 'under an acre';
  const rounded = roundTo(acres, acres < 10 ? 1 : 0);
  return `${rounded.toLocaleString('en-US')} acres`;
}

/** Miles at a precision that does not out-run the measurement. */
function formatMiles(meters: number): string {
  const miles = metersToMiles(meters);
  return `${roundTo(miles, miles < 10 ? 1 : 0)}`;
}

/**
 * Shoreline, rounded to the **nearest whole mile** (D85, founder call).
 *
 * Taking the softer of the two offers — *"nearest"* over *"round up"* — because rounding up
 * systematically overstates, and a skater may use this to judge how long a lap takes. Under a mile
 * renders without a decimal: no false precision on a farm pond.
 */
export function formatShoreline(meters: number): string {
  const miles = metersToMiles(meters);
  if (miles < 1) return 'under a mile of shoreline';
  return `about ${Math.round(miles).toLocaleString('en-US')} miles of shoreline`;
}

// `mostExposedBearing` — "the compass point with the longest fetch" — used to live here and is
// deliberately gone rather than merely unused. It is a claim about geometry that reads as a claim
// about wind, and exporting it leaves the bug one autocomplete away from coming back. The replacement
// is `mostExposedSector` in `windRose.ts`, which cannot answer without a rose.

/** "the northwest" — the spoken form of a compass point, for prose rather than a label. */
export function spokenDirection(point: CompassPoint16): string {
  const words: Record<string, string> = {
    N: 'the north',
    NNE: 'the north-northeast',
    NE: 'the northeast',
    ENE: 'the east-northeast',
    E: 'the east',
    ESE: 'the east-southeast',
    SE: 'the southeast',
    SSE: 'the south-southeast',
    S: 'the south',
    SSW: 'the south-southwest',
    SW: 'the southwest',
    WSW: 'the west-southwest',
    W: 'the west',
    WNW: 'the west-northwest',
    NW: 'the northwest',
    NNW: 'the north-northwest',
  };
  return words[point] ?? 'the north';
}

/**
 * The size clause: acres, then shoreline.
 *
 * **No dimension line** (founder call, 2026-08-02: *"I'd drop the 'about A × B miles' clause, and
 * just go from surface-area acres to miles of shoreline"*). Acres and shoreline are two different
 * facts; acres, dimensions and shoreline are three ways of saying one, and the middle one is the
 * least useful of the three to someone deciding where to skate. The axis still earns its place —
 * it orients the wind clause, and `longAxisM` still feeds the D2 prominence terms and A5's deciles.
 */
function sizeClause(input: CaptionInput): string | null {
  const parts: string[] = [];
  if (typeof input.surfaceAreaSqM === 'number' && input.surfaceAreaSqM > 0) {
    parts.push(formatAcres(input.surfaceAreaSqM));
  }
  if (typeof input.shorelineM === 'number' && input.shorelineM > 0) {
    parts.push(formatShoreline(input.shorelineM));
  }
  if (parts.length === 0) return null;
  return `${parts.join(', ')}.`;
}

/**
 * The depth clause: the number, its provenance, its rank, and the physics.
 *
 * **The physics is the payload and the number is the evidence**, which is why they are one
 * sentence. "91 m maximum depth" tells a skater nothing on its own; "deep water holds heat, so
 * lakes like this freeze well after nearby shallow ponds" is the thing they came for.
 */
function depthClause(input: CaptionInput): string | null {
  const max = input.maxDepthM;
  const mean = input.meanDepthM;
  const value = max ?? mean;
  const source = max !== undefined ? input.maxDepthSource : input.meanDepthSource;
  if (typeof value !== 'number' || value <= 0) return null;

  // Rule 4: a 90 m-DEM guess must not sound like a depth-sounder transect. The provenance rides an
  // adjective rather than a trailing parenthetical, so it cannot be skimmed past.
  const estimated = source === undefined || !isMeasuredDepthSource(source);
  const qualifier = estimated ? 'estimated' : 'measured';
  const feet = Math.round(value / 0.3048).toLocaleString('en-US');
  const label = max !== undefined ? 'maximum depth' : 'average depth';

  const block = max !== undefined ? input.basis?.maxDepthM : input.basis?.meanDepthM;
  const region = input.stateName;
  // All three branches are complete sentences. An earlier version appended the physics after an
  // em-dash and only introduced a subject when a rank was present, so every un-ranked lake — most
  // of the corpus — read "At a measured 43 ft maximum depth — deep water holds heat", a fragment.
  // Caught by previewing real lakes rather than fixtures.
  let sentence: string;
  if (region && isTopDecile(value, block)) {
    sentence = `Its ${qualifier} ${label} of ${feet} ft is among the deepest in ${region}.`;
  } else if (region && isBottomDecile(value, block)) {
    sentence = `Its ${qualifier} ${label} of ${feet} ft is among the shallowest in ${region}.`;
  } else {
    sentence = `Its ${qualifier} ${label} is ${feet} ft.`;
  }

  // Present tense, about the class of lake, never about this winter (rule 2 / D3).
  //
  // **Only stated when the lake is clearly one or the other.** `isShallowDepth` is D69's *decay*
  // threshold — a binary built to decide whether thaw is amplified — and it carries copy badly:
  // everything above 7 m falls in its "not shallow" half, so Lake Morey at 43 ft was being told
  // "deep water holds heat", which is a stretch a reader will notice. "Shallow" is an absolute
  // physical claim the number alone supports; "deep" is a relative one that needs the corpus, so
  // it waits for a top-decile rank. In between, the number stands on its own and the caption says
  // nothing further — rule 3, applied to a clause rather than to a field.
  const shallow = isShallowDepth({ meanDepthM: mean, maxDepthM: max });
  if (shallow) {
    return `${sentence} Shallow water gives up its heat quickly, so ponds like this tend to take ice early and lose it early.`;
  }
  if (isTopDecile(value, block)) {
    return `${sentence} Deep water holds heat, so lakes like this tend to freeze well after nearby shallow ponds.`;
  }
  return sentence;
}

/** The elevation clause: height, rank, and the freeze-order tendency it implies. */
function elevationClause(input: CaptionInput): string | null {
  const value = input.elevationM;
  if (typeof value !== 'number') return null;
  const region = input.stateName;
  const feet = Math.round(value / 0.3048).toLocaleString('en-US');

  // Elevation only earns a clause when it says something COMPARATIVE. On its own, "at 412 ft" is a
  // fact with no consequence, and this caption's job is consequence. The DEM is also ~20 m out on
  // some bodies (see `elevation.ts`), which a bare figure would present as precision it lacks.
  if (region && isTopDecile(value, input.basis?.elevationM)) {
    return `At ${feet} ft it sits high for ${region}, and higher water tends to take ice before the valleys below it.`;
  }
  if (region && isBottomDecile(value, input.basis?.elevationM)) {
    return `At ${feet} ft it sits low for ${region}, and low-lying water tends to take ice after the hills around it.`;
  }
  return null;
}

/**
 * The wind clause: the lake's lie, and where wind actually reaches it across open water.
 *
 * **Requires a wind rose, and falls back to nothing without one.** An earlier version named the
 * longest-fetch bearing outright, which is a claim about *geometry* dressed as a claim about
 * *wind* — Lake Willoughby was described as "most open to wind out of the south-southeast" purely
 * because that is where its water runs. Falling back to that when a rose is missing would
 * reintroduce the exact sentence this clause was rewritten to stop saying, and it would be
 * invisible in the output. See `windRose.ts` for the measurement that settled it.
 */
function fetchClause(input: CaptionInput): string | null {
  const exposed = mostExposedSector(input.windRose, input.fetchProfileM);
  if (!exposed || exposed.fetchM < MIN_FETCH_CLAUSE_M) return null;

  const run = formatMiles(exposed.fetchM);
  const from = spokenDirection(COMPASS_POINTS_16[exposed.sector] as CompassPoint16);
  const share = Math.round(exposed.frequency * 100);
  // The direction is meteorological — the one wind blows FROM — matching both the profile's
  // indexing and the rose's.
  //
  // **The percentage is not decoration: it is the denominator.** "Most exposed to the northwest"
  // is a superlative with nothing behind it, and it reads the same whether that sector carries 40%
  // of winter hours or 7%. Naming the share lets a reader discount it themselves, which is the same
  // discipline D78 applies to recurrence and D86 to the quality mark.
  //
  // **Deliberately factual, with no physics tacked on.** An earlier draft closed with "long fetch
  // is what roughens ice and builds pressure ridges", which is true, useful to a novice, and would
  // have appeared verbatim on every body that clears the fetch floor. Repeated at that scale a
  // general explanation stops being information and becomes chrome, and it dilutes the one part of
  // the sentence specific to this lake. That physics belongs in docs/ once, not in every caption.
  const axis =
    typeof input.longAxisBearingDeg === 'number'
      ? `Its long axis runs ${axisCompassLabel(input.longAxisBearingDeg)}. `
      : '';
  return `${axis}Winter wind here comes from ${from} about ${share}% of the time, crossing roughly ${run} miles of open water.`;
}

/**
 * The whole caption: `[size] [depth] [elevation] [fetch]`, each independently omittable.
 *
 * Returns `null` when nothing can be said, which the clients must render as **nothing at all** —
 * not as an empty section with a heading, and above all not as hedged filler. A lake we know
 * nothing about should look like a lake we know nothing about.
 */
export function lakeCaption(input: CaptionInput): string | null {
  const clauses = [
    sizeClause(input),
    depthClause(input),
    elevationClause(input),
    fetchClause(input),
  ].filter((c): c is string => c !== null);
  return clauses.length > 0 ? clauses.join(' ') : null;
}

/**
 * Today's fetch, for the drawer: how much open water the current wind has crossed.
 *
 * Separate from the caption because it is the one line here that changes hour to hour — the caption
 * is a property of the lake, this is a property of the weather. Reads the profile by the direction
 * the wind blows **from**, which is what every forecast source reports.
 */
export function fetchForWind(
  profile: readonly number[] | undefined,
  windFromBearingDeg: number | undefined,
): { point: CompassPoint16; fetchM: number } | null {
  if (!profile || profile.length !== COMPASS_POINTS_16.length) return null;
  if (typeof windFromBearingDeg !== 'number' || !Number.isFinite(windFromBearingDeg)) return null;
  const bucket =
    Math.round((((windFromBearingDeg % 360) + 360) % 360) / FETCH_BEARING_STEP_DEG) %
    COMPASS_POINTS_16.length;
  const fetchM = profile[bucket];
  if (typeof fetchM !== 'number' || !Number.isFinite(fetchM) || fetchM <= 0) return null;
  return { point: COMPASS_POINTS_16[bucket] as CompassPoint16, fetchM };
}
