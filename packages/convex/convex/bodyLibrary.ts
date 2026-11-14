/**
 * **The Bodies library's jobs** (B01-3): the backfill that builds the rows for the existing corpus,
 * the minute cron that drains the machine's queue, the season turning, and the drift repair. The
 * writer itself is `lib/bodyLibrary.ts`; the reads are `bodies.ts`.
 *
 * ## After deploy, in order
 *
 * 1. `bodyLibrary:backfillAll` — every body's rows and the counts, paged by body and resumable (it
 *    re-schedules itself with its cursor; pass the last logged cursor to resume a stopped run).
 *    Re-running is safe: a refresh writes only what changed and moves the counts by the difference.
 * 2. `bodyLibrary:backfillChangedAt` — *Changed* from the audit log, oldest first, paged and
 *    resumable the same way. Needs the rows from step 1.
 */

import { currentSeason, SCOPE_ALL } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
  query,
} from './_generated/server';
import { requireCapability } from './lib/auth';
import {
  bodiesOfTarget,
  changesTheBody,
  closeSeasonFor,
  drainLibraryQueue,
  hasRefreshBudget,
  isParked,
  markRead,
  queueLibraryRefresh,
  REFRESHED_STALE_MS,
  rebuildBodyLibrary,
  refreshBodyLibrary,
  refreshFailure,
  stampChanged,
} from './lib/bodyLibrary';
import { CANONICAL_SOURCES } from './lib/enums';
import { literals } from './lib/validators';

const MiB = 1024 * 1024;

/**
 * Whether this transaction can afford one more read of a body document — its polygon, at most a
 * document's 1 MiB — with room past it for what the caller writes next.
 */
async function canReadAnotherBody(ctx: QueryCtx): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics();
  return (
    m.bytesRead.remaining >= 2 * MiB &&
    m.documentsRead.remaining >= 100 &&
    m.databaseQueries.remaining >= 100
  );
}

/**
 * One body's refresh as its own (nested) transaction — what `refreshBodyLibrary` runs, so a body
 * that throws rolls back only its own work.
 */
export const refreshOne = internalMutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    changedAt: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, changedAt, now }) => {
    try {
      await rebuildBodyLibrary(ctx, waterBodyId, {
        ...(changedAt !== undefined ? { changedAt } : {}),
        ...(now !== undefined ? { now } : {}),
      });
    } catch (err) {
      // An error leaves a nested call as a plain `Error`, its class lost: the class rides as data.
      throw refreshFailure(err);
    }
  },
});

/** Bodies a backfill page refreshes. Small: a body is its polygon, and a busy one its reports. */
export const BACKFILL_BATCH = 10;
/** The body page's read budget, so a page of large outlines stops early rather than failing. */
const BACKFILL_MAX_BYTES = 4 * MiB;
/** Pages one action run takes at most before it hands its cursor to a fresh run. */
const PAGES_PER_RUN = 200;
/**
 * How long one action run pages before it hands its cursor on — well inside an action's ten
 * minutes, so a run of slow pages still logs its cursor and schedules the next rather than dying
 * with neither.
 */
const RUN_MS = 4 * 60_000;

/** One page of the backfill: refresh up to `batchSize` bodies from `cursor`. */
export const backfill = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const page = await ctx.db.query('waterBodies').paginate({
      cursor: cursor ?? null,
      numItems: Math.min(50, Math.max(1, batchSize ?? BACKFILL_BATCH)),
      maximumBytesRead: BACKFILL_MAX_BYTES,
    });
    const now = Date.now();
    // Each body isolated: one that throws is queued with its attempt, and the page goes on. A page
    // that runs short of budget for another full refresh queues the rest for the minute cron.
    let refreshed = 0;
    let tried = 0;
    for (const body of page.page) {
      if (!(await hasRefreshBudget(ctx))) break;
      tried++;
      if (await refreshBodyLibrary(ctx, body._id, { now })) refreshed++;
    }
    const rest = page.page.slice(tried).map((b) => b._id);
    await queueLibraryRefresh(ctx, rest, now);
    return {
      refreshed,
      failed: tried - refreshed,
      deferred: rest.length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * The whole corpus: pages of {@link backfill} until done, re-scheduling itself every
 * {@link PAGES_PER_RUN} pages or {@link RUN_MS}, whichever comes first, so no run outlives an
 * action's limit. About 2,500 pages for 25,000 bodies — tens of minutes.
 */
export const backfillAll = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }): Promise<{ refreshed: number; done: boolean }> => {
    const started = Date.now();
    let next = cursor;
    let refreshed = 0;
    for (let i = 0; i < PAGES_PER_RUN && Date.now() - started < RUN_MS; i++) {
      const page = await ctx.runMutation(internal.bodyLibrary.backfill, {
        ...(next !== undefined ? { cursor: next } : {}),
      });
      refreshed += page.refreshed;
      if (page.isDone) return { refreshed, done: true };
      next = page.continueCursor;
    }
    console.log(`bodyLibrary.backfillAll: ${refreshed} refreshed; resuming from ${next}`);
    await ctx.scheduler.runAfter(0, internal.bodyLibrary.backfillAll, { cursor: next });
    return { refreshed, done: false };
  },
});

