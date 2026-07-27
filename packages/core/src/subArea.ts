/**
 * Named sub-areas (N2 / D60) — the geometry rules for a region *inside* one water body.
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
import { type LatLng, pointInPolygon } from './geometry';

/**
 * How much of a drawn shape must survive the clip for the write to be accepted (Decision 10).
 *
 * Tracing a bay along a real shoreline cuts across land on nearly every vertex, so *some* overhang is
 * normal authoring, not a mistake — clipping it away is the right answer. But a shape that is mostly
 * outside its parent isn't a sloppy edge, it's a misplaced draw (the wrong lake, a dragged vertex, a
 * pasted GeoJSON from somewhere else), and silently saving the sliver that happens to overlap is the
 * silent-wrong-answer class this codebase keeps refusing. So there is a line, and it's here.
 *
 * 0.6 is an opening number to be checked against the real Champlain traces in the curation session,
 * not a derived one. It is deliberately loose: the failure it guards against is gross, and a
 * false refusal costs the operator a redraw of work they did correctly.
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

/** Below this fractional loss the draw counts as already-inside and is stored as-drawn (0.5%). */
const CLIP_SIGNIFICANCE = 0.005;

/**
 * Clip a drawn sub-area to its parent water body (Decision 10): store the intersection, refuse only
 * when too little of the draw survives.
 *
 * **This is the Phase-9.5 `clipFootprintToBody` pattern with its failure direction reversed, and the
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

  // Already inside: storing the re-noded copy would only bloat the row and let the stored outline
  // drift from what the operator drew, for no gain. Same call the hazard clip makes.
  if (retainedFraction >= 1 - CLIP_SIGNIFICANCE) {
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
 * answer is a property of the geometry, not of which row the `by_parent` index reached first. N1's
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
