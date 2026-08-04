/**
 * **How much the catalogues agree, per attribute** (N7, D110).
 *
 * A merged body is assembled field by field from up to three publishers, and by the time it reaches
 * a row every trace of *how sure we were* is gone. One number per body would be useless — a lake can
 * have a perfectly corroborated outline and a name only one source has ever heard of — so this scores
 * each attribute separately and stores all of them.
 *
 * ## Four levels, and the fourth is the one that makes the review queue workable
 *
 * | | means | who acts |
 * | --- | --- | --- |
 * | `high` | two **independent** catalogues assert the same thing | nobody |
 * | `medium` | exactly one catalogue asserts it, uncontested | nobody |
 * | `low` | the catalogues **conflict** and a precedence rule broke the tie | **a moderator, from the queue** |
 * | `none` | nothing asserts it at all | nobody — it is a backlog, not a queue |
 *
 * **`low` and `none` are separated on purpose, and it is the difference between a queue that gets
 * worked and one that does not.** Collapsing them would put every unnamed body and every
 * `unclassified` row into review — on today's corpus that is thousands of rows, which is a backlog
 * wearing a queue's clothes, and the honest consequence is that nobody opens it. A genuine conflict
 * between two publishers is rare, specific, and something a human can actually adjudicate in seconds.
 * Absence of evidence is a browsable list ranked by size, and N7b's request path is what pulls an
 * individual row out of it.
 *
 * ## NHD and 3DHP are ONE independent source, not two
 *
 * 3DHP re-publishes NHD wherever elevation-derived hydrography has not landed, which in the Northeast
 * is everywhere: 7,878 lakes compared, **zero area disagreements at or above 0.1%**. If they were
 * counted separately every federal body would score `high` for free and the level would mean nothing.
 * `independentVoices` collapses them, and the year EDH actually arrives is the year that stops being
 * the right call — which is what D102's divergence monitor exists to notice.
 *
 * **And 3DHP publishes no wetland class at all**, so its silence is never evidence against NHD's.
 * That is enforced upstream, in `waterClass`'s three-outcome `SourceClaim`; it is restated here
 * because a scorer that treated `silent` as a dissenting vote would mark all 44,290 federal wetlands
 * as contested.
 */

import type { WaterBodyClass } from './types';

/** How well corroborated one attribute of one body is. */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'none'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Which publisher a claim came from. */
export const CLAIM_SOURCES = ['osm', 'nhd', '3dhp', 'name', 'user'] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/**
 * The catalogues that count as **separate votes**.
 *
 * `nhd` and `3dhp` collapse to one; `name` is not a catalogue at all (it is the same string the
 * catalogue supplied, read a second way) and never corroborates the source it came from; `user` is a
 * moderator decision, which outranks the question rather than voting in it.
 */
export function independentVoices(sources: readonly ClaimSource[]): number {
  let federal = false;
  let osm = false;
  for (const source of sources) {
    if (source === 'osm') osm = true;
    if (source === 'nhd' || source === '3dhp') federal = true;
  }
  return (osm ? 1 : 0) + (federal ? 1 : 0);
}

/** One publisher's claim about one attribute. `value` is compared with `===` after normalisation. */
export interface AttributeClaim<T> {
  readonly source: ClaimSource;
  readonly value: T;
}

/**
 * Score one attribute from the claims made about it.
 *
 * `equals` is injected because "the same" differs by attribute: two names match case-insensitively,
 * two classes match exactly, two polygons match above an IoU bar. Passing the comparison in keeps
 * this function honest about the one thing it does — counting agreement — instead of growing a branch
 * per field type.
 */
