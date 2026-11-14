/**
 * The dedup-review queue's read and its grouping — **one rule for every reader**.
 *
 * `waterBodies.listDedupCandidates` draws the queue and `console.corpusCounts` puts its size on the
 * Overview. They used to read different things: the Overview counted rows by `reviewReason`, the
 * queue reads `dedupStatus`, and a body D36's match-on-create flagged (`waterBodies.create` sets
 * `dedupStatus` and its candidates, never a review reason) sat in the queue while the Overview said
 * nothing was waiting. Both now call this, so the Overview's figure is the queue's `total` by
 * construction.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { takeCappedResult } from './scan';

/** How many flagged rows the queue reads before it says so. Two per pair, so this is ~125 pairs. */
export const DEDUP_QUEUE_CAP = 250;
/** The most bodies one card may hold. A component larger than this is a matcher bug, not a merge. */
export const DEDUP_GROUP_CAP = 6;

/** One card's worth of duplicates: the bodies, and whether the group cap cut it short. */
export type DedupGroupDocs = {
  key: string;
  members: Doc<'waterBodies'>[];
  truncated: boolean;
};

/**
 * The queue, grouped into one entry per decision.
 *
 * Both match-on-create tiers land in it, near-certain first (D36): a body flagged as almost
 * certainly a duplicate is the one a moderator should merge before anything else, and before more
 * reports accumulate on the wrong row. The read stops at {@link DEDUP_QUEUE_CAP} flagged rows, and
 * `truncated` says when it did: past that, `groups.length` is a floor.
 *
 * Rows are folded into connected components over `duplicateCandidateIds`. Edges are followed
 * **only out of rows that are themselves flagged**. A candidate that is clean (or already merged)
 * is pulled in so the card can name it, but its own candidate list is not walked: that bound is
 * what keeps one mis-scored chain from swallowing the corpus into a single card. A candidate that
 * no longer exists links nothing, so two flags pointing at the same deleted body are two cards.
 */
export async function readDedupQueue(ctx: QueryCtx): Promise<{
  groups: DedupGroupDocs[];
  flaggedRows: number;
  truncated: boolean;
}> {
  const near = await takeCappedResult(
    ctx.db
      .query('waterBodies')
      .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'near_certain')),
    DEDUP_QUEUE_CAP,
    'dedupQueue (near_certain)',
  );
  const suspected = await takeCappedResult(
    ctx.db
      .query('waterBodies')
      .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'suspected_duplicate')),
    Math.max(0, DEDUP_QUEUE_CAP - near.rows.length),
    'dedupQueue (suspected_duplicate)',
  );
  const flagged = [...near.rows, ...suspected.rows];

  // Every body the card has to name, flagged or not: a candidate may be a clean canonical body
  // (D36's original case) that never carries a flag of its own.
  const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>(flagged.map((b) => [b._id, b]));
  for (const body of flagged) {
    for (const id of body.duplicateCandidateIds ?? []) {
      if (byId.has(id)) continue;
      const other = await ctx.db.get(id);
      if (other) byId.set(id, other);
    }
  }

  // Connected components, walking edges out of flagged rows only (both directions: a mutual pair
  // and a one-way D36 stamp must both come out as one card).
  const neighbors = new Map<Id<'waterBodies'>, Set<Id<'waterBodies'>>>();
  const link = (a: Id<'waterBodies'>, b: Id<'waterBodies'>) => {
    if (!byId.has(a) || !byId.has(b)) return;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const set = neighbors.get(from) ?? new Set<Id<'waterBodies'>>();
      set.add(to);
      neighbors.set(from, set);
    }
  };
  for (const body of flagged) {
    for (const id of body.duplicateCandidateIds ?? []) link(body._id, id);
  }

  const seen = new Set<Id<'waterBodies'>>();
  const groups: DedupGroupDocs[] = [];
  for (const body of flagged) {
    if (seen.has(body._id)) continue;
    const members: Doc<'waterBodies'>[] = [];
    const stack = [body._id];
    let truncated = false;
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const doc = byId.get(id);
      if (!doc) continue;
      if (members.length >= DEDUP_GROUP_CAP) {
        truncated = true;
        continue;
      }
      members.push(doc);
      for (const next of neighbors.get(id) ?? []) stack.push(next);
    }
    // A flag whose only candidate has since been deleted leaves a group of one. It still belongs
    // in the queue (the flag is real and someone has to clear it).
    const key = members
      .map((m) => m._id)
      .sort()
      .join('+');
    groups.push({ key, members, truncated });
  }

  // Near-certain groups first (D36), then the biggest: a three-body group is either the matcher
  // chaining two lakes together or a genuinely messy piece of the corpus, and both want a human
  // sooner than a routine pair does.
  groups.sort((a, b) => {
    const tier = (g: DedupGroupDocs) =>
      g.members.some((m) => m.dedupStatus === 'near_certain') ? 0 : 1;
    return tier(a) - tier(b) || b.members.length - a.members.length;
  });

  return {
    groups,
    flaggedRows: flagged.length,
    truncated: near.truncated || suspected.truncated,
  };
}
