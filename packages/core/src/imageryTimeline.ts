/**
 * One lake's freeze-up timeline: which frames the scrubber offers, and why it withholds the rest
 * (N6e §C1/§C4, D84, D150).
 *
 * ## The scrubber is this lake's observation record, not a regional calendar
 *
 * > **Founder, 2026-08-23:** *"it might be weird to go to one lake and be able to slide the slider to
 * > one date, then pop to a different lake and not have that same date marked/available without any
 * > explanation."*
 *
 * Right, and the fix is in the **denominator**. Two different things make a date missing for a body,
 * and only one of them is weather:
 *
 * 1. **Coverage.** A frame is one granule's cut, and the region spans twenty-odd granules on separate
 *    MGRS tiles and orbit tracks. Lake George and Moosehead are photographed on different days by
 *    different passes. This is most of the variance.
 * 2. **Cloud**, among the passes that did cover this lake.
 *
 * Showing *every regional pass* and grey-ing out the rest would make the control mostly grey, for a
 * reason no skater can be expected to hold in their head — and it would collapse "the satellite was
 * never over your lake" and "it was cloudy" into one disabled state, which trades a silent gap for a
 * misleading one.
 *
 * So a frame that does not cover this body is **not a stop at all**, and a frame that does is either
 * landable or blocked with a reason specific enough to caption: *"Feb 3 — 94% cloud."* Every stop is
 * then about this lake, and every blocked one explains itself.
 *
 * ## Two passes, because exact coverage costs a fetch
 *
 * Per-lake coverage and cloud live in the **per-granule manifest**, not the season index — the index
 * carries a body *count* rather than a body *list* on purpose, since the list is millions of entries
 * across a season. So the honest shape is two steps:
 *
 * 1. {@link candidateFramesFor} narrows the season to the handful of frames whose footprint contains
 *    this lake. No network, no stats — this is *what to fetch*.
 * 2. {@link buildBodyTimeline} takes whatever statistics came back and produces the stops.
 *
 * **The second works without the first.** Given no statistics it falls back to footprint inference and
 * says so in `coverageInferred`, which is what keeps a scrubber renderable while its manifests are
 * still in flight.
 *
 * ## What this module deliberately does not decide
 *
 * **Phrasing.** The reason codes carry the numbers; turning them into words is the client's job,
 * under D150 — a stop's caption reports a measurement and its source and never advises. The same
 * split `weatherConditions` already draws between a bucket and its label.
 */

import { pointInPolygon } from './geometry';
import {
  bodyStatsIn,
  type FrameBodyStats,
  type FrameStats,
  type IndexedFrame,
  type SeasonIndex,
} from './imageryArchive';
import {
  linkCoordinate,
  type ReferenceLinkBody,
  satelliteImageryAvailable,
} from './referenceLinks';

/**
 * The granule-wide cloud fraction above which a frame is in the archive but not worth landing on.
 *
 * ⚠ **A display gate, and deliberately not the ingest gate.** `DEFAULT_MAX_CLOUD_PCT = 60` in
 * `@skating/imagery` decides what we *cut*, and §C3 argues at length that it should be generous:
 * an over-eager ingest gate wastes a few dollars of granule reads, while a strict one silently drops
 * the frame that showed freeze-up. That asymmetry does not survive the trip to a scrubber, where the
 * cost of an over-eager gate is a skater landing on a white rectangle and concluding the feature is
 * broken.
 *
 * ⚠ **The fallback, not the preference.** This is granule-wide `eo:cloud_cover` over a 110 km tile,
 * so two lakes in one granule always agree and a pass 70% clouded over the White Mountains says
 * nothing about Champlain. Where per-body `clearPct` is available, {@link MIN_BODY_CLEAR_FRACTION}
 * governs instead.
 */
export const FRAME_MAX_CLOUD_PCT = 40;

