/**
 * Water-body **match-on-create** scoring (D36, Phase 8) — the cheapest dedup is the one that never
 * creates the duplicate.
 *
 * Before a skate on unmapped water writes a new `waterBodies` row, the candidate is scored against
 * every nearby existing body and the result steers the UI: strong matches are offered as "attach
 * here?" and creating anyway requires an explicit "none of these". Whatever the user chooses, the new
 * row is **stamped** with its verdict, which is what feeds the moderator merge queue built in Phase 7
 * (and which has had nothing flowing into it until now).
 *
 * **This module adds no geometry.** Every metric it composes — `polygonIoU`, `pointInPolygon`,
 * `bboxIntersects`, `bufferedLineOverlap`, `haversineMeters` — already ships in `geometry.ts` and is
 * already tested there. Dedup is pure orchestration: pick the right metric for the shape, apply the
 * D36 thresholds, and let a name match bump a tier.
 *
 * **Rivers are compared as reaches, not areas (D4).** A river's IoU against another river is
 * meaningless — two overlapping reaches of the same river can share almost no area while being the
 * same water. So linear bodies route to `bufferedLineOverlap` instead.
 */

import type { LineString, MultiPolygon, Polygon } from 'geojson';
import {
  type BBox,
  bboxIntersects,
  bufferedLineOverlap,
  haversineMeters,
  type LatLng,
  pointInPolygon,
  polygonIoU,
} from './geometry';

/**
 * The verdict on a proposed new body. Mirrors the `dedupStatus` values the schema already carries, so
 * a classification is stored verbatim rather than translated.
 */
export type DedupVerdict = 'clean' | 'suspected_duplicate' | 'near_certain';

/** D36's tunable thresholds, in one place. */
export const DEDUP_THRESHOLDS = {
  /** Polygon IoU at or above which two bodies are *suspected* the same water. */
  iouSuspected: 0.5,
  /** ...and at or above which they're near-certainly the same. */
  iouNearCertain: 0.9,
  /** Centroids closer than this (metres) suspect a duplicate even with little overlap — the
   *  small-body / point-body case, where two hand-placed ponds barely intersect but obviously match. */
  centroidSuspectedM: 75,
  /** Normalized name similarity at or above which a match bumps up one tier. */
  nameBoost: 0.8,
  /** Buffer width for river-reach comparison (D4) — reaches of one river rarely align exactly. */
  reachBufferM: 50,
  /** Buffered-line overlap fractions, the linear analogues of the IoU thresholds. */
  reachSuspected: 0.4,
  reachNearCertain: 0.8,
} as const;

/** Strip case, punctuation, and the noise words that make "Lake Morey" and "morey lake" look different. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(lake|pond|reservoir|river|the|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The set of character bigrams in a string, for the Dice coefficient. */
function bigrams(text: string): string[] {
  const compact = text.replace(/\s/g, '');
  if (compact.length < 2) return compact.length === 1 ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, i) => compact.slice(i, i + 2));
}

/**
 * Normalized name similarity on `0..1` — the D36 booster.
 *
 * Sørensen–Dice over character bigrams, after stripping the generic words ("Lake", "Pond") that
 * otherwise make every pair of lakes look 40% alike. Dice rather than raw edit distance because it's
 * insensitive to word order ("Lake Morey" vs "Morey Lake" → 1) which is the most common way the same
 * water gets typed two ways. Two bodies with no name at all score 0, not 1: absence isn't agreement.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  if (leftGrams.length === 0 || rightGrams.length === 0) return 0;

  // Multiset intersection — a repeated bigram should only match as often as it appears in both.
  const counts = new Map<string, number>();
  for (const gram of leftGrams) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of rightGrams) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      shared++;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * shared) / (leftGrams.length + rightGrams.length);
}

/** One side of a comparison — the proposed body, or an existing one. */
export interface DedupShape {
  name: string;
  /** `LineString` for a river reach (D4); a polygon for everything else. */
  geometry: Polygon | MultiPolygon | LineString;
  centroid: LatLng;
  bbox: BBox;
}

/** A scored match against one existing body, with the evidence that produced it. */
export interface DedupMatch<Ref> {
  ref: Ref;
  verdict: Exclude<DedupVerdict, 'clean'>;
  /** Polygon IoU, when both sides are areal. `null` for a river-reach comparison. */
  iou: number | null;
  /** Buffered-line overlap fraction, when either side is linear. `null` otherwise. */
  reachOverlap: number | null;
  centroidDistanceM: number;
  nameSimilarity: number;
  /** True when the existing body is official (OSM/NHD) — D36 prefers attaching to those. */
  official: boolean;
}

/** Bump a verdict one tier. `near_certain` is already the top. */
function bumpTier(verdict: Exclude<DedupVerdict, 'clean'>): Exclude<DedupVerdict, 'clean'> {
  return verdict === 'suspected_duplicate' ? 'near_certain' : 'near_certain';
}

