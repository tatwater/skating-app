/**
 * **The Inbox's one writer** (B01-5, *The stored items, their members and their counts*): every
 * stored Inbox item (`inboxItems`), its members (`inboxItemMembers`) and the counts (`inboxCounts`)
 * are written here and nowhere else. `packages/guards/src/inboxWriters.test.ts` holds every writer of
 * the four source tables' open/closed state to calling one of the entry points below.
 *
 * **One rule: the source row says what its member is.** Every entry point reads the source row as it
 * now stands and reconciles its member to it — an open source is the open member of the one open item
 * its fields key; a decided source is a closed member; a withdrawn, erased or non-Inbox source has no
 * member. So a hook placed after any write is correct whatever the write was, a hook run twice is a
 * no-op, and the drift repair is the same function run over the stored rows. The five names are what
 * the callers mean, and each still reconciles:
 *
 * - {@link fileMember} — a source filed (a flag, an ask, a drawn body, a ticket);
 * - {@link leaveMember} — a source withdrawn or erased: its member goes, and an item left with no
 *   member is deleted, never decided;
 * - {@link decideItem} — a source decided: its member closes, stamped with the decision's audit row,
 *   and the item is decided when that was its last open member;
 * - {@link rekey} — a source's question changed (an admit resolved to a catalog feature, a merge moved
 *   an ask or an access report to the survivor);
 * - {@link reopenItem} — an undo: every member a decision closed is reconciled again (its source back
 *   open), so the item reopens and the counts move back.
 *
 * Counts move in the same transaction as the item (`moveCounts`), so a count is the tally of the rows
 * by construction (the `bodyLibraryCounts` pattern).
 *
 * Reads: every read a reconcile makes is a point read or a fixed-size `take` (at most
 * {@link MAX_MEMBERS} members of a status, {@link LANDMARK_SCAN} landmark asks), so its worst case is
 * known; the backfill and the repair run each one as a nested transaction under byte limits.
 */

import {
  INBOX_LANE_ORDER,
  type InboxDecision,
  type InboxItemKind,
  type InboxLane,
  type LandmarkAsk,
  landmarkAsksAreSamePlace,
} from '@skating/core';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { flagSubject, subjectOfTarget } from './flagSubject';
import { flagBodyId, OPEN_FLAG_STATUSES } from './openFlags';
import { ROW_MAX, type RowKind } from './readBudget';
import { requestKeyOf } from './requestDecisions';

// ── Sources ────────────────────────────────────────────────────────────────────────────────────

/** A source row an item may hold: a flag, an ask, a drawn body, a ticket. */
export type InboxSource =
  | { table: 'contentFlags'; id: Id<'contentFlags'> }
  | { table: 'waterBodyRequests'; id: Id<'waterBodyRequests'> }
  | { table: 'waterBodies'; id: Id<'waterBodies'> }
  | { table: 'supportTickets'; id: Id<'supportTickets'> };

export const flagSource = (id: Id<'contentFlags'>): InboxSource => ({ table: 'contentFlags', id });
export const requestSource = (id: Id<'waterBodyRequests'>): InboxSource => ({
  table: 'waterBodyRequests',
  id,
});
export const bodySource = (id: Id<'waterBodies'>): InboxSource => ({ table: 'waterBodies', id });
export const ticketSource = (id: Id<'supportTickets'>): InboxSource => ({
  table: 'supportTickets',
  id,
});

/** The most members an item counts, and the most reporters an Access rank tells apart. */
export const MAX_MEMBERS = 500;

/**
 * The member bound in force — a **test seam**, as `MAP_BOUNDS` is: a test shrinks it (with Convex's
 * limits in proportion) to prove the batching, the paging and the room check on a small item, then
 * puts it back. Everything the bound sizes at run time reads it here — a recount, a reopen, a derive,
 * the repair's member reads, a refresh's cost; {@link MAX_MEMBERS} stays the real bound, which a test
 * holds the real limits to by arithmetic ({@link refreshCost} at it).
 */
export const MEMBER_BOUND = { members: MAX_MEMBERS };
/** Open landmark asks on a body a landmark ask is compared with, to find the place it joins. */
export const LANDMARK_SCAN = 8;
/** How far apart two rank tiers sit: past any instant (`Date.now()` stays under 10¹³ until 2286). */
const RANK_TIER = 1e13;

/** What a source's row says its member is: `null` — it has none (gone, withdrawn, not an Inbox row). */
export type SourceFacts = {
  state: 'open' | 'closed';
  key: string;
  kind: InboxItemKind;
  lane: InboxLane;
  facet: string;
  filedAt: number;
  waterBodyId?: Id<'waterBodies'>;
  subjectUserId?: Id<'profiles'>;
  filedByUserId?: Id<'profiles'>;
  /** A closed source's decision, when it stores one. */
  decision?: InboxDecision;
  decidedAt?: number;
  decidedByUserId?: Id<'profiles'>;
  /** A landmark ask: its place, for the same-place rule (the key is the place's first ask). */
  landmark?: { waterBodyId: Id<'waterBodies'>; ask: LandmarkAsk };
};

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────

/**
 * How the writer reads. A live hook's reads are the mutation's own handful; a pass runs each reconcile
 * as its own nested transaction under byte limits (`convex/inboxItems.ts`), so Convex itself bounds
 * them. The seam stays so a reader can be counted in a test.
 */
export interface InboxReads {
  get<T extends TableNames>(kind: RowKind, id: Id<T>): Promise<Doc<T> | null>;
  take<T>(kind: RowKind, n: number, read: (n: number) => Promise<T[]>): Promise<T[]>;
  /** Within one batch's reopen: each key's open item, looked up once (a new item forgets its key). */
  openByKey?: Map<string, Doc<'inboxItems'> | null>;
}

/**
 * A batch reopen's reads: each row read once (an item's row, a target's, a body's — none of which a
 * batch writes before its end), and each key's open item looked up once.
 */
function memoReads(ctx: QueryCtx, known: ReadonlyMap<string, unknown> = new Map()): InboxReads {
  const memo = new Map<string, Promise<unknown>>(
    [...known].map(([id, doc]) => [id, Promise.resolve(doc)] as const),
  );
  return {
    get: <T extends TableNames>(_kind: RowKind, id: Id<T>) => {
      let read = memo.get(id) as Promise<Doc<T> | null> | undefined;
      if (read === undefined) {
        read = ctx.db.get(id);
        memo.set(id, read);
      }
      return read;
    },
    take: (_kind, n, read) => read(n),
    openByKey: new Map(),
  };
}