/**
 * The per-body counterpart, and **deliberately the same strictness**.
 *
 * 40% cloud allowed is 60% clear required, so switching a lake from the granule figure to its own
 * changes *accuracy* and not *how much cloud we tolerate*. That matters because the two gates will
 * coexist for as long as the archive holds frames cut before the per-body pass — and a threshold that
 * quietly tightened as manifests arrived would look like the archive losing frames.
 */
export const MIN_BODY_CLEAR_FRACTION = 0.6;

/**
 * How much of a lake a single frame must reach to be worth landing on by itself.
 *
 * A pass that clipped 15% of a lake is a real observation of a sliver, and offering it as *the* view
 * of that date shows a skater a corner and lets them read it as the whole. Half is the point where
 * what is on screen is recognisably the lake.
 *
 * ⚠ **Below this a frame is blocked, never dropped.** It stays visible as a stop carrying
 * `blockedBy: 'coverage'`, because a silently shorter scrubber is the failure this whole module
 * exists to answer. Pairing two such frames into one view is the split-body seam, which composes
 * these rather than replacing them.
 */
export const MIN_BODY_COVERAGE = 0.5;

/** Why a covered frame is not landable. Carries no words — see the module note on phrasing. */
export type StopBlockReason = 'cloud' | 'coverage';

/** How a stop's coverage was established — and therefore how much to trust it. */
export type CoverageBasis =
  /** The frame's manifest lists this body. Exact. */
  | 'measured'
  /** The granule's footprint contains the lake's interior point. A guess, and usually a good one. */
  | 'inferred'
  /** Neither was available. The frame is kept rather than dropped; see {@link buildBodyTimeline}. */
  | 'unknown';

/** One position on the scrubber: a frame that covers this body, landable or not. */
export interface TimelineStop {
  frame: IndexedFrame;
  /** May the thumb come to rest here? */
  landable: boolean;
  /** Set exactly when `landable` is false. */
  blockedBy?: StopBlockReason;
  /** How coverage was decided. `'inferred'`/`'unknown'` mean no manifest backed this stop. */
  basis: CoverageBasis;
  /**
   * This lake's row in that frame's statistics, when a manifest was supplied.
   *
   * The caption's raw material — `clearPct` for the cloud caveat, `coveragePct` for the seam,
   * `vhDb` for radar. Absent whenever `basis` is not `'measured'`.
   */
  stats?: FrameBodyStats;
}

/**
 * A body's frames, plus what was left out — because an omission that is only visible as a shorter
 * list is the kind that hides.
 */
export interface BodyTimeline {
  season: string;
  /** Ascending by capture time, inheriting the index's own order. */
  stops: TimelineStop[];
  /** How many stops the thumb may rest on. Zero means a control with nothing to show. */
  landableCount: number;
  /** Frames dropped because this pass did not reach this body. Expected to be most of them. */
  notCovered: number;
  /** Stops resting on footprint inference rather than a manifest — how much of this is a guess. */
  coverageInferred: number;
  /** Stops with neither a manifest nor a footprint. Kept, and counted so they cannot hide. */
  coverageUnknown: number;
}

/** Per-granule statistics a consumer has already fetched. Returns `undefined` for "not loaded". */
export type FrameStatsLookup = (granuleId: string) => FrameStats | undefined;

/** A water body as this module reads it — {@link ReferenceLinkBody} plus the id a manifest keys on. */
export interface TimelineBody extends ReferenceLinkBody {
  /**
   * The corpus id, which is what a manifest's `bodies[]` is keyed by.
   *
   * Optional because the fallback is real: with no id there is no way to look this lake up in a
   * manifest, so coverage degrades to footprint inference rather than failing. Convex documents carry
   * it as `_id`, so both clients satisfy this structurally.
   */
  _id?: string;
}

