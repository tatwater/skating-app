/**
 * Named sub-areas (A02 / D60) — the geometry rules for a region *inside* one water body.
 *
 * A bay is not a lake. "Malletts Bay" is a name for part of Lake Champlain, and the whole point of
 * the model is that reports, hazards and bounties keep belonging to the parent while carrying the
 * finer name. Two rules follow from that, and both live here so the write path and the stamp path
 * can't drift:
 *
 *  1. **A stored sub-area is inside its parent by construction** (Decision 10) — the drawn shape is
 *     intersected with the parent and the *clipped* result is what gets stored.
 *  2. **A point in two overlapping sub-areas takes the smaller one** (Decision 9) — most specific
 *     name wins, and the answer doesn't depend on which row an index reached first.
 */

import area from '@turf/area';
import { feature, featureCollection } from '@turf/helpers';
import intersect from '@turf/intersect';
import truncate from '@turf/truncate';
import type { MultiPolygon, Polygon } from 'geojson';
import { distanceToPolygonMeters, type LatLng, pointInPolygon } from './geometry';

/**
 * How much of a drawn shape must survive the clip for the write to be accepted (Decision 10).
 *
 * Tracing a bay along a real shoreline cuts across land on nearly every vertex, so *some* overhang is
 * normal authoring, not a mistake — clipping it away is the right answer. But a shape that is mostly
 * outside its parent isn't a sloppy edge, it's a misplaced draw (the wrong lake, a dragged vertex, a
 * pasted GeoJSON from somewhere else), and silently saving the sliver that happens to overlap is the
 * silent-wrong-answer class this codebase keeps refusing. So there is a line, and it's here.
 *
 * **0.6 is measured, not guessed** (A02 curation session, 2026-07-26). Boxes on the right water
 * retained 0.61–0.92; boxes in the wrong place retained 0.16–0.17. Between them sits the Inland Sea
 * at 0.42 — a genuine archipelago arm where roughly half of any rectangle is islands — which is why
 * `subAreas.importSeed` runs a looser 0.35 bar for *box*-shaped input while this stays 0.6 for a
 * traced outline, where most of what you drew really should be water.
 *
 * The bar it has to clear is "is this on the right water", not "is this a good shape": the failure it
 * guards against is gross, and a false refusal costs the operator a redraw of work they did correctly.
 */
export const SUB_AREA_MIN_RETAINED_FRACTION = 0.6;

/** Why a drawn sub-area couldn't be stored. Each maps to a distinct thing the operator did. */
export type SubAreaClipRejection =
  /** The drawn shape has no area at all — a collapsed ring or a single repeated vertex. */
  | 'degenerate'
  /** The shape and the parent don't overlap: this bay was drawn on the wrong lake. */
  | 'disjoint'
  /** They overlap, but too little of the draw survives — see {@link SUB_AREA_MIN_RETAINED_FRACTION}. */
  | 'mostly_outside'
  /** The polygon clipper threw. Unlike the hazard clip, this fails **closed** — see below. */
  | 'clip_failed';

/**
 * The outcome of clipping a drawn sub-area to its parent. `retainedFraction` is reported on both
 * branches so the editor can say *how far* outside a refused shape was, rather than only that it was.
 */
export type SubAreaClipResult =
  | {
      ok: true;
      /** What to store — the intersection, always inside the parent. */
      polygon: Polygon | MultiPolygon;
      /** Fraction of the drawn area that survived, in `(0, 1]`. */
      retainedFraction: number;
      /** Did the clip actually change the shape? `false` ⇒ the draw was already wholly inside. */
      clipped: boolean;
    }
  | { ok: false; reason: SubAreaClipRejection; retainedFraction: number };

/**
 * Float-noise tolerance for "the clipper removed nothing". Not a significance threshold: the
 * clipper re-nodes coordinates, so an untouched shape's area comes back equal to within ~1e-12
 * relative rather than bit-identical. Anything above this is a real overhang and gets clipped away.
 */
const CLIP_EPSILON = 1e-9;

/**
 * Clip a drawn sub-area to its parent water body (Decision 10): store the intersection, refuse only
 * when too little of the draw survives.
 *
 * **This is the Phase-09b `clipFootprintToBody` pattern with its failure direction reversed, and the
 * reversal is the interesting part.** A hazard clip fails *open* — a clipper error keeps the full
 * unclipped footprint, because making a real hazard invisible is the one direction safety never
 * fails (D3). A sub-area has the opposite asymmetry: the entire argument that drawing one doesn't
 * breach the path-only doctrine (Decision 2) is that its geometry is *constrained to lie inside an
 * already-trusted official polygon*. A clip that failed open would store an unconstrained
 * client-drawn shape and quietly retire that argument. So a clipper failure refuses the write, and
 * the operator redraws or uses the paste-GeoJSON escape hatch. Nothing is at risk in the meantime: an
 * unnamed bay is a missing label, not a missing warning.
 *
 * Coordinates are truncated to ~9 decimals first, same reason as `polygonIoU` and the hazard clip:
 * sub-epsilon float noise makes the clipper choke on near-coincident edges, and a hand-traced bay
 * follows the parent's own shoreline vertices, so near-coincident is the *normal* case here.
 */
