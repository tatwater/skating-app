/**
 * Matching a third-party depth record to one of our water bodies (N6a).
 *
 * **Why this exists as its own module, after the first real run.** The join was a single rule:
 * *"the source's point must be strictly inside our polygon"*, with a loose area gate behind it. That
 * rule is right and it is also lossy — the first run stamped only **60% of the bodies that draw at
 * regional zoom**, against a plan that predicted near-total coverage. Sampling the misses found
 * Sugar Hill Reservoir (23 ha) sitting **260 m** from `hylak/1047231` (22 ha): the same lake, the
 * same size, no match, because HydroLAKES' representative point and our polygon come from different
 * water masks drawn on different dates.
 *
 * This is the `centroid`-is-not-a-centroid finding from N6c-1 arriving from the other direction. A
 * source's "point on the lake" is a point on **its** lake.
 *
 * **The rule that keeps the fallback safe: it is STRICTER than the primary path, never looser.**
 * Containment is strong geometric evidence, so it only needs a loose attribute check. Proximity is
 * weak geometric evidence, so it must carry strong attribute agreement — a much tighter area match,
 * or a name that agrees. Anything else would be the failure the zero-buffer rule was written to
 * prevent: *"a point just off one shoreline claiming the body across the road."*
 */

import { nameSimilarity } from './dedup';
import { type BodyCandidate, type LatLng, nearestBodyForPoint } from './geometry';

/**
 * How far outside our polygon a source's point may sit and still be considered.
 *
 * 500 m is set from the observed misses rather than from taste: Sugar Hill's was 260 m, and the
 * gap between two renderings of the same shoreline is bounded by how differently the two surveys
 * drew it, not by lake size. Going much wider stops testing "the same lake drawn differently" and
 * starts testing "the nearest lake", which is what the corroboration below has to catch.
 */
export const DEPTH_PROXIMITY_METERS = 500;

/**
 * The area agreement a proximity match must show **on its own**, with no name to help.
 *
 * Deliberately far tighter than the containment path's gate. At 1.25 the two sources have to agree
 * about the lake's size to within a quarter — which two renderings of one shoreline do, and two
 * different lakes 300 m apart generally do not.
 */
export const DEPTH_PROXIMITY_AREA_RATIO = 1.25;

/**
 * Name similarity that lets a proximity match fall back on the *containment* path's looser area
 * gate. Same threshold as D36's dedup boost, and deliberately the same function — two subsystems
 * disagreeing about whether "Lake Morey" and "Morey Lake" are the same water would be worse than
 * either being wrong alone.
 */
export const DEPTH_PROXIMITY_NAME_SIMILARITY = 0.8;

export interface DepthCandidate<T> extends BodyCandidate<T> {
  /** Our name for this body, when it has one. Absence scores 0 — it never corroborates. */
  name?: string;
}

export interface DepthSourceRecord {
  point: LatLng;
  /** The source's own reported area. Absent means the area gate cannot run at all. */
  areaSqM?: number;
  /** The source's own name for the lake, when it publishes one. */
  name?: string;
}

export type DepthMatchMethod = 'contained' | 'proximity';

export type DepthMatchOutcome<T> =
  | {
      matched: T;
      method: DepthMatchMethod;
      /** 0 for a containment match; the shoreline gap for a proximity one. */
      distanceM: number;
      /** Absent when neither side reported an area, which is itself worth counting. */
      areaRatio?: number;
      /** What corroborated a proximity match. Never set for containment. */
      corroboration?: 'area' | 'name';
    }
  | {
      matched: null;
      reason: 'no_body_nearby' | 'area_mismatch' | 'proximity_unconfirmed';
      detail?: string;
      /**
       * The body we looked at and declined, when there was one.
       *
       * Returned so the caller can name it in the rejection — "area mismatch with Little Pond:
       * 100 m² vs 80,000 m²" is actionable and "800× area difference" is a number to squint at.
       * Absent only for `no_body_nearby`, where there genuinely was no candidate.
       */
      nearest?: T;
    };

