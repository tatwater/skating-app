/**
 * Reconciling one lake across two catalogues — the decision, without the I/O (N7 step 2, D93).
 *
 * ## What this is for, and what it must not become
 *
 * OSM and NHD both describe the same water. Neither knows the other's ids, so the only way to say
 * *"these two polygons are the same lake"* is geometric. That claim then becomes an `nhdId` on our
 * record, which is what lets D92 change a lake's geometry source later without re-keying anything,
 * and what lets NHD collapse duplicates OSM cannot see (Long Pond is `way/150404999` **and**
 * `relation/2602300`; both are one `Permanent_Identifier`).
 *
 * **A wrong match is worse than no match**, because it is invisible: a body silently carrying another
 * lake's `nhdId` will later inherit that lake's geometry, its depth, its contours. So every rule here
 * is biased toward refusing — `ambiguous` and `none` are ordinary, successful outcomes.
 *
 * ## Why IoU and not containment
 *
 * **Measured, not assumed** (D93). North Bay's interior point sits inside NHD's *Moosehead Lake*, so
 * a containment join hands a bay its parent's identity — after which the bay and the lake look like
 * duplicates of each other. Meanwhile Moosehead itself matches **nothing**, because `pointOnFeature`
 * lands on the shoreline of any large irregular lake (D85 amendment). Both failures are silent, and
 * both are avoided by scoring overlap symmetrically: a bay inside a lake has high containment and
 * *low* IoU, which is exactly the distinction that matters.
 *
 * ## Why GNIS proposes but never decides
 *
 * The GNIS Feature ID is the one identifier all three catalogues carry, and an exact match on it is
 * far stronger evidence than any geometric score. But GNIS names **places**, and a catalogue may
 * split one place into several features: **92 GNIS ids resolve to more than one NHD body** (measured
 * over the archives, 0.8% of 10,984). So a GNIS agreement *narrows the candidates* and *lowers the
 * bar* — it never bypasses the geometry check, because the case where it would help most (a lake one
 * catalogue splits) is exactly the case where it is wrong.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { type BBox, bboxIntersects, polygonIoU, surfaceAreaSqM } from './geometry';

/**
 * The overlap two polygons need before we will call them the same lake.
 *
 * **0.5 means they share more area than they don't.** Two catalogues tracing the same shoreline
 * routinely land at 0.85–0.98; the measured OSM-vs-NHD median disagreement on area is 2.4%. A pair
 * scoring below 0.5 is not "the same lake drawn differently", it is a bay against its parent, a
 * reservoir against the river it dams, or two neighbours in a chain.
 *
 * Set from what the failure looks like rather than from a target match rate: the point is to refuse
 * the Moosehead/North Bay class, and a bay is typically well under 0.3 of its parent.
 */
export const RECONCILE_MIN_IOU = 0.5;

/**
 * The bar when both catalogues independently assert the same GNIS Feature ID.
 *
 * Lower, because the geometric evidence is no longer alone — a shared GNIS id is two publishers
 * agreeing this is the same named place. Still a real bar, not a bypass: a lake NHD splits into two
 * features shares its GNIS id with both halves, and each half might score 0.4 against the OSM whole.
 * Accepting those merges a real lake into a fragment.
 */
export const RECONCILE_MIN_IOU_WITH_GNIS = 0.3;

/**
 * How much the best candidate must beat the runner-up to be trusted.
 *
 * A lake in a chain — Moose Pond's five NHD rows, the Rangeley string — can overlap two candidates
 * plausibly. When the top two are close, the honest answer is that geometry cannot tell them apart,
 * and `ambiguous` sends it to a human rather than picking the marginally larger number.
 */
export const RECONCILE_MIN_MARGIN = 0.15;

/**
 * A precomputed geodesic area, in square metres.
 *
 * **Optional, and purely an optimisation — but a load-bearing one at merge scale.** The area bound
 * below is evaluated once per *pair*, so without this a candidate's area is recomputed for every
 * target that comes near it, over its full vertex list. Lake Champlain is 10,755 vertices and sits in
 * hundreds of grid cells; a three-lane merge over 264,000 features re-walks those vertices millions
 * of times to reach a number that never changes. Callers that already know the area should say so.
 */
type PrecomputedArea = { areaSqM?: number | undefined };

