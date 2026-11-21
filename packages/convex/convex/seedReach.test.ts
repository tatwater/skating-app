/**
 * What a fake person from the dev seed does reaches no real person (D287), and no real person's
 * points, tallies or content move on it — one test per path a seeded write could take to someone
 * else, each failing if its check is dropped. The recipient side (a fake person is never notified)
 * is `seedPeople.test.ts`.
 */
import { CONTRADICTION_FLAG_THRESHOLD } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const PREFS_ON = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: true,
  greatReportNearby: true,
};

async function person(t: T, clerkUserId: string, role: 'member' | 'admin' = 'member') {
  const id = await t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId,
      displayName: `${clerkUserId} Test-Person`,
      username: clerkUserId.replace(/\W/g, '_').toLowerCase(),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS_ON,
      channelPrefs: { push: true, email: true },
      email: `${clerkUserId}@example.test`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    });
    await ctx.db.insert('pushTokens', {
      userId: id,
      token: `ExponentPushToken[${clerkUserId}]`,
      platform: 'android',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return id;
  });
  return { id, as: t.withIdentity({ subject: clerkUserId }) };
}

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72, 43],
      [-72, 43.02],
      [-71.98, 43.02],
      [-71.98, 43],
      [-72, 43],
    ],
  ],
};

async function body(t: T) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId: 'way/9',
        osmId: 'way/9',
        name: 'Shared Pond',
        type: 'lakePond',
        polygon: square,
        bbox: { minLat: 43, minLng: -72, maxLat: 43.02, maxLng: -71.98 },
        centroid: { lat: 43.01, lng: -71.99 },
        surfaceAreaSqM: 4_000_000,
      },
    ],
  });
  const row = await t.run((ctx) => ctx.db.query('waterBodies').first());
  if (!row) throw new Error('seed failed');
  return row._id;
}

const report = (
  who: { as: ReturnType<T['withIdentity']> },
  waterBodyId: Id<'waterBodies'>,
  hoursAgo: number,
) =>
  who.as.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime: Date.now() - hoursAgo * 3_600_000,
    iceTypes: ['black_ice'],
    skateQuality: 'great',
  });

const pin = (who: { as: ReturnType<T['withIdentity']> }, waterBodyId: Id<'waterBodies'>) =>
  who.as.mutation(api.hazards.create, {
    waterBodyId,
    type: 'open_water',
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [-71.99, 43.01] },
    radiusMeters: 40,
  });

/** What a real person could have been sent or credited. */
async function reachOf(t: T, userId: Id<'profiles'>) {
  return t.run(async (ctx) => ({
    queued: (await ctx.db.query('notificationQueue').collect()).filter((q) => q.userId === userId)
      .length,
    notified: (await ctx.db.query('notifications').collect()).filter((n) => n.userId === userId)
      .length,
    points: (await ctx.db.get(userId))?.reputationPoints,
    events: (await ctx.db.query('pointEvents').collect())
      .filter((e) => e.userId === userId)
      .map((e) => e.reason)
      .sort(),
  }));
}

const urls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A real author with a recent report and a pin, a real fan of the body, and a fake person. */
async function world(t: T) {
  const waterBodyId = await body(t);
  const author = await person(t, 'user_author');
  const fan = await person(t, 'user_fan');
  const fake = await person(t, 'seed_inbox_1');
  await t.run((ctx) =>
    ctx.db.insert('waterBodyFavorites', { userId: fan.id, waterBodyId, createdAt: Date.now() }),
  );
  const realReport = await report(author, waterBodyId, 10);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { waterBodyId, author, fan, fake, realReport };
}

describe('a fake person’s report', () => {
  test('tells no favoriter, digest or neighbor, and corroborates no real report', async () => {
    const t = harness();
    const { waterBodyId, author, fan, fake } = await world(t);
    const before = { author: await reachOf(t, author.id), fan: await reachOf(t, fan.id) };
    const fakeReport = await report(fake, waterBodyId, 8);
    const about = await t.run(async (ctx) =>
      (await ctx.db.query('notificationQueue').collect()).filter(
        (q) => q.latestReportId === fakeReport,
      ),
    );
    expect(about).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await reachOf(t, fan.id)).toEqual(before.fan);
    expect(await reachOf(t, author.id)).toEqual(before.author);
    expect(urls.filter((u) => u.includes('exp.host') || u.includes('resend'))).toEqual([]);
  });

  test('a real report’s favorite notice still goes out (the control)', async () => {
    const t = harness();
    const { waterBodyId, fan } = await world(t);
    const other = await person(t, 'user_other');
    await report(other, waterBodyId, 8);
    const queued = await t.run((ctx) => ctx.db.query('notificationQueue').collect());
    expect(queued.some((q) => q.userId === fan.id && q.kind === 'favorite')).toBe(true);
  });

  test('the nearby fan-out stops at a fake author', async () => {
    const t = harness();
    const { waterBodyId, fake } = await world(t);
    const reportId = await report(fake, waterBodyId, 8);
    expect(
      await t.mutation(internal.notifications.fanOutNearbyNotifications, { reportId }),
    ).toEqual({ stopped: 'seed_author' });
  });

  test('a real report agreeing with a fake one earns its author nothing from it', async () => {
    const t = harness();
    const { waterBodyId, fake } = await world(t);
    await report(fake, waterBodyId, 30);
    const later = await person(t, 'user_later');
    await report(later, waterBodyId, 6);
    const events = (await reachOf(t, later.id)).events;
    // Corroborated by the real author's report, never by the fake one: one, not two.
    expect(events.filter((e) => e === 'report_corroborated')).toHaveLength(1);
  });

  test('answers no real bounty', async () => {
    const t = harness();
    const { waterBodyId, fan, fake } = await world(t);
    const bountyId = await t.run((ctx) =>
      ctx.db.insert('bounties', {
        requesterId: fan.id,
        waterBodyId,
        windowHours: 48,
        rewardPoints: 10,
        fulfillingReportIds: [],
        status: 'open',
        createdAt: Date.now() - 20 * 3_600_000,
        expiresAt: Date.now() + 86_400_000,
      }),
    );
    await report(fake, waterBodyId, 8);
    const bounty = await t.run((ctx) => ctx.db.get(bountyId));
    expect(bounty?.fulfillingReportIds).toEqual([]);
    const real = await person(t, 'user_real');
    const answered = await report(real, waterBodyId, 7);
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toEqual([answered]);
  });

  test('is never in a real report’s contradiction cluster, nor a real one in its', async () => {
    const t = harness();
    const { waterBodyId, fake, realReport } = await world(t);
    const fakeReport = await report(fake, waterBodyId, 9);
    const fromReal = await t.query(internal.contradictions.contradictionCluster, {
      reportId: realReport,
    });
    const fromFake = await t.query(internal.contradictions.contradictionCluster, {
      reportId: fakeReport,
    });
    expect(fromReal?.reports.map((r) => r.id)).toEqual([realReport]);
    expect(fromFake?.reports.map((r) => r.id)).toEqual([fakeReport]);
  });
});