/** A live hook's reads: the mutation's own handful, unmetered. */
export function liveReads(ctx: QueryCtx): InboxReads {
  return {
    get: (_kind, id) => ctx.db.get(id),
    take: (_kind, n, read) => read(n),
  };
}

// ── The facts a source gives ───────────────────────────────────────────────────────────────────

/** A flag's lane: an unsafe report is Safety; a body's no-public-access report is Access; else Content. */
export function flagLane(
  f: Pick<Doc<'contentFlags'>, 'reason' | 'targetType'>,
): 'safety' | 'accessReports' | 'contentFlags' {
  if (f.reason === 'unsafe_false_report') return 'safety';
  if (f.reason === 'no_public_access' && f.targetType === 'waterbody') return 'accessReports';
  return 'contentFlags';
}

/** A flag's tab in its lane; `all` when no tab names its target. */
export function flagFacet(lane: InboxLane, targetType: Doc<'contentFlags'>['targetType']): string {
  if (lane === 'safety') {
    if (targetType === 'report' || targetType === 'post') return 'reports';
    if (targetType === 'hazard') return 'hazards';
    if (targetType === 'user') return 'people';
    return 'all';
  }
  switch (targetType) {
    case 'report':
    case 'post':
      return 'reports';
    case 'comment':
      return 'comments';
    case 'accessAlert':
      return 'alerts';
    case 'photo':
      return 'photos';
    case 'user':
      return 'people';
    default:
      return 'all';
  }
}

const OPEN_FLAG = new Set<string>(OPEN_FLAG_STATUSES);

async function flagFacts(reads: InboxReads, ctx: QueryCtx, f: Doc<'contentFlags'>) {
  if (f.status === 'retracted') return null;
  const lane = flagLane(f);
  const get = <T extends TableNames>(id: Id<T>) => reads.get('report', id);
  const waterBodyId = (await flagBodyId(ctx, f, get)) ?? undefined;
  const known = flagSubject(f);
  const subject =
    known === undefined
      ? await flagSubjectOfRead(reads, ctx, f.targetType, f.targetId)
      : (known ?? undefined);
  let facet: string;
  let key: string;
  let kind: InboxItemKind;
  if (lane === 'accessReports') {
    kind = 'access';
    key = `access:${f.targetId}`;
    const body = waterBodyId ? await reads.get('waterBody', waterBodyId) : null;
    // Reports that came after a ruling that the body is open dispute it.
    facet = body?.publicAccess?.verdict === 'open' ? 'disputes' : 'new';
  } else {
    kind = 'flag';
    key = `flag:${lane}:${f.targetType}:${f.targetId}`;
    facet = flagFacet(lane, f.targetType);
  }
  let decision: InboxDecision | undefined;
  if (f.status === 'actioned' || f.status === 'dismissed') {
    decision =
      kind === 'access'
        ? f.status === 'actioned'
          ? 'ruled_closed'
          : 'ruled_accessible'
        : f.status;
  }
  return {
    state: OPEN_FLAG.has(f.status) ? 'open' : 'closed',
    key,
    kind,
    lane,
    facet,
    filedAt: f.createdAt,
    ...(waterBodyId ? { waterBodyId } : {}),
    ...(subject ? { subjectUserId: subject } : {}),
    // A person filed it; an auto flag (or one from before the field, read as auto) was no one (D289).
    ...(f.origin === 'user' ? { filedByUserId: f.flaggerId } : {}),
    ...(decision ? { decision } : {}),
    ...(f.resolvedAt !== undefined ? { decidedAt: f.resolvedAt } : {}),
    ...(f.resolvedByUserId ? { decidedByUserId: f.resolvedByUserId } : {}),
  } satisfies SourceFacts;
}

const SUBJECT_TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
  accessAlert: 'accessAlerts',
  photo: 'photos',
  user: 'profiles',
} as const;

/** `flagSubjectOf` for a flag the subjects backfill hasn't stamped, its one read charged. */
async function flagSubjectOfRead(
  reads: InboxReads,
  ctx: QueryCtx,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
): Promise<Id<'profiles'> | undefined> {
  if (targetType === 'waterbody') return undefined;
  const id = ctx.db.normalizeId(SUBJECT_TABLE[targetType], targetId);
  if (!id) return undefined;
  return subjectOfTarget(targetType, targetId, await reads.get('report', id)) ?? undefined;
}

function requestFacts(r: Doc<'waterBodyRequests'>): SourceFacts | null {
  // A script's ask is machine-found work, never an Inbox item (D289, amended).
  if (r.origin === 'seed' || r.status === 'retracted') return null;
  const place = r.kind === 'name_bay' || r.kind === 'name_landmark';
  const lane: InboxLane = place ? 'placesAsked' : 'requests';
  const facet = r.kind === 'name_bay' ? 'bays' : r.kind === 'name_landmark' ? 'landmarks' : r.kind;
  let key: string;
  if (r.kind === 'admit') {
    key = r.candidateExternalId ? `admit:${r.candidateExternalId}` : `admit:${r._id}`;
  } else if (r.kind === 'name_bay') {
    key = `bay:${r.waterBodyId}:${requestKeyOf(r)}`;
  } else if (r.kind === 'name_landmark') {
    key = `landmark:${r.waterBodyId}:${r._id}`;
  } else {
    key = `${r.kind}:${r.waterBodyId}`;
  }
  const closed = r.status === 'approved' || r.status === 'declined';
  return {
    state: r.status === 'open' ? 'open' : 'closed',
    key,
    kind: place ? 'place' : 'request',
    lane,
    facet,
    filedAt: r.createdAt,
    ...(r.waterBodyId ? { waterBodyId: r.waterBodyId } : {}),
    subjectUserId: r.requesterId,
    filedByUserId: r.requesterId,
    ...(closed ? { decision: r.status as 'approved' | 'declined' } : {}),
    ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
    ...(r.decidedByUserId ? { decidedByUserId: r.decidedByUserId } : {}),
    ...(r.kind === 'name_landmark' && r.waterBodyId
      ? {
          landmark: {
            waterBodyId: r.waterBodyId,
            ask: { names: requestNamesOf(r), coord: r.coord },
          },
        }
      : {}),
  };
}

