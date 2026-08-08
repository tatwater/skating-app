import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  return t;
}

const BASE_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

/** Covers the seeded body centroid (0.5, 0.5) — used as a viewer's 30-min band. */
const BAND30: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

interface ProfileOpts {
  prefs?: Partial<typeof BASE_PREFS>;
  allRadiusMinutes?: number;
  greatRadiusMinutes?: number;
  inBand?: boolean;
}

async function seedProfile(
  t: ReturnType<typeof convexTest>,
  subject: string,
  opts: ProfileOpts = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      ...(opts.inBand
        ? {
            homeCoord: { lat: 0.5, lng: 0.5 },
            cachedIsochrones: { band30: BAND30 },
            outerRadiusMeters: 50_000,
          }
        : {}),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: { ...BASE_PREFS, ...opts.prefs },
      ...(opts.allRadiusMinutes !== undefined ? { allRadiusMinutes: opts.allRadiusMinutes } : {}),
      ...(opts.greatRadiusMinutes !== undefined
        ? { greatRadiusMinutes: opts.greatRadiusMinutes }
        : {}),
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id: id as Id<'profiles'>, as: t.withIdentity({ subject }) };
}

const POLYGON = {
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
};

async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'osm/1') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: 'Lake Morey',
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return body._id as Id<'waterBodies'>;
}

const SKATE_TIME = Date.UTC(2026, 0, 10);

/** Make every pending queue row due, then flush; returns the delivered `notifications` rows. */
async function flushAllDue(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('notificationQueue').collect()) {
      await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    }
  });
  await t.mutation(internal.notifications.flushNotificationQueue, {});
  return t.run((ctx) => ctx.db.query('notifications').collect());
}

/**
 * Create a report and run its distance fan-out, the way the scheduler does in production (N1).
 * `reports.create` schedules `fanOutNearbyNotifications` rather than walking every profile inline;
 * convex-test won't drive a `runAfter(0)` job without fake timers, so drive it explicitly here.
 * (That the scheduling *happens* is asserted separately, off `_scheduled_functions`.)
 */
async function createReport(
  t: ReturnType<typeof convexTest>,
  as: ReturnType<ReturnType<typeof convexTest>['withIdentity']>,
  args: { waterBodyId: Id<'waterBodies'>; skateEndTime: number; skateQuality?: string },
) {
  const reportId = await as.mutation(api.reports.create, args as never);
  await t.mutation(internal.notifications.fanOutNearbyNotifications, { reportId });
  return reportId;
}

describe('notifications — favorites', () => {
  test('a favorited-body report enqueues for the favoriter, not the author, and coalesces', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const fan = await seedProfile(t, 'fan');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME + 1 });

    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1); // coalesced into one row
    expect(queue[0]?.userId).toBe(fan.id);
    expect(queue[0]?.kind).toBe('favorite');
    expect(queue[0]?.count).toBe(2);
  });

  test('the author is never notified about their own favorited body', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await author.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });
    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test('flush delivers an in-app notification carrying the coalesced count + key', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const fan = await seedProfile(t, 'fan');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });
    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const delivered = await flushAllDue(t);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.type).toBe('favorite_report');
    expect(delivered[0]?.userId).toBe(fan.id);
    expect(delivered[0]?.payload.count).toBe(1);
    expect(delivered[0]?.payload.coalesceKey).toContain('favorite');
    // Queue row consumed.
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });
});