describe('a fake person’s pin', () => {
  test('never folds into a real pin, nor a real pin into it', async () => {
    const t = harness();
    const { waterBodyId, author, fake } = await world(t);
    const realPin = await pin(author, waterBodyId);
    const fakePin = await pin(fake, waterBodyId);
    const later = await person(t, 'user_later');
    const laterPin = await pin(later, waterBodyId);
    // `create` answers with the survivor: a merged pin answers with the pin it folded into.
    expect(fakePin).not.toBe(realPin);
    expect(laterPin).toBe(realPin);
    const fakeRow = await t.run((ctx) => ctx.db.get(fakePin));
    expect(fakeRow?.mergedIntoHazardId).toBeUndefined();
  });
});

describe('a real pin', () => {
  test('never folds into a fake person’s pin', async () => {
    const t = harness();
    const waterBodyId = await body(t);
    const fake = await person(t, 'seed_inbox_1');
    const real = await person(t, 'user_real');
    const fakePin = await pin(fake, waterBodyId);
    expect(await pin(real, waterBodyId)).not.toBe(fakePin);
  });
});

describe('a fake person’s act pages no one and syncs nothing', () => {
  test('a contradiction pattern on a fake author files its flag but mails no operator', async () => {
    const t = harness();
    const { waterBodyId, author, fake } = await world(t);
    const fakeReport = await report(fake, waterBodyId, 9);
    const realReport = await report(author, waterBodyId, 11);
    const alerts = async () =>
      (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter(
        (j) => j.name === 'operatorAlerts:send',
      ).length;
    await t.run(async (ctx) => {
      await ctx.db.patch(fake.id, { contradictionCount: CONTRADICTION_FLAG_THRESHOLD - 1 });
      await ctx.db.patch(author.id, { contradictionCount: CONTRADICTION_FLAG_THRESHOLD - 1 });
    });
    const before = await alerts();
    const settle = (id: Id<'reports'>, flaggerId: Id<'profiles'>) =>
      t.mutation(internal.contradictions.applyContradictionSettlement, {
        reports: [{ id, conflicting: true, contradiction: true, flaggerId }],
      });
    await settle(fakeReport, author.id);
    expect(await alerts()).toBe(before);
    await settle(realReport, author.id);
    expect(await alerts()).toBe(before + 1);
  });

  test('a ban or a lift on a fake person schedules no Clerk sync', async () => {
    const t = harness();
    const admin = await person(t, 'user_admin', 'admin');
    const fake = await person(t, 'seed_inbox_1');
    const real = await person(t, 'user_real');
    const syncs = async () =>
      (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter(
        (j) => j.name === 'clerkAdmin:setBanned',
      ).length;
    await admin.as.mutation(api.moderation.banUser, { userId: fake.id, reason: 'spam' });
    await admin.as.mutation(api.moderation.unbanUser, { userId: fake.id });
    expect(await syncs()).toBe(0);
    await admin.as.mutation(api.moderation.banUser, { userId: real.id, reason: 'spam' });
    expect(await syncs()).toBe(1);
  });

  test('a comment, a thumb and a hazard vote by a fake person on real content notify no one', async () => {
    const t = harness();
    const { waterBodyId, author, fake, realReport } = await world(t);
    const realPin = await pin(author, waterBodyId);
    const before = await reachOf(t, author.id);
    await fake.as.mutation(api.comments.create, { reportId: realReport, body: 'Where?' });
    await fake.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: realReport,
      verdict: 'helpful',
    });
    await fake.as.mutation(api.hazardConfirmations.confirm, {
      hazardId: realPin,
      verdict: 'still_there',
      via: 'app_open_nearby',
    });
    const after = await reachOf(t, author.id);
    expect(after.queued).toBe(before.queued);
  });
});
