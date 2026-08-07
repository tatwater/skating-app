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
export const CLAIM_SOURCES = ['osm', 'nhd', '3dhp', 'gnis', 'name', 'user'] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/**
 * The catalogues that count as **separate votes**.
 *
 * `nhd` and `3dhp` collapse to one; `name` is not a catalogue at all (it is the same string the
 * catalogue supplied, read a second way) and never corroborates the source it came from; `user` is a
 * moderator decision, which outranks the question rather than voting in it.
 *
 * **`gnis` gets no vote either, and that is not obvious.** It is a real independent authority — the
 * body that assigns US place names — but NHD's own `gnis_name` column *is* GNIS, so counting them
 * separately would be the NHD/3DHP mistake wearing a different hat: one source agreeing with itself.
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

  // `name` is a keyword read off a string a catalogue already supplied; `gnis` is where NHD's own
  // name column comes from. Neither is a second opinion, so neither joins the vote.
  const catalogue = claims.filter((c) => c.source !== 'name' && c.source !== 'gnis');
  // Nothing but a keyword or a gazetteer lookup. Better than silence, and never corroboration.
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
  const catalogue = claims.filter((c) => c.source !== 'name' && c.source !== 'gnis');
  if (catalogue.length === 0) return 'none';
  if (catalogue.length === 1 || independentVoices(catalogue.map((c) => c.source)) < 2) {
    return 'medium'; // one outline, uncorroborated — not a conflict, just unverified
  }
  const worst = Math.min(...catalogue.map((c) => c.value));
  if (worst >= POLYGON_AGREE_IOU) return 'high';
  return worst < POLYGON_DISAGREE_IOU ? 'low' : 'medium';
}

/**
 * Two names are the same claim if they differ only in ways that are **structural rather than
 * semantic** — case, accent, apostrophe, possessive or plural `s`, and word order.
 *
 * Read off the 507 pairs the first version flagged. Nearly all of them were spelling conventions,
 * not disagreements:
 *
 * | | |
 * | --- | --- |
 * | apostrophe | `Harvey's Lake` / `Harvey Lake` · `Leffert's Pond` / `Lefferts Pond` |
 * | possessive `s` | `Clark Pond` / `Clarks Pond` · `Howes Pond` / `Howe Pond` |
 * | word order | `Salem Lake` / `Lake Salem` · `Lake Sadawga` / `Sadawga Lake` |
 *
 * **Typos are deliberately NOT normalised, and that line is the important part.** `Lake Runnemede` /
 * `Lake Runnenede`, `Therman W. Dix` / `Thurman W. Dix` and `Little Eligo` / `Little Elligo` all
 * differ by one character and would fall to an edit-distance rule — but so do **`Bear Pond` and
 * `Bean Pond`**, which are two different lakes. A structural difference is provably the same name
 * spelled twice; a one-character difference only looks like one. Those go to a human.
 *
 * Word order is sorted rather than compared in sequence because `Lake X` and `X Lake` are the same
 * place in every one of these cases and in no case a different one.
 */