export function clipSubAreaToParent(
  drawn: Polygon | MultiPolygon,
  parent: Polygon | MultiPolygon,
  minRetainedFraction: number = SUB_AREA_MIN_RETAINED_FRACTION,
): SubAreaClipResult {
  let drawnArea: number;
  try {
    drawnArea = area(feature(drawn));
  } catch {
    return { ok: false, reason: 'degenerate', retainedFraction: 0 };
  }
  if (!(drawnArea > 0)) return { ok: false, reason: 'degenerate', retainedFraction: 0 };

  let clippedFeature: ReturnType<typeof intersect>;
  try {
    clippedFeature = intersect(
      featureCollection([
        truncate(feature(drawn), { precision: 9 }),
        truncate(feature(parent), { precision: 9 }),
      ]),
    );
  } catch {
    return { ok: false, reason: 'clip_failed', retainedFraction: 0 };
  }
  if (!clippedFeature) return { ok: false, reason: 'disjoint', retainedFraction: 0 };

  const clippedArea = area(clippedFeature);
  if (!(clippedArea > 0)) return { ok: false, reason: 'disjoint', retainedFraction: 0 };

  // Clamped: the clipper can return a hair more than the input through re-noding, and a fraction
  // above 1 would read as nonsense in the operator's rejection message.
  const retainedFraction = Math.min(1, clippedArea / drawnArea);
  if (retainedFraction < minRetainedFraction) {
    return { ok: false, reason: 'mostly_outside', retainedFraction };
  }

  // Already inside: nothing was removed, so storing the re-noded copy would only bloat the row and
  // let the stored outline drift from what the operator drew.
  //
  // **The bar here is "nothing measurable was removed", not "not much was removed"** — and the
  // difference is load-bearing. The hazard clip skips at a 0.5% tolerance, which is fine there
  // because it's an optimization on a fail-open path. Here the same tolerance would let a shape
  // overhanging the parent by half a percent of its area be stored *as drawn*, which quietly turns
  // "inside its parent by construction" (Decision 2's whole argument for moderator drawing) into
  // "inside its parent nearly always". A property test found exactly that: a tall thin rectangle
  // whose bottom edge sat three meters past the shoreline, accepted unclipped at 0.995 retained.
  if (retainedFraction >= 1 - CLIP_EPSILON) {
    return { ok: true, polygon: drawn, retainedFraction, clipped: false };
  }
  return {
    ok: true,
    polygon: clippedFeature.geometry as Polygon | MultiPolygon,
    retainedFraction,
    clipped: true,
  };
}

/** The user-facing half of a refusal, so the editor and the server message agree (one string set). */
export const SUB_AREA_CLIP_MESSAGES: Record<SubAreaClipRejection, string> = {
  degenerate: 'That shape has no area — draw a closed outline with at least three corners.',
  disjoint: "That shape doesn't overlap this lake at all. Are you on the right water body?",
  mostly_outside:
    'Most of that shape falls outside this lake. A sub-area has to be a region *of* the lake — ' +
    'trim it back to the water, or check you drew it on the right body.',
  clip_failed:
    "We couldn't fit that shape to the lake outline. Try redrawing it with simpler edges, or " +
    'paste the GeoJSON directly.',
};

/** A sub-area considered for the membership stamp: an opaque `ref` plus what the rule needs. */
export interface SubAreaCandidate<T> {
  ref: T;
  polygon: Polygon | MultiPolygon;
  /** Geodesic area in m². Ties break on it, so it must be comparable across candidates. */
  surfaceAreaSqM: number;
}

/**
 * The sub-area a point belongs to: the **smallest** one containing it, or `null` when none does
 * (Decision 9).
 *
 * Bays overlap in practice — "Inner" and "Outer" Malletts are exactly this case — so a point often
 * sits in two. Taking the smallest means the most specific name wins, which is what a skater expects
 * ("Inner Malletts," not "Malletts Bay"), and more importantly it is **order-independent**: the
 * answer is a property of the geometry, not of which row the `by_parent` index reached first. A01's
 * whole correction series was one lesson about answers that depended on traversal order, and
 * first-match here would have been the same bug in a smaller place.
 *
 * Equal areas tie-break on nothing — the first is kept — which is fine because two distinct bays with
 * identical geodesic area to the float is not a case the data produces, and if it did, either name is
 * as defensible as the other.
 */