export function scoreAttribute<T>(
  claims: readonly AttributeClaim<T>[],
  equals: (a: T, b: T) => boolean = (a, b) => a === b,
): Confidence {
  // A moderator has looked at it. That is the strongest evidence available and it ends the question.
  if (claims.some((c) => c.source === 'user')) return 'high';
  if (claims.length === 0) return 'none';

  const catalogue = claims.filter((c) => c.source !== 'name');
  // Nothing but a keyword read off the name. Better than silence, and never corroboration.
  if (catalogue.length === 0) return 'medium';

  const [reference, ...rest] = catalogue;
  if (reference === undefined) return 'medium';
  const unanimous = rest.every((c) => equals(c.value, reference.value));
  if (!unanimous) return 'low';

  return independentVoices(catalogue.map((c) => c.source)) >= 2 ? 'high' : 'medium';
}

/**
 * Where two outlines stop agreeing — **derived from the measured distribution, not from prose**.
 *
 * The first draft of this file put a single bar at 0.85 and justified it with a sentence carried over
 * from the phase plan: *"two catalogues tracing one shoreline land at 0.85–0.98"*. The real
 * OSM-vs-NHD distribution over all **12,643 matched pairs** says otherwise:
 *
 * | p1 | p10 | p25 | **p50** | p75 | p90 | p99 |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | 0.522 | 0.668 | 0.791 | **0.883** | 0.936 | 0.964 | 0.986 |
 *
 * 0.85 sits *below the median*, so it would have called 38.6% of every matched pair a disagreement.
 * The quoted range described the upper half of the distribution and missed a long left tail.
 *
 * So agreement is bucketed rather than thresholded once: above `POLYGON_AGREE_IOU` the two are the
 * same lake drawn twice (61%), below `POLYGON_DISAGREE_IOU` they materially differ about where the
 * water ends (13%), and the band between is ordinary tracing variance.
 *
 * Both are **stricter than `RECONCILE_MIN_IOU` (0.5)**, which answers a different question:
 * reconciliation asks *"is this the same lake?"* and must be permissive or it splits one body in two;
 * this asks *"do they agree about its shape?"*. One number for both would silently pick a side.
 */
export const POLYGON_AGREE_IOU = 0.85;
/** Below this the two publishers disagree about the shoreline itself. p13 of the measured spread. */
export const POLYGON_DISAGREE_IOU = 0.7;

/**
 * Score outline agreement from the worst pairwise IoU among the claims.
 *
 * Separate from `scoreAttribute` because agreement here is **continuous**, and forcing a continuous
 * quantity through a boolean `equals` is what produced the 0.85 mistake above — a binary test has to
 * put its threshold somewhere, and there was nowhere honest to put it.
 */
export function scorePolygonAgreement(claims: readonly AttributeClaim<number>[]): Confidence {
  if (claims.some((c) => c.source === 'user')) return 'high';
  const catalogue = claims.filter((c) => c.source !== 'name');
  if (catalogue.length === 0) return 'none';
  if (catalogue.length === 1 || independentVoices(catalogue.map((c) => c.source)) < 2) {
    return 'medium'; // one outline, uncorroborated — not a conflict, just unverified
  }
  const worst = Math.min(...catalogue.map((c) => c.value));
  if (worst >= POLYGON_AGREE_IOU) return 'high';
  return worst < POLYGON_DISAGREE_IOU ? 'low' : 'medium';
}

/** Two names are the same claim if they differ only by case, accent or surrounding space. */
export function sameName(a: string, b: string): boolean {
  const fold = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  return fold(a) === fold(b);
}

/** The per-attribute scores carried on a merged body. */
export interface BodyConfidence {
  readonly name: Confidence;
  readonly polygon: Confidence;
  readonly cls: Confidence;
  readonly depth: Confidence;
}

/**
 * Score a whole body from what each catalogue said about it.
 *
 * Claims are passed already extracted, so this stays pure and testable without a geodatabase — the
 * merge does the reading, this does the judging, and the split is what lets every dangerous case be
 * covered by a unit test rather than discovered in a campaign.
 */
