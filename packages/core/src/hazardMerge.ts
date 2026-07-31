/**
 * Auto-merge — layer 4 of D80, and the only destructive-looking one (N5c).
 *
 * The first three layers make duplicates *read* as one hazard. This one makes them *be* one row, which
 * is what actually removes the N× work the confirm loop was doing: two "fully healed" votes retire one
 * ridge instead of two per pin, and there is one list entry instead of several.
 *
 * **Built on D36's water-body merge pattern**, which is the thing that makes automating it acceptable:
 * the loser is tombstoned rather than deleted, the chain is resolved through a hop cap, and a moderator
 * `unmerge` puts both pins back intact. Nothing is destroyed, so the worst outcome is reversible.
 *
 * **Confirmations are never re-pointed.** A confirmation is a named person's statement about a
 * *specific* pin (D65 names confirmers publicly), so rewriting its `hazardId` would edit that
 * statement. The chain is read *through* instead — the survivor's consensus counts the whole chain's
 * authors and confirmers, and every one of them stays attached to the pin they actually spoke about.
 *
 * **The residual risk, stated plainly:** a wrong merge costs a distinct hazard its separate identity,
 * the one failure here a skater cannot undo for themselves. What bounds it is that a merge can never
 * shrink the warned footprint (the survivor takes the union), never pools clearance votes, and never
 * survives a moderator noticing it. So the cost of being wrong is *a confusing pin*, not *unwarned ice*.
 */

import { polygonDistanceMeters, polygonIoU } from './geometry';
import { type ClusterableHazard, hazardFamilyFor, hazardFootprintOf } from './hazardCluster';
import { isPassageMarker } from './types';

/**
 * How much of the two footprints must be shared before a merge is automatic, as
 * intersection-over-union.
 *
 * The job of this number is to stop a lake-spanning polygon swallowing a small distinct pin it happens
 * to contain. Overlap alone can't: a 300 m `thawed_rotten` zone contains a 5 m drilled hole completely,
 * and "contains" is not "is the same as". Requiring half the combined area to be shared means the two
 * shapes have to be roughly the same thing at roughly the same size.
 */
export const AUTOMERGE_MIN_FOOTPRINT_IOU = 0.5;

/**
 * Whether a near miss can ever auto-merge. It cannot, and this constant exists to be read in
 * `/admin/tuning` rather than to be flipped: 25 m apart is *probably* the same ridge, and overlapping
 * is *yes*. Automating the first would merge on a guess.
 */
export const AUTOMERGE_REQUIRE_OVERLAP = true;

/** One candidate for merging, with the state the bar has to check. */
export interface MergeCandidate extends ClusterableHazard {
  season: number;
  moderationStatus: string;
  /** Set when this row is already a merge tombstone. */
  mergedIntoHazardId?: string;
  /** Set when a moderator promoted this pin into a body feature. */
  promotedToFeatureId?: string;
  /** The pin the skater was shown at draw time and told us was a different hazard (D80, layer 1). */
  dismissedDuplicateOf?: string;
  /** Pins a moderator has already separated from this one — a merge must never be re-decided. */
  noMergeWith?: readonly string[];
}

/** Why a pair was refused, for the audit trail and for tests that assert the reason, not just the no. */
export type MergeRefusal =
  | 'same_row'
  | 'different_family'
  | 'passage_marker'
  | 'different_season'
  | 'already_merged'
  | 'promoted'
  | 'moderator_hidden'
  | 'no_overlap'
  | 'insufficient_overlap'
  | 'skater_said_different'
  | 'previously_unmerged'
  | 'unusable_geometry';

export type MergeVerdict = { merge: true } | { merge: false; reason: MergeRefusal };

/**
 * May these two pins be merged without a human looking? Every condition is required.
 *
 * **No time-window condition, deliberately.** A ridge marked in December and independently marked
 * again in February, overlapping, is the same ridge — and the February reporter is exactly the
 * corroboration the pin has been missing. Merging them is right, and the survivor keeps December.
 * What *is* required is the same **season**: across the boundary is recurrence's question, not this
 * one, and it has a different tolerance and a different answer.
 */
