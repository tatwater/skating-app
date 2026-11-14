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
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import {
  bodiesOfTarget,
  drainLibraryQueue,
  hasRefreshBudget,
  isParked,
  markRead,
  queueLibraryRefresh,
  rebuildBodyLibrary,
  refreshBodyLibrary,
  refreshFailure,
  stampChanged,
} from './lib/bodyLibrary';

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
const BACKFILL_MAX_BYTES = 4 * 1024 * 1024;
/** Pages one action run takes before it hands its cursor to a fresh run (actions time out). */
const PAGES_PER_RUN = 200;

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
 * {@link PAGES_PER_RUN} pages so no run outlives an action's limit. About 2,500 pages for 25,000
 * bodies — tens of minutes.
 */
export const backfillAll = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }): Promise<{ refreshed: number; done: boolean }> => {
    let next = cursor;
    let refreshed = 0;
    for (let i = 0; i < PAGES_PER_RUN; i++) {
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

/** Audit rows a *Changed* backfill page reads. */
const CHANGED_PAGE = 200;

/**
 * One page of *Changed* from the audit log, oldest first: each moderator action on a body, its bays,
 * landmarks or put-ins stamps that body's rows (the latest wins). Returns the cursor to resume.
 */
export const backfillChangedAt = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('moderationActions')
      .withIndex('by_created_at')
      .paginate({ cursor: cursor ?? null, numItems: CHANGED_PAGE });
    const latest = new Map<Id<'waterBodies'>, number>();
    for (const row of page.page) {
      if (row.actorId === undefined) continue;
      const { bodies, changes } = await bodiesOfTarget(ctx, row.targetType, row.targetId);
      if (!changes) continue;
      for (const id of bodies) latest.set(id, Math.max(latest.get(id) ?? 0, row.createdAt));
    }
    for (const [id, at] of latest) await stampChanged(ctx, id, at);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bodyLibrary.backfillChangedAt, {
        cursor: page.continueCursor,
      });
    }
    return { stamped: latest.size, isDone: page.isDone, continueCursor: page.continueCursor };
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
    return { refreshed, failed: tried - refreshed };
  },
});

/** Bodies one drift-repair tick refreshes. */
const DRIFT_BATCH = 10;

/**
 * The drift repair: the rows refreshed longest ago, a few bodies a tick — the whole corpus in about
 * four days at the cron's pace. It catches what no write refreshes yet (a skater's new corpus request
 * or flag, whose files the author-deletion PR is rewriting); nothing a moderator does waits on it.
 */
export const repairDrift = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_refreshed_at')
      .take(DRIFT_BATCH * 4);
    const bodies = [...new Set(rows.map((r) => r.waterBodyId))].slice(0, DRIFT_BATCH);
    const now = Date.now();
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
 * **Bodies whose library refresh is parked** — for the console's Machinery: how many (counted to
 * the list's bound, `capped` past it), and each with its attempts, its last error's class and when
 * it was parked. No content: an error's class, never its message.
 */
export const parked = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'machinery.read');
    const rows = await ctx.db
      .query('bodyLibraryQueue')
      .withIndex('by_parked_queued', (q) => q.gt('parkedAt', 0))
      .take(PARKED_LIST + 1);
    const out = [];
    for (const row of rows.slice(0, PARKED_LIST)) {
      // The name from the body's library row, a small document; the body itself (its polygon) only
      // for one that never had a row.
      const listed = await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', row.waterBodyId).eq('scope', SCOPE_ALL))
        .first();
      const name = listed?.name ?? (await ctx.db.get(row.waterBodyId))?.name ?? null;
      out.push({
        waterBodyId: row.waterBodyId,
        name,
        attempts: row.attempts ?? 0,
        lastErrorClass: row.lastErrorClass ?? null,
        parkedAt: row.parkedAt as number,
      });
    }
    return { count: out.length, capped: rows.length > PARKED_LIST, rows: out };
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