/** Every name an ask goes by (`requestNames`, without the import cycle's weight). */
function requestNamesOf(r: Pick<Doc<'waterBodyRequests'>, 'name' | 'aliases'>): string[] {
  return [r.name ?? '', ...(r.aliases ?? [])].filter((n) => n.trim().length > 0);
}

function bodyFacts(b: Doc<'waterBodies'>): SourceFacts | null {
  // Only a skater's drawing is reviewed (D37); a catalog body never is.
  if (b.source !== 'user' || b.reviewStatus === undefined) return null;
  const merged = b.dedupStatus === 'merged' || b.mergedIntoId !== undefined;
  const open = b.reviewStatus === 'pending' && !merged;
  const decision: InboxDecision | undefined = open
    ? undefined
    : merged
      ? 'merged'
      : b.reviewStatus === 'approved'
        ? 'approved'
        : b.reviewStatus === 'rejected'
          ? 'rejected'
          : 'merged';
  return {
    state: open ? 'open' : 'closed',
    key: `drawn:${b._id}`,
    kind: 'drawn',
    lane: 'drawnBodies',
    facet: (b.duplicateCandidateIds?.length ?? 0) > 0 ? 'overlap' : 'newWater',
    filedAt: b.createdAt ?? b._creationTime,
    waterBodyId: b._id,
    ...(b.createdByUserId ? { subjectUserId: b.createdByUserId } : {}),
    ...(b.createdByUserId ? { filedByUserId: b.createdByUserId } : {}),
    ...(decision ? { decision } : {}),
  };
}

function ticketFacts(t: Doc<'supportTickets'>): SourceFacts {
  return {
    // `in_progress` reads as open (D284: no assignee, no claim).
    state: t.status === 'resolved' ? 'closed' : 'open',
    key: `ticket:${t._id}`,
    kind: 'ticket',
    lane: 'support',
    facet: t.category,
    filedAt: t.createdAt,
    ...(t.userId ? { subjectUserId: t.userId, filedByUserId: t.userId } : {}),
    ...(t.status === 'resolved' ? { decision: 'resolved' as const } : {}),
    ...(t.resolvedAt !== undefined ? { decidedAt: t.resolvedAt } : {}),
    ...(t.resolvedByUserId ? { decidedByUserId: t.resolvedByUserId } : {}),
  };
}

/** What `source`'s row says now; `null` when it has no member (gone, withdrawn, not an Inbox row). */
export async function factsOf(
  ctx: QueryCtx,
  source: InboxSource,
  reads: InboxReads = liveReads(ctx),
): Promise<SourceFacts | null> {
  switch (source.table) {
    case 'contentFlags': {
      const f = await reads.get('contentFlag', source.id);
      return f ? flagFacts(reads, ctx, f) : null;
    }
    case 'waterBodyRequests': {
      const r = await reads.get('waterBodyRequest', source.id);
      return r ? requestFacts(r) : null;
    }
    case 'waterBodies': {
      const b = await reads.get('waterBody', source.id);
      return b ? bodyFacts(b) : null;
    }
    case 'supportTickets': {
      const t = await reads.get('supportTicket', source.id);
      return t ? ticketFacts(t) : null;
    }
  }
}

// ── The rank and the counts ────────────────────────────────────────────────────────────────────

/** Smaller first: the oldest; Access, the most-corroborated, then the oldest. */
export function rankKeyOf(lane: InboxLane, memberCount: number, filedAt: number): number {
  if (lane !== 'accessReports') return filedAt;
  return (MAX_MEMBERS - Math.min(memberCount, MAX_MEMBERS)) * RANK_TIER + filedAt;
}

/** The count rows an item stands in: its lane and tab while open, the decided total once decided. */
export function countKeysOf(
  item: Pick<Doc<'inboxItems'>, 'status' | 'lane' | 'facet'> | null,
): string[] {
  if (item === null) return [];
  // Support's decided items are counted apart too, so a viewer without support's read is told the
  // total without them (D37).
  if (item.status === 'decided')
    return item.lane === 'support' ? ['decided', 'decided:support'] : ['decided'];
  return item.facet === 'all'
    ? [`open:${item.lane}`]
    : [`open:${item.lane}`, `open:${item.lane}:${item.facet}`];
}

/** Move the counts from what `before` stood in to what `after` does, in this transaction. */
async function moveCounts(
  ctx: MutationCtx,
  before: Pick<Doc<'inboxItems'>, 'status' | 'lane' | 'facet'> | null,
  after: Pick<Doc<'inboxItems'>, 'status' | 'lane' | 'facet'> | null,
): Promise<void> {
  const delta = new Map<string, number>();
  for (const k of countKeysOf(before)) delta.set(k, (delta.get(k) ?? 0) - 1);
  for (const k of countKeysOf(after)) delta.set(k, (delta.get(k) ?? 0) + 1);
  for (const [key, by] of delta) {
    if (by === 0) continue;
    const row = await ctx.db
      .query('inboxCounts')
      .withIndex('by_key', (q) => q.eq('key', key))
      .first();
    if (row) await ctx.db.patch(row._id, { count: row.count + by });
    else await ctx.db.insert('inboxCounts', { key, count: by });
  }
}

/** A count row's value (zero when absent). */
export async function readCount(ctx: QueryCtx, key: string): Promise<number> {
  const row = await ctx.db
    .query('inboxCounts')
    .withIndex('by_key', (q) => q.eq('key', key))
    .first();
  return row?.count ?? 0;
}

// ── The reconcile ──────────────────────────────────────────────────────────────────────────────

/** What a decision tells the writer: its audit row and who made it. */
export type DecideOpts = {
  now?: number;
  /** The decision's audit row: stamped on the members it closed (an undo reopens them by it). */
  actionId?: Id<'moderationActions'>;
  actorId?: Id<'profiles'>;
  /** Overrides the decision the source gives (a takedown's `actioned` on a flag dismissed elsewhere). */
  decision?: InboxDecision;
};