export function shouldAutoMerge(a: MergeCandidate, b: MergeCandidate): MergeVerdict {
  if (a.id === b.id) return { merge: false, reason: 'same_row' };

  const family = hazardFamilyFor(a.type);
  if (family === null || family !== hazardFamilyFor(b.type)) {
    // Never merge a spring into a ridge. Two facts about the lake are not one fact.
    return { merge: false, reason: 'different_family' };
  }
  // Belt and braces: `hazardFamilyFor` already returns null for a crossing, so this is unreachable —
  // and it is written anyway, because merging crossings would claim a wider crossable span than
  // anyone reported and that is the direction safety content never errs in.
  if (isPassageMarker(a.type) || isPassageMarker(b.type)) {
    return { merge: false, reason: 'passage_marker' };
  }
  if (a.season !== b.season) return { merge: false, reason: 'different_season' };

  // Never re-decide something a human decided.
  if (a.mergedIntoHazardId !== undefined || b.mergedIntoHazardId !== undefined) {
    return { merge: false, reason: 'already_merged' };
  }
  if (a.promotedToFeatureId !== undefined || b.promotedToFeatureId !== undefined) {
    return { merge: false, reason: 'promoted' };
  }
  if (a.moderationStatus !== 'visible' || b.moderationStatus !== 'visible') {
    return { merge: false, reason: 'moderator_hidden' };
  }
  if (a.noMergeWith?.includes(b.id) || b.noMergeWith?.includes(a.id)) {
    // A moderator separated these two. Re-merging them on the next pass would make `unmerge` a
    // button that undoes nothing.
    return { merge: false, reason: 'previously_unmerged' };
  }
  if (a.dismissedDuplicateOf === b.id || b.dismissedDuplicateOf === a.id) {
    // The skater was shown this exact pin and said theirs was different. The nudge promised not to
    // argue; merging anyway is the same argument, held quietly.
    return { merge: false, reason: 'skater_said_different' };
  }

  const footA = hazardFootprintOf(a);
  const footB = hazardFootprintOf(b);
  if (!footA || !footB) return { merge: false, reason: 'unusable_geometry' };

  if (AUTOMERGE_REQUIRE_OVERLAP && polygonDistanceMeters(footA, footB) > 0) {
    return { merge: false, reason: 'no_overlap' };
  }
  if (polygonIoU(footA, footB) < AUTOMERGE_MIN_FOOTPRINT_IOU) {
    return { merge: false, reason: 'insufficient_overlap' };
  }
  return { merge: true };
}

/**
 * Which of two mergeable pins survives: the **earliest** `firstReportedAt`, ties broken by id.
 *
 * It is the first sighting, so it is the honest date for the merged pin to carry — and it is the date
 * the cross-season record wants, since recurrence keys a season off `firstReportedAt` (D63). Keeping
 * the *newer* row would quietly move a hazard's first-seen date forward every time someone re-marked
 * it, which is the sort of drift nobody notices until a denominator is wrong.
 */
export function mergeSurvivorOf<T extends { id: string; firstReportedAt: number }>(a: T, b: T): T {
  if (a.firstReportedAt !== b.firstReportedAt) return a.firstReportedAt < b.firstReportedAt ? a : b;
  return a.id <= b.id ? a : b;
}

/**
 * How many tombstones a survivor lookup will follow before giving up.
 *
 * Mirrors the water-body `resolveSurvivor` cap and exists for the same reason: a cycle written by a
 * bug must degrade into "we couldn't resolve this" rather than into a query that never returns. Three
 * is far past any real chain — a merge always points at a *survivor*, so chains longer than one hop
 * only appear when a survivor is later merged itself.
 */
export const MERGE_CHAIN_MAX_HOPS = 3;
