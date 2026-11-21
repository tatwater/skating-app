/**
 * **A page of History costs a bounded number of sequential database rounds, whatever its length**
 * (B01-3h). Each row's undo state is a few indexed reads and, for the newest row on a target whose
 * verb checks the row as it stands, a refusal read; a page that awaits them row by row pays every
 * read in sequence — 50 rows, hundreds of rounds, which is what put one body's History near a
 * query's second. Rows run concurrently; a target's newest row is read once a page; the refusal
 * reads reserve their worst case before they start, so the shared budget stays exact without a queue.
 *
 * A round is counted when a database call starts with none in flight: calls that overlap share one.
 * Counted structurally, never by the clock.
 */

import { SCOPE_ALL } from '@skating/core';
import { getDocumentSize } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { historyPage } from './bodyConsole';
import { writeAudit, writeSnapshot } from './lib/audit';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { refreshBodyNames } from './lib/bodyNames';
import { listablePeople } from './lib/peopleFigures';
import { refreshPersonRow } from './lib/peopleRows';
import {
  CHARGED_QUERY_BUDGET,
  DOC_MAX,
  REQUEST_PROFILE_BUDGET,
  ReadBudget,
  ROW_MAX,
  requestBudget,
} from './lib/readBudget';
import { readRoots } from './lib/staffTenure';
import { UNDO_NEEDS_ROWS, type UndoState, undoStates } from './lib/undo';
import { UNDO_CHECKED_ELSEWHERE } from './lib/undoReads';
import { listActionsPage } from './moderation';
import { decisionsPage, labelFlags, shapeRows, staffSeasonPage, staffStatsPage } from './people';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

/**
 * A query's view of `ctx` whose database calls are counted: `calls`, and `rounds` — a call started
 * with none in flight begins a round. No `insert`, so the reads take their query paths. With
 * `ticks`, the n-th call settles that many extra microtask turns late — a different order reads
 * settle in, for a page that must not depend on it.
 */