/** One catalogue feature offered as a possible match. */
export interface ReconcileCandidate extends PrecomputedArea {
  /** The catalogue's identifier — becomes `nhdId` when this candidate wins. */
  id: string;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  /** Normalized GNIS Feature ID, when the candidate carries one. */
  gnisId?: string | undefined;
  name?: string | undefined;
}

/** The body we are trying to find a counterpart for. */
export interface ReconcileTarget extends PrecomputedArea {
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  gnisId?: string | undefined;
  name?: string | undefined;
}

export interface ScoredCandidate {
  id: string;
  iou: number;
  /** Both sides asserted the same GNIS Feature ID. */
  gnisAgrees: boolean;
  name?: string | undefined;
}

export type ReconcileOutcome =
  /** One clear counterpart. `id` becomes the body's `nhdId`. */
  | {
      readonly verdict: 'matched';
      readonly id: string;
      readonly iou: number;
      readonly gnisAgrees: boolean;
      readonly runnerUp?: ScoredCandidate | undefined;
    }
  /** Two or more plausible counterparts, too close to separate. Route to review; write nothing. */
  | { readonly verdict: 'ambiguous'; readonly candidates: readonly ScoredCandidate[] }
  /** Nothing overlapped enough. Ordinary: NHD holds water OSM does not, and the reverse. */
  | { readonly verdict: 'none'; readonly best?: ScoredCandidate | undefined };

/**
 * A `none` that **very nearly wasn't** — a real candidate that fell just under the bar.
 *
 * Measured over the 2026-08-03 run: of 9,022 unmatched bodies, **815 had a best candidate scoring
 * above zero**, 350 of them between 0.40 and the 0.50 bar and **196 within 0.05 of it**. Today all
 * 9,022 look identical in the output, which conflates two completely different facts — *"no catalogue
 * has ever heard of this lake"* and *"we found its counterpart and rejected it by two points"*. The
 * first is coverage; the second is a threshold, and only one of them is worth a human's time.
 *
 * Deliberately **not a fourth verdict**. Nothing may be written on a near miss — the bar exists
 * because below it a bay inherits its parent's identity — so promoting it to a verdict would invite
 * exactly the write it must not license. It is a *reading* of `none`, for the ledger and the queue.
 */
export const RECONCILE_NEAR_MISS_IOU = 0.4;

/** Did this `none` reject a genuine candidate rather than find nothing? */
export function isNearMiss(
  outcome: ReconcileOutcome,
  threshold = RECONCILE_NEAR_MISS_IOU,
): boolean {
  return outcome.verdict === 'none' && (outcome.best?.iou ?? 0) >= threshold;
}

export interface ReconcileOptions {
  minIou?: number;
  minIouWithGnis?: number;
  minMargin?: number;
}

/**
 * Score every candidate whose bbox meets the target's, best first.
 *
 * Exported because the bbox filter is the only cheap step: a caller with 40,000 candidates should
 * block spatially before calling this, and the scores are worth inspecting even when the verdict is
 * `none` (the drop ledger wants to know *how close* the best miss was).
 */
export function scoreCandidates(
  target: ReconcileTarget,
  candidates: readonly ReconcileCandidate[],
  options: ReconcileOptions = {},
): ScoredCandidate[] {
  // The lowest bar any candidate could clear — so a pair the area bound rules out below this can be
  // skipped without computing anything. Uses the GNIS bar even for candidates without one, because
  // skipping is only sound if it is sound for the most permissive threshold in play.
  const floor = Math.min(
    options.minIou ?? RECONCILE_MIN_IOU,
    options.minIouWithGnis ?? RECONCILE_MIN_IOU_WITH_GNIS,
  );
  const targetArea = target.areaSqM ?? surfaceAreaSqM(target.polygon);

  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    // Disjoint bounding boxes cannot overlap, and the IoU call is far more expensive than this.
    if (!bboxIntersects(target.bbox, candidate.bbox)) continue;

    // **An exact bound, not a heuristic.** The intersection cannot exceed the smaller polygon and
    // the union cannot be smaller than the larger, so `IoU ≤ min(|A|,|B|) / max(|A|,|B|)`. When that
    // ceiling is already under the lowest threshold, no intersection needs computing.
    //
    // This is worth its own line because of *which* pairs it removes: the bay-against-its-parent
    // case, which is both the most expensive comparison (two large, detailed polygons) and the one
    // guaranteed to be rejected. Measured on the real run it turns ~79 minutes into a few, which is
    // what makes "export once, re-derive with different thresholds" an actual workflow rather than
    // an aspiration.
    const candidateArea = candidate.areaSqM ?? surfaceAreaSqM(candidate.polygon);
    const ceiling =
      Math.min(targetArea, candidateArea) / Math.max(targetArea, candidateArea, Number.EPSILON);
    if (ceiling < floor) continue;

    const iou = polygonIoU(target.polygon, candidate.polygon);
    if (iou <= 0) continue;
    scored.push({
      id: candidate.id,
      iou,
      gnisAgrees: Boolean(target.gnisId && candidate.gnisId && target.gnisId === candidate.gnisId),
      name: candidate.name,
    });
  }
  // GNIS agreement breaks a tie in scoring order too, so the preferred candidate is the one the
  // threshold will actually judge first.
  return scored.sort((a, b) =>
    b.iou !== a.iou ? b.iou - a.iou : Number(b.gnisAgrees) - Number(a.gnisAgrees),
  );
}