/**
 * Score one candidate against one existing body. Returns `null` when they're clearly unrelated, so
 * the caller only ever sees real matches.
 *
 * Order of evidence: geometric agreement decides the tier, then a strong name match bumps it. The
 * name is deliberately never sufficient on its own — hundreds of "Mud Pond"s exist in New England,
 * and treating a name alone as a match would merge distinct lakes.
 */
export function scoreDedupPair<Ref>(
  candidate: DedupShape,
  existing: DedupShape & { ref: Ref; official?: boolean },
): DedupMatch<Ref> | null {
  const centroidDistanceM = haversineMeters(candidate.centroid, existing.centroid);
  const names = nameSimilarity(candidate.name, existing.name);

  // Cheapest possible rejection first: boxes that don't touch and centroids far apart can't be the
  // same water, whatever their names say.
  const boxesTouch = bboxIntersects(candidate.bbox, existing.bbox);
  if (!boxesTouch && centroidDistanceM > DEDUP_THRESHOLDS.centroidSuspectedM) return null;

  const linear =
    candidate.geometry.type === 'LineString' || existing.geometry.type === 'LineString';

  let verdict: Exclude<DedupVerdict, 'clean'> | null = null;
  let iou: number | null = null;
  let reachOverlap: number | null = null;

  if (linear) {
    // Rivers as reaches (D4): only comparable when *both* sides are linear. A reach against a lake
    // polygon is a category error, so it falls through to the centroid test below.
    if (candidate.geometry.type === 'LineString' && existing.geometry.type === 'LineString') {
      reachOverlap = bufferedLineOverlap(
        candidate.geometry,
        existing.geometry,
        DEDUP_THRESHOLDS.reachBufferM,
      );
      if (reachOverlap >= DEDUP_THRESHOLDS.reachNearCertain) verdict = 'near_certain';
      else if (reachOverlap >= DEDUP_THRESHOLDS.reachSuspected) verdict = 'suspected_duplicate';
    }
  } else {
    iou = polygonIoU(
      candidate.geometry as Polygon | MultiPolygon,
      existing.geometry as Polygon | MultiPolygon,
    );
    if (iou >= DEDUP_THRESHOLDS.iouNearCertain) verdict = 'near_certain';
    else if (iou >= DEDUP_THRESHOLDS.iouSuspected) verdict = 'suspected_duplicate';
    // A dropped point landing inside an existing body is strong evidence on its own — this is the
    // "point-in-polygon → strong" rule, applied to the candidate's representative point.
    else if (pointInPolygon(candidate.centroid, existing.geometry as Polygon | MultiPolygon)) {
      verdict = 'suspected_duplicate';
    }
  }

  // The small-body case: two hand-placed ponds can barely intersect and still obviously be the same
  // water, so near-coincident centroids suspect a duplicate regardless of overlap.
  if (verdict === null && centroidDistanceM < DEDUP_THRESHOLDS.centroidSuspectedM) {
    verdict = 'suspected_duplicate';
  }
  if (verdict === null) return null;

  if (names >= DEDUP_THRESHOLDS.nameBoost) verdict = bumpTier(verdict);

  return {
    ref: existing.ref,
    verdict,
    iou,
    reachOverlap,
    centroidDistanceM,
    nameSimilarity: names,
    official: existing.official ?? false,
  };
}

/** The overall verdict on a create, plus the ranked matches the UI offers as "attach here?". */
export interface DedupClassification<Ref> {
  status: DedupVerdict;
  matches: DedupMatch<Ref>[];
}

/**
 * Classify a proposed body against every nearby candidate (D36).
 *
 * Matches come back **ranked**, and the ranking is not simply "strongest overlap": an **official**
 * (OSM/NHD) body outranks a user-created one at the same tier, because D36 says overlaps with
 * official data should prefer attaching to the official body. Offering the OSM lake first is how that
 * preference reaches the person actually making the choice.
 *
 * `status` is the strongest single verdict, and it's what gets stamped on the row — so a body created
 * over a near-certain match lands in the moderator queue at the top of the pile.
 */
export function classifyDedup<Ref>(
  candidate: DedupShape,
  existing: readonly (DedupShape & { ref: Ref; official?: boolean })[],
): DedupClassification<Ref> {
  const matches = existing
    .map((body) => scoreDedupPair(candidate, body))
    .filter((m): m is DedupMatch<Ref> => m !== null)
    .sort((a, b) => {
      const tier = (m: DedupMatch<Ref>) => (m.verdict === 'near_certain' ? 1 : 0);
      if (tier(b) !== tier(a)) return tier(b) - tier(a);
      // Official first within a tier — D36 prefers attaching to canonical data.
      if (a.official !== b.official) return a.official ? -1 : 1;
      const overlap = (m: DedupMatch<Ref>) => m.iou ?? m.reachOverlap ?? 0;
      if (overlap(b) !== overlap(a)) return overlap(b) - overlap(a);
      return a.centroidDistanceM - b.centroidDistanceM;
    });

  const status: DedupVerdict = matches.some((m) => m.verdict === 'near_certain')
    ? 'near_certain'
    : matches.length > 0
      ? 'suspected_duplicate'
      : 'clean';

  return { status, matches };
}
