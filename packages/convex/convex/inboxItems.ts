/**
 * **The Inbox's stored items: the backfill and the drift repair** (B01-5). The items themselves are
 * written by `lib/inboxItems.ts` beside every source write; this module fills them for rows written
 * before the hooks (the backfill) and re-derives open items from their members and sources on a slow
 * walk (the repair).
 *
 * **Every pass is bounded on bytes as well as rows, and never wedges.** A pass sizes its page by the
 * `ReadBudget` — each row its table's worst case plus a whole item's work ({@link ITEM_BYTES}) — and
 * runs each item as its own nested transaction under {@link ITEM_LIMITS} (`runIsolated`), so Convex
 * itself holds the item to its bytes. An item that throws, or reads past its limits, rolls back alone,
 * is recorded in `jobFailures` (keyed by the job and the item, its error class, never its contents)
 * and stepped past; the cursor always moves to the page's end. The backfill's failures are retried by
 * the repair's passes, and counted on Machinery until they succeed.
 *
 *   pnpm convex run inboxItems:backfill '{}'            # resumable; '{"restart":true}' re-runs it all
 */

import { INBOX_SOURCE_TABLES } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { type InboxSource, syncInboxSource } from './lib/inboxItems';
import { repairInboxItem } from './lib/inboxRepair';
import { ReadBudget, ROW_MAX, type RowKind, TX_BUDGET, traced } from './lib/readBudget';
import {
  affords,
  asItem,
  clearFailure,
  type ItemBudget,
  type Limits,
  MiB,
  recordFailure,
  runIsolated,
} from './lib/recurringWork';
import { literals } from './lib/validators';

/** What one item's reconcile may read and write — its nested transaction's own limits. */
export const ITEM_LIMITS: Limits = {
  bytesRead: 2 * MiB,
  documentsRead: 2_000,
  databaseQueries: 64,
  documentsWritten: 32,
};
/** An item's bytes, as a pass plans them. */
export const ITEM_BYTES = ITEM_LIMITS.bytesRead;

/** Rows a backfill pass reads at most; the budget may take fewer. */
export const BACKFILL_PAGE = 40;
/** Open items a repair pass checks at most; the budget may take fewer. */
export const REPAIR_PAGE = 12;
/** Backfill failures a repair pass retries. */
export const RETRY_PAGE = 3;
/** Decided items a repair pass re-checks (the walk for an item left decided while a source reopened). */
export const REPAIR_DECIDED_PAGE = 4;

/**
 * What one item's repair may read and write, sized for the member bound: an item of `MAX_MEMBERS`
 * open and as many closed members costs about one read per member (`lib/inboxRepair` reads each
 * source once), and a visit reconciles at most `REPAIR_FIXES_PER_VISIT` drifted members.
 */
export const REPAIR_LIMITS: Limits = {
  bytesRead: 8 * MiB,
  documentsRead: 12_000,
  databaseQueries: 2_400,
  documentsWritten: 3_000,
};
/** An item's repair, and what the pass keeps back past it (the outcome's record, the next read). */
const REPAIR_ITEM: ItemBudget = {
  limits: REPAIR_LIMITS,
  reserve: { bytesRead: MiB, documentsRead: 200, databaseQueries: 40, documentsWritten: 40 },
};

type Phase = {
  name: string;
  table: (typeof INBOX_SOURCE_TABLES)[number];
  kind: RowKind;
  page: (
    ctx: QueryCtx,
    cursor: string | null,
    n: number,
  ) => Promise<{ page: { _id: string }[]; isDone: boolean; continueCursor: string }>;
};

/**
 * The backfill's phases: every open source first (so the lanes fill before the record), then the
 * decided history, so *Decided* starts with the record.
 */