describe('notifications — nearby digest (X₁)', () => {
  test('enqueues an in-band digest with a future (8pm) flush time', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await seedProfile(t, 'nearby', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });

    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('digest');
    // Batched to the next 8pm rather than sent now. The margin used to be `now + 1 hour`, which was a
    // proxy for "batched" that quietly depended on the wall clock: the next 8pm is less than an hour
    // away for the whole 7–8pm window in `DIGEST_TIMEZONE`, so the suite failed for one hour a day and
    // passed the other twenty-three. What the test actually means is asserted here and on the two lines
    // below — it isn't due yet, and the immediate flush doesn't deliver it.
    expect(queue[0]?.flushAfter).toBeGreaterThan(Date.now());

    // The immediate cron flush does NOT deliver it (not due yet).
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toEqual([]);
  });

  test('rolls all of a user’s due digest rows into ONE consolidated notification, grouped by body', async () => {
    const t = convexTestWithGeo();
    const bodyA = await seedBody(t, 'osm/1');
    const bodyB = await seedBody(t, 'osm/2');
    const author = await seedProfile(t, 'author');
    const nearby = await seedProfile(t, 'nearby', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });

    // Two reports on body A (coalesce into one queue row) + one on body B → two digest queue rows.
    await createReport(t, author.as, { waterBodyId: bodyA, skateEndTime: SKATE_TIME });
    await createReport(t, author.as, {
      waterBodyId: bodyA,
      skateEndTime: SKATE_TIME + 1,
    });
    await createReport(t, author.as, {
      waterBodyId: bodyB,
      skateEndTime: SKATE_TIME + 2,
    });

    const delivered = await flushAllDue(t);
    // ONE digest for the user, enumerating both bodies — not one notification per lake.
    expect(delivered).toHaveLength(1);
    const digest = delivered[0];
    expect(digest?.type).toBe('nearby_report_digest');
    expect(digest?.userId).toBe(nearby.id);
    expect(digest?.payload.bodies).toHaveLength(2);
    expect(digest?.payload.totalCount).toBe(3); // 2 on A + 1 on B
    expect(digest?.payload.coalesceKey).toBe(`${nearby.id}:digest`);
    // Queue fully drained.
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test("a body out of the viewer's band produces no digest", async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    // Digest on + radius set, but no home/bands → band is null → out of range.
    await seedProfile(t, 'faraway', { prefs: { nearbyReportDigest: true }, allRadiusMinutes: 30 });
    await createReport(t, author.as, { waterBodyId: id, skateEndTime: SKATE_TIME });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });
});

describe('notifications — great nearby (X₂)', () => {
  test('fires only for a great report within the great radius', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await seedProfile(t, 'greatfan', {
      prefs: { greatReportNearby: true },
      greatRadiusMinutes: 30,
      inBand: true,
    });

    // A non-great report → nothing.
    await createReport(t, author.as, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      skateQuality: 'good',
    });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);

    // A great report → one great queue row.
    await createReport(t, author.as, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME + 1,
      skateQuality: 'great',
    });
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('great');
  });
});

describe('notifications — the fan-out is scheduled, not inline (N1)', () => {
  test('reports.create schedules the fan-out instead of walking every profile in the transaction', async () => {
    // The write path used to `collect()` the whole profiles table on every report — an unbounded
    // read inside the app's most important mutation. Now create schedules a paged job.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.map((s) => s.name)).toContain('notifications:fanOutNearbyNotifications');
  });

  test('pages, and schedules its own continuation rather than stopping at the page boundary', async () => {
    // A cap here would mean silently not telling someone about ice near them — the one failure
    // worse than a slow one — so the job continues itself instead. Seed past one page to prove it.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert('profiles', {
          clerkUserId: `bulk${i}`,
          displayName: `bulk${i}`,
          username: `bulk${i}`,
          homeCoord: { lat: 0.5, lng: 0.5 },
          cachedIsochrones: { band30: BAND30 },
          allRadiusMinutes: 30,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: { ...BASE_PREFS, nearbyReportDigest: true },
          dateOfBirth: Date.parse('1990-01-01'),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: Date.now(),
        });
      }
    });
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });

    const first: { isDone?: boolean; scanned?: number } = await t.mutation(
      internal.notifications.fanOutNearbyNotifications,
      { reportId },
    );
    expect(first.isDone).toBe(false); // more profiles than one page holds
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(
      scheduled.filter((f) => f.name === 'notifications:fanOutNearbyNotifications').length,
    ).toBeGreaterThan(0); // it queued its own next page

    // Drain the rest the way the scheduler would, then assert nobody was dropped.
    let cursor = (first as { cursor?: string }).cursor;
    for (let i = 0; i < 10; i++) {
      const page: { isDone?: boolean; cursor?: string } = await t.mutation(
        internal.notifications.fanOutNearbyNotifications,
        { reportId, cursor },
      );
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue.filter((q) => q.kind === 'digest')).toHaveLength(210);
  }, 30_000);

  test('stops early when the report is hidden mid-fan-out', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    await seedProfile(t, 'nearby', {
      prefs: { nearbyReportDigest: true },
      allRadiusMinutes: 30,
      inBand: true,
    });
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));

    const result: { stopped?: string } = await t.mutation(
      internal.notifications.fanOutNearbyNotifications,
      { reportId },
    );
    expect(result.stopped).toBe('report_gone');
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });
});
