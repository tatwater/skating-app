/**
 * D258's chains on an adversarial page, under Convex's real transaction limits: every row as heavy as
 * an uncapped field lets it be. Each walk asks the transaction's real metrics before every item and
 * runs the item under limits of its own, so a pass stops and continues rather than reading past the
 * limit — no pass may throw, none may stall, and each must leave what it is for.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';
import { forgetGoneMirrors } from './lib/recurringWork';
import { recordQueueFailure } from './notifications';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2027, 0, 14, 15);
/** Near the document limit: what an uncapped field can weigh. */
const HEAVY = 'h'.repeat(1000 * 1024);

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

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const harness = () => convexTest({ schema, modules, transactionLimits: true });

/** A profile whose bio is near the document limit. */
async function heavyUser(t: T, subject: string, role: 'member' | 'admin' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      bio: HEAVY,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: T): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

/** Run the chain out; then nothing it scheduled may have failed. */
async function runOut(t: T, start: () => Promise<unknown>) {
  await start();
  await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
  const failed = (
    await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
  ).filter((j) => j.state.kind === 'failed');
  expect(failed.map((j) => j.name)).toEqual([]);
}

describe('D258 chains under real limits', () => {
  test('the orphan walk: thirty photos near the document limit, half in use — the lap reaches its end and the orphans go', async () => {
    const t = harness();
    const { id: uploader } = await heavyUser(t, 'uploader');
    const waterBodyId = await seedBody(t);
    const old = Date.now() - PHOTO_ORPHAN_GRACE_MS - DAY;
    const reportId = await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: uploader,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: old,
        reportTime: old,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: old,
        updatedAt: old,
      }),
    );
    const orphans: Id<'photos'>[] = [];
    for (let i = 0; i < 30; i++) {
      const id = await t.run(async (ctx) =>
        ctx.db.insert('photos', {
          storageId: await ctx.storage.store(new Blob([`p${i}`])),
          thumbStorageId: await ctx.storage.store(new Blob([`t${i}`])),
          uploaderId: uploader,
          caption: HEAVY,
          placeOnMap: false,
          ...(i % 2 === 0 ? { reportId } : {}),
          createdAt: old + i,
        }),
      );
      if (i % 2 === 1) orphans.push(id);
    }
    await runOut(t, () => t.mutation(internal.storageHygiene.sweepOrphanPhotos, {}));
    for (const id of orphans) expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    const left = await t.run((ctx) =>
      ctx.db
        .query('photos')
        .withIndex('by_report', (q) => q.eq('reportId', reportId))
        .collect(),
    );
    expect(left).toHaveLength(15);
    expect((await t.run((ctx) => ctx.db.query('jobPositions').first()))?.lapsCompleted).toBe(1);
  }, 180_000);

  test('the flush, one row at a time: twenty recipients near the document limit after a batch that fails — every row lands', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    const rows: Id<'notificationQueue'>[] = [];
    for (let i = 0; i < 20; i++) {
      const { id } = await heavyUser(t, `fan${i}`);
      rows.push(
        await t.run((ctx) =>
          ctx.db.insert('notificationQueue', {
            userId: id,
            waterBodyId,
            kind: 'favorite' as const,
            type: 'favorite_report' as const,
            coalesceKey: `${id}:${waterBodyId}:favorite`,
            count: 1,
            flushAfter: Date.now() - 1,
            createdAt: Date.now() - 1,
          }),
        ),
      );
    }
    // Twenty heavy profiles is past the batch's own limits: the batch fails as a batch, and the
    // one-by-one path delivers each, passes stopping and continuing as the real budget runs down.
    await runOut(t, () => t.mutation(internal.notifications.flushNotificationQueue, {}));
    for (const id of rows) expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toHaveLength(20);
  }, 180_000);

  test('the prompt sweep: twelve skaters near the document limit, each with a recording near it — every one is asked', async () => {
    const t = harness();
    const rows: Id<'gpsActivities'>[] = [];
    for (let i = 0; i < 12; i++) {
      const { id } = await heavyUser(t, `skater${i}`);
      rows.push(
        await t.run((ctx) =>
          ctx.db.insert('gpsActivities', {
            userId: id,
            provider: 'native' as const,
            providerActivityId: `s${i}`,
            sportType: HEAVY,
            startTime: T0 - 10 * DAY + i * DAY,
            promptState: 'pending' as const,
            detectedAt: T0 - 5 * HOUR - i,
          }),
        ),
      );
    }
    await runOut(t, () => t.mutation(internal.gpsActivities.sweepUnpromptedActivities, {}));
    for (const id of rows) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.promptState).toBe('prompted');
    }
  }, 180_000);

  test('the card sweep: cards whose windows hold Reports near the document limit — the sweep stops and continues, and every card refreshes', async () => {
    const t = harness();
    // The one-time full walk, done on an empty corpus, so the hourly tick reads due rows only.
    await t.action(internal.waterBodies.sweepAllBodySummaries, {});
    const { id: author } = await heavyUser(t, 'author');
    const bodies: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await seedBody(t);
      bodies.push(id);
      for (let r = 0; r < 4; r++) {
        await t.run((ctx) =>
          ctx.db.insert('reports', {
            authorId: author,
            waterBodyId: id,
            point: { lat: 0.5, lng: 0.5 },
            skateEndTime: Date.now() - DAY,
            reportTime: Date.now() - DAY,
            source: 'native' as const,
            iceTypes: [],
            surfaceTags: [],
            photoIds: [],
            notes: HEAVY,
            moderationStatus: 'visible' as const,
            hazardIdsCreated: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        );
      }
      await t.run((ctx) =>
        ctx.db.insert('bodySummaryRefreshes', { waterBodyId: id, refreshAt: Date.now() - 1 }),
      );
    }
    const result = await t.action(internal.waterBodies.sweepDueBodySummaries, {});
    expect(result).toMatchObject({ mode: 'due', refreshed: 6 });
    expect(result.batches).toBeGreaterThan(1);
    for (const id of bodies) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.summary?.recentReportCount).toBe(4);
    }
  }, 180_000);

  test('the Machinery read: fourteen parked queue rows near the document limit — it reads only their small mirrors', async () => {
    const t = harness();
    const admin = await heavyUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    for (let i = 0; i < 14; i++) {
      const row = await t.run((ctx) =>
        ctx.db.insert('notificationQueue', {
          userId: admin.id,
          waterBodyId,
          kind: 'favorite' as const,
          type: 'favorite_report' as const,
          coalesceKey: HEAVY.slice(0, 900 * 1024) + i,
          count: 1,
          flushAfter: T0,
          firstDueAt: T0,
          createdAt: T0,
        }),
      );
      for (let k = 0; k < 3; k++) {
        await t.run(async (ctx) => {
          const r = await ctx.db.get(row);
          if (r) await recordQueueFailure(ctx, r, 'Error', T0, {});
        });
      }
    }
    const health = await admin.as.query(api.recurringJobs.health, { now: T0 });
    expect(health.jobs.find((j) => j.job === 'flush notification queue')).toMatchObject({
      parked: 14,
      capped: false,
    });
  }, 180_000);

  test('the forget step at the end of a spent pass: ten checks of heavy rows stop at the budget, never past the limit', async () => {
    const t = harness();
    const { id: userId } = await heavyUser(t, 'mirrored');
    const waterBodyId = await seedBody(t);
    const rows: Id<'notificationQueue'>[] = [];
    for (let i = 0; i < 20; i++) {
      const row = await t.run((ctx) =>
        ctx.db.insert('notificationQueue', {
          userId,
          waterBodyId,
          kind: 'favorite' as const,
          type: 'favorite_report' as const,
          coalesceKey: HEAVY.slice(0, 900 * 1024) + i,
          count: 1,
          flushAfter: T0,
          firstDueAt: T0,
          createdAt: T0,
        }),
      );
      rows.push(row);
      await t.run(async (ctx) => {
        const r = await ctx.db.get(row);
        if (r) await recordQueueFailure(ctx, r, 'Error', T0, {});
      });
    }
    const forgotten = await t.run(async (ctx) => {
      // The pass's own items have spent most of its budget: ten heavy rows (about 9 MiB) read.
      for (const id of rows.slice(10)) await ctx.db.get(id);
      // Ten more at about 0.9 MiB each would pass the 16 MiB limit and fail the whole pass.
      return forgetGoneMirrors(ctx, 'notifications', 10, async (key) => {
        const id = ctx.db.normalizeId('notificationQueue', key);
        const row = id ? await ctx.db.get(id) : null;
        return row?.attempts !== undefined;
      });
    });
    expect(forgotten).toBe(0);
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toHaveLength(20);
  }, 180_000);
});