/** Audit rows a *Changed* backfill page reads at most. */
const CHANGED_PAGE = 100;
/** Read budget a page keeps back; below it the page stops and is re-run smaller from its cursor. */
const CHANGED_BYTES_RESERVE = 4 * 1024 * 1024;

/** The body a merge's audit row named as its survivor, when it names one. */
function survivorOf(row: Doc<'moderationActions'>): Id<'waterBodies'> | null {
  if (row.action !== 'merge_waterbody') return null;
  const id = (row.metadata as { survivorId?: unknown } | undefined)?.survivorId;
  return typeof id === 'string' ? (id as Id<'waterBodies'>) : null;
}

/**
 * One page of *Changed* from the audit log, oldest first: each moderator action on a body, its bays,
 * landmarks or put-ins stamps that body (the latest wins), and a merge stamps its survivor too. A
 * stamp is idempotent, so a page that runs low on read budget stops before its writes and is re-run
 * from the same cursor at half the size — never skipping a row. Returns the cursor to resume.
 */
export const backfillChangedAt = internalMutation({
  args: { cursor: v.optional(v.string()), pageSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, pageSize }) => {
    const size =
      pageSize !== undefined && Number.isFinite(pageSize)
        ? Math.min(CHANGED_PAGE, Math.max(1, Math.floor(pageSize)))
        : CHANGED_PAGE;
    const page = await ctx.db
      .query('moderationActions')
      .withIndex('by_created_at')
      .paginate({ cursor: cursor ?? null, numItems: size });
    const latest = new Map<Id<'waterBodies'>, number>();
    const stamp = (id: Id<'waterBodies'>, at: number) =>
      latest.set(id, Math.max(latest.get(id) ?? 0, at));
    // A target is read once a page — a bay is its polygon, and a session edits one bay many times —
    // and only a kind that stamps: a lot's links, a flag or a request are never read here.
    const bodiesOf = new Map<string, Id<'waterBodies'>[]>();
    for (const row of page.page) {
      if (row.actorId === undefined) continue;
      const survivor = survivorOf(row);
      if (survivor !== null) stamp(survivor, row.createdAt);
      if (!changesTheBody(row.targetType)) continue;
      const key = `${row.targetType}\u0001${row.targetId}`;
      let bodies = bodiesOf.get(key);
      if (bodies === undefined) {
        const m = await ctx.meta.getTransactionMetrics();
        if (m.bytesRead.remaining < CHANGED_BYTES_RESERVE && size > 1) {
          await ctx.scheduler.runAfter(0, internal.bodyLibrary.backfillChangedAt, {
            ...(cursor !== undefined ? { cursor } : {}),
            pageSize: Math.floor(size / 2),
          });
          return {
            stamped: 0,
            isDone: false,
            continueCursor: cursor ?? null,
            rerunAt: Math.floor(size / 2),
          };
        }
        bodies = (await bodiesOfTarget(ctx, row.targetType, row.targetId)).bodies;
        bodiesOf.set(key, bodies);
      }
      for (const id of bodies) stamp(id, row.createdAt);
    }
    for (const [id, at] of latest) await stampChanged(ctx, id, at);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bodyLibrary.backfillChangedAt, {
        cursor: page.continueCursor,
      });
    }
    return {
      stamped: latest.size,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      rerunAt: null,
    };
  },
});

/**
 * Bodies the minute cron refreshes from the queue. Small, because a refresh reads a body's polygon and
 * its newest reports: ten of the busiest are well inside a transaction's read limit. After a full
 * canonical campaign (every body queued), run `backfillAll` rather than wait on the queue.
 */
export const DRAIN_BATCH = 10;

/** The minute cron: refresh the bodies the machine's bulk writes queued. */
export const drainQueue = internalMutation({
  args: {},
  handler: (ctx) => drainLibraryQueue(ctx, DRAIN_BATCH),
});

