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

import { currentSeason } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import {
  bodiesOfTarget,
  drainLibraryQueue,
  refreshBodyLibrary,
  stampChanged,
} from './lib/bodyLibrary';

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
    for (const body of page.page) await refreshBodyLibrary(ctx, body._id, { known: body, now });
    return {
      refreshed: page.page.length,
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

/**
 * The season turning (1 July): re-count the rows that still count an earlier season's reports. Only
 * those need it — a row counting none reads the same in any season, and the list reads an earlier
 * season's count as this season's empty record until the row is re-counted. An equality on the
 * season and a lower bound on the count, so a tick outside the first days of July reads nothing.
 */
export const turnSeason = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const current = currentSeason(now);
    const bodies = new Set<Id<'waterBodies'>>();
    for (let s = current - 1; s >= current - SEASONS_BACK && bodies.size < SEASON_BATCH; s--) {
      const rows = await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_reports_season', (q) => q.eq('reportsSeason', s).gt('reports', 0))
        .take(SEASON_BATCH * 4);
      for (const r of rows) if (bodies.size < SEASON_BATCH) bodies.add(r.waterBodyId);
    }
    for (const id of bodies) await refreshBodyLibrary(ctx, id, { now });
    return { refreshed: bodies.size };
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
    for (const id of bodies) await refreshBodyLibrary(ctx, id, { now });
    return { refreshed: bodies.length };
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
    const queued = await ctx.db.query('bodyLibraryQueue').take(1001);
    return {
      corpus: corpus?.count ?? 0,
      queued: Math.min(queued.length, 1000),
      queuedCapped: queued.length > 1000,
    };
  },
});