const PHASES: Phase[] = [
  ...(['open', 'reviewing', 'actioned', 'dismissed'] as const).map(
    (status): Phase => ({
      name: `flags:${status}`,
      table: 'contentFlags',
      kind: 'contentFlag',
      page: (ctx, cursor, n) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_status', (q) => q.eq('status', status))
          .paginate({ cursor, numItems: n }),
    }),
  ),
  ...(['open', 'approved', 'declined'] as const).map(
    (status): Phase => ({
      name: `requests:${status}`,
      table: 'waterBodyRequests',
      kind: 'waterBodyRequest',
      page: (ctx, cursor, n) =>
        ctx.db
          .query('waterBodyRequests')
          .withIndex('by_status_created', (q) => q.eq('status', status))
          .paginate({ cursor, numItems: n }),
    }),
  ),
  ...(['pending', 'approved', 'rejected'] as const).map(
    (reviewStatus): Phase => ({
      name: `drawn:${reviewStatus}`,
      table: 'waterBodies',
      kind: 'waterBody',
      page: (ctx, cursor, n) =>
        ctx.db
          .query('waterBodies')
          .withIndex('by_review_status', (q) => q.eq('reviewStatus', reviewStatus))
          .paginate({ cursor, numItems: n }),
    }),
  ),
  ...(['open', 'in_progress', 'resolved'] as const).map(
    (status): Phase => ({
      name: `tickets:${status}`,
      table: 'supportTickets',
      kind: 'supportTicket',
      page: (ctx, cursor, n) =>
        ctx.db
          .query('supportTickets')
          .withIndex('by_status', (q) => q.eq('status', status))
          .paginate({ cursor, numItems: n }),
    }),
  ),
];
export const BACKFILL_PHASES = PHASES.map((p) => p.name);

/** A source from a table name and an id string. */
function sourceOf(table: Phase['table'], id: string): InboxSource {
  return { table, id } as InboxSource;
}

/** The job's key for a source: its table and id, never its contents. */
const keyOf = (table: string, id: string) => `${table}:${id}`;

/**
 * One source reconciled, as its own transaction (the backfill's and the retry's item). The decided
 * history joins a decided item; a drawn body's review instant comes from its audit row (the body
 * stores none).
 */
export const syncOne = internalMutation({
  args: { table: literals(INBOX_SOURCE_TABLES), id: v.string() },
  handler: (ctx, { table, id }) =>
    asItem(keyOf(table, id), async () => {
      const source = sourceOf(table, id);
      let decidedAt: number | undefined;
      let actorId: Id<'profiles'> | undefined;
      if (table === 'waterBodies') {
        const review = await reviewAuditOf(ctx, id);
        decidedAt = review?.createdAt;
        actorId = review?.actorId;
      }
      return syncInboxSource(ctx, source, {
        history: true,
        ...(decidedAt !== undefined ? { decidedAt } : {}),
        ...(actorId ? { actorId } : {}),
      });
    }),
});

/** A drawn body's latest review row (approve, reject or merge), if it has one. */
async function reviewAuditOf(ctx: QueryCtx, id: string): Promise<Doc<'moderationActions'> | null> {
  let latest: Doc<'moderationActions'> | null = null;
  for (const action of ['approve_waterbody', 'reject_waterbody', 'merge_waterbody'] as const) {
    const row = await ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q.eq('targetType', 'waterbody').eq('targetId', id).eq('action', action),
      )
      .order('desc')
      .first();
    if (row && (latest === null || row.createdAt > latest.createdAt)) latest = row;
  }
  return latest;
}

/** One open item repaired, as its own transaction. */
export const repairOne = internalMutation({
  args: { itemId: v.id('inboxItems') },
  handler: (ctx, { itemId }) =>
    asItem(itemId, async () => {
      const item = await ctx.db.get(itemId);
      return item ? repairInboxItem(ctx, item, Date.now()) : 0;
    }),
});

