/**
 * The draw-time duplicate nudge — layer 1 of D80, and the cheapest of the four (N5c).
 *
 * Before a skater submits, the form can say *"there's already a pressure ridge marked here"* and offer
 * *"confirm that one"* as the primary action, which converts the duplicate into the corroboration it
 * was about to replace. The alternative is one tap away and **never blocked**: somebody standing on
 * ice looking at something the map has wrong must not be argued with. That is the founder call, and it
 * is why this returns a candidate rather than a verdict.
 *
 * **It costs nothing and works offline**, which is where it matters most — the on-ice capture path is
 * exactly where duplicates happen (two skaters, same ridge, no signal, both flagging it). Both clients
 * already hold the body's hazards to draw the map, so this is arithmetic over data in memory.
 *
 * Implemented by clustering the draft *with* the existing hazards rather than by a bespoke distance
 * check, so the nudge and the server's pooling can never disagree about what "the same ridge" means —
 * which is the entire reason D77 insists on one primitive.
 */

import { polygonDistanceMeters } from './geometry';
import {
  type ClusterableHazard,
  clusterHazards,
  DUPLICATE_MATCH_METERS,
  DUPLICATE_MAX_CLUSTER_SPREAD_M,
  hazardFamilyFor,
  hazardFootprintOf,
} from './hazardCluster';

/** A live hazard offered to a skater as "you may be marking this again". */
export interface DuplicateCandidate<T> {
  hazard: T;
  /** Edge-to-edge metres between the draft's footprint and this one's; `0` when they overlap. */
  distanceMeters: number;
}

/** The draft being authored, in the shape the clustering primitive reads. */
export type DuplicateDraft = Omit<ClusterableHazard, 'id' | 'firstReportedAt'>;

/**
 * The live hazard a draft is most likely a duplicate of, or `null`.
 *
 * The **nearest** candidate is offered, tie-broken by the newest sighting: a skater is most likely
 * looking at the thing closest to where they are standing, and among equals the freshest pin is the
 * one whose confirmation is worth the most.
 */
export function findDuplicateCandidate<T extends ClusterableHazard>(
  draft: DuplicateDraft,
  existing: readonly T[],
  {
    matchMeters = DUPLICATE_MATCH_METERS,
    maxSpreadMeters = DUPLICATE_MAX_CLUSTER_SPREAD_M,
  }: { matchMeters?: number; maxSpreadMeters?: number } = {},
): DuplicateCandidate<T> | null {
  // A passage marker never clusters, so it never nudges: merging two crossings would claim a wider
  // crossable span than anyone reported, and suggesting it at draw time is the same claim, earlier.
  if (hazardFamilyFor(draft.type) === null) return null;

  const DRAFT_ID = '~draft';
  // `firstReportedAt: Infinity` puts the draft last in the canonical order by construction, so adding
  // it can never reshuffle how the existing hazards cluster among themselves — the nudge sees exactly
  // the groups the map does, plus wherever the draft lands.
  const withDraft: ClusterableHazard[] = [
    ...existing,
    { ...draft, id: DRAFT_ID, firstReportedAt: Number.POSITIVE_INFINITY },
  ];
  const cluster = clusterHazards(withDraft, { matchMeters, maxSpreadMeters }).find((c) =>
    c.members.some((m) => m.id === DRAFT_ID),
  );
  if (!cluster) return null;

  const draftFootprint = hazardFootprintOf({ ...draft, id: DRAFT_ID, firstReportedAt: 0 });
  if (!draftFootprint) return null;

  const byId = new Map(existing.map((h) => [h.id, h]));
  let best: DuplicateCandidate<T> | null = null;
  for (const member of cluster.members) {
    const hazard = byId.get(member.id);
    if (!hazard) continue;
    const footprint = hazardFootprintOf(member);
    if (!footprint) continue;
    const distanceMeters = polygonDistanceMeters(draftFootprint, footprint);
    if (
      best === null ||
      distanceMeters < best.distanceMeters ||
      (distanceMeters === best.distanceMeters &&
        hazard.firstReportedAt > best.hazard.firstReportedAt)
    ) {
      best = { hazard, distanceMeters };
    }
  }
  return best;
}