type SyncOpts = DecideOpts & {
  reads?: InboxReads;
  /** When the decision was made, for a source that doesn't store it (a drawn body's review). */
  decidedAt?: number;
  /** The backfill's decided history: a decided source with no member joins a decided item. */
  history?: boolean;
  /** A decision's own reconcile: a decided source with no member is filed, then closed (`decideItem`). */
  record?: boolean;
  /** The source's member as just read (a reopen's walk by decision row), so it isn't read again. */
  member?: Doc<'inboxItemMembers'>;
};

/** What a reconcile did — for the drift repair's count and the tests. */
export type SyncOutcome = 'unchanged' | 'filed' | 'moved' | 'closed' | 'left' | 'reopened' | 'none';

async function memberOf(ctx: QueryCtx, reads: InboxReads, source: InboxSource) {
  const rows = await reads.take('small', 1, (n) =>
    ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', source.table).eq('sourceId', source.id))
      .take(n),
  );
  return rows[0] ?? null;
}

async function openItemByKey(ctx: QueryCtx, reads: InboxReads, key: string) {
  const known = reads.openByKey?.get(key);
  if (known !== undefined) return known;
  const rows = await reads.take('small', 1, (n) =>
    ctx.db
      .query('inboxItems')
      .withIndex('by_key', (q) => q.eq('key', key).eq('status', 'open'))
      .take(n),
  );
  const found = rows[0] ?? null;
  reads.openByKey?.set(key, found);
  return found;
}

/**
 * The open item a landmark ask joins: the first open landmark item on its body whose asks include one
 * that is the same place (`landmarkAsksAreSamePlace`). Asks that would bridge two items join the
 * first; the decision's sibling drain closes every same-place ask anyway.
 */
async function landmarkItemFor(
  ctx: QueryCtx,
  reads: InboxReads,
  facts: SourceFacts,
  self: Id<'waterBodyRequests'>,
): Promise<Doc<'inboxItems'> | null> {
  const place = facts.landmark;
  if (place === undefined) return null;
  const asks = await reads.take('waterBodyRequest', LANDMARK_SCAN, (n) =>
    ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q.eq('waterBodyId', place.waterBodyId).eq('kind', 'name_landmark').eq('status', 'open'),
      )
      .take(n),
  );
  let best: Doc<'inboxItems'> | null = null;
  for (const other of asks) {
    if (other._id === self || other.origin === 'seed') continue;
    if (
      !landmarkAsksAreSamePlace(place.ask, { names: requestNamesOf(other), coord: other.coord })
    ) {
      continue;
    }
    const m = await memberOf(ctx, reads, requestSource(other._id));
    if (m?.status !== 'open') continue;
    const item = await reads.get('small', m.itemId);
    if (item && item.status === 'open' && (best === null || item.filedAt < best.filedAt)) {
      best = item;
    }
  }
  return best;
}

/** The open item `facts` belong to, if one exists (for a landmark ask, by place). */
async function targetItem(
  ctx: QueryCtx,
  reads: InboxReads,
  source: InboxSource,
  facts: SourceFacts,
  current: Doc<'inboxItems'> | null,
): Promise<Doc<'inboxItems'> | null> {
  if (facts.landmark !== undefined) {
    // An ask already in an open landmark item on its body stays there.
    const prefix = `landmark:${facts.landmark.waterBodyId}:`;
    if (current?.status === 'open' && current.key.startsWith(prefix)) return current;
    return landmarkItemFor(ctx, reads, facts, source.id as Id<'waterBodyRequests'>);
  }
  return openItemByKey(ctx, reads, facts.key);
}

/** Insert an item standing in no count yet: the refresh that follows moves it in (`fresh`). */
async function createItem(
  ctx: MutationCtx,
  facts: SourceFacts,
  now: number,
  status: 'open' | 'decided',
  /** A decided item's instant, set at once: a batch's later twin finds it before its refresh runs. */
  decidedAt?: number,
): Promise<Id<'inboxItems'>> {
  return ctx.db.insert('inboxItems', {
    key: facts.key,
    kind: facts.kind,
    lane: facts.lane,
    laneOrder: INBOX_LANE_ORDER[facts.lane],
    facet: facts.facet,
    status,
    rankKey: rankKeyOf(facts.lane, 0, facts.filedAt),
    filedAt: facts.filedAt,
    lastActivityAt: facts.filedAt,
    memberCount: 0,
    ...(facts.waterBodyId ? { waterBodyId: facts.waterBodyId } : {}),
    ...(facts.subjectUserId ? { subjectUserId: facts.subjectUserId } : {}),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    refreshedAt: now,
  });
}

/** Whether `item` asks the question `facts` key (a landmark ask: any open place on its body). */
export function asksSameQuestion(
  item: Pick<Doc<'inboxItems'>, 'key'>,
  facts: SourceFacts,
): boolean {
  return facts.landmark !== undefined
    ? item.key.startsWith(`landmark:${facts.landmark.waterBodyId}:`)
    : item.key === facts.key;
}

type Decided = {
  decision: InboxDecision;
  decidedAt: number;
  decidedByUserId?: Id<'profiles'>;
  decisionActionId?: Id<'moderationActions'>;
};

// ── Batches ────────────────────────────────────────────────────────────────────────────────────

/** A refresh an open batch owes an item: the newest facts and decision it was handed, and whether it is new. */
type OwedRefresh = { facts?: SourceFacts; decided?: Decided; fresh: boolean; now: number };

/**
 * The open batch of each transaction (one per `ctx`, as the request budget is): while one is open,
 * an item's refresh is owed, not run — so closing N members of one item recounts it **once** at the
 * batch's end, not N times (a recount reads up to {@link MAX_MEMBERS} members; per source, a
 * 201-ask drain of a 500-ask item read ~80,000 member rows, past Convex's documents limit).
 */
const BATCHES = new WeakMap<object, { depth: number; owed: Map<string, OwedRefresh> }>();

/**
 * **Run `work` as one Inbox batch** (B01-5): every reconcile inside it updates its member at once and
 * leaves its item's refresh owed; the batch ends by refreshing each touched item once, with the last
 * facts and decision it was handed (the decision that closes an item is the one handed with its last
 * open member, as one at a time). Nested batches join the outer one. Within a batch an item's stored
 * status and counts lag its members until the end — which no reconcile reads for a close, and for a
 * reopen reads to the same end (a decided item reopens in place either way).
 */