export interface BodyTimelineOptions {
  /**
   * Which band to build the timeline for. One date per band, never the same date twice over.
   *
   * ⚠ **This is also the mission filter, and that is load-bearing rather than incidental.** The
   * archive holds Sentinel-2 (`visual`, `scl`) and Sentinel-1 (`vh`) in one index, so a timeline built
   * without it would interleave a photograph and a radar greyscale on the same scrubber — two
   * different measurements presented as one series. Defaulting to `visual` means the optical case
   * is right by construction and radar has to be asked for.
   */
  band?: string;
  /** Per-granule statistics, where the consumer has them. Absent ⇒ footprint inference. */
  stats?: FrameStatsLookup;
  /** Override the granule-wide cloud gate — for the admin editor, which sees everything. */
  maxCloudPct?: number;
  /** Override the per-body clear-fraction gate. Same reason. */
  minClearFraction?: number;
  /** Override the standalone coverage floor. Same reason. */
  minCoverage?: number;
}

/** An empty timeline, for the several honest ways a body has no scrubber. */
function emptyTimeline(season: string): BodyTimeline {
  return {
    season,
    stops: [],
    landableCount: 0,
    notCovered: 0,
    coverageInferred: 0,
    coverageUnknown: 0,
  };
}

/**
 * The frames whose footprint contains this lake — *what to fetch manifests for*.
 *
 * Cheap and synchronous: the season index is already in hand, and a footprint test is a
 * point-in-polygon. Over a five-state region this is the difference between fetching a handful of
 * manifests and fetching four and a half thousand.
 *
 * ⚠ **A superset, and meant to be.** A footprint says the granule's pixels reach this coordinate, not
 * that the cut kept the lake — a body whose mask union failed is inside plenty of footprints and in no
 * manifest at all. {@link buildBodyTimeline} narrows it once the statistics arrive; this only has to
 * be small enough to fetch and wide enough not to miss anything.
 */
export function candidateFramesFor(
  index: SeasonIndex,
  body: TimelineBody,
  options: Pick<BodyTimelineOptions, 'band'> = {},
): IndexedFrame[] {
  if (!satelliteImageryAvailable(body)) return [];
  const coord = linkCoordinate(body);
  if (!coord) return [];
  const band = options.band ?? 'visual';

  return index.frames.filter(
    (frame) => frame.band === band && (!frame.footprint || pointInPolygon(coord, frame.footprint)),
  );
}

/**
 * Fold a season index into one body's timeline.
 *
 * ## Two gates run before coverage, and they are not the same gate
 *
 * **Is this body offered imagery at all?** `satelliteImageryAvailable` (D70/D75) — a 10 m pixel cannot
 * resolve a pond, and an operator's `off` is a takedown-shaped word that must win outright. A body
 * that fails this has no scrubber, not an empty one.
 *
 * **Do we know where it is?** `linkCoordinate` resolves `interiorPoint → representativePoint →
 * centroid`, in that order and for the reason N6c-1 measured: `centroid` is Turf's `pointOnFeature`
 * and lands on the *shoreline*, 30.7 km from mid-lake on Champlain. A shoreline point is a fine place
 * to open a link from and a poor place to test granule coverage from, since it is the one point on the
 * body most likely to fall the wrong side of a boundary.
 *
 * ## Coverage: measured if we can, inferred if we must
 *
 * With a manifest, membership is **exact** — `bodies[]` is the list of lakes that granule actually cut,
 * so absence is a real answer and `coveragePct` says how much of the lake the pass reached. This is
 * what makes a half-covering pass legible instead of invisible: the point-in-polygon fallback calls it
 * "not covered" and throws away the half we have.
 *
 * Without one, the footprint test stands in and the stop is marked `'inferred'`.
 *
 * ## The cloud gate needs no mission branch, because the data shape already has one
 *
 * Radar carries no `clearPct` and a `null` `cloudCoverPct` — not because the figure is missing but
 * because the question does not apply, since Sentinel-1 sees straight through cloud. Optical frames
 * with no reported fraction look identical, and the right answer is the same for both: **do not block.**
 * `null` is never a guess, so it cannot be read as 100% and used to withhold a date.
 *
 * So the gate reads whichever figure exists, prefers the per-body one, and blocks on neither when
 * neither is there. A mission check would be a second way of asking the same question, and a second
 * chance to disagree.
 *
 * ## Failing open, and why here that is the safe direction
 *
 * A frame with neither manifest nor footprint is kept and counted in `coverageUnknown`. That is the
 * opposite of what `revealMasks` does with a failed union, and the difference is what failure costs:
 * a reveal that fails open publishes a photograph of ground somebody asked us to stop showing, while a
 * timeline that fails open offers a date that might render blank. Silently *dropping* those frames
 * would be the worse outcome — a scrubber quietly missing half a winter.
 */
