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

import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { historyPage } from './bodyConsole';
import { writeAudit, writeSnapshot } from './lib/audit';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import {
  CHARGED_QUERY_BUDGET,
  DOC_MAX,
  REQUEST_PROFILE_BUDGET,
  requestBudget,
} from './lib/readBudget';
import { UNDO_NEEDS_ROWS, type UndoState, undoStates } from './lib/undo';
import { UNDO_CHECKED_ELSEWHERE } from './lib/undoReads';
import { listActionsPage } from './moderation';
import { decisionsPage, labelFlags, shapeRows, staffStatsPage } from './people';
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
    const read = (ticks: number[] = [0]) =>
      t.run(async (raw) => {
        const viewer = (await raw.db.get(viewerId)) as Doc<'profiles'>;
        const { ctx, stats } = counted(raw, ticks);
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
});

describe('the person page’s flag labels’ rounds (B01-4c)', () => {
  test('twenty flagged Reports on twenty lakes: every one labelled, in a stated few rounds', async () => {
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
    expect(calm.stats.rounds).toBeLessThanOrEqual(FLAG_LABEL_ROUNDS);
    const shuffled = await read([5, 0, 3, 6, 1, 4, 2]);
    expect({ capped: shuffled.capped, labels: shuffled.labels }).toEqual({
      capped: calm.capped,
      labels: calm.labels,
    });
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
 * The rounds the person page's flag labels cost for twenty flagged Reports on twenty lakes: each flag
 * reserves its Report and its lake's library row at a document's worth apiece, so five go in a wave
 * of the request's 11 MiB, and each wave is two rounds (the Report, then the name). One after
 * another it was forty.
 */
const FLAG_LABEL_ROUNDS = 2 * Math.ceil(20 / 5);