/** Bodies one season-turning tick re-counts. */
const SEASON_BATCH = 10;
/** How many seasons back the turning looks for rows still counting reports. */
const SEASONS_BACK = 3;
/** The most rows one season-turning tick reads looking for its batch, past parked bodies' rows. */
const SEASON_SCAN = SEASON_BATCH * 40;

/**
 * The season turning (1 July): re-count the rows that still count an earlier season's reports. Only
 * those need it — a row counting none reads the same in any season, and the list reads an earlier
 * season's count as this season's empty record until the row is re-counted. An equality on the
 * season and a lower bound on the count, so a tick outside the first days of July reads nothing.
 * A parked body is passed over: its rows keep their old season and would otherwise hold the front
 * of the range every tick.
 */
export const turnSeason = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const current = currentSeason(now);
    const bodies = new Set<Id<'waterBodies'>>();
    const passed = new Set<Id<'waterBodies'>>();
    let scanned = 0;
    for (
      let s = current - 1;
      s >= current - SEASONS_BACK && bodies.size < SEASON_BATCH && scanned < SEASON_SCAN;
      s--
    ) {
      const rows = ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_reports_season', (q) => q.eq('reportsSeason', s).gt('reports', 0));
      for await (const r of rows) {
        if (bodies.size >= SEASON_BATCH || ++scanned > SEASON_SCAN) break;
        const id = r.waterBodyId;
        if (bodies.has(id) || passed.has(id)) continue;
        if (await isParked(ctx, id)) passed.add(id);
        else bodies.add(id);
      }
    }
    let refreshed = 0;
    let tried = 0;
    for (const id of bodies) {
      if (!(await hasRefreshBudget(ctx))) break;
      tried++;
      if (await refreshBodyLibrary(ctx, id, { now })) refreshed++;
    }
    // A parked body can't be re-counted, but its last season's count is not this season's: its rows
    // close to the new season's empty record (the counts moved with them), so the turn finishes.
    for (const id of passed) await closeSeasonFor(ctx, id, current);
    return { refreshed, failed: tried - refreshed, closed: passed.size };
  },
});

/** Bodies one drift-repair tick refreshes. */
const DRIFT_BATCH = 10;

/**
 * The drift repair: the rows refreshed longest ago, a few bodies a tick — the whole corpus in about
 * four days at the cron's pace. It catches what no write refreshes yet (a skater's new corpus request
 * or flag, whose files the author-deletion PR is rewriting); nothing a moderator does waits on it.
 *
 * Only rows refreshed at least {@link REFRESHED_STALE_MS} ago: a refresh marks an unchanged row read
 * no oftener than that, so a younger one would stay at the front and be re-read every tick (the day
 * after a backfill, or a corpus the repair has caught up with) — work that moves nothing on.
 */
export const repairDrift = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_refreshed_at', (q) => q.lte('refreshedAt', now - REFRESHED_STALE_MS))
      .take(DRIFT_BATCH * 4);
    const bodies = [...new Set(rows.map((r) => r.waterBodyId))].slice(0, DRIFT_BATCH);
    let refreshed = 0;
    let skipped = 0;
    let failedHere = 0;
    for (const id of bodies) {
      // Out of budget for another full refresh: the rest come first next tick.
      if (!(await hasRefreshBudget(ctx))) break;
      // A parked body is passed over, and a failing one too: each is marked read so the repair moves
      // on rather than meeting it again first on every tick.
      if (await isParked(ctx, id)) {
        skipped++;
        await markRead(ctx, id, now);
      } else if (await refreshBodyLibrary(ctx, id, { now })) refreshed++;
      else {
        failedHere++;
        await markRead(ctx, id, now);
      }
    }
    return { refreshed, skipped, failed: failedHere };
  },
});

/** The most parked bodies the parked read lists. */
const PARKED_LIST = 50;

/**
 * Release parked bodies back to the queue — their attempts reset, at its back — for the drain to
 * try again. The way out besides the body's next audited write.
 */
export const retryParked = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const asked = limit !== undefined && Number.isFinite(limit) ? Math.floor(limit) : 100;
    const parked = await ctx.db
      .query('bodyLibraryQueue')
      .withIndex('by_parked_queued', (q) => q.gt('parkedAt', 0))
      .take(Math.min(500, Math.max(1, asked)));
    const now = Date.now();
    for (const row of parked) {
      await ctx.db.patch(row._id, { parkedAt: undefined, attempts: 0, queuedAt: now });
    }
    return { released: parked.length };
  },
});

