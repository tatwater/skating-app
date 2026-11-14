/**
 * The dedup-review queue's read and its grouping — **one rule for every reader**.
 *
 * `waterBodies.listDedupCandidates` draws the queue and `console.corpusCounts` puts its size on the
 * Overview. They used to read different things: the Overview counted rows by `reviewReason`, the
 * queue reads `dedupStatus`, and a body D36's match-on-create flagged (`waterBodies.create` sets
 * `dedupStatus` and its candidates, never a review reason) sat in the queue while the Overview said
 * nothing was waiting. Both now read the flags here and group them with {@link dedupGroups}, so the
 * Overview's figure is the queue's `total` by construction.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { takeCappedResult } from './scan';

/** How many flagged rows the queue reads before it says so. Two per pair, so this is ~125 pairs. */
export const DEDUP_QUEUE_CAP = 250;
/** The most bodies one card may hold. A component larger than this is a matcher bug, not a merge. */
export const DEDUP_GROUP_CAP = 6;

type BodyId = Id<'waterBodies'>;

/**
 * The flagged rows, both match-on-create tiers, near-certain first (D36): a body flagged as almost
 * certainly a duplicate is the one a moderator should merge before anything else. The read stops at
 * {@link DEDUP_QUEUE_CAP} rows, and `truncated` says when it did: past that, any count is a floor.
 */
export async function readDedupFlags(
  ctx: QueryCtx,
): Promise<{ flagged: Doc<'waterBodies'>[]; truncated: boolean }> {
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
  return {
    flagged: [...near.rows, ...suspected.rows],
    truncated: near.truncated || suspected.truncated,
  };
}

type Flag = Pick<Doc<'waterBodies'>, '_id' | 'duplicateCandidateIds'>;

/**
 * The candidates whose existence can change the grouping: unflagged bodies named by two or more
 * flagged rows. A candidate named once is a leaf of its one row's group whether it exists or not,
 * and a flagged candidate is in the read. Only these need fetching to count the decisions.
 */
export function sharedCandidates(flagged: readonly Flag[]): BodyId[] {
  const flaggedIds = new Set(flagged.map((f) => f._id));
  const named = new Map<BodyId, number>();
  for (const row of flagged) {
    for (const id of new Set(row.duplicateCandidateIds ?? [])) {
      if (!flaggedIds.has(id)) named.set(id, (named.get(id) ?? 0) + 1);
    }
  }
  return [...named].filter(([, n]) => n >= 2).map(([id]) => id);
}

/**
 * The flagged rows grouped into decisions: connected components over `duplicateCandidateIds`, each
 * listed flagged rows first (in read order), then the candidates they pulled in. Edges are followed
 * **only out of flagged rows**: a clean (or merged) candidate joins the rows that name it, but its own
 * candidate list is not walked, so one mis-scored chain can't swallow the corpus into one card.
 *
 * A candidate that no longer exists links nothing, so two flags naming the same deleted body are two
 * decisions. `exists` is consulted only for {@link sharedCandidates}: that is the whole of what the
 * count must fetch, and the queue, which fetches every candidate to name it, gets the same groups.
 */
export function dedupGroups(flagged: readonly Flag[], exists: (id: BodyId) => boolean): BodyId[][] {
  const flaggedIds = new Set(flagged.map((f) => f._id));
  const shared = new Set(sharedCandidates(flagged));
  const linkable = (id: BodyId) => flaggedIds.has(id) || !shared.has(id) || exists(id);

  const parent = new Map<BodyId, BodyId>();
  const find = (x: BodyId): BodyId => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let at = x;
    while (parent.get(at) !== root) {
      const next = parent.get(at) as BodyId;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const add = (x: BodyId) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const row of flagged) {
    add(row._id);
    for (const id of row.duplicateCandidateIds ?? []) {
      if (!linkable(id)) continue;
      add(id);
      const a = find(row._id);
      const b = find(id);
      if (a !== b) parent.set(a, b);
    }
  }

  const groups = new Map<BodyId, BodyId[]>();
  const placed = new Set<BodyId>();
  const place = (id: BodyId) => {
    if (placed.has(id) || !parent.has(id)) return;
    placed.add(id);
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  };
  for (const row of flagged) place(row._id);
  for (const row of flagged) for (const id of row.duplicateCandidateIds ?? []) place(id);
  return [...groups.values()];
}

/** How many decisions the queue holds — its `total` — reading only what can change the number. */
export async function countDedupDecisions(
  ctx: QueryCtx,
): Promise<{ count: number; truncated: boolean }> {
  const { flagged, truncated } = await readDedupFlags(ctx);
  const existing = new Set<BodyId>();
  for (const id of sharedCandidates(flagged)) {
    if ((await ctx.db.get(id)) !== null) existing.add(id);
  }
  return { count: dedupGroups(flagged, (id) => existing.has(id)).length, truncated };
}
