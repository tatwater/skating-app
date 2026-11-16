/**
 * **A page of the record sheet costs a bounded number of sequential database rounds** (B01-4d). Each
 * list reads its rows by index (one round), then every row's documents in waves (`ReadBudget.waves`):
 * a wave admits as many rows as their declared worst cases fit the request's budget, and its reads run
 * together. A row's worst case is a whole document per audit row, item, Report and library row, so a
 * wave holds a handful of rows whatever they really weigh — the rounds grow with a page's waves,
 * never with its rows one by one. The worst a page of fifty costs is stated below, from the budget.
 *
 * A round is counted when a database call starts with none in flight: calls that overlap share one.
 * Counted structurally, never by the clock.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { countsOf, deletedPage, HEAVY_STEPS, reversedPage, standingPage } from './contentRecord';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { CHARGED_QUERY_BUDGET, ROW_MAX } from './lib/readBudget';
import { DELETED_TAKE, RECORD_PAGE } from './lib/recordReads';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;
const NOW = Date.UTC(2026, 10, 14, 12);

/** A query's view of `ctx` whose database calls are counted (as `undoRounds.test.ts` counts them). */
function counted(ctx: MutationCtx) {
  const stats = { calls: 0, rounds: 0, inFlight: 0 };
  const track = <R>(p: Promise<R>): Promise<R> => {
    if (stats.inFlight === 0) stats.rounds++;
    stats.calls++;
    stats.inFlight++;
    return p.finally(() => {
      stats.inFlight--;
    });
  };
  const TERMINAL = new Set(['first', 'unique', 'take', 'collect', 'paginate']);
  const wrapQuery = (q: unknown): unknown =>
    new Proxy(q as object, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return TERMINAL.has(String(key)) ? track(out as Promise<unknown>) : wrapQuery(out);
        };
      },
    });
  const db = {
    get: (id: never) => track(ctx.db.get(id)),
    query: (table: never) => wrapQuery(ctx.db.query(table)),
    normalizeId: ctx.db.normalizeId.bind(ctx.db),
    system: ctx.db.system,
  };
  return { ctx: { ...ctx, db } as unknown as QueryCtx, stats };
}

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

/**
 * A person with `n` items of each list's dearest kind: Reports a moderator hid (Standing), Reports a
 * moderator removed and another restored (Reversed), and comments they deleted on someone's Report
 * (Deleted: each names its body through the Report).
 */
async function record(t: T, n: number) {
  return t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts'] as const) {
      await markReady(ctx, b);
    }
    const profile = async (subject: string, role: 'member' | 'moderator') => {
      const id = await ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: subject,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: NOW,
      });
      await refreshPersonRow(ctx, id);
      return id;
    };
    const rob = await profile(`rob-${n}`, 'member');
    const kate = await profile(`kate-${n}`, 'member');
    const matt = await profile(`matt-${n}`, 'moderator');
    const waterBodyId = await ctx.db.insert('waterBodies', {
      name: 'Mascoma Lake',
      searchText: 'Mascoma Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: NOW,
    });
    const report = (authorId: Id<'profiles'>, over: Partial<Doc<'reports'>> = {}) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: NOW,
        reportTime: NOW,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
      });
    const on = await report(kate);
    for (let i = 0; i < n; i++) {
      const hidden = await report(rob, { moderationStatus: 'hidden' });
      const hide = await ctx.db.insert('moderationActions', {
        actorId: matt,
        action: 'hide',
        targetType: 'report',
        targetId: hidden,
        reason: 'hidden',
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: NOW - 1_000 + i,
      });
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: rob,
        targetType: 'report',
        targetId: hidden,
        actionId: hide,
        kind: 'hidden',
        at: NOW - 1_000 + i,
        standing: true,
        superseded: false,
      });
      const restored = await report(rob);
      const remove = await ctx.db.insert('moderationActions', {
        actorId: matt,
        action: 'remove',
        targetType: 'report',
        targetId: restored,
        reason: 'removed',
        metadata: { priorStatus: 'visible', newStatus: 'removed' },
        createdAt: NOW - 3_000 + i,
      });
      const restore = await ctx.db.insert('moderationActions', {
        actorId: matt,
        action: 'restore',
        targetType: 'report',
        targetId: restored,
        reason: 'Restored',
        metadata: { priorStatus: 'removed', newStatus: 'visible', reasonDefaulted: true },
        createdAt: NOW - 2_000 + i,
      });
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: rob,
        targetType: 'report',
        targetId: restored,
        actionId: remove,
        kind: 'removed',
        at: NOW - 3_000 + i,
        standing: false,
        endedAt: NOW - 2_000 + i,
        endedByActionId: restore,
        superseded: false,
      });
      await ctx.db.insert('comments', {
        reportId: on,
        authorId: rob,
        body: `c${i}`,
        moderationStatus: 'removed' as const,
        source: 'native' as const,
        authorDeletedAt: NOW - 500 + i,
        eraseAt: NOW + 30 * 86_400_000,
        createdAt: NOW - 5_000,
      } as never);
    }
    return { rob, viewer: (await ctx.db.get(matt)) as Doc<'profiles'> };
  });
}

