import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
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
        name: 'Lake Morey',
        type: 'lake',
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

describe('notifications — favorites', () => {
  test('a favorited-body report enqueues for the favoriter, not the author, and coalesces', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const fan = await seedProfile(t, 'fan');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });

    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME + 1 });

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
    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);
  });

  test('flush delivers an in-app notification carrying the coalesced count + key', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const fan = await seedProfile(t, 'fan');
    await fan.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id });
    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });

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

    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('digest');
    expect(queue[0]?.flushAfter).toBeGreaterThan(Date.now() + 60 * 60 * 1000); // batched to next 8pm

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
    await author.as.mutation(api.reports.create, { waterBodyId: bodyA, skateEndTime: SKATE_TIME });
    await author.as.mutation(api.reports.create, {
      waterBodyId: bodyA,
      skateEndTime: SKATE_TIME + 1,
    });
    await author.as.mutation(api.reports.create, {
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
    await author.as.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
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
    await author.as.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      skateQuality: 'good',
    });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toEqual([]);

    // A great report → one great queue row.
    await author.as.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME + 1,
      skateQuality: 'great',
    });
    const queue = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('great');
  });
});