export async function inboxBatch<T>(ctx: MutationCtx, work: () => Promise<T>): Promise<T> {
  const open = BATCHES.get(ctx);
  if (open) {
    open.depth++;
    try {
      return await work();
    } finally {
      open.depth--;
    }
  }
  const batch = { depth: 1, owed: new Map<string, OwedRefresh>() };
  BATCHES.set(ctx, batch);
  let value: T;
  try {
    value = await work();
  } finally {
    BATCHES.delete(ctx);
  }
  const reads = liveReads(ctx);
  for (const [itemId, owed] of batch.owed) {
    await refreshItemNow(
      ctx,
      reads,
      itemId as Id<'inboxItems'>,
      owed.now,
      owed.facts,
      owed.decided,
      owed.fresh,
    );
  }
  return value;
}

/**
 * The most sources a closer takes a page — a **test seam** (a test sets it to force pages between
 * which it interleaves writes); in force, every page is sized by its room alone.
 */
export const PAGE_SEAM = { sources: Number.POSITIVE_INFINITY };

/** Whether a page that has taken `done` sources is full by the seam. */
export const pageIsFull = (done: number): boolean => done >= PAGE_SEAM.sources;

/** How many items the open batch owes a refresh (none outside one) — for a closer sizing its page. */
export function owedRefreshes(ctx: MutationCtx): number {
  return BATCHES.get(ctx)?.owed.size ?? 0;
}

/** Whether `ctx` has an open batch. */
export function inBatch(ctx: MutationCtx): boolean {
  return BATCHES.has(ctx);
}

/** A cost on each axis Convex limits a transaction by. */
export type TxCost = {
  bytesRead: number;
  documentsRead: number;
  databaseQueries: number;
  documentsWritten: number;
  /** A patch writes the whole row back: an ask with its polygon is written at its full size. */
  bytesWritten: number;
};

/**
 * The worst one item's refresh reads and writes at a member bound (the one in force by default): its
 * first open and closed member, up to `members` of each status counted, the item, a decision's source
 * (a request's worst), and its counts.
 */
export function refreshCost(members: number = MEMBER_BOUND.members): TxCost {
  return {
    bytesRead:
      (2 * members + 4) * ROW_MAX.inboxMember + 8 * ROW_MAX.small + ROW_MAX.waterBodyRequest,
    documentsRead: 2 * members + 16,
    databaseQueries: 24,
    documentsWritten: 16,
    bytesWritten: 16 * ROW_MAX.small,
  };
}

/** A reconcile's own reads and writes beyond its source row: its member, its item, an open item by key. */
export const RECONCILE_COST: TxCost = {
  bytesRead: 6 * ROW_MAX.small,
  documentsRead: 8,
  databaseQueries: 8,
  documentsWritten: 4,
  bytesWritten: 4 * ROW_MAX.inboxMember,
};

/** Headroom a closer keeps past its batch: the next page's schedule, its own last rows. */
export const CLOSER_RESERVE: TxCost = {
  bytesRead: 256 * 1024,
  documentsRead: 200,
  databaseQueries: 100,
  documentsWritten: 100,
  bytesWritten: 256 * 1024,
};

export const AXES = [
  'bytesRead',
  'documentsRead',
  'databaseQueries',
  'documentsWritten',
  'bytesWritten',
] as const;

/**
 * **Room for one more source in this transaction's batch** — its own cost (`perSource`, the closer's
 * reads and writes for it plus {@link RECONCILE_COST}), a refresh for every item the batch owes and one
 * more for the item it may touch, and the closer's headroom — on Convex's live metrics, so the reads
 * already made count as made. A closer asks before each source and, out of room, stops and schedules
 * the rest: always one source at least, so it advances.
 */
export async function batchHasRoom(
  ctx: MutationCtx,
  perSource: TxCost,
  /** What the closer runs once after its batch (a flag page's settle), kept back too. */
  after?: TxCost,
): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics();
  const refreshes = owedRefreshes(ctx) + 1;
  const refresh = refreshCost();
  return AXES.every(
    (k) =>
      m[k].remaining >=
      perSource[k] +
        RECONCILE_COST[k] +
        refreshes * refresh[k] +
        CLOSER_RESERVE[k] +
        (after?.[k] ?? 0),
  );
}

async function refreshItem(
  ctx: MutationCtx,
  reads: InboxReads,
  itemId: Id<'inboxItems'>,
  now: number,
  facts?: SourceFacts,
  decided?: Decided,
  freshItem?: boolean,
): Promise<void> {
  const batch = BATCHES.get(ctx);
  if (!batch) return refreshItemNow(ctx, reads, itemId, now, facts, decided, freshItem);
  const prior = batch.owed.get(itemId);
  batch.owed.set(itemId, {
    facts: facts ?? prior?.facts,
    decided: decided ?? prior?.decided,
    fresh: (prior?.fresh ?? false) || freshItem === true,
    now,
  });
}

/**
 * Re-derive an item from its members and move its counts: open while any member is open (its count,
 * oldest filing and rank from the open ones); decided once none is (from them all); deleted once it
 * has none. `facts` refresh its tab, body and kind; `decided` is the decision that closed its last open
 * member, when this refresh is the one that closes it.
 */