/**
 * Decide, from scored candidates, whether this body has a counterpart.
 *
 * Separate from `scoreCandidates` so the thresholds can be re-tuned against a stored score set
 * without recomputing 40,000 polygon intersections — the same fetch-once/derive-many split the
 * archives use.
 */
export function decideMatch(
  scored: readonly ScoredCandidate[],
  options: ReconcileOptions = {},
): ReconcileOutcome {
  const minIou = options.minIou ?? RECONCILE_MIN_IOU;
  const minWithGnis = options.minIouWithGnis ?? RECONCILE_MIN_IOU_WITH_GNIS;
  const minMargin = options.minMargin ?? RECONCILE_MIN_MARGIN;

  const bar = (c: ScoredCandidate) => (c.gnisAgrees ? minWithGnis : minIou);
  const viable = scored.filter((c) => c.iou >= bar(c));

  if (viable.length === 0) return { verdict: 'none', best: scored[0] };

  const [best, second] = viable;
  if (!best) return { verdict: 'none', best: scored[0] };

  if (second && best.iou - second.iou < minMargin) {
    // Geometry cannot separate them. Picking the marginally larger number here is how a lake in a
    // chain acquires its neighbour's identity — and the error would be invisible afterwards.
    //
    // **This fired zero times across 21,665 bodies on the 2026-08-03 run, and the reason is not that
    // the rule is dead.** Two candidates both clearing 0.50 against one target must overlap each
    // other heavily, which a catalogue deduped on its own primary key does not produce. The case it
    // was written for is the *split lake*, which clears the lower `minIouWithGnis` bar (0.30) — and
    // that bar never applied, because the stored corpus carries **no GNIS ids at all**: the OSM
    // transform never captured `gnis:feature_id`, though 35.3% of named features have one.
    //
    // So the precondition was missing, not the rule. Matching source-to-source rather than
    // corpus-to-source puts GNIS on both sides for the first time, and this becomes reachable.
    return { verdict: 'ambiguous', candidates: viable };
  }

  return {
    verdict: 'matched',
    id: best.id,
    iou: best.iou,
    gnisAgrees: best.gnisAgrees,
    runnerUp: second,
  };
}

/** Score then decide, for callers that do not need the intermediate. */
export function reconcileOne(
  target: ReconcileTarget,
  candidates: readonly ReconcileCandidate[],
  options: ReconcileOptions = {},
): ReconcileOutcome {
  return decideMatch(scoreCandidates(target, candidates, options), options);
}

/**
 * Group bodies by the counterpart they matched — **this is where OSM's invisible duplicates surface**.
 *
 * OSM cannot see that `way/150404999` and `relation/2602300` are both Long Pond; NHD can, because
 * both land on one `Permanent_Identifier`. Any id claimed by more than one of our bodies is a
 * duplicate pair the corpus has been carrying, and the phase's headline verification is that five
 * known pairs collapse exactly this way.
 *
 * **Reported, never auto-merged.** A merge collapses rows that user content may point at, and the
 * dedup queue exists for that decision (`requiresReview`, `bodyIdentity.ts`).
 */
export function findCollapsedDuplicates<Key>(
  matches: readonly { key: Key; id: string }[],
): { id: string; keys: Key[] }[] {
  const byId = new Map<string, Key[]>();
  for (const m of matches) {
    const list = byId.get(m.id);
    if (list) list.push(m.key);
    else byId.set(m.id, [m.key]);
  }
  return [...byId.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([id, keys]) => ({ id, keys }));
}
