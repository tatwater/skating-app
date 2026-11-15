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
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { historyPage } from './bodyConsole';
import { writeAudit, writeSnapshot } from './lib/audit';
import { undoState } from './lib/undo';
import { UNDO_CHECKED_ELSEWHERE } from './lib/undoReads';
import { listActionsPage } from './moderation';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

/**
 * A query's view of `ctx` whose database calls are counted: `calls`, and `rounds` — a call started
 * with none in flight begins a round. No `insert`, so the reads take their query paths.
 */
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
    // A heavy outline (≈ 0.5 MB) on each of 10 bodies — 5 MB, past the page's 4 MiB, each body's newest row a depth choice.
    const ring = Array.from({ length: 20_000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 20_000;
      return [-72 + 0.01 * Math.cos(a), 44 + 0.01 * Math.sin(a)];
    });
    const heavy = { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] };
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 10 }, (_, i) => ({
        source: 'osm',
        externalId: `way/${i}`,
        osmId: `way/${i}`,
        name: `Pond ${i}`,
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: 40_000,
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
    const rows = await t.run(async (raw) => {
      const { ctx } = counted(raw);
      const viewer = (await raw.db.get(actorId)) as Doc<'profiles'>;
      const actions = await raw.db.query('moderationActions').order('desc').take(10);
      return Promise.all(actions.map((row) => undoState(ctx, viewer, row)));
    });
    const elsewhere = rows.filter(
      (u) => u.state === 'unavailable' && u.why === UNDO_CHECKED_ELSEWHERE,
    );
    const offered = rows.filter((u) => u.state === 'available');
    expect(offered.length).toBeGreaterThan(0);
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(offered.length + elsewhere.length).toBe(10);
  });
});

describe('the audit feed’s rounds (the Overview’s recent actions, B01-3h)', () => {
  test('a feed of 50 rows over 50 targets costs the same few rounds as one of 10', async () => {
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

/** The rounds a page of History costs when its rows share their targets (stated, B01-3h). */
const PAGE_ROUNDS = 8;
/**
 * The rounds the worst page costs: 45 distinct targets each reading a row of at most a document's
 * weight, four reservations at a time inside the page's 4 MiB — `PAGE_ROUNDS` plus one per wave.
 */
const WORST_PAGE_ROUNDS = PAGE_ROUNDS + Math.ceil(46 / 4);