/** Whether the backfill has finished: until it has, every Inbox read says `pending`. */
export async function inboxPending(ctx: QueryCtx): Promise<boolean> {
  const run = await ctx.db
    .query('inboxJobRuns')
    .withIndex('by_job', (q) => q.eq('job', 'backfill'))
    .first();
  return run?.done !== true;
}

const passArgs = {
  /** Test seams: a smaller page, and a smaller budget (a pass ends early, then reschedules). */
  pageCap: v.optional(v.number()),
  budgetBytes: v.optional(v.number()),
};

/** How many rows of `kind` a pass takes: each its worst case plus an item's work, at least one. */
function rowsFor(budget: ReadBudget, kind: RowKind, cap: number): number {
  return Math.max(1, budget.rows(kind, cap, 0, ROW_MAX[kind] + ITEM_BYTES));
}

/**
 * The backfill, a pass at a time: one page of the current phase, each row its own transaction, then
 * the cursor to the page's end, and the next pass scheduled — until the last phase is done.
 * Idempotent from any cursor: a reconcile of a row already filed changes nothing.
 */
export const backfill = internalMutation({
  args: { restart: v.optional(v.boolean()), ...passArgs },
  handler: (ctx, args) => traced('inboxItems:backfill', args, () => backfillPass(ctx, args)),
});

async function backfillPass(
  ctx: MutationCtx,
  args: { restart?: boolean; pageCap?: number; budgetBytes?: number },
): Promise<{ phase: string; read: number; failed: number; done: boolean }> {
  const now = Date.now();
  let run = await ctx.db
    .query('inboxJobRuns')
    .withIndex('by_job', (q) => q.eq('job', 'backfill'))
    .first();
  if (run === null || args.restart === true) {
    const fresh = {
      job: 'backfill' as const,
      phase: PHASES[0]?.name ?? '',
      cursor: null,
      done: false,
      startedAt: now,
      updatedAt: now,
    };
    if (run === null) await ctx.db.insert('inboxJobRuns', fresh);
    else await ctx.db.patch(run._id, fresh);
    run = await ctx.db
      .query('inboxJobRuns')
      .withIndex('by_job', (q) => q.eq('job', 'backfill'))
      .first();
  }
  if (run === null) throw new Error('inboxItems:backfill: the run row did not save');
  if (run.done) return { phase: run.phase, read: 0, failed: 0, done: true };
  const index = Math.max(
    0,
    PHASES.findIndex((p) => p.name === run.phase),
  );
  const phase = PHASES[index] as Phase;
  const budget = new ReadBudget(args.budgetBytes ?? TX_BUDGET);
  const n = rowsFor(budget, phase.kind, args.pageCap ?? BACKFILL_PAGE);
  // The page is charged at its worst; the items' own reads are their nested transactions'.
  const cursor = run.cursor;
  const page = await budget.page(phase.kind, n, (k) => phase.page(ctx, cursor, k));
  let failed = 0;
  for (const row of page.page) {
    const key = keyOf(phase.table, row._id);
    const result = await runIsolated<unknown>(
      ctx,
      internal.inboxItems.syncOne,
      { table: phase.table, id: row._id },
      ITEM_LIMITS,
    );
    if (result.ok) await clearFailure(ctx, 'inboxBackfill', key);
    else {
      failed++;
      await recordFailure(ctx, 'inboxBackfill', key, result.errorClass, now);
    }
  }
  const last = index === PHASES.length - 1;
  const next = page.isDone
    ? last
      ? { phase: phase.name, cursor: null, done: true }
      : { phase: (PHASES[index + 1] as Phase).name, cursor: null, done: false }
    : { phase: phase.name, cursor: page.continueCursor, done: false };
  await ctx.db.patch(run._id, { ...next, updatedAt: now });
  if (!next.done) {
    await ctx.scheduler.runAfter(0, internal.inboxItems.backfill, {
      ...(args.pageCap !== undefined ? { pageCap: args.pageCap } : {}),
      ...(args.budgetBytes !== undefined ? { budgetBytes: args.budgetBytes } : {}),
    });
  }
  return { phase: phase.name, read: page.page.length, failed, done: next.done };
}