/** An outline near the document limit: a ring of tens of thousands of points around the unit square. */
let heavyRing: { type: 'Polygon'; coordinates: [number, number][][] } | undefined;
function heavyPolygon() {
  if (heavyRing) return heavyRing;
  const n = 40_000;
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push([0.5 + 0.4 * Math.cos(a), 0.5 + 0.4 * Math.sin(a)]);
  }
  ring.push(ring[0] as [number, number]);
  heavyRing = { type: 'Polygon' as const, coordinates: [ring] };
  return heavyRing;
}

async function heavyBody(t: T, i: number): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: `Heavy ${i}`,
      searchText: `Heavy ${i}`,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: heavyPolygon(),
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5 + i * 0.3, lng: 0.5 + i * 0.3 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

describe('D258 walks whose every document is at the document limit', () => {
  test('the rollover: seven outlines near the limit — pages sized from the heaviest, the walk reaches its end', async () => {
    const t = harness();
    const ids: Id<'waterBodies'>[] = [];
    // Seven: more than two of the three-body pages the heaviest outline sizes a page to.
    for (let i = 0; i < 7; i++) ids.push(await heavyBody(t, i));
    const result = await t.action(internal.standing.runStandingRollover, {
      season: 2029,
      apply: true,
    });
    expect(result).toMatchObject({ scanned: 7, demoted: 7, failed: 0 });
  }, 180_000);

  test('the registry walk: ten outlines near the limit — pages end by weight, every body registered', async () => {
    const t = harness();
    // Ten: more than one 6 MiB page of them.
    for (let i = 0; i < 10; i++) await heavyBody(t, i);
    await runOut(t, () =>
      t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' }),
    );
    const members = await t.run((ctx) => ctx.db.query('bodyWeatherCells').collect());
    expect(members).toHaveLength(10);
  }, 180_000);

  test('the gap walk: forty registered cells near the limit — pages end by weight, the walk reaches its end', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert('weatherCells', {
          cellKey: `${String(i).padStart(3, '0')}:${'k'.repeat(400 * 1024)}`,
          tier: 'filter' as const,
          lat: 44,
          lng: -72,
          bodyCount: 1,
          runId: 'r',
          updatedAt: 0,
        });
      }
    });
    await runOut(t, () =>
      t.action(internal.weatherArchive.sweepWeatherDayGaps, { tier: 'filter' }),
    );
  }, 180_000);

  test('the flush: forty queue rows near the limit — the batch reads by weight and every row lands', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    const { id: fan } = await heavyUser(t, 'fan');
    const rows: Id<'notificationQueue'>[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(
        await t.run((ctx) =>
          ctx.db.insert('notificationQueue', {
            userId: fan,
            waterBodyId,
            kind: 'favorite' as const,
            type: 'favorite_report' as const,
            coalesceKey: `${i}:${'c'.repeat(400 * 1024)}`,
            count: 1,
            flushAfter: Date.now() - 1,
            firstDueAt: Date.now() - 1,
            createdAt: Date.now() - 1,
          }),
        ),
      );
    }
    await runOut(t, () => t.mutation(internal.notifications.flushNotificationQueue, {}));
    for (const id of rows) expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toHaveLength(40);
  }, 180_000);
});
