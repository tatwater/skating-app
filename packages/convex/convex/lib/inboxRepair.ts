/**
 * **The Inbox's drift check and repair** (B01-5): an item re-derived from its members, each member
 * from its source row — the same rule the one writer applies at every write (`lib/inboxItems`), run
 * over the stored rows. Nothing a moderator does depends on it; it catches a write whose hook was
 * missed (a write the guard can't see — fields arriving through a variable) and counts what it fixed.
 *
 * **Sized for the member bound.** One examination reads each member's source facts once, through
 * memoized reads (a hundred flags on one report read the report, its body and its author once), so
 * an item of `MAX_MEMBERS` members costs about one read per member. Members whose sources are gone
 * leave together with one recount; a visit reconciles at most {@link REPAIR_FIXES_PER_VISIT} other
 * drifted members and leaves the rest to its next lap, so an item that drifted wholesale is repaired
 * over a few laps rather than failing every one.
 */

import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
  asksSameQuestion,
  deriveItem,
  factsOf,
  type InboxReads,
  inboxBatch,
  leaveMembers,
  MAX_MEMBERS,
  refreshInboxItem,
  type SourceFacts,
  sourceOfMember,
  syncInboxSource,
} from './inboxItems';

/** What the check found wrong with one item — kinds only, never contents. */
export type InboxDriftKind =
  | 'member_stale'
  | 'member_open'
  | 'member_closed'
  | 'fields'
  | 'facet'
  | 'empty';

/**
 * Drifted members one visit reconciles in full at most (each re-derives the item); the rest wait for
 * the item's next lap. Members whose sources are gone or withdrawn leave together, uncapped.
 */
export const REPAIR_FIXES_PER_VISIT = 10;

/** Point reads remembered for one examination: a body or a target named by every member, read once. */
function memoReads(ctx: QueryCtx): InboxReads {
  const memo = new Map<string, Promise<unknown>>();
  return {
    get: <T extends TableNames>(_kind: unknown, id: Id<T>) => {
      let read = memo.get(id) as Promise<Doc<T> | null> | undefined;
      if (read === undefined) {
        read = ctx.db.get(id);
        memo.set(id, read);
      }
      return read;
    },
    take: (_kind, n, read) => read(n),
  };
}

/** Up to `MAX_MEMBERS` of an item's members of one status. */
function membersOf(ctx: QueryCtx, item: Pick<Doc<'inboxItems'>, '_id'>, status: 'open' | 'closed') {
  return ctx.db
    .query('inboxItemMembers')
    .withIndex('by_item_status', (q) => q.eq('itemId', item._id).eq('status', status))
    .take(MAX_MEMBERS);
}

type Examination = {
  drifted: { member: Doc<'inboxItemMembers'>; kind: InboxDriftKind }[];
  kinds: Set<InboxDriftKind>;
  /** An open member whose facts carry the tab the item should have, when the tab drifted. */
  facetFrom: Doc<'inboxItemMembers'> | null;
};

/** One look at an item: every member against its source (each read once), its fields, its tab. */
async function examine(ctx: QueryCtx, item: Doc<'inboxItems'>): Promise<Examination> {
  const reads = memoReads(ctx);
  const drifted: Examination['drifted'] = [];
  let firstOpen: { member: Doc<'inboxItemMembers'>; facts: SourceFacts } | null = null;
  for (const status of ['open', 'closed'] as const) {
    for (const member of await membersOf(ctx, item, status)) {
      const facts = await factsOf(ctx, sourceOfMember(member), reads);
      if (facts === null) drifted.push({ member, kind: 'member_stale' });
      else if (facts.state === 'open') {
        if (
          member.status !== 'open' ||
          item.status !== 'open' ||
          !asksSameQuestion(item, facts) ||
          item.lane !== facts.lane
        ) {
          drifted.push({ member, kind: 'member_open' });
        } else if (firstOpen === null) {
          firstOpen = { member, facts };
        }
      } else if (member.status !== 'closed') {
        drifted.push({ member, kind: 'member_closed' });
      }
    }
  }
  const kinds = new Set<InboxDriftKind>(drifted.map((d) => d.kind));
  const derived = await deriveItem(ctx, item);
  if (derived.status === 'empty') kinds.add('empty');
  else if (
    derived.status !== item.status ||
    derived.memberCount !== item.memberCount ||
    derived.filedAt !== item.filedAt ||
    derived.rankKey !== item.rankKey
  ) {
    kinds.add('fields');
  }
  // The tab follows the source's facts (a body's ruling, a drawing's overlap) — a write with no hook
  // leaves it behind.
  const open = firstOpen as { member: Doc<'inboxItemMembers'>; facts: SourceFacts } | null;
  const facetFrom = open !== null && open.facts.facet !== item.facet ? open.member : null;
  if (facetFrom !== null) kinds.add('facet');
  return { drifted, kinds, facetFrom };
}

/** What the repair would fix on `item` — empty when it is what its members and sources say. */
export async function inboxDrift(
  ctx: QueryCtx,
  item: Doc<'inboxItems'>,
): Promise<InboxDriftKind[]> {
  return [...(await examine(ctx, item)).kinds];
}

/**
 * Repair one item: up to {@link REPAIR_FIXES_PER_VISIT} drifted members reconciled to their sources,
 * a drifted tab refreshed from an open member's facts, then the item re-derived (which also moves it
 * to the back of the walk). Returns how many things it fixed (zero when nothing drifted).
 */
export async function repairInboxItem(
  ctx: MutationCtx,
  item: Doc<'inboxItems'>,
  now: number,
): Promise<number> {
  const { drifted, kinds, facetFrom } = await examine(ctx, item);
  const stale = drifted.filter((d) => d.kind === 'member_stale').map((d) => d.member);
  const fixing = drifted.filter((d) => d.kind !== 'member_stale').slice(0, REPAIR_FIXES_PER_VISIT);
  // One batch: every item the fixes touch recounted once at its end.
  const left = await inboxBatch(ctx, async () => {
    const gone = await leaveMembers(ctx, item._id, stale, { now });
    for (const { member } of fixing) await syncInboxSource(ctx, sourceOfMember(member), { now });
    if (facetFrom !== null) await syncInboxSource(ctx, sourceOfMember(facetFrom), { now });
    return gone;
  });
  if ((await ctx.db.get(item._id)) !== null) await refreshInboxItem(ctx, item._id, now);
  return left + fixing.length + (kinds.has('fields') ? 1 : 0) + (facetFrom !== null ? 1 : 0);
}