export function smallestContainingSubArea<T>(
  point: LatLng,
  candidates: readonly SubAreaCandidate<T>[],
): T | null {
  let best: { ref: T; area: number } | null = null;
  for (const c of candidates) {
    if (!pointInPolygon(point, c.polygon)) continue;
    if (best === null || c.surfaceAreaSqM < best.area)
      best = { ref: c.ref, area: c.surfaceAreaSqM };
  }
  return best?.ref ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A09 (D175): a bay is a place — the rules that tag what sits in one
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How far off a bay's outline a put-in may sit and still be *its* launch (A09 kickoff call 3).
 *
 * Put-ins are snapped **to the shoreline**, and a bay's clipped outline *is* that shoreline — so
 * point-in-polygon on a launch is a coin flip decided by which side of a shared edge the float
 * noise landed on. Distance is the honest test: within this of the outline, the launch is on the
 * bay's shore. 30 m is a snap tolerance, not a walking radius — wide enough to absorb the
 * re-noding a clip introduces, narrow enough that a launch on the far side of a headland stays
 * with the open lake.
 */
export const SUB_AREA_PUT_IN_TOLERANCE_M = 30;

/**
 * Two bays' outlines are "the same shore" when a launch's distance to each differs by less than
 * this. Nested bays trace the parent's shoreline through their own re-noded clips, so a launch a
 * meter off the shore they share measures ~1e-10 m apart from each — an exact-equality tie would be
 * decided by float rounding, and could flip on the next re-import. A millimetre is far below any
 * distance the geometry can mean and far above the noise.
 */
const SHARED_SHORE_EPSILON_M = 0.001;

/**
 * The bay a put-in belongs to (A09): the nearest bay within {@link SUB_AREA_PUT_IN_TOLERANCE_M},
 * **smallest wins** on a tie — `nearestBodyForPoint`'s shape, because a launch inside both
 * "Inner" and "Outer" Malletts belongs to the inner one for the same reason a report does
 * (Decision 9) — with the tie judged to {@link SHARED_SHORE_EPSILON_M} rather than to the bit.
 * `null` when no bay's shore is within tolerance: open-lake access.
 */
export function subAreaForPutIn<T>(
  coord: LatLng,
  candidates: readonly SubAreaCandidate<T>[],
): T | null {
  let best: { ref: T; distance: number; area: number } | null = null;
  for (const c of candidates) {
    const distance = distanceToPolygonMeters(coord, c.polygon);
    if (distance > SUB_AREA_PUT_IN_TOLERANCE_M) continue;
    if (
      best === null ||
      distance < best.distance - SHARED_SHORE_EPSILON_M ||
      (Math.abs(distance - best.distance) <= SHARED_SHORE_EPSILON_M && c.surfaceAreaSqM < best.area)
    ) {
      best = { ref: c.ref, distance, area: c.surfaceAreaSqM };
    }
  }
  return best?.ref ?? null;
}

/**
 * The share of a track's samples a bay needs before the track is a **member** of it (A09).
 *
 * Membership carries reach (D175): a member bay's favoriters are told, its bounty is satisfied, its
 * feed lists the report. A skate that crossed a bay's mouth for one sample of sixty-four — ninety
 * seconds of an hour — was not *in* that bay in any sense a bounty requester meant, and before A09
 * such a skate carried no bay at all (its pin sat in open water). So a bay counts only past this
 * floor; below it, the samples are open water for every purpose except the mouth-line flag. At
 * `SUB_AREA_TRACK_SAMPLE_POINTS` = 64 this is ~6 samples, or about six minutes of an hour's skate.
 *
 * Taken **against all samples**, open water included, so a track that is mostly open water can end
 * in no bay: the primary is a plurality among *members*, and the floor is what keeps a plurality of
 * three samples from labeling a lake-wide skate "Malletts Bay".
 */
export const SUB_AREA_MEMBERSHIP_MIN_SHARE = 0.1;

/** What a recorded track says about the bays it crossed — see {@link resolveTrackSubAreas}. */
export interface TrackSubAreas<T> {
  /** The member bay holding the most sampled points, or `null` when no bay reached the floor. */
  primary: T | null;
  /** Every bay past {@link SUB_AREA_MEMBERSHIP_MIN_SHARE}, most-visited first. `[]` when none. */
  all: T[];
  /**
   * Some sample fell on the **parent, outside every bay** — the mouth-line evidence (A09 kickoff Q4).
   * Judged only against samples that are actually on the parent when its polygon is supplied, so
   * shoreline GPS jitter on the way to the car does not read as a skater leaving the bay.
   */
  leftSubArea: boolean;
}

/**
 * Resolve a track's sampled points to the bays it was skated in (A09 kickoff Q4, "the two-bay
 * skate").
 *
 * **Majority of samples, not the start point.** A report derived from an activity carries the GPS
 * *start* as its `point` (D44), which is the put-in — so before A09 an activity report was stamped
 * with the bay you launched from, whatever you skated. The primary is instead the bay with the most
 * sampled points, the same rule `resolveTrackToBodies` applies one level up for the body; and the
 * list is *every* bay touched, because a skater who spent an hour in each of two bays was in both,
 * and the rule that governs everything downstream (D175) says a report appears under every place
 * that contains it — once.
 *
 * A sample in two overlapping bays counts for the **smallest** (Decision 9), so nested "Inner" /
 * "Outer" pairs do not double-count one point. `leftSubArea` is the one output nothing acts on: it
 * is stored so the admin card can count skates that ran past a bay's drawn mouth, which is the
 * evidence a moderator adjusts the line on.
 */
export function resolveTrackSubAreas<T>(
  samples: readonly LatLng[],
  candidates: readonly SubAreaCandidate<T>[],
  parentPolygon?: Polygon | MultiPolygon,
): TrackSubAreas<T> {
  const hits = new Map<T, number>();
  let leftSubArea = false;
  for (const sample of samples) {
    const bay = smallestContainingSubArea(sample, candidates);
    if (bay !== null) {
      hits.set(bay, (hits.get(bay) ?? 0) + 1);
      continue;
    }
    if (parentPolygon === undefined || pointInPolygon(sample, parentPolygon)) leftSubArea = true;
  }
  // Only meaningful when there is a bay to have left: open water on a lake with no bays, or a track
  // that never entered one, is not evidence about any mouth line.
  if (hits.size === 0) return { primary: null, all: [], leftSubArea: false };
  const floor = samples.length * SUB_AREA_MEMBERSHIP_MIN_SHARE;
  const ranked = [...hits.entries()]
    .filter(([, count]) => count >= floor)
    .sort((a, b) => b[1] - a[1]);
  return {
    primary: ranked[0]?.[0] ?? null,
    all: ranked.map(([bay]) => bay),
    leftSubArea,
  };
}

/**
 * The bays a stamped row is a member of, primary first — the one way to read the pair of fields
 * that carry membership (A09). `subAreaIds` is stored only when there is more than one (the
 * `waterBodyIds` convention), so most rows answer through `subAreaId` alone; a row with neither is
 * in no bay.
 */
export function memberSubAreaIds<T>(row: { subAreaId?: T; subAreaIds?: readonly T[] }): T[] {
  if (row.subAreaIds !== undefined && row.subAreaIds.length > 0) return [...row.subAreaIds];
  return row.subAreaId === undefined ? [] : [row.subAreaId];
}

/**
 * The membership fields to store for a resolved list, in the stored convention: the primary in
 * `subAreaId`, the whole list in `subAreaIds` **only when it has more than one entry**. A
 * single-element array on every ordinary row would be noise, and a reader that forgot the array
 * would silently see one bay less on the rows that have two — so the convention is written down
 * once, here, and both writers use it.
 */
export function subAreaMembershipFields<T>(all: readonly T[]): {
  subAreaId: T | undefined;
  subAreaIds: T[] | undefined;
} {
  return {
    subAreaId: all[0],
    subAreaIds: all.length > 1 ? [...all] : undefined,
  };
}

/**
 * Does this report count as favorited for a viewer (A09)? A lake favorite takes every report on the
 * lake; a bay favorite takes only reports whose **membership** includes the bay — the feed boost and
 * badge follow the report, not the lake, so favoriting Malletts Bay does not lift Burlington Bay's
 * reports. Both shapes of favorite are tested, because a person very plausibly holds both.
 */
export function isFavoriteReport(
  favorites: { bodyIds: ReadonlySet<string>; subAreaIds: ReadonlySet<string> },
  report: { waterBodyId: string; subAreaId?: string; subAreaIds?: readonly string[] },
): boolean {
  if (favorites.bodyIds.has(report.waterBodyId)) return true;
  if (favorites.subAreaIds.size === 0) return false;
  return memberSubAreaIds(report).some((id) => favorites.subAreaIds.has(id));
}