async function refreshItemNow(
  ctx: MutationCtx,
  reads: InboxReads,
  itemId: Id<'inboxItems'>,
  now: number,
  facts?: SourceFacts,
  decided?: Decided,
  freshItem?: boolean,
): Promise<void> {
  const item = await reads.get('small', itemId);
  if (!item) return;
  const before = freshItem ? null : item;
  const firstOf = (status: 'open' | 'closed') =>
    reads.take('small', 1, (n) =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_item_status', (q) => q.eq('itemId', itemId).eq('status', status))
        .take(n),
    );
  const countOf = async (status: 'open' | 'closed') =>
    (
      await reads.take('small', MEMBER_BOUND.members, (n) =>
        ctx.db
          .query('inboxItemMembers')
          .withIndex('by_item_status', (q) => q.eq('itemId', itemId).eq('status', status))
          .take(n),
      )
    ).length;
  const [firstOpen] = await firstOf('open');
  const facetFields = facts
    ? {
        facet: facts.facet,
        ...(facts.waterBodyId ? { waterBodyId: facts.waterBodyId } : {}),
      }
    : {};
  if (firstOpen) {
    const memberCount = await countOf('open');
    const lane = item.lane;
    const next = {
      ...facetFields,
      status: 'open' as const,
      memberCount,
      filedAt: firstOpen.filedAt,
      rankKey: rankKeyOf(lane, memberCount, firstOpen.filedAt),
      lastActivityAt: Math.max(item.lastActivityAt, firstOpen.filedAt, facts?.filedAt ?? 0),
      decidedAt: undefined,
      decidedByUserId: undefined,
      decision: undefined,
      decisionActionId: undefined,
      refreshedAt: now,
    };
    await ctx.db.patch(itemId, next);
    await moveCounts(ctx, before, { ...item, ...next });
    return;
  }
  const [firstClosed] = await firstOf('closed');
  if (!firstClosed) {
    await ctx.db.delete(itemId);
    await moveCounts(ctx, before, null);
    return;
  }
  const memberCount = await countOf('closed');
  // The item's stored decision stands only while a member of it still records that decision: an
  // undo that reopens the deciding member into a newer open item on the key leaves this item decided
  // by its other members — and its decision is then theirs, never a row none of them carries.
  const stored =
    item.status === 'decided' &&
    item.decision !== undefined &&
    (await decisionHeld(ctx, reads, item))
      ? {
          decision: item.decision,
          decidedAt: item.decidedAt ?? now,
          ...(item.decidedByUserId ? { decidedByUserId: item.decidedByUserId } : {}),
          ...(item.decisionActionId ? { decisionActionId: item.decisionActionId } : {}),
        }
      : null;
  const decision: Decided | null =
    decided ?? stored ?? (await decisionOfMember(ctx, reads, firstClosed, now));
  const next = {
    ...facetFields,
    status: 'decided' as const,
    memberCount,
    filedAt: firstClosed.filedAt,
    rankKey: rankKeyOf(item.lane, memberCount, firstClosed.filedAt),
    lastActivityAt: Math.max(item.lastActivityAt, decision?.decidedAt ?? now),
    decision: decision?.decision ?? fallbackDecision(item.kind),
    decidedAt: decision?.decidedAt ?? now,
    decidedByUserId: decision?.decidedByUserId,
    decisionActionId: decision?.decisionActionId,
    refreshedAt: now,
  };
  await ctx.db.patch(itemId, next);
  await moveCounts(ctx, before, { ...item, ...next });
}

/**
 * Whether a decided item's stored decision is still recorded by one of its members — the member a
 * decision closed carries its row (`closedByActionId`). An item with no decision row (decided before
 * the Inbox stamped them) holds by default. One point range on the decision's members, bounded as
 * every member read is (a decision closes at most that many).
 */
export async function decisionHeld(
  ctx: QueryCtx,
  reads: InboxReads,
  item: Pick<Doc<'inboxItems'>, '_id' | 'decisionActionId'>,
): Promise<boolean> {
  const actionId = item.decisionActionId;
  if (actionId === undefined) return true;
  const closed = await reads.take('small', MEMBER_BOUND.members, (n) =>
    ctx.db
      .query('inboxItemMembers')
      .withIndex('by_closed_by', (q) => q.eq('closedByActionId', actionId))
      .take(n),
  );
  return closed.some((m) => m.itemId === item._id);
}

/** The decision a closed member's source records (an item whose deciding member left). */
async function decisionOfMember(
  ctx: QueryCtx,
  reads: InboxReads,
  member: Doc<'inboxItemMembers'>,
  now: number,
): Promise<Decided | null> {
  const facts = await factsOf(ctx, sourceOfMember(member), reads);
  if (!facts?.decision) return null;
  return {
    decision: facts.decision,
    decidedAt: facts.decidedAt ?? now,
    ...(facts.decidedByUserId ? { decidedByUserId: facts.decidedByUserId } : {}),
    ...(member.closedByActionId ? { decisionActionId: member.closedByActionId } : {}),
  };
}

function fallbackDecision(kind: InboxItemKind): InboxDecision {
  switch (kind) {
    case 'flag':
      return 'dismissed';
    case 'access':
      return 'ruled_accessible';
    case 'ticket':
      return 'resolved';
    case 'drawn':
      return 'approved';
    default:
      return 'declined';
  }
}

/** The source a member stands for. */
export function sourceOfMember(
  m: Pick<Doc<'inboxItemMembers'>, 'sourceTable' | 'sourceId'>,
): InboxSource {
  return { table: m.sourceTable, id: m.sourceId } as InboxSource;
}

/**
 * **The reconcile**: make `source`'s member what its row says. Every entry point is this.
 */