/**
 * The drift repair (the cron, every few minutes): the oldest-refreshed open items, each re-derived
 * from its members and their sources as its own transaction — a failure recorded and the item moved
 * to the back, so the walk never re-reads one head forever — then a few of the backfill's failures
 * retried. Returns what it checked and fixed (Machinery reads the failures).
 */
export const repair = internalMutation({
  args: passArgs,
  handler: (ctx, args) => traced('inboxItems:repair', args, () => repairPass(ctx, args)),
});

async function repairPass(
  ctx: MutationCtx,
  args: { pageCap?: number; budgetBytes?: number },
): Promise<{
  checked: number;
  decidedChecked: number;
  fixed: number;
  failed: number;
  retried: number;
}> {
  const now = Date.now();
  const budget = new ReadBudget(args.budgetBytes ?? TX_BUDGET);
  const n = rowsFor(budget, 'small', args.pageCap ?? REPAIR_PAGE);
  const walk = (status: 'open' | 'decided', k: number) =>
    budget.take('small', k, (m) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_refreshed_at', (q) => q.eq('status', status))
        .take(m),
    );
  // The open items, and a few decided ones: an item wrongly left decided while one of its sources is
  // open again (a missed reopen) is found there, never among the open.
  const open = await walk('open', n);
  // Sized to what the walk left, as the retry's read below is: a short budget reads fewer, never past.
  const decided = await walk('decided', budget.rows('small', Math.min(n, REPAIR_DECIDED_PAGE)));
  let fixed = 0;
  let failed = 0;
  let checked = 0;
  let decidedChecked = 0;
  for (const item of [...open, ...decided]) {
    // Started only while the transaction can still pay an item's whole limits: a heavy item is never
    // starved into failing by the ones before it, and the rest wait for the next pass.
    if (!(await affords(ctx, REPAIR_ITEM))) break;
    if (item.status === 'open') checked++;
    else decidedChecked++;
    const result = await runIsolated<number>(
      ctx,
      internal.inboxItems.repairOne,
      { itemId: item._id },
      REPAIR_LIMITS,
    );
    if (result.ok) {
      fixed += result.value;
      await clearFailure(ctx, 'inboxRepair', item._id);
    } else {
      failed++;
      await recordFailure(ctx, 'inboxRepair', item._id, result.errorClass, now);
      // Its refresh rolled back with it: moved to the back here, so the walk goes on past it.
      await ctx.db.patch(item._id, { refreshedAt: now });
    }
  }
  // The backfill's failures, retried a few at a time until they go through (or park, by the rule) —
  // read past the parked ones by index (`eq(parkedAt, undefined)`, the equality the non-sparse index
  // answers), so parked rows never hold the head and a later failure is always reached.
  const owed = await budget.take('small', budget.rows('small', RETRY_PAGE), (k) =>
    ctx.db
      .query('jobFailures')
      .withIndex('by_job_parked', (q) => q.eq('job', 'inboxBackfill').eq('parkedAt', undefined))
      .take(k),
  );
  let retried = 0;
  for (const row of owed) {
    const [table, id] = row.key.split(':') as [Phase['table'], string];
    if (!(INBOX_SOURCE_TABLES as readonly string[]).includes(table) || !id) continue;
    retried++;
    const result = await runIsolated<unknown>(
      ctx,
      internal.inboxItems.syncOne,
      { table, id },
      ITEM_LIMITS,
    );
    if (result.ok) await clearFailure(ctx, 'inboxBackfill', row.key);
    else await recordFailure(ctx, 'inboxBackfill', row.key, result.errorClass, now);
  }
  if (fixed > 0) console.info(`inboxItems:repair: fixed ${fixed} drifted item(s)`);
  return { checked, decidedChecked, fixed, failed, retried };
}