export function scoreBody(input: {
  names: readonly AttributeClaim<string>[];
  /** Pre-computed pairwise IoU against the first claim; the merge holds the geometry, not us. */
  polygons: readonly AttributeClaim<number>[];
  classes: readonly AttributeClaim<WaterBodyClass>[];
  depths: readonly AttributeClaim<number>[];
}): BodyConfidence {
  return {
    name: scoreAttribute(input.names, sameName),
    // Each polygon claim carries its IoU against the reference outline; the reference itself is 1.
    polygon: scorePolygonAgreement(input.polygons),
    // **`unclassified` is silence, not a dissenting vote**, and dropping it here is not a nicety:
    // scoring it as a claim made 6,756 bodies where OSM said nothing and NHD said `LakePond` read as
    // "the catalogues conflict", which was most of a 3,999-row review queue nobody could have worked.
    // Same principle as 3DHP's `silent` — a source with no opinion does not get a vote.
    cls: scoreAttribute(input.classes.filter((c) => c.value !== 'unclassified')),
    depth: scoreAttribute(input.depths),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The review queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which attributes send a body to review when they score `low` (D110, founder call 2026-08-04).
 *
 * **Not every conflict is worth a person — the test is whether a human has an action.** A class
 * conflict is one: a moderator looks at a map and a name and picks. A name conflict is one: they pick
 * the name. A **polygon** conflict is *not*, and that is the correction worth recording — nobody can
 * usefully adjudicate "these two outlines differ by 20%" by eye, and the thing that decides which
 * outline to use is D92's geometry-source rule, not a person. Measured, it would also have been the
 * single largest contributor to the queue at 4,415 rows. It is still *scored*, because that is real
 * information about the body; it just does not summon anyone.
 *
 * Depth is likewise scored and not queued: it resolves itself the next time the depth pass runs.
 */
export const REVIEWABLE_ATTRIBUTES = ['cls', 'name'] as const;

/** Why a body is in the review queue — shown to the moderator, and bulk-filterable. */
export type ReviewReason =
  | 'class-conflict'
  | 'name-conflict'
  | 'bay-without-parent'
  | 'same-source-duplicate';

/**
 * Does this body need a human before it ships?
 *
 * Two triggers that are **not** confidence scores, because they are structural rather than
 * evidential:
 *
 * - **`bayWithoutParent`** — a `bay` is an arm *of* something, so one with no parent body in our
 *   corpus is a claim we cannot support. Half Moon Cove is the fixture: 330 acres, named "Cove",
 *   0.00 contained in anything, and [the state's own map](https://anrmaps.vermont.gov/websites/wma/maps/Halfmoon%20Cove.pdf)
 *   calls it a wetland. Nothing about the *name* could have caught that; only the missing parent does.
 * - **`sameSourceDuplicate`** — one merge group holding two features from one catalogue means our
 *   matching chained two distinct lakes together, or found a real duplicate OSM cannot see. Both are
 *   findings; neither may be merged unattended.
 */
export function mergeReviewReasons(input: {
  confidence: BodyConfidence;
  bayWithoutParent?: boolean;
  sameSourceDuplicate?: boolean;
}): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (input.confidence.cls === 'low') reasons.push('class-conflict');
  if (input.confidence.name === 'low') reasons.push('name-conflict');
  if (input.bayWithoutParent) reasons.push('bay-without-parent');
  if (input.sameSourceDuplicate) reasons.push('same-source-duplicate');
  return reasons;
}

/**
 * Is this body merely **unresolved** rather than contested?
 *
 * The backlog, not the queue — an unnamed `unclassified` pond nobody has ever described. It ships,
 * it is browsable in the admin water list ranked by area, and a community flag or an N7b request is
 * what promotes an individual one into a moderator's hands. Kept as a named predicate so the
 * distinction is enforced by a function rather than remembered by whoever writes the next query.
 */
export function needsAttention(confidence: BodyConfidence): boolean {
  return confidence.cls === 'none' || confidence.name === 'none';
}