type Page = (
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  args: { userId: Id<'profiles'> },
) => Promise<{ page: unknown[] }>;

async function roundsOf(n: number, page: Page) {
  const t = convexTest(schema, modules);
  const { rob, viewer } = await record(t, n);
  return t.run(async (ctx) => {
    const { ctx: c, stats } = counted(ctx);
    const out = await page(c, viewer, { userId: rob });
    return { rows: out.page.length, ...stats };
  });
}

/** Rows a wave admits, at most: what the budget leaves after the page's own rows, by a row's worst. */
const perWave = (rowCost: number) =>
  Math.floor((CHARGED_QUERY_BUDGET - (RECORD_PAGE + 1 + 4) * ROW_MAX.verdict) / rowCost);
const waves = (rowCost: number) => Math.ceil(RECORD_PAGE / perWave(rowCost));

/**
 * The worst rounds a page of fifty costs: the backfill check and the rows (two), the first row whole
 * ({@link HEAD_ROUNDS}), the rest's documents in waves
 * (a Standing Report: its decision beside the item; a Reversed one, the action that ended it too), the
 * names (one wave: one body, a few people) — and on Reversed the undo engine's first step (main's,
 * three rounds: the undoing row and the newest together, then the author's stamp).
 */
/**
 * A page's first row, read whole on its own before any other is admitted (so a page always moves on):
 * its documents, its Report, its erasure row, its names — four rounds at most.
 */
const HEAD_ROUNDS = 4;
const STANDING_ROUNDS = 2 + HEAD_ROUNDS + waves(2 * ROW_MAX.report) + 1;
const REVERSED_ROUNDS = 2 + HEAD_ROUNDS + waves(3 * ROW_MAX.report) + 1 + 3;
/** Deleted: the five ranges together, each row's hold, the Reports once a page, then the names. */
const DELETED_ROUNDS = 2 + HEAD_ROUNDS + 3;
/**
 * The counts: the check, then Reversed's range, the Reports' range and the light kinds' ranges together,
 * then the heavy kinds' steps (one round each, at most `HEAVY_STEPS`), then the holds (two waves at
 * worst).
 */
const COUNT_ROUNDS = 2 + HEAVY_STEPS + 2;
/** The same with no Post or hazard deleted: the heavy kinds end on their first step. */
const COUNT_ROUNDS_LIGHT = 2 + 1 + 2;

describe('a page’s first row always fits (B01-4d)', () => {
  test('every list’s first row, read whole at its worst, fits what its rows leave of a fresh budget', () => {
    const prep = 4 * ROW_MAX.small;
    const verdictRows = (RECORD_PAGE + 1) * 2 * ROW_MAX.verdict; // a cursor's two parts
    const names = ROW_MAX.bodyLibraryRow + 3 * ROW_MAX.personRow;
    const item = Math.max(ROW_MAX.report, ROW_MAX.post, ROW_MAX.hazard, ROW_MAX.comment);
    // Reversed is the dearest verdict list: its decision, the action that ended it, the item, then
    // the Report a comment names its body through (or a gone item's erasure row), then the names.
    const reversedHead = 2 * ROW_MAX.moderationAction + item + ROW_MAX.report + names;
    expect(prep + verdictRows + reversedHead).toBeLessThanOrEqual(CHARGED_QUERY_BUDGET);
    // Deleted: its five ranges, and the tie part of the one kind the cursor sits in (the dearest),
    // then one row's hold, Report and names.
    const parts = Object.entries(DELETED_TAKE).map(
      ([kind, n]) => n * ROW_MAX[kind as keyof typeof DELETED_TAKE],
    );
    const ranges = parts.reduce((a, b) => a + b, 0) + Math.max(...parts);
    const deletedHead = ROW_MAX.verdict + ROW_MAX.report + names;
    expect(prep + ranges + deletedHead).toBeLessThanOrEqual(CHARGED_QUERY_BUDGET);
  });
});