function counted(ctx: MutationCtx, ticks: readonly number[] = [0]) {
  const stats = { calls: 0, rounds: 0, inFlight: 0 };
  const late = async <R>(p: Promise<R>, n: number): Promise<R> => {
    const value = await p;
    for (let i = 0; i < n; i++) await Promise.resolve();
    return value;
  };
  const track = <R>(p: Promise<R>): Promise<R> => {
    if (stats.inFlight === 0) stats.rounds++;
    const n = ticks[stats.calls % ticks.length] ?? 0;
    stats.calls++;
    stats.inFlight++;
    return late(p, n).finally(() => {
      stats.inFlight--;
    });
  };
  const TERMINAL = new Set(['first', 'unique', 'take', 'collect', 'paginate']);
  const wrapQuery = (q: unknown): unknown =>
    new Proxy(q as object, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === Symbol.asyncIterator) {
          return () => {
            const it = (value as () => AsyncIterator<unknown>).call(target);
            return { next: () => track(it.next()) };
          };
        }
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

let seq = 0;
async function admin(t: T) {
  const n = seq++;
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: `rounds-${n}`,
      displayName: `Ari ${n}`,
      username: `ari-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      reputationPoints: 0,
      role: 'admin',
      status: 'active',
      createdAt: NOW,
    }),
  );
}

const POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-72.01, 43.99],
      [-71.99, 43.99],
      [-71.99, 44.01],
      [-72.01, 44.01],
      [-72.01, 43.99],
    ],
  ],
};

/**
 * One busy body's page: `rows` audit rows, the worst mix — four boosts from before undo existed and
 * the rest edits of distinct landmarks on the body (each the newest on its own target, so each asks
 * its refusal: a landmark read), plus the body's newest row a depth choice (its refusal reads the body).
 */
async function busyBody(t: T, rows: number, landmarks = true) {
  const actorId = await admin(t);
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId: 'way/1',
        osmId: 'way/1',
        name: 'Long Lake',
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: 40_000,
        // The region rule's answer (D266): an import refuses a record that carries none.
        states: ['VT'],
      },
    ],
  });
  const waterBodyId = await t.run(async (ctx) => {
    const id = (await ctx.db.query('waterBodies').first())?._id as Id<'waterBodies'>;
    await ctx.db.patch(id, {
      maxDepthM: 24,
      maxDepthSource: 'state_agency',
      depthCandidates: [
        { measure: 'max', source: 'state_agency', valueM: 24 },
        { measure: 'max', source: 'lagos_us', valueM: 23 },
      ],
    });
    for (let i = 0; i < 4; i++) {
      await writeAudit(ctx, {
        actorId,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: id,
        reason: 'an old boost',
        metadata: { curatedBoost: i },
        createdAt: NOW - 10_000 + i,
      });
    }
    for (let i = 0; i < rows - 5; i++) {
      if (!landmarks) {
        await writeAudit(ctx, {
          actorId,
          action: 'set_aliases',
          targetType: 'waterbody',
          targetId: id,
          reason: 'aliases',
          metadata: { moderatorAliases: [`A${i}`], prev: { moderatorAliases: [] } },
          createdAt: NOW - 5_000 + i,
        });
        continue;
      }
      const landmarkId = await ctx.db.insert('bodyLandmarks', {
        waterBodyId: id,
        name: `Point ${i}`,
        kind: 'point',
        point: { lat: 44, lng: -72 + i * 0.0001 },
        aliases: [`Pt ${i}`],
        source: 'gnis',
        externalIds: [`gnis:${i}`],
        createdAt: NOW,
        updatedAt: NOW,
      } as never);
      await writeAudit(ctx, {
        actorId,
        action: 'edit_landmark',
        targetType: 'bodyLandmark',
        targetId: landmarkId,
        reason: 'spelling',
        metadata: {
          waterBodyId: id,
          aliases: [`Pt ${i}`],
          prev: { name: `Point ${i}`, aliases: [], kind: 'point', point: { lat: 44, lng: -72 } },
        },
        createdAt: NOW - 5_000 + i,
      });
    }
    const depth = await writeAudit(ctx, {
      actorId,
      action: 'choose_depth_source',
      targetType: 'waterbody',
      targetId: id,
      reason: 'the survey',
      metadata: {
        measure: 'max',
        choice: 'state_agency',
        valueM: 24,
        prev: { choice: null, valueM: 24, source: 'state_agency' },
      },
      createdAt: NOW,
    });
    await writeSnapshot(ctx, depth, {});
    return id;
  });
  return { actorId, waterBodyId };
}

async function measure(t: T, rows: number, landmarks = true) {
  const { actorId, waterBodyId } = await busyBody(t, rows, landmarks);
  return t.run(async (raw) => {
    const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
    const { ctx, stats } = counted(raw);
    const page = await historyPage(ctx, viewer, {
      waterBodyId: waterBodyId as Id<'waterBodies'>,
      limit: rows,
    });
    return { page, stats };
  });
}

describe('History’s rounds (B01-3h)', () => {
  test('a page of 50 costs the same few rounds as a page of 10', async () => {
    const fifty = await measure(harness(), 50, false);
    const ten = await measure(harness(), 10, false);
    console.log(
      `History rounds (one target): 50 rows ${fifty.stats.rounds} rounds / ${fifty.stats.calls} calls; 10 rows ${ten.stats.rounds} / ${ten.stats.calls}`,
    );
    expect(fifty.page.entries).toHaveLength(50);
    expect(fifty.stats.rounds).toBeLessThanOrEqual(PAGE_ROUNDS);
    expect(fifty.stats.rounds).toBe(ten.stats.rounds);
  });

  test('the worst page — 45 targets each asking its refusal — stays within its stated bound, every check made', async () => {
    const { page, stats } = await measure(harness(), 50);
    console.log(`History rounds (45 refusals): ${stats.rounds} rounds / ${stats.calls} calls`);
    // The landmark edits and the depth choice are each offered; the old boosts say why not.
    expect(page.entries.filter((e) => e.undo.state === 'available')).toHaveLength(46);
    expect(stats.rounds).toBeLessThanOrEqual(WORST_PAGE_ROUNDS);
  });

  test('the worst page with the body’s short list of names built: one more read, shared by every line (B01-3u)', async () => {
    const t = harness();
    const { actorId, waterBodyId } = await busyBody(t, 50);
    await t.run((ctx) => refreshBodyNames(ctx, waterBodyId as Id<'waterBodies'>));
    const { page, stats } = await t.run(async (raw) => {
      const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
      const { ctx, stats } = counted(raw);
      const page = await historyPage(ctx, viewer, {
        waterBodyId: waterBodyId as Id<'waterBodies'>,
        limit: 50,
      });
      return { page, stats };
    });
    console.log(`History rounds (45 refusals, names built): ${stats.rounds} / ${stats.calls}`);
    // Every landmark edit checked against the whole rule from the list, and offered (no clash).
    expect(page.entries.filter((e) => e.undo.state === 'available')).toHaveLength(46);
    // The list is read once a query — the first wave pays one round more, the rest share it.
    expect(stats.rounds).toBeLessThanOrEqual(WORST_PAGE_ROUNDS + 1);
  });

  test('worst case across bodies: heavy refusal reads past the budget in one feed stay inside the budget; the overflow says "check elsewhere", never a throw', async () => {
    const t = harness();
    const actorId = await admin(t);
    // A heavy outline (≈ 0.2 MB) on each of 6 bodies, each body's newest row a depth choice; the page
    // has 1.6 MiB of its budget left, so the waves spend it and the rest overflow.
    const ring = Array.from({ length: 8_000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 8_000;
      return [-72 + 0.01 * Math.cos(a), 44 + 0.01 * Math.sin(a)];
    });
    const heavy = { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] };
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 6 }, (_, i) => ({
        source: 'osm',
        externalId: `way/${i}`,
        osmId: `way/${i}`,
        name: `Pond ${i}`,
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: 40_000,
        states: ['VT'],
      })),
    } as never);
    await t.run(async (ctx) => {
      for (const body of await ctx.db.query('waterBodies').collect()) {
        await ctx.db.patch(body._id, {
          polygon: heavy as never,
          maxDepthM: 24,
          maxDepthSource: 'state_agency',
          depthCandidates: [{ measure: 'max', source: 'state_agency', valueM: 24 }],
        });
        await writeAudit(ctx, {
          actorId,
          action: 'choose_depth_source',
          targetType: 'waterbody',
          targetId: body._id,
          reason: 'the survey',
          metadata: {
            measure: 'max',
            choice: 'state_agency',
            valueM: 24,
            prev: { choice: null, valueM: 24, source: 'state_agency' },
          },
        });
      }
    });
    // One page's reading (`undoStates`), as History and the feed take it — not ten readings racing on
    // one budget — under two settling orders.
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const { ctx } = counted(raw, ticks);
        requestBudget(ctx).spend(REQUEST_PROFILE_BUDGET - 1.6 * DOC_MAX);
        const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
        const actions = await raw.db.query('moderationActions').order('desc').take(6);
        return undoStates(ctx, viewer, actions);
      });
    const rows = await read([0]);
    expect(await read([5, 0, 3, 6, 1, 4, 2])).toEqual(rows);
    const elsewhere = rows.filter(
      (u) => u.state === 'unavailable' && u.why === UNDO_CHECKED_ELSEWHERE,
    );
    const offered = rows.filter((u) => u.state === 'available');
    // More than one wave's one: what each wave didn't weigh is handed back and spent again.
    expect(offered.length).toBeGreaterThan(1);
    expect(elsewhere.length).toBeGreaterThan(0);
    // In page order: the checked rows first, then "check elsewhere" to the end.
    expect(rows.slice(0, offered.length)).toEqual(offered);
    expect(rows.slice(offered.length)).toEqual(elsewhere);
  });

  test('people with no People row yet are read in page order, whatever order reads settle in', async () => {
    const t = harness();
    const actorId = await admin(t);
    const subject = await t.run(
      async (ctx) => ((await ctx.db.get(actorId)) as Doc<'profiles'>).clerkUserId,
    );
    const people: Id<'profiles'>[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        const profile = (await ctx.db.get(actorId)) as Doc<'profiles'>;
        const { _id, _creationTime, ...fields } = profile;
        people.push(
          await ctx.db.insert('profiles', {
            ...fields,
            clerkUserId: `rowless-${i}`,
            displayName: `Rowless ${i}`,
            username: `rowless-${i}`,
            role: 'member',
          }),
        );
      }
    });
    const as = t.withIdentity({ subject });
    for (const userId of people) {
      await as.mutation(api.moderation.setPostingPermission, {
        userId,
        permission: 'reports',
        allowed: false,
        reason: 'r',
      });
    }
    // The writes made their rows; take them away again, as before the backfill.
    await t.run(async (ctx) => {
      for (const id of people) {
        const row = await ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', id))
          .first();
        if (row) await ctx.db.delete(row._id);
      }
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
        const rows = await raw.db.query('moderationActions').order('desc').take(6);
        const states = await undoStates(counted(raw, ticks).ctx, viewer, rows);
        const feed = await listActionsPage(counted(raw, ticks).ctx, viewer, { limit: 6 });
        return { states, feed: feed.map((r) => ({ label: r.targetLabel ?? null, undo: r.undo })) };
      });
    const calm = await read([0]);
    expect(await read([6, 0, 3, 5, 1, 4, 2])).toEqual(calm);
    expect(await read([0, 4, 0, 7, 2])).toEqual(calm);
    // The request's 4 MiB reaches four profiles at their worst: the newest four rows, in page order;
    // the feed names the same four (read once a request) and leaves the rest unnamed.
    const unchecked = (u: UndoState) => u.state === 'unavailable' && u.why === UNDO_NEEDS_ROWS;
    expect(calm.states.map(unchecked)).toEqual([false, false, false, false, true, true]);
    expect(calm.feed.map((r) => unchecked(r.undo))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(calm.feed.map((r) => r.label !== null)).toEqual([true, true, true, true, false, false]);
  });
});

describe('the audit feed’s rounds (the Overview’s recent actions, B01-3h)', () => {
  test('a feed of 50 rows over 50 targets stays within the worst page’s bound', async () => {
    const feed = async (rows: number) => {
      const t = harness();
      const { actorId } = await busyBody(t, rows);
      return t.run(async (raw) => {
        const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
        const { ctx, stats } = counted(raw);
        const page = await listActionsPage(ctx, viewer, { limit: rows });
        return { page, stats };
      });
    };
    const fifty = await feed(50);
    const ten = await feed(10);
    console.log(
      `Feed rounds: 50 rows ${fifty.stats.rounds} rounds / ${fifty.stats.calls} calls; 10 rows ${ten.stats.rounds} / ${ten.stats.calls}`,
    );
    expect(fifty.page).toHaveLength(50);
    expect(fifty.stats.rounds).toBeLessThanOrEqual(WORST_PAGE_ROUNDS);
  });
});

describe('People’s Decisions rounds (B01-4c)', () => {
  const decisions = async (rows: number, landmarks = true) => {
    const t = harness();
    const { actorId } = await busyBody(t, rows, landmarks);
    return t.run(async (raw) => {
      const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
      const { ctx, stats } = counted(raw);
      const page = await decisionsPage(ctx, viewer, { userId: actorId, limit: rows });
      return { page, stats };
    });
  };

  test('a page of 50 on one target costs the same few rounds as a page of 10', async () => {
    const fifty = await decisions(50, false);
    const ten = await decisions(10, false);
    console.log(
      `Decisions rounds (one target): 50 rows ${fifty.stats.rounds} rounds / ${fifty.stats.calls} calls; 10 rows ${ten.stats.rounds} / ${ten.stats.calls}`,
    );
    expect(fifty.page?.rows).toHaveLength(50);
    expect(fifty.stats.rounds).toBeLessThanOrEqual(DECISIONS_PAGE_ROUNDS);
    expect(fifty.stats.rounds).toBe(ten.stats.rounds);
  });

  test('the worst page — 45 targets each asking its refusal — stays within its stated bound, every check made', async () => {
    const { page, stats } = await decisions(50);
    console.log(`Decisions rounds (45 refusals): ${stats.rounds} rounds / ${stats.calls} calls`);
    expect(page?.rows).toHaveLength(50);
    expect(page?.rows.filter((r) => r.undo.state === 'available')).toHaveLength(46);
    expect(page?.rows.every((r) => r.actor !== null)).toBe(true);
    expect(stats.rounds).toBeLessThanOrEqual(DECISIONS_WORST_ROUNDS);
  });

  test('the same page whatever order its reads settle in — what the budget reaches is page-ordered', async () => {
    const t = harness();
    const actorId = await admin(t);
    const subject = await t.run(
      async (ctx) => ((await ctx.db.get(actorId)) as Doc<'profiles'>).clerkUserId,
    );
    // Eight people with no People row yet, each restricted by the staffer: their profiles are read
    // in full, charged to the request's budget, which reaches four at their worst.
    const people: Id<'profiles'>[] = [];
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(actorId)) as Doc<'profiles'>;
      for (let i = 0; i < 8; i++) {
        people.push(
          await ctx.db.insert('profiles', {
            ...fields,
            clerkUserId: `decided-${i}`,
            displayName: `Decided ${i}`,
            username: `decided-${i}`,
            role: 'member',
          }),
        );
      }
    });
    const as = t.withIdentity({ subject });
    for (const userId of people) {
      await as.mutation(api.moderation.setPostingPermission, {
        userId,
        permission: 'reports',
        allowed: false,
        reason: 'r',
      });
    }
    await t.run(async (ctx) => {
      for (const id of people) {
        const row = await ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', id))
          .first();
        if (row) await ctx.db.delete(row._id);
      }
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
        const rows = await raw.db
          .query('moderationActions')
          .withIndex('by_actor', (q) => q.eq('actorId', actorId))
          .order('desc')
          .take(8);
        const { ctx } = counted(raw, ticks);
        // A page with a profile budget's worth left (4 MiB), as History opens with.
        requestBudget(ctx);
        return shapeRows(ctx, viewer, rows, new Map());
      });
    const calm = await read([0]);
    // The newest four rows are checked and named; the rest are not — in page order.
    const unchecked = (u: UndoState) => u.state === 'unavailable' && u.why === UNDO_NEEDS_ROWS;
    expect(calm.map((r) => unchecked(r.undo))).toEqual([
      ...Array(4).fill(false),
      ...Array(4).fill(true),
    ]);
    expect(calm.map((r) => r.targetLabel !== undefined)).toEqual([
      ...Array(4).fill(true),
      ...Array(4).fill(false),
    ]);
    const ticks = fc.array(fc.nat(7), { minLength: 1, maxLength: 9 });
    const same = fc.asyncProperty(ticks, async (order) => {
      expect(await read(order)).toEqual(calm);
    });
    // Pinned seeds, so a failure replays; then one run on a fresh seed.
    for (const seed of [20261115, 4242]) await fc.assert(same, { seed, numRuns: 3 });
    await fc.assert(same, { numRuns: 1 });
  });
});

describe('a staffer’s figures’ rounds (B01-4c)', () => {
  /**
   * A busy week: `roots` undos whose chain's first row lies outside the staffer's own read, and
   * `filings` decisions on flags whose row records no filing time — a read each, all at once.
   */
  const week = async (roots: number, filings: number) => {
    const t = harness();
    const viewerId = await admin(t);
    const staffer = await admin(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(staffer, { role: 'moderator' });
      for (let i = 0; i < roots; i++) {
        const root = await ctx.db.insert('moderationActions', {
          actorId: viewerId,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `x${i}`,
          reason: 'r',
          undoTop: 1,
          undoTopActorId: staffer,
          createdAt: now - 20 * 86_400_000,
        });
        await ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `x${i}`,
          reason: 'r',
          undoesActionId: root,
          undoRoot: root,
          undoDepth: 1,
          createdAt: now - 1_000,
        });
      }
      for (let i = 0; i < filings; i++) {
        const flag = await ctx.db.insert('contentFlags', {
          flaggerId: viewerId,
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'spam',
          status: 'actioned',
          subjectUserId: null,
          createdAt: now - 86_400_000,
        });
        await ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'resolve_flag',
          targetType: 'contentFlag',
          targetId: flag,
          reason: 'r',
          createdAt: now - 1_000,
        });
      }
    });
    // With `opening`, the request's budget opens that small: what a tighter request leaves.
    const read = (ticks: number[] = [0], opening?: number) =>
      t.run(async (raw) => {
        const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
        const { ctx, stats } = counted(raw, ticks);
        if (opening !== undefined) requestBudget(ctx, opening);
        const figures = await staffStatsPage(ctx, viewer, { userId: staffer, now });
        return { figures, stats };
      });
    return { ...(await read()), read };
  };

  test('a week of 200 undos and 200 filings to read costs a stated number of rounds, not one per row', async () => {
    const busy = await week(200, 200);
    const quiet = await week(20, 20);
    console.log(
      `Staff figures rounds: 200+200 reads ${busy.stats.rounds} rounds / ${busy.stats.calls} calls; 20+20 ${quiet.stats.rounds} / ${quiet.stats.calls}`,
    );
    expect(busy.figures?.decisions.undoneByOthers.capped).toBe(false);
    expect(busy.figures?.timeToDecide).toMatchObject({ decided: 200, capped: false });
    expect(busy.stats.rounds).toBeLessThanOrEqual(STAFF_FIGURES_ROUNDS);
    // The same figures whatever order the reads settle in.
    expect((await busy.read([6, 0, 3, 5, 1, 4, 2])).figures).toEqual(busy.figures);
  });

  test('a first row since gone judges its undo on its own (it stands); a root in the read is never read again; a gone flag is unrecorded, not capped', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const staffer = await admin(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(staffer, { role: 'moderator' });
      const row = (fields: Partial<Omit<Doc<'moderationActions'>, '_id' | '_creationTime'>>) =>
        ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: 'x',
          reason: 'r',
          createdAt: now - 1_000,
          ...fields,
        });
      // The staffer's undo of a first row someone else wrote, since erased.
      const gone = await row({ actorId: viewerId, undoTop: 1, undoTopActorId: staffer });
      await row({ undoesActionId: gone, undoRoot: gone, undoDepth: 1 });
      await ctx.db.delete(gone);
      // Their own change and their own undo of it: the first row is in the read.
      const own = await row({ targetId: 'y', undoTop: 1, undoTopActorId: staffer });
      await row({ targetId: 'y', undoesActionId: own, undoRoot: own, undoDepth: 1 });
      // A change the viewer undid: undone by someone else.
      await row({ targetId: 'z', undoTop: 1, undoTopActorId: viewerId });
      // A decision on a flag since deleted: its filing time can't be told.
      const flag = await ctx.db.insert('contentFlags', {
        flaggerId: viewerId,
        targetType: 'report',
        targetId: 'r',
        reason: 'spam',
        status: 'actioned',
        subjectUserId: null,
        createdAt: now - 86_400_000,
      });
      await row({ action: 'resolve_flag', targetType: 'contentFlag', targetId: flag });
      await ctx.db.delete(flag);
    });
    const figures = await t.run(async (raw) => {
      const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
      return staffStatsPage(counted(raw).ctx, viewer, { userId: staffer, now });
    });
    expect(figures?.decisions.undoneByOthers).toMatchObject({ count: 1, capped: false });
    expect(figures?.timeToDecide).toEqual({ medianMs: null, decided: 1, capped: false });
  });

  test('with no room left for a root, the undos say capped — never a throw — and the filings still read', async () => {
    const { figures, read } = await week(3, 2);
    expect(figures?.decisions.undoneByOthers).toMatchObject({ count: 0, capped: false });
    const tight = await read([0], STAFF_PAGE_FIXED + DOC_MAX - 1);
    expect(tight.figures?.decisions.undoneByOthers).toMatchObject({ count: 0, capped: true });
    expect(tight.figures?.timeToDecide).toMatchObject({ decided: 2, capped: false });
    expect(tight.figures?.tenureCapped).toBe(true);
  });

  test('the roots a page reads stop in page order, at the limit or the budget — the same whatever order reads settle in', async () => {
    const t = harness();
    const actor = await admin(t);
    const { rows, sizes } = await t.run(async (ctx) => {
      const rows: Doc<'moderationActions'>[] = [];
      const sizes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const fields = {
          actorId: actor,
          action: 'set_posting_permission' as const,
          targetType: 'user' as const,
          targetId: `x${i}`,
          reason: 'r',
          createdAt: NOW,
        };
        const root = await ctx.db.insert('moderationActions', fields);
        sizes.push(getDocumentSize((await ctx.db.get(root)) as never));
        const undo = await ctx.db.insert('moderationActions', {
          ...fields,
          undoesActionId: root,
          undoRoot: root,
          undoDepth: 1,
        });
        rows.push((await ctx.db.get(undo)) as Doc<'moderationActions'>);
      }
      return { rows, sizes };
    });
    const read = (ticks: number[], bytes: number, limit: number) =>
      t.run(async (raw) => {
        const { ctx } = counted(raw, ticks);
        const { rootOf, reads } = await readRoots(ctx, new ReadBudget(bytes), [], rows, limit);
        return { found: rows.map((r) => rootOf(r)?._id ?? null), reads };
      });
    const roots = rows.map((r) => r.undoRoot ?? null);
    // Room for one root at its worst and the first two as they weigh: three read, then none.
    const tight = DOC_MAX + (sizes[0] as number) + (sizes[1] as number);
    const calm = await read([0], tight, Number.POSITIVE_INFINITY);
    expect(calm).toEqual({ found: [...roots.slice(0, 3), null, null, null], reads: 3 });
    expect(await read([5, 0, 3, 1, 4, 2], tight, Number.POSITIVE_INFINITY)).toEqual(calm);
    // The limit, on a whole budget: the first two.
    expect(await read([0], CHARGED_QUERY_BUDGET, 2)).toEqual({
      found: [...roots.slice(0, 2), null, null, null, null],
      reads: 2,
    });
  });
});

describe('a staffer’s season’s rounds (B01-4c)', () => {
  test('a season of 100 hides each restored by someone else: every one counted, in a stated few rounds', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const staffer = await admin(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(staffer, { role: 'moderator' });
      for (let i = 0; i < 100; i++) {
        const hide = await ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'hide',
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'r',
          createdAt: now - 2_000,
        });
        const restore = await ctx.db.insert('moderationActions', {
          actorId: viewerId,
          action: 'restore',
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'r',
          createdAt: now - 1_000,
        });
        await ctx.db.insert('contentVerdicts', {
          subjectUserId: viewerId,
          targetType: 'report',
          targetId: `r${i}`,
          actionId: hide,
          kind: 'hidden',
          at: now - 2_000,
          standing: false,
          endedAt: now - 1_000,
          endedByActionId: restore,
        });
      }
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
        const { ctx, stats } = counted(raw, ticks);
        const season = await staffSeasonPage(ctx, viewer, { userId: staffer, now });
        return { season, stats };
      });
    const calm = await read([0]);
    console.log(
      `Season rounds: 100 reversals ${calm.stats.rounds} rounds / ${calm.stats.calls} calls`,
    );
    expect(calm.season?.overturned).toEqual({ count: 100, capped: false });
    expect(calm.stats.rounds).toBeLessThanOrEqual(SEASON_ROUNDS);
    expect((await read([5, 0, 3, 6, 1, 4, 2])).season).toEqual(calm.season);
  });

  test('a season of 100 hides the staffer restored themselves: the restores are in hand, never read again', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const staffer = await admin(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(staffer, { role: 'moderator' });
      for (let i = 0; i < 100; i++) {
        const hide = await ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'hide',
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'r',
          createdAt: now - 2_000,
        });
        const restore = await ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'restore',
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'r',
          createdAt: now - 1_000,
        });
        await ctx.db.insert('contentVerdicts', {
          subjectUserId: viewerId,
          targetType: 'report',
          targetId: `r${i}`,
          actionId: hide,
          kind: 'hidden',
          at: now - 2_000,
          standing: false,
          endedAt: now - 1_000,
          endedByActionId: restore,
        });
      }
      // And one undo whose chain's first row is someone else's: its root is read, and kept.
      const root = await ctx.db.insert('moderationActions', {
        actorId: viewerId,
        action: 'set_posting_permission',
        targetType: 'user',
        targetId: 'x',
        reason: 'r',
        undoTop: 1,
        undoTopActorId: staffer,
        createdAt: now - 3_000,
      });
      await ctx.db.insert('moderationActions', {
        actorId: staffer,
        action: 'set_posting_permission',
        targetType: 'user',
        targetId: 'x',
        reason: 'r',
        undoesActionId: root,
        undoRoot: root,
        undoDepth: 1,
        createdAt: now - 500,
      });
    });
    const { season, stats } = await t.run(async (raw) => {
      const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
      const { ctx, stats } = counted(raw);
      return { season: await staffSeasonPage(ctx, viewer, { userId: staffer, now }), stats };
    });
    expect(season?.overturned).toEqual({ count: 0, capped: false });
    // The reads before them, the one root, the verdicts: no wave of restores read a second time.
    expect(stats.rounds).toBeLessThanOrEqual(SEASON_ROUNDS - Math.ceil(100 / 4));
  });

  /** A staffer's hide whose verdict someone else's `ending` row ended. */
  const endedHide = async (
    ctx: MutationCtx,
    staffer: Id<'profiles'>,
    subject: Id<'profiles'>,
    target: string,
    at: number,
    ending: Partial<Omit<Doc<'moderationActions'>, '_id' | '_creationTime'>>,
  ) => {
    const hide = await ctx.db.insert('moderationActions', {
      actorId: staffer,
      action: 'hide',
      targetType: 'report',
      targetId: target,
      reason: 'r',
      createdAt: at,
    });
    const ended = await ctx.db.insert('moderationActions', {
      actorId: subject,
      action: 'restore',
      targetType: 'report',
      targetId: target,
      reason: 'r',
      createdAt: at + 500,
      ...ending,
    });
    await ctx.db.insert('contentVerdicts', {
      subjectUserId: subject,
      targetType: 'report',
      targetId: target,
      actionId: hide,
      kind: 'hidden',
      at,
      standing: false,
      endedAt: at + 500,
      endedByActionId: ended,
    });
  };

  test('with no room left for the rows that ended the verdicts, the season counts up to the first it can’t check and says capped — the same whatever order reads settle in', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const staffer = await admin(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(staffer, { role: 'moderator' });
      // Oldest, so last: the staffer's undo of a row the viewer wrote — its root a read away.
      const root = await ctx.db.insert('moderationActions', {
        actorId: viewerId,
        action: 'set_posting_permission',
        targetType: 'user',
        targetId: 'x',
        reason: 'r',
        undoTop: 1,
        undoTopActorId: staffer,
        createdAt: now - 5_000,
      });
      await ctx.db.insert('moderationActions', {
        actorId: staffer,
        action: 'set_posting_permission',
        targetType: 'user',
        targetId: 'x',
        reason: 'r',
        undoesActionId: root,
        undoRoot: root,
        undoDepth: 1,
        createdAt: now - 4_000,
      });
      for (let i = 0; i < 3; i++) await endedHide(ctx, staffer, viewerId, `r${i}`, now - 3_000, {});
      // Newer, so first: two decisions the viewer undid, answered from the rows alone.
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert('moderationActions', {
          actorId: staffer,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `u${i}`,
          reason: 'r',
          undoTop: 1,
          undoTopActorId: viewerId,
          createdAt: now - 500,
        });
      }
    });
    const read = (ticks: number[], left: number) =>
      t.run(async (raw) => {
        const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
        const { ctx } = counted(raw, ticks);
        requestBudget(ctx, STAFF_PAGE_FIXED + left);
        return staffSeasonPage(ctx, viewer, { userId: staffer, now });
      });
    // The verdicts (small) fit; not one audit row at its worst does — no root, no ending.
    const calm = await read([0], DOC_MAX - 1);
    expect(calm?.overturned).toEqual({ count: 2, capped: true });
    expect(await read([3, 0, 2, 1], DOC_MAX - 1)).toEqual(calm);
    // Not even a verdict fits: the same two, then capped.
    expect((await read([0], ROW_MAX.verdict - 1))?.overturned).toEqual({ count: 2, capped: true });
  });

  test('a reversal whose own first row is gone is judged on its own (it stands); an ending that reverses nothing is no reversal', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const staffer = await admin(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(staffer, { role: 'moderator' });
      const gone = await ctx.db.insert('moderationActions', {
        actorId: viewerId,
        action: 'hide',
        targetType: 'report',
        targetId: 'r0',
        reason: 'r',
        createdAt: now - 9_000,
      });
      await ctx.db.delete(gone);
      // A restore two deep in a chain whose first row was erased: nothing known above it.
      await endedHide(ctx, staffer, viewerId, 'r0', now - 3_000, {
        undoesActionId: gone,
        undoRoot: gone,
        undoDepth: 2,
      });
      // A verdict ended by a removal, which reverses nothing.
      await endedHide(ctx, staffer, viewerId, 'r1', now - 2_000, { action: 'remove' });
    });
    const season = await t.run(async (raw) => {
      const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
      return staffSeasonPage(counted(raw).ctx, viewer, { userId: staffer, now });
    });
    expect(season?.overturned).toEqual({ count: 1, capped: false });
  });
});

describe('a queue lane’s people’s rounds (B01-4c)', () => {
  test('the 200 people a queue names are read in one round, in the queue’s order', async () => {
    const t = harness();
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < 200; i++) ids.push(await admin(t));
    await t.run(async (ctx) => {
      // Every other person has a People row; the rest can't be listed yet.
      for (const [i, id] of ids.entries()) if (i % 2 === 0) await refreshPersonRow(ctx, id);
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const { ctx, stats } = counted(raw, ticks);
        const { rows, missing } = await listablePeople(ctx, ids);
        return { users: rows.map((r) => r.userId), missing, stats };
      });
    const calm = await read([0]);
    expect(calm.users).toEqual(ids.filter((_, i) => i % 2 === 0));
    expect(calm.missing).toBe(true);
    expect(calm.stats.rounds).toBe(1);
    const shuffled = await read([5, 0, 3, 6, 1, 4, 2]);
    expect({ users: shuffled.users, missing: shuffled.missing }).toEqual({
      users: calm.users,
      missing: calm.missing,
    });
  });

  test('past the budget, the queue’s later people read as missing, in its order — never a throw', async () => {
    const t = harness();
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < 10; i++) ids.push(await admin(t));
    const sizes = await t.run(async (ctx) => {
      const out: number[] = [];
      for (const id of ids) {
        await refreshPersonRow(ctx, id);
        const row = await ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', id))
          .first();
        out.push(getDocumentSize(row as never));
      }
      return out;
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const { ctx } = counted(raw, ticks);
        // Room for one row at its worst and the first three as they weigh: four read, then none.
        requestBudget(ctx, ROW_MAX.personRow + sizes.slice(0, 3).reduce((a, b) => a + b, 0));
        const { rows, missing } = await listablePeople(ctx, ids);
        return { users: rows.map((r) => r.userId), missing };
      });
    const calm = await read([0]);
    expect(calm).toEqual({ users: ids.slice(0, 4), missing: true });
    expect(await read([3, 0, 2, 1])).toEqual(calm);
  });
});

describe('the person page’s flag labels’ rounds (B01-4c)', () => {
  test('twenty flagged Reports on twenty lakes, on a whole request budget: every one labeled, in a stated few rounds', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const skater = await admin(t);
    const flags = await t.run(async (ctx) => {
      const out = [];
      for (let i = 0; i < 20; i++) {
        const body = await ctx.db.insert('waterBodies', {
          name: `Lake ${i}`,
          searchText: `lake ${i}`,
          type: 'lakePond',
          source: 'osm',
          polygon: POLYGON,
          bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
          centroid: { lat: 44, lng: -72 },
          dedupStatus: 'clean',
          createdAt: NOW,
        });
        await rebuildBodyLibrary(ctx, body);
        const report = await ctx.db.insert('reports', {
          authorId: skater,
          waterBodyId: body,
          point: { lat: 44, lng: -72 },
          skateEndTime: NOW,
          reportTime: NOW,
          source: 'native',
          iceTypes: [{ type: 'black_ice' }],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: NOW,
          updatedAt: NOW,
        });
        const flagId = await ctx.db.insert('contentFlags', {
          flaggerId: viewerId,
          targetType: 'report',
          targetId: report,
          reason: 'spam',
          status: 'open',
          subjectUserId: skater,
          createdAt: NOW + i,
        });
        out.push({
          flagId,
          reason: 'spam' as const,
          targetType: 'report' as const,
          targetId: report as string,
          status: 'open' as const,
          createdAt: NOW + i,
        });
      }
      return out;
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const person = (await raw.db.get(skater)) as Doc<'profiles'>;
        const { ctx, stats } = counted(raw, ticks);
        const mine: Array<(typeof flags)[number] & { targetLabel?: string }> = flags.map((f) => ({
          ...f,
        }));
        const capped = await labelFlags(
          ctx,
          requestBudget(ctx, CHARGED_QUERY_BUDGET),
          person,
          mine,
        );
        return { capped, labels: mine.map((f) => f.targetLabel ?? null), stats };
      });
    const calm = await read([0]);
    console.log(
      `Flag label rounds: 20 lakes ${calm.stats.rounds} rounds / ${calm.stats.calls} calls`,
    );
    expect(calm.capped).toBe(false);
    expect(calm.labels).toEqual(flags.map((_, i) => `Lake ${i}`));
    expect(calm.stats.rounds).toBeLessThanOrEqual(FLAG_LABEL_ROUNDS_WHOLE_BUDGET);
    const shuffled = await read([5, 0, 3, 6, 1, 4, 2]);
    expect({ capped: shuffled.capped, labels: shuffled.labels }).toEqual({
      capped: calm.capped,
      labels: calm.labels,
    });
  });

  test('every kind of flagged thing finds its lake within its declared reads — even a lake named “over”', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const skater = await admin(t);
    const flags = await t.run(async (ctx) => {
      const body = await ctx.db.insert('waterBodies', {
        name: 'over',
        searchText: 'over',
        type: 'lakePond',
        source: 'osm',
        polygon: POLYGON,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        dedupStatus: 'clean',
        createdAt: NOW,
      });
      await rebuildBodyLibrary(ctx, body);
      const report = await ctx.db.insert('reports', {
        authorId: skater,
        waterBodyId: body,
        point: { lat: 44, lng: -72 },
        skateEndTime: NOW,
        reportTime: NOW,
        source: 'native',
        iceTypes: [{ type: 'black_ice' }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const comment = await ctx.db.insert('comments', {
        reportId: report,
        authorId: skater,
        body: 'a comment',
        source: 'native',
        moderationStatus: 'visible',
        createdAt: NOW,
      });
      const photo = await ctx.db.insert('photos', {
        storageId: 'full',
        thumbStorageId: 'thumb',
        uploaderId: skater,
        placeOnMap: false,
        reportId: report,
        createdAt: NOW,
      });
      const hazard = await ctx.db.insert('hazards', {
        waterBodyId: body,
        type: 'pressure_ridge',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [-72, 44] },
        radiusMeters: 30,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        createdByUserId: skater,
        description: 'a ridge',
        photoIds: [],
        status: 'active',
        moderationStatus: 'visible',
        firstReportedAt: NOW,
        lastConfirmedAt: NOW,
        confirmCount: 0,
        goneCount: 0,
        createdAt: NOW,
      });
      const alert = await ctx.db.insert('accessAlerts', {
        targetType: 'put_in',
        waterBodyId: body,
        reason: 'not_plowed',
        kind: 'blocker',
        createdByUserId: skater,
        createdAt: NOW,
        season: 2026,
        status: 'expired',
        confirmCount: 0,
        denyCount: 0,
      });
      const post = await ctx.db.insert('posts', {
        authorId: skater,
        reportIds: [report],
        photoIds: [],
        latestSkateEndTime: NOW,
        moderationStatus: 'visible',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const targets = [
        ['waterbody', body],
        ['report', report],
        ['post', post],
        ['comment', comment],
        ['photo', photo],
        ['hazard', hazard],
        ['accessAlert', alert],
      ] as const;
      const out = [];
      for (const [i, [targetType, targetId]] of targets.entries()) {
        const flagId = await ctx.db.insert('contentFlags', {
          flaggerId: viewerId,
          targetType,
          targetId,
          reason: 'spam',
          status: 'open',
          subjectUserId: skater,
          createdAt: NOW + i,
        });
        out.push({
          flagId,
          reason: 'spam' as const,
          targetType,
          targetId: targetId as string,
          status: 'open' as const,
          createdAt: NOW + i,
        });
      }
      return out;
    });
    const { capped, labels } = await t.run(async (raw) => {
      const person = (await raw.db.get(skater)) as Doc<'profiles'>;
      const { ctx } = counted(raw);
      const mine: Array<(typeof flags)[number] & { targetLabel?: string }> = flags.map((f) => ({
        ...f,
      }));
      const capped = await labelFlags(ctx, requestBudget(ctx, CHARGED_QUERY_BUDGET), person, mine);
      return { capped, labels: mine.map((f) => f.targetLabel ?? null) };
    });
    expect(capped).toBe(false);
    expect(labels).toEqual(flags.map(() => 'over'));
  });

  test('past the budget, a flag it can’t reach is unlabeled and said so — a lake’s name read once for every flag on it, the same whatever order reads settle in', async () => {
    const t = harness();
    const viewerId = await admin(t);
    const skater = await admin(t);
    const { flags, bytes } = await t.run(async (ctx) => {
      const lakes: Id<'waterBodies'>[] = [];
      for (const name of ['Lake A', 'Lake B', 'Lake C']) {
        const body = await ctx.db.insert('waterBodies', {
          name,
          searchText: name.toLowerCase(),
          type: 'lakePond',
          source: 'osm',
          polygon: POLYGON,
          bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
          centroid: { lat: 44, lng: -72 },
          dedupStatus: 'clean',
          createdAt: NOW,
        });
        await rebuildBodyLibrary(ctx, body);
        lakes.push(body);
      }
      const [a, b, c] = lakes as [Id<'waterBodies'>, Id<'waterBodies'>, Id<'waterBodies'>];
      const report = await ctx.db.insert('reports', {
        authorId: skater,
        waterBodyId: a,
        point: { lat: 44, lng: -72 },
        skateEndTime: NOW,
        reportTime: NOW,
        source: 'native',
        iceTypes: [{ type: 'black_ice' }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      // The three lakes themselves (no read on the way), then a Report on the first.
      const targets = [
        ['waterbody', a],
        ['waterbody', b],
        ['waterbody', c],
        ['report', report],
      ] as const;
      const out = [];
      for (const [i, [targetType, targetId]] of targets.entries()) {
        const flagId = await ctx.db.insert('contentFlags', {
          flaggerId: viewerId,
          targetType,
          targetId,
          reason: 'spam',
          status: 'open',
          subjectUserId: skater,
          createdAt: NOW + i,
        });
        out.push({
          flagId,
          reason: 'spam' as const,
          targetType,
          targetId: targetId as string,
          status: 'open' as const,
          createdAt: NOW + i,
        });
      }
      const nameRow = await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', a).eq('scope', SCOPE_ALL))
        .first();
      // Room for the Report at its worst and as it weighs, Lake A's name as it weighs, and one
      // more name at its worst: Lake A and Lake B are named, Lake C is past the budget.
      const weight = (doc: unknown) => getDocumentSize(doc as never);
      return {
        flags: out,
        bytes: DOC_MAX + weight(await ctx.db.get(report)) + weight(nameRow) + 1,
      };
    });
    const read = (ticks: number[]) =>
      t.run(async (raw) => {
        const person = (await raw.db.get(skater)) as Doc<'profiles'>;
        const { ctx } = counted(raw, ticks);
        const mine: Array<(typeof flags)[number] & { targetLabel?: string }> = flags.map((f) => ({
          ...f,
        }));
        const capped = await labelFlags(ctx, new ReadBudget(bytes), person, mine);
        return { capped, labels: mine.map((f) => f.targetLabel ?? null) };
      });
    const calm = await read([0]);
    // The Report on Lake A is labeled though Lake C, before it, was not: its lake's name was read.
    expect(calm).toEqual({ capped: true, labels: ['Lake A', 'Lake B', null, 'Lake A'] });
    expect(await read([3, 0, 2, 1])).toEqual(calm);
  });
});

/** The rounds a page of History costs when its rows share their targets (stated, B01-3h). */
const PAGE_ROUNDS = 8;
/**
 * The rounds the worst page costs: 46 refusals (45 distinct landmarks and the body), each reading a
 * row of at most a document's weight — `PAGE_ROUNDS` plus one per wave. The first wave reserves four
 * worst cases inside the page's 4 MiB; every later one three, since what the earlier waves really
 * read stays spent.
 */
const WORST_PAGE_ROUNDS = PAGE_ROUNDS + 1 + Math.ceil((46 - 4) / 3);

/**
 * The rounds a page of People's Decisions costs when its rows share their target: History's, since
 * its rows are shaped the same way — the page's own read before them adds no round of its own.
 */
const DECISIONS_PAGE_ROUNDS = PAGE_ROUNDS;
/** The worst Decisions page: the worst History page's rounds (46 refusals, in waves). */
const DECISIONS_WORST_ROUNDS = WORST_PAGE_ROUNDS;

/**
 * The rounds a staffer's figures cost on a week of 200 undos whose first rows lie outside the week's
 * read and 200 filings to look up (the time bound's 400 reads): the reads before them, then the roots
 * in waves — each an audit row, reserved at a document's worth, four to a wave in what the week's own
 * read (4 MiB and a document) and the staffer's profile leave — then the filings, small enough to go
 * in a wave or two. Read one after another, the same week was over 400 rounds.
 */
const STAFF_FIGURES_ROUNDS = 8 + Math.ceil(200 / 4);

/**
 * The rounds `labelFlags` costs for twenty flagged Reports on twenty lakes **on a whole request
 * budget** (the 11 MiB a People query opens with): first every flag's Report, reserved at a
 * document's worth, ten or eleven to a wave; then the twenty lakes' names, likewise — a round a
 * wave. One after another it was forty. On the person page `labelFlags` runs after the page's other
 * reads (about 3.5 to 5.5 MiB left in the People tests), so three to five go to a wave there and the
 * rounds are more — still a round a wave; this bound claims only the whole-budget case it measures.
 */
const FLAG_LABEL_ROUNDS_WHOLE_BUDGET = Math.ceil(20 / 10) + Math.ceil(20 / 10);

/**
 * The rounds a staffer's season costs when 100 of its decisions were each reversed by someone else:
 * the reads before them, then a step at a time for every row together — the verdicts (small: one
 * wave), the rows that ended them (an audit row each, reserved at a document's worth, so four or five
 * to a wave in what the season's own read leaves). One row after another it was over 200: a verdict
 * and the row that ended it, each.
 */
const SEASON_ROUNDS = 8 + 1 + Math.ceil(100 / 4);

/**
 * What a staffer's figures or season charge before their per-row reads, for a test that opens the
 * request's budget smaller: the staffer's profile, the backfill marker (four small rows), and the
 * decisions' own read (4 MiB of real weight, charged with a document over).
 */
const STAFF_PAGE_FIXED = ROW_MAX.profile + 4 * ROW_MAX.small + 5 * DOC_MAX;