export function buildBodyTimeline(
  index: SeasonIndex,
  body: TimelineBody,
  options: BodyTimelineOptions = {},
): BodyTimeline {
  if (!satelliteImageryAvailable(body)) return emptyTimeline(index.season);

  const coord = linkCoordinate(body);
  if (!coord) return emptyTimeline(index.season);

  const band = options.band ?? 'visual';
  const maxCloudPct = options.maxCloudPct ?? FRAME_MAX_CLOUD_PCT;
  const minClear = options.minClearFraction ?? MIN_BODY_CLEAR_FRACTION;
  const minCoverage = options.minCoverage ?? MIN_BODY_COVERAGE;

  const stops: TimelineStop[] = [];
  let notCovered = 0;
  let coverageInferred = 0;
  let coverageUnknown = 0;

  for (const frame of index.frames) {
    if (frame.band !== band) continue;

    const frameStats = options.stats?.(frame.granuleId);
    const row = frameStats && body._id ? bodyStatsIn(frameStats, body._id) : undefined;

    let basis: CoverageBasis;
    if (row) {
      basis = 'measured';
    } else if (frameStats && body._id) {
      // The manifest was loaded and this lake is not in it. That is not a gap — the cut is the
      // authority on what it cut, so this pass genuinely did not produce pixels for this body.
      notCovered++;
      continue;
    } else if (frame.footprint) {
      if (!pointInPolygon(coord, frame.footprint)) {
        notCovered++;
        continue;
      }
      basis = 'inferred';
      coverageInferred++;
    } else {
      basis = 'unknown';
      coverageUnknown++;
    }

    // Coverage first: "we barely saw it" is a more fundamental objection than "what we saw was
    // cloudy", and captioning a sliver as cloudy would explain the wrong problem.
    const coveragePct = row?.coveragePct ?? null;
    if (coveragePct !== null && coveragePct < minCoverage) {
      stops.push({
        frame,
        landable: false,
        blockedBy: 'coverage',
        basis,
        ...(row ? { stats: row } : {}),
      });
      continue;
    }

    const clearPct = row?.clearPct ?? null;
    const blocked =
      clearPct !== null
        ? clearPct < minClear
        : frame.cloudCoverPct !== null && frame.cloudCoverPct > maxCloudPct;

    stops.push({
      frame,
      landable: !blocked,
      ...(blocked ? { blockedBy: 'cloud' as const } : {}),
      basis,
      ...(row ? { stats: row } : {}),
    });
  }

  return {
    season: index.season,
    stops,
    landableCount: stops.filter((stop) => stop.landable).length,
    notCovered,
    coverageInferred,
    coverageUnknown,
  };
}

/**
 * The landable stop nearest `position`, preferring the earlier one on a tie.
 *
 * **What the thumb does when it is dragged onto a blocked stop.** The blocked stops stay drawn — that
 * is the whole point of drawing them — but the thumb slides past to the nearest date that has a
 * picture behind it, rather than resting somewhere that renders nothing.
 *
 * Ties break earlier because the scrubber runs forward through a winter: landing before an ambiguous
 * gap and reading toward it matches how the archive is actually read, and it makes the choice
 * deterministic rather than a function of which side the drag came from.
 *
 * Returns `null` when no stop is landable — a season fully clouded over this body is a real outcome
 * and the caller has to render something honest for it.
 */
export function nearestLandableStop(
  stops: readonly TimelineStop[],
  position: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [i, stop] of stops.entries()) {
    if (!stop.landable) continue;
    const distance = Math.abs(i - position);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }

  return best;
}