export function sameName(a: string, b: string): boolean {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // accents
      .toLowerCase()
      .replace(/[’']/g, '') // Harvey's → harveys
      .split(/[\s\-–]+/)
      .filter((w) => w.length > 0)
      .map((w) => w.replace(/s$/, '')) // harveys → harvey, ponds → pond
      .sort()
      .join(' ');
  return fold(a) === fold(b);
}

/**
 * Class pairs that **look like a disagreement and are not** (founder call, 2026-08-04).
 *
 * Both entries have the same shape: **our vocabulary draws a distinction the federal catalogue does
 * not, and we have already written down which way it resolves.** NHD classes a body by what it *is*;
 * we class two kinds of body by what they *do to a person on the ice*. When NHD says `LakePond` and
 * OSM says `reservoir`, the two are not contradicting each other — they are answering different
 * questions, and both independently agree it is still water of a non-wetland kind.
 *
 * So these score as **agreement**, and the rank in `CLASS_RANK` picks the stored value. Scoring them
 * `low` was measurably wrong in the way that matters: it put **1,437 rows** into a review queue where
 * a moderator would have confirmed a rule we already trust, every time, and a queue that is 70%
 * foregone conclusions is one nobody finishes.
 *
 * **`wetland` is deliberately absent from every pair, and it has to stay absent.**
 * Open-water-versus-bog is the one class disagreement that is about the substance of the water rather
 * than about vocabulary, it is what D96's admission rules turn on, and mis-resolving it is what
 * deleted 123 bodies NHD calls `LakePond`.
 *
 * It does not follow that *every* wetland disagreement needs a human, and the difference is
 * **direction** — which a symmetric pair list cannot express. See `settledWetlandDissent`.
 */
const RECONCILABLE_CLASS_PAIRS: readonly (readonly [WaterBodyClass, WaterBodyClass])[] = [
  // A dammed natural lake. NHD calls it what it is; we call it what it is used for, because that is
  // what carries access rules. 1,419 bodies, in both directions.
  ['reservoir', 'lakePond'],
  // A deadwater or stillwater. NHD publishes it as a waterbody because hydrologically it is one; we
  // separate it because there is current under the ice. 18 bodies.
  ['river', 'lakePond'],
];

/** Do two class claims mean the same thing once our own precedence is applied? */
export function classesReconcile(a: WaterBodyClass, b: WaterBodyClass): boolean {
  if (a === b) return true;
  return RECONCILABLE_CLASS_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** Water we cover that is not a bog. The claim a wetland tag has to beat to be a disagreement. */
const OPEN_WATER_CLASSES: ReadonlySet<WaterBodyClass> = new Set(['lakePond', 'reservoir']);

/**
 * **A federal open-water class against an OSM wetland tag is a settled resolution, not a conflict**
 * (founder call, 2026-08-07, on the measured volume).
 *
 * This is the 123-body rescue — the thing *merge first, filter once* exists for — and it is the
 * single largest population in the review queue. Measured on the `n7-2026-08-07` master list by
 * joining all 652 `class-conflict` bodies to the NHD feature they merged with:
 *
 * | the federal catalogue says | we stored | | |
 * | --- | --- | --- | --- |
 * | `390 LakePond` / `436 Reservoir` | open water | **520** | OSM's mapper tagged it `wetland` |
 * | `466 SwampMarsh` | open water | **132** | the *federal* catalogue is the dissenter |
 *
 * **Only the first row is settled, and the asymmetry is the whole point.** NHD compiled the
 * northeast at 1:24,000 and calls this open water; one mapper tagged the same polygon a marsh. We
 * already decided that direction, in D96, on evidence — so queueing it asks a moderator to confirm a
 * rule we trust, 520 times, which is exactly the 1,437-row mistake `RECONCILABLE_CLASS_PAIRS` was
 * written to undo. The **reverse** direction is where the federal catalogue is the one saying "bog",
 * it is the direction D96's admission floor turns on, and those 132 stay in the queue.
 *
 * **Settled is not silent.** The merge counts every collapse and reports it, because the *volume* of
 * this pattern moving between runs is a real signal about a catalogue changing under us — and a rule
 * that resolves rows without leaving a number behind is how the original 123-body deletion went
 * unnoticed in the first place.
 *
 * Not expressible as a `RECONCILABLE_CLASS_PAIRS` entry: that list is compared value-to-value and
 * both directions of `wetland` ↔ `lakePond` would collapse together, taking the 132 with them.
 */
export function settledWetlandDissent(classes: readonly AttributeClaim<WaterBodyClass>[]): boolean {
  let federalOpenWater = false;
  let osmWetland = false;
  for (const claim of classes) {
    const federal = claim.source === 'nhd' || claim.source === '3dhp';
    if (federal && OPEN_WATER_CLASSES.has(claim.value)) federalOpenWater = true;
    // A federal wetland claim is the direction that is NOT settled, and one is enough to disqualify
    // the whole group — otherwise NHD saying `SwampMarsh` while 3DHP republishes it as `LakePond`
    // would silence the case this rule most needs to leave alone.
    if (federal && claim.value === 'wetland') return false;
    if (claim.source === 'osm' && claim.value === 'wetland') osmWetland = true;
  }
  return federalOpenWater && osmWetland;
}

/**
 * The class claims worth scoring — the settled wetland dissent removed, everything else untouched.
 *
 * Drops **only** the OSM wetland claim rather than the whole group, so a body where OSM *also*
 * disagrees about something else still scores that disagreement. Losing a real conflict to a rule
 * aimed at a different one is the failure this shape avoids.
 */
export function scorableClassClaims(
  classes: readonly AttributeClaim<WaterBodyClass>[],
): readonly AttributeClaim<WaterBodyClass>[] {
  if (!settledWetlandDissent(classes)) return classes;
  return classes.filter((c) => !(c.source === 'osm' && c.value === 'wetland'));
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
    // **…and a federal open-water class beating an OSM wetland tag is settled, not contested.** See
    // `settledWetlandDissent` — 520 of the queue's 652 class conflicts, all of them our own rule
    // firing correctly.
    cls: scoreAttribute(
      scorableClassClaims(input.classes).filter((c) => c.value !== 'unclassified'),
      classesReconcile,
    ),
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

/**
 * Why a body is in the review queue — shown to the moderator, and bulk-filterable.
 *
 * A `const` array rather than a bare union because the values are now **stored**, so a Convex
 * validator has to name them — and two hand-maintained spellings of one vocabulary is how a reason
 * gets written that nothing can read back.
 */
export const REVIEW_REASONS = [
  'class-conflict',
  'name-conflict',
  'bay-without-parent',
  'same-source-duplicate',
  /**
   * Two **separate** bodies in the master list whose outlines overlap — the failure the second N7
   * audit measured and nothing could previously see. See `overlapDuplicate` in `mergeRules.ts`.
   */
  'duplicate-candidate',
] as const;

export type ReviewReason = (typeof REVIEW_REASONS)[number];

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
 * - **`overlapDuplicate`** — two bodies that never shared a group and yet cover the same water. This
 *   is the one the matcher cannot self-report: a missed match produces *two rows*, and the upsert
 *   key is a catalogue id, so nothing downstream can tell them from two real lakes. Measured at 632
 *   overlapping pairs (≥ 0.3 IoU) in the pre-fix master list, 408 of which shared a name.
 */
export function mergeReviewReasons(input: {
  confidence: BodyConfidence;
  bayWithoutParent?: boolean;
  sameSourceDuplicate?: boolean;
  overlapDuplicate?: boolean;
}): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (input.confidence.cls === 'low') reasons.push('class-conflict');
  if (input.confidence.name === 'low') reasons.push('name-conflict');
  if (input.bayWithoutParent) reasons.push('bay-without-parent');
  if (input.sameSourceDuplicate) reasons.push('same-source-duplicate');
  if (input.overlapDuplicate) reasons.push('duplicate-candidate');
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