describe('the record sheet’s rounds (B01-4d)', () => {
  test('Standing: a page of fifty costs its waves, not a round a row', async () => {
    const fifty = await roundsOf(50, standingPage as Page);
    console.log(
      `Standing: 50 rows ${fifty.rounds} rounds / ${fifty.calls} calls (worst ${STANDING_ROUNDS})`,
    );
    expect(fifty.rows).toBe(50);
    expect(fifty.rounds).toBeLessThanOrEqual(STANDING_ROUNDS);
  });

  test('Reversed: the same, with each row’s undo state in a handful more', async () => {
    const fifty = await roundsOf(50, reversedPage as Page);
    console.log(
      `Reversed: 50 rows ${fifty.rounds} rounds / ${fifty.calls} calls (worst ${REVERSED_ROUNDS})`,
    );
    expect(fifty.rows).toBe(50);
    expect(fifty.rounds).toBeLessThanOrEqual(REVERSED_ROUNDS);
  });

  test('Deleted: five ranges at once, then the rows in waves', async () => {
    const fifty = await roundsOf(50, deletedPage as Page);
    console.log(
      `Deleted: 50 rows ${fifty.rounds} rounds / ${fifty.calls} calls (worst ${DELETED_ROUNDS})`,
    );
    expect(fifty.rows).toBe(50);
    expect(fifty.rounds).toBeLessThanOrEqual(DELETED_ROUNDS);
  });

  test('the counts: a fixed few rounds', async () => {
    const t = convexTest(schema, modules);
    const { rob } = await record(t, 50);
    const stats = await t.run(async (ctx) => {
      const { ctx: c, stats } = counted(ctx);
      const out = await countsOf(c, { userId: rob });
      expect(out.reversed.count).toBe(50);
      return stats;
    });
    console.log(
      `Counts: ${stats.rounds} rounds / ${stats.calls} calls (worst ${COUNT_ROUNDS_LIGHT})`,
    );
    expect(stats.rounds).toBeLessThanOrEqual(COUNT_ROUNDS_LIGHT);
  });

  test('the counts with many deleted Posts: a few steps, never a round a Post', async () => {
    const t = convexTest(schema, modules);
    const { rob } = await record(t, 1);
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert('posts', {
          authorId: rob,
          reportIds: [],
          photoIds: [],
          latestSkateEndTime: NOW,
          moderationStatus: 'removed' as const,
          authorDeletedAt: NOW - 10_000 + i,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    const stats = await t.run(async (ctx) => {
      const { ctx: c, stats } = counted(ctx);
      const out = await countsOf(c, { userId: rob });
      // Exact as far as the steps reached; past them, a floor that says so.
      expect(out.deleted.byKind.post).toBe(40);
      expect(out.deleted.capped).toBe(out.deleted.byKind.post < 40);
      return stats;
    });
    console.log(`Counts, 40 Posts: ${stats.rounds} rounds (worst ${COUNT_ROUNDS})`);
    expect(stats.rounds).toBeLessThanOrEqual(COUNT_ROUNDS);
  });

  test('the counts with Posts deleted in one instant: a floor once the ties fill the share', async () => {
    const t = convexTest(schema, modules);
    const { rob } = await record(t, 1);
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        await ctx.db.insert('posts', {
          authorId: rob,
          reportIds: [],
          photoIds: [],
          latestSkateEndTime: NOW,
          moderationStatus: 'removed' as const,
          authorDeletedAt: NOW - 10_000,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    const out = await t.run((ctx) => countsOf(ctx, { userId: rob }));
    // Each step reads the rows tied at the last one's time again, at a whole document a row: once
    // they alone fill the kind's share, no further row can be reserved, and the count says so.
    expect(out.deleted.capped).toBe(true);
    expect(out.deleted.byKind.post).toBeGreaterThanOrEqual(1);
    expect(out.deleted.byKind.post).toBeLessThan(12);
  });
});
