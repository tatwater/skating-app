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
 * then about this lake, and every blocked one explains itself. The cross-lake difference stops being
 * mysterious because the control never claimed to be a regional calendar in the first place.
 *
 * ## What this module deliberately does not decide
 *
 * **Phrasing.** The reason codes carry the numbers; turning them into words is the client's job,
 * under D150 — a stop's caption reports a measurement and its source and never advises. The same
 * split `weatherConditions` already draws between a bucket and its label.
 */

import { pointInPolygon } from './geometry';
import type { IndexedFrame, SeasonIndex } from './imageryArchive';
import {
  linkCoordinate,
  type ReferenceLinkBody,
  satelliteImageryAvailable,
} from './referenceLinks';

/**
 * The cloud fraction above which a frame is in the archive but not worth landing on.
 *
 * ⚠ **A display gate, and deliberately not the ingest gate.** `DEFAULT_MAX_CLOUD_PCT = 60` in
 * `@skating/imagery` decides what we *cut*, and §C3 argues at length that it should be generous:
 * an over-eager ingest gate wastes a few dollars of granule reads, while a strict one silently drops
 * the frame that showed freeze-up. That asymmetry does not survive the trip to a scrubber, where the
 * cost of an over-eager gate is a skater landing on a white rectangle and concluding the feature is
 * broken.
 *
 * 40% is the point where enough of a granule is clear that a given lake has a real chance of being
 * under one of the gaps. It is a guess, and it is meant to be — the first season's frames are what
 * will actually calibrate it, and being wrong here costs a stop rather than a frame, because the
 * granule is already in the bucket either way.
 *
 * ⚠ **Granule-wide, so it cannot yet mean "cloudy over *this* lake."** `cloudCoverPct` is STAC's
 * `eo:cloud_cover` for the whole 110 km tile, so two lakes in one granule always agree — the honest
 * caption is "cloud over the region," never "cloud over Lake George." Per-body `clearPct` from ESA's
 * SCL is the better gate and now exists in the per-granule manifest; wiring it is PR 3's.
 *
 * ⚠ **Optical only. A radar timeline must not be gated on this.** Sentinel-1 sees through cloud, so
 * a `vh` frame carries `cloudCoverPct: null` because the question does not apply — not because the
 * figure is missing. The `null`-is-landable rule below therefore gives the right answer for radar,
 * but for the wrong reason, and anything that later tightens that rule needs to branch on the band
 * rather than sharpening the threshold.
 */
export const FRAME_MAX_CLOUD_PCT = 40;

/** Why a covered frame is not landable. Carries no words — see the module note on phrasing. */
export type StopBlockReason = 'cloud';

/** One position on the scrubber: a frame that covers this body, landable or not. */
export interface TimelineStop {
  frame: IndexedFrame;
  /** May the thumb come to rest here? */
  landable: boolean;
  /** Set exactly when `landable` is false. */
  blockedBy?: StopBlockReason;
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
  /** Frames dropped because their footprint does not contain this body. Expected to be most of them. */
  notCovered: number;
  /**
   * Frames kept **despite** having no footprint to test against. See {@link buildBodyTimeline} — this
   * is the count that says how much of the timeline is a guess.
   */
  coverageUnknown: number;
}

export interface BodyTimelineOptions {
  /**
   * Which band to build the timeline for. One date per band, never the same date twice over.
   *
   * ⚠ **This is also the mission filter, and that is load-bearing rather than incidental.** The
   * archive holds Sentinel-2 (`visual`) and Sentinel-1 (`vh`) in one index, so a timeline built
   * without it would interleave a photograph and a radar greyscale on the same scrubber — two
   * different measurements presented as one series. Defaulting to `visual` means the optical case
   * is right by construction and radar has to be asked for.
   */
  band?: string;
  /** Override the display cloud gate — for the admin editor, which is allowed to see everything. */
  maxCloudPct?: number;
}

/** An empty timeline, for the several honest ways a body has no scrubber. */
function emptyTimeline(season: string): BodyTimeline {
  return { season, stops: [], landableCount: 0, notCovered: 0, coverageUnknown: 0 };
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
 * ## Coverage is tested at a point, and that is a real limitation
 *
 * ⚠ **A body larger than the gap between two granules can be half-covered, and this will call that
 * "not covered."** Champlain is ~200 km end to end and straddles tiles; a pass photographing only its
 * southern half does not contain the interior point and is dropped. The frame that gets offered is
 * always the one covering the point the map centres on, which is the right default and is not the same
 * as complete. Fixing it properly means intersecting the footprint with the body's own polygon and
 * deciding how much overlap is enough — a threshold nobody has evidence for yet, against a handful of
 * bodies. Worth revisiting once the first season shows how often it bites.
 *
 * ## A missing footprint fails open, and here that is the safe direction
 *
 * A frame with no `footprint` is kept and counted in `coverageUnknown`. That is the opposite of what
 * `revealMasks` does with a failed union, and the difference is what failure costs: a reveal that
 * fails open publishes a photograph of ground somebody asked us to stop showing, while a timeline that
 * fails open offers a date that might render blank. Silently *dropping* those frames would be the
 * worse outcome — a scrubber quietly missing half a winter, which is the exact complaint this module
 * exists to answer.
 */
export function buildBodyTimeline(
  index: SeasonIndex,
  body: ReferenceLinkBody,
  options: BodyTimelineOptions = {},
): BodyTimeline {
  if (!satelliteImageryAvailable(body)) return emptyTimeline(index.season);

  const coord = linkCoordinate(body);
  if (!coord) return emptyTimeline(index.season);

  const band = options.band ?? 'visual';
  const maxCloudPct = options.maxCloudPct ?? FRAME_MAX_CLOUD_PCT;

  const stops: TimelineStop[] = [];
  let notCovered = 0;
  let coverageUnknown = 0;

  for (const frame of index.frames) {
    if (frame.band !== band) continue;

    if (frame.footprint) {
      if (!pointInPolygon(coord, frame.footprint)) {
        notCovered++;
        continue;
      }
    } else {
      coverageUnknown++;
    }

    // `null` is "the source did not report one", which the archive type is explicit is never a guess
    // — so it cannot be read as 100% and block the stop. An unreported fraction leaves the frame
    // landable and lets the skater judge the pixels, which is the only honest reading available.
    const blocked = frame.cloudCoverPct !== null && frame.cloudCoverPct > maxCloudPct;
    stops.push(
      blocked ? { frame, landable: false, blockedBy: 'cloud' } : { frame, landable: true },
    );
  }

  return {
    season: index.season,
    stops,
    landableCount: stops.filter((stop) => stop.landable).length,
    notCovered,
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