export async function syncInboxSource(
  ctx: MutationCtx,
  source: InboxSource,
  opts: SyncOpts = {},
): Promise<SyncOutcome> {
  const reads = opts.reads ?? liveReads(ctx);
  const now = opts.now ?? Date.now();
  const facts = await factsOf(ctx, source, reads);
  const member = opts.member ?? (await memberOf(ctx, reads, source));
  const current = member ? await reads.get('small', member.itemId) : null;

  // ── No member owed: withdrawn, erased, or never an Inbox row ──
  if (facts === null) {
    if (!member) return 'none';
    await ctx.db.delete(member._id);
    if (current) await refreshItem(ctx, reads, current._id, now);
    return 'left';
  }

  // ── Decided ──
  if (facts.state === 'closed') {
    const decided: Decided = {
      decision: opts.decision ?? facts.decision ?? fallbackDecision(facts.kind),
      decidedAt: facts.decidedAt ?? opts.decidedAt ?? now,
      ...((facts.decidedByUserId ?? opts.actorId)
        ? { decidedByUserId: facts.decidedByUserId ?? opts.actorId }
        : {}),
      ...(opts.actionId ? { decisionActionId: opts.actionId } : {}),
    };
    if (member) {
      if (member.status === 'closed') {
        if (opts.actionId && member.closedByActionId === undefined) {
          await ctx.db.patch(member._id, { closedByActionId: opts.actionId });
          if (current?.status === 'decided' && current.decisionActionId === undefined) {
            await ctx.db.patch(current._id, { decisionActionId: opts.actionId });
          }
        }
        return 'unchanged';
      }
      await ctx.db.patch(member._id, {
        status: 'closed',
        ...(opts.actionId ? { closedByActionId: opts.actionId } : {}),
      });
      if (current) await refreshItem(ctx, reads, current._id, now, facts, decided);
      return 'closed';
    }
    if (!opts.history && !opts.record) return 'none';
    const stamp = opts.actionId ? { closedByActionId: opts.actionId } : {};
    // A decision on a source the backfill hadn't reached (`record`): it is filed first — into the open
    // item its question is, when there is one — then closed, stamped with the decision's row, so the
    // decision records every member it closed and its undo reopens them all.
    const open = opts.record ? await targetItem(ctx, reads, source, facts, null) : null;
    // Else (and for the backfill's decided history): a decided item with this key and this instant.
    const twins = open
      ? []
      : await reads.take('small', 20, (n) =>
          ctx.db
            .query('inboxItems')
            .withIndex('by_key', (q) => q.eq('key', facts.key).eq('status', 'decided'))
            .take(n),
        );
    const twin = open ?? twins.find((t) => t.decidedAt === decided.decidedAt);
    const itemId = twin?._id ?? (await createItem(ctx, facts, now, 'decided', decided.decidedAt));
    await ctx.db.insert('inboxItemMembers', {
      itemId,
      sourceTable: source.table,
      sourceId: source.id,
      ...(facts.filedByUserId ? { filedByUserId: facts.filedByUserId } : {}),
      status: 'closed',
      ...stamp,
      filedAt: facts.filedAt,
    });
    await refreshItem(ctx, reads, itemId, now, facts, decided, twin === undefined);
    return 'filed';
  }

  // ── Open ──
  const target = await targetItem(ctx, reads, source, facts, current);
  if (member && current && target && current._id === target._id && member.status === 'open') {
    // Where it belongs: its facts may still move the item's tab or body.
    if (current.facet !== facts.facet || current.waterBodyId !== facts.waterBodyId) {
      await refreshItem(ctx, reads, current._id, now, facts);
      return 'moved';
    }
    return 'unchanged';
  }
  if (
    member &&
    current &&
    member.status === 'closed' &&
    target === null &&
    asksSameQuestion(current, facts)
  ) {
    // An undo, with no newer question open on this key: the decided item reopens in place.
    await ctx.db.patch(member._id, { status: 'open', closedByActionId: undefined });
    await refreshItem(ctx, reads, current._id, now, facts);
    return 'reopened';
  }
  const fresh = target === null;
  const into = target?._id ?? (await createItem(ctx, facts, now, 'open'));
  if (target === null) reads.openByKey?.delete(facts.key);
  if (member) {
    const reopening = member.status === 'closed';
    await ctx.db.patch(member._id, {
      itemId: into,
      status: 'open',
      closedByActionId: undefined,
      filedAt: facts.filedAt,
    });
    await refreshItem(ctx, reads, into, now, facts, undefined, fresh);
    if (current && current._id !== into) await refreshItem(ctx, reads, current._id, now);
    return reopening ? 'reopened' : 'moved';
  }
  await ctx.db.insert('inboxItemMembers', {
    itemId: into,
    sourceTable: source.table,
    sourceId: source.id,
    ...(facts.filedByUserId ? { filedByUserId: facts.filedByUserId } : {}),
    status: 'open',
    filedAt: facts.filedAt,
  });
  await refreshItem(ctx, reads, into, now, facts, undefined, fresh);
  return 'filed';
}

/** Re-derive an item from its members and move its counts (the drift repair's last step). */
export async function refreshInboxItem(
  ctx: MutationCtx,
  itemId: Id<'inboxItems'>,
  now: number = Date.now(),
): Promise<void> {
  await refreshItem(ctx, liveReads(ctx), itemId, now);
}

// ── The entry points ───────────────────────────────────────────────────────────────────────────

/** A source was filed: it becomes the open member of the item its fields key (none for a seed ask). */
export async function fileMember(
  ctx: MutationCtx,
  source: InboxSource,
  opts: { now?: number } = {},
): Promise<SyncOutcome> {
  return syncInboxSource(ctx, source, opts);
}

/**
 * The item a decision asks the Inbox's rule through (B01-5, D283, D289): the source's own, filed
 * first through this writer when the backfill hasn't reached it yet — an open source as an open
 * member, a decided one into the decided history — so a source with no item yet gets the same answer
 * as one with an item: never two rules. `null` only for a row that is never an item (a script's ask,
 * a withdrawn or erased source), which its caller answers itself.
 */
export async function itemToDecide(
  ctx: MutationCtx,
  source: InboxSource,
  opts: { now?: number } = {},
): Promise<Doc<'inboxItems'> | null> {
  const reads = liveReads(ctx);
  let member = await memberOf(ctx, reads, source);
  if (!member) {
    await syncInboxSource(ctx, source, { ...opts, reads, history: true });
    member = await memberOf(ctx, reads, source);
  }
  return member ? await ctx.db.get(member.itemId) : null;
}

/**
 * A source was withdrawn or erased: its member goes, whatever its row still says. An item left with no
 * member is deleted (never decided); one left with only closed members is decided by theirs.
 */
export async function leaveMember(
  ctx: MutationCtx,
  source: InboxSource,
  opts: { now?: number } = {},
): Promise<SyncOutcome> {
  const reads = liveReads(ctx);
  const member = await memberOf(ctx, reads, source);
  if (!member) return 'none';
  await ctx.db.delete(member._id);
  await refreshItem(ctx, reads, member.itemId, opts.now ?? Date.now());
  return 'left';
}

/**
 * An open item's source facts moved without a source row changing state (a body's ruling flips its
 * access reports between *New* and *Disputes*): its first open member is reconciled, which refreshes
 * the item's tab and counts. A key with no open item is a no-op.
 */
export async function refreshItemTab(
  ctx: MutationCtx,
  key: string,
  opts: { now?: number } = {},
): Promise<void> {
  const reads = liveReads(ctx);
  const item = await openItemByKey(ctx, reads, key);
  if (!item) return;
  const first = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_item_status', (q) => q.eq('itemId', item._id).eq('status', 'open'))
    .first();
  if (first) await syncInboxSource(ctx, sourceOfMember(first), opts);
}

/**
 * The repair's batch leave: members whose sources are gone, withdrawn or no longer Inbox rows, all
 * dropped from one item, then the item re-derived once (one recount, not one per member).
 */