/** Larger-over-smaller, so the ratio reads the same whichever source is bigger. */
function areaRatio(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined || a <= 0 || b <= 0) return undefined;
  return Math.max(a / b, b / a);
}

/**
 * Resolve a source lake to one of our bodies, or explain why not.
 *
 * `areaRatioLimit` is the containment path's gate, passed in rather than hard-coded so the caller
 * owns the tuning knob it already surfaces to operators.
 */
export function matchDepthSource<T>(
  source: DepthSourceRecord,
  candidates: readonly DepthCandidate<T>[],
  opts: { areaRatioLimit: number },
): DepthMatchOutcome<T> {
  const byRef = new Map<T, DepthCandidate<T>>(candidates.map((c) => [c.ref, c]));

  // ── 1. Containment. Strong geometry, loose attribute check. ────────────────────────────────
  const containedRef = nearestBodyForPoint(source.point, candidates, 0);
  if (containedRef !== null) {
    const body = byRef.get(containedRef);
    const ratio = areaRatio(body?.surfaceAreaSqM, source.areaSqM);
    if (ratio !== undefined && ratio > opts.areaRatioLimit) {
      // Deliberately NOT falling through to proximity. A point *inside* a body whose area disagrees
      // fourfold is the pond next door, and looking further afield can only find a worse answer.
      return {
        matched: null,
        reason: 'area_mismatch',
        detail: `${ratio.toFixed(1)}× area difference inside the matched body`,
        nearest: containedRef,
      };
    }
    return { matched: containedRef, method: 'contained', distanceM: 0, areaRatio: ratio };
  }

  // ── 2. Proximity. Weak geometry, so the attribute check has to carry it. ───────────────────
  const nearRef = nearestBodyForPoint(source.point, candidates, DEPTH_PROXIMITY_METERS);
  if (nearRef === null) return { matched: null, reason: 'no_body_nearby' };

  const body = byRef.get(nearRef);
  const ratio = areaRatio(body?.surfaceAreaSqM, source.areaSqM);
  const similarity = source.name && body?.name ? nameSimilarity(source.name, body.name) : 0;

  // Area alone, but held to a much tighter standard than containment ever is.
  if (ratio !== undefined && ratio <= DEPTH_PROXIMITY_AREA_RATIO) {
    return {
      matched: nearRef,
      method: 'proximity',
      distanceM: distanceOf(source, candidates, nearRef),
      areaRatio: ratio,
      corroboration: 'area',
    };
  }

  // A name that agrees is independent evidence, so it earns the containment path's area gate — but
  // never more than it. The fallback is never looser than the primary; that is the invariant.
  if (
    similarity >= DEPTH_PROXIMITY_NAME_SIMILARITY &&
    ratio !== undefined &&
    ratio <= opts.areaRatioLimit
  ) {
    return {
      matched: nearRef,
      method: 'proximity',
      distanceM: distanceOf(source, candidates, nearRef),
      areaRatio: ratio,
      corroboration: 'name',
    };
  }

  // A candidate was there and could not be confirmed. Distinct from `no_body_nearby` on purpose:
  // one says the corpus has nothing here, the other says it has something we declined to trust,
  // and only the second is worth a human's attention.
  return {
    matched: null,
    reason: 'proximity_unconfirmed',
    nearest: nearRef,
    detail:
      ratio === undefined
        ? 'a body is within range but neither side reported an area'
        : `nearest body is ${ratio.toFixed(1)}× different in area, name similarity ${similarity.toFixed(2)}`,
  };
}

/** Re-measure the winner's shoreline gap, for the record. */
function distanceOf<T>(
  source: DepthSourceRecord,
  candidates: readonly DepthCandidate<T>[],
  ref: T,
): number {
  const only = candidates.filter((c) => c.ref === ref);
  // Walk the buffer up until the single candidate is admitted; cheaper than exporting the raw
  // distance helper and keeps `nearestBodyForPoint` the one place that measures.
  for (const metres of [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, DEPTH_PROXIMITY_METERS]) {
    if (nearestBodyForPoint(source.point, only, metres) !== null) return metres;
  }
  return DEPTH_PROXIMITY_METERS;
}