/**
 * The parked read's rows. The name from the body's library row, a small document; the body itself
 * (its polygon) only for one that never had a row — a body that failed its first refresh, so often
 * a heavy one — and only while the read can afford another body, else `null` (not recorded).
 */
export async function parkedRows(ctx: QueryCtx) {
  const rows = await ctx.db
    .query('bodyLibraryQueue')
    .withIndex('by_parked_queued', (q) => q.gt('parkedAt', 0))
    .take(PARKED_LIST + 1);
  const out = [];
  for (const row of rows.slice(0, PARKED_LIST)) {
    const listed = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', row.waterBodyId).eq('scope', SCOPE_ALL))
      .first();
    let name = listed?.name ?? null;
    if (listed === null && (await canReadAnotherBody(ctx))) {
      name = (await ctx.db.get(row.waterBodyId))?.name ?? null;
    }
    out.push({
      waterBodyId: row.waterBodyId,
      name,
      attempts: row.attempts ?? 0,
      lastErrorClass: row.lastErrorClass ?? null,
      parkedAt: row.parkedAt as number,
    });
  }
  return { count: out.length, capped: rows.length > PARKED_LIST, rows: out };
}

/**
 * **Bodies whose library refresh is parked** — for the console's Machinery: how many (counted to
 * the list's bound, `capped` past it), and each with its attempts, its last error's class and when
 * it was parked. No content: an error's class, never its message.
 */
export const parked = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'machinery.read');
    return parkedRows(ctx);
  },
});

/** Coverage refs one resolve run takes at most, so its writes stay small too. */
export const RESOLVE_BATCH = 500;

/** A body as the contour coverage knows it: its catalog and its id there. */
export type CatalogRef = { source: (typeof CANONICAL_SOURCES)[number]; externalId: string };

/**
 * Resolve refs to their bodies and queue them, for as long as the transaction can afford another
 * body read (the first is always read, so every run moves the list on). Returns the refs it left.
 */
export async function queueCatalogRefs(
  ctx: MutationCtx,
  refs: readonly CatalogRef[],
): Promise<{ queued: number; rest: CatalogRef[] }> {
  const now = Date.now();
  let done = 0;
  let queued = 0;
  for (const { source, externalId } of refs) {
    if (done >= RESOLVE_BATCH || (done > 0 && !(await canReadAnotherBody(ctx)))) break;
    done++;
    const body = await ctx.db
      .query('waterBodies')
      .withIndex('by_external_id', (q) => q.eq('source', source).eq('externalId', externalId))
      .first();
    if (body === null) continue;
    await queueLibraryRefresh(ctx, [body._id], now);
    queued++;
  }
  return { queued, rest: refs.slice(done) };
}

/**
 * **Queue the bodies a catalog-keyed write moved** — the contour coverage, which knows a body by its
 * source and external id. Resolving one reads the body (its polygon), and a coverage replacement's
 * first batch clears the whole set, so this reads as many as the transaction affords and hands the
 * rest to a fresh run of itself.
 */
export const queueByExternalId = internalMutation({
  args: {
    refs: v.array(v.object({ source: literals(CANONICAL_SOURCES), externalId: v.string() })),
  },
  handler: async (ctx, { refs }) => {
    const { queued, rest } = await queueCatalogRefs(ctx, refs);
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.bodyLibrary.queueByExternalId, { refs: rest });
    }
    return { queued, deferred: rest.length };
  },
});

/** Where the library stands: the corpus it counts and how many bodies wait in the queue. */
export const state = internalQuery({
  args: {},
  handler: async (ctx) => {
    const corpus = await ctx.db
      .query('bodyLibraryCounts')
      .withIndex('by_lane_scope_key', (q) =>
        q.eq('lane', 'all').eq('scope', '*').eq('key', 'total'),
      )
      .first();
    const queued = await ctx.db
      .query('bodyLibraryQueue')
      .withIndex('by_parked_queued', (q) => q.eq('parkedAt', undefined))
      .take(1001);
    const parkedRows = await ctx.db
      .query('bodyLibraryQueue')
      .withIndex('by_parked_queued', (q) => q.gt('parkedAt', 0))
      .take(1001);
    return {
      corpus: corpus?.count ?? 0,
      queued: Math.min(queued.length, 1000),
      queuedCapped: queued.length > 1000,
      parked: Math.min(parkedRows.length, 1000),
      parkedCapped: parkedRows.length > 1000,
    };
  },
});