export async function leaveMembers(
  ctx: MutationCtx,
  itemId: Id<'inboxItems'>,
  members: readonly Pick<Doc<'inboxItemMembers'>, '_id' | 'itemId'>[],
  opts: { now?: number } = {},
): Promise<number> {
  let left = 0;
  for (const m of members) {
    if (m.itemId !== itemId) continue;
    await ctx.db.delete(m._id);
    left++;
  }
  if (left > 0) await refreshItem(ctx, liveReads(ctx), itemId, opts.now ?? Date.now());
  return left;
}

/**
 * A source was decided: its member closes, stamped with the decision's audit row (`actionId`), and the
 * item is decided — by `decision` (else what the source records), `actorId`, `actionId` — when that
 * was its last open member.
 */
export async function decideItem(
  ctx: MutationCtx,
  source: InboxSource,
  opts: DecideOpts = {},
): Promise<SyncOutcome> {
  return syncInboxSource(ctx, source, { ...opts, record: true });
}

/** A source's question changed (an admit resolved; a merge moved it): its member moves to its new item. */
export async function rekey(
  ctx: MutationCtx,
  source: InboxSource,
  opts: { now?: number } = {},
): Promise<SyncOutcome> {
  return syncInboxSource(ctx, source, opts);
}

/**
 * An undo: every member the decision `actionId` closed is reconciled again — call it **after** the
 * sources are back open. Each reopens into its item (the decided item itself, unless a newer question
 * on the same key is open, which it then joins), and the counts move back. Returns how many reopened.
 */
export async function reopenItem(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  opts: {
    now?: number;
    /** Filled with every source reconciled here, so a caller's follow-up skips them. */
    covered?: Set<string>;
    /**
     * Source rows the caller has just written, as they now stand: read from here rather than again
     * (a flag at its longest note is 12 KiB, and an undo of five hundred reads each once fewer).
     */
    known?: ReadonlyMap<string, unknown>;
  } = {},
): Promise<number> {
  const members = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_closed_by', (q) => q.eq('closedByActionId', actionId))
    .take(MEMBER_BOUND.members);
  let reopened = 0;
  // One batch, its reads memoized: an item that had every member closed by the decision is recounted
  // once, and its row, its target and its key's open item read once — not per member (PR #170: a
  // 500-report ruling's undo read past Convex's 4,096 index ranges, member by member).
  const reads = memoReads(ctx, opts.known);
  await inboxBatch(ctx, async () => {
    for (const m of members) {
      const outcome = await syncInboxSource(ctx, sourceOfMember(m), {
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        reads,
        member: m,
      });
      opts.covered?.add(m.sourceId);
      if (outcome === 'reopened' || outcome === 'moved' || outcome === 'filed') reopened++;
    }
  });
  return reopened;
}

/**
 * **Whether the Inbox's stored items can't yet be taken as whole** — every Inbox read's `pending`, and
 * the Overview card's: until the backfill's scan has finished, **and** while any source it couldn't
 * file is still owed (a `jobFailures` row of `inboxBackfill`, parked or not — PR #170). The scan
 * finishing is not the Inbox being ready: a source that failed is a question missing from the counts,
 * so the counts say why they may be short rather than reading as exact. Such a failure is retried by
 * the drift repair's pass while it is failing, and once parked by the daily retry
 * (`recurringJobs.retryParkedDaily`, D258); Machinery counts both (`recurringJobs.health`), with their
 * error classes.
 */
export async function inboxPending(ctx: QueryCtx): Promise<boolean> {
  const run = await ctx.db
    .query('inboxJobRuns')
    .withIndex('by_job', (q) => q.eq('job', 'backfill'))
    .first();
  if (run?.done !== true) return true;
  const owed = await ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) => q.eq('job', 'inboxBackfill'))
    .first();
  return owed !== null;
}

/**
 * A source an undo has just put back, reconciled from the row as the undo wrote it (`known`) rather
 * than read again — a flag at its longest note is 12 KiB, and an undo reopens hundreds.
 */
export async function syncReopened(
  ctx: MutationCtx,
  source: InboxSource,
  known: unknown,
  reads: ReopenReads,
  opts: { now?: number } = {},
): Promise<SyncOutcome> {
  reads.know(source.id, known);
  return syncInboxSource(ctx, source, { ...opts, reads: reads.reads });
}

/** One undo page's memoized reads, shared by its reconciles: items and keys read once a page. */
export type ReopenReads = { reads: InboxReads; know: (id: string, doc: unknown) => void };

/** Reads for a page of {@link syncReopened}: a memo the page's patched rows are added to. */
export function reopenReads(ctx: QueryCtx): ReopenReads {
  const known = new Map<string, unknown>();
  const memo = memoReads(ctx, known);
  const base = memo.get;
  return {
    reads: {
      ...memo,
      get: <T extends TableNames>(kind: RowKind, id: Id<T>) =>
        known.has(id) ? Promise.resolve(known.get(id) as Doc<T> | null) : base(kind, id),
    },
    know: (id, doc) => known.set(id, doc),
  };
}

// ── What the reads and the repair share ────────────────────────────────────────────────────────

/** What an item's members derive — the drift repair's check, and the property test's. */
export type DerivedItem = {
  status: 'open' | 'decided' | 'empty';
  memberCount: number;
  filedAt: number | null;
  rankKey: number | null;
};

/** Derive an item's fields from its members (bounded at {@link MAX_MEMBERS} of each status). */
export async function deriveItem(
  ctx: QueryCtx,
  item: Pick<Doc<'inboxItems'>, '_id' | 'lane'>,
  reads: InboxReads = liveReads(ctx),
): Promise<DerivedItem> {
  const of = (status: 'open' | 'closed') =>
    reads.take('small', MEMBER_BOUND.members, (n) =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_item_status', (q) => q.eq('itemId', item._id).eq('status', status))
        .take(n),
    );
  const open = await of('open');
  const rows = open.length > 0 ? open : await of('closed');
  if (rows.length === 0) return { status: 'empty', memberCount: 0, filedAt: null, rankKey: null };
  const filedAt = rows[0]?.filedAt ?? 0;
  return {
    status: open.length > 0 ? 'open' : 'decided',
    memberCount: rows.length,
    filedAt,
    rankKey: rankKeyOf(item.lane, rows.length, filedAt),
  };
}
