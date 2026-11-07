import { TRAVEL_BASE_MAX_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 0, 10, 15);
const HOUR = 3_600_000;
const HOME = { lat: 0.5, lng: 0.5 };
const AWAY = { lat: 10.5, lng: 10.5 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function square(cx: number, cy: number, half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
      ],
    ],
  };
}

/** Run what is due now (the `runAfter(0)` recompute), leaving the job at `until` queued. */
async function drainNow(t: ReturnType<typeof convexTest>) {
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

async function seedUser(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'clerk_a',
      displayName: 'a',
      username: 'a',
      homeCoord: HOME,
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
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: T0,
      ...overrides,
    }),
  );
  return { id: id as Id<'profiles'>, as: t.withIdentity({ subject: 'clerk_a' }) };
}

async function seedBody(t: ReturnType<typeof convexTest>, at: { lat: number; lng: number }) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      source: 'osm',
      name: `Lake at ${at.lat}`,
      searchText: `Lake at ${at.lat}`,
      type: 'lakePond',
      polygon: square(at.lng, at.lat, 0.01),
      bbox: {
        minLat: at.lat - 0.01,
        minLng: at.lng - 0.01,
        maxLat: at.lat + 0.01,
        maxLng: at.lng + 0.01,
      },
      centroid: at,
      dedupStatus: 'clean',
      createdAt: T0,
    }),
  );
}

/** Answer every ORS call with a 30-min polygon around whatever origin was asked for. */
function stubOrs() {
  vi.stubEnv('ORS_API_KEY', 'test-key');
  const calls: number[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const [lng, lat] = (JSON.parse(init.body) as { locations: number[][] }).locations[0] ?? [];
      calls.push([lng ?? 0, lat ?? 0]);
      return new Response(
        JSON.stringify({
          features: [
            { properties: { value: 1800 }, geometry: square(lng ?? 0, lat ?? 0, 0.1) },
            { properties: { value: 3600 }, geometry: square(lng ?? 0, lat ?? 0, 0.2) },
          ],
        }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

describe('profiles.setTravelBase / clearTravelBase (B03 §11, board 7.19)', () => {
  test('drive time follows the base while it is in force, and comes home on its own at `until`', async () => {
    const calls = stubOrs();
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t);
    await t.action(internal.isochrones.recompute, { userId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.cachedIsochronesOrigin).toEqual(HOME);

    const until = T0 + 48 * HOUR;
    await as.mutation(api.profiles.setTravelBase, { ...AWAY, until });
    await drainNow(t);
    let p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.travelBase).toMatchObject({ coord: AWAY, until });
    expect(p?.cachedIsochronesOrigin).toEqual(AWAY);
    expect(calls.at(-1)).toEqual([AWAY.lng, AWAY.lat]);

    // The expiry recompute fires at `until` and draws from home again.
    vi.setSystemTime(until);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.cachedIsochronesOrigin).toEqual(HOME);
    expect(calls.at(-1)).toEqual([HOME.lng, HOME.lat]);
  });

  test('the lake arrival band reads the base, not home, while the base is in force', async () => {
    stubOrs();
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t);
    const nearHome = await seedBody(t, HOME);
    const nearAway = await seedBody(t, AWAY);
    await t.action(internal.isochrones.recompute, { userId: id });
    const asViewerNow = (waterBodyId: Id<'waterBodies'>) =>
      as.query(internal.weather.resolveForecastPlace, { waterBodyId });
    expect((await asViewerNow(nearHome))?.arrivalBandMinutes).toBe(30);

    await as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 + HOUR });
    await drainNow(t);
    const asViewer = (waterBodyId: Id<'waterBodies'>) =>
      as.query(internal.weather.resolveForecastPlace, { waterBodyId });
    expect((await asViewer(nearAway))?.arrivalBandMinutes).toBe(30);
    expect((await asViewer(nearHome))?.arrivalBandMinutes).toBeNull();
  });

  test('re-setting cancels the old expiry; clearing cancels it and recomputes from home', async () => {
    const calls = stubOrs();
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t);
    await as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 + 2 * HOUR });
    await drainNow(t);
    const first = (await t.run((ctx) => ctx.db.get(id)))?.travelBase?.expiryJobId;
    await as.mutation(api.profiles.setTravelBase, { lat: 20, lng: 20, until: T0 + 3 * HOUR });
    await drainNow(t);
    const firstJob = await t.run(async (ctx) => (first ? await ctx.db.system.get(first) : null));
    expect(firstJob?.state.kind).toBe('canceled');

    const second = (await t.run((ctx) => ctx.db.get(id)))?.travelBase?.expiryJobId;
    await as.mutation(api.profiles.clearTravelBase, {});
    await drainNow(t);
    const p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.travelBase).toBeUndefined();
    expect(p?.cachedIsochronesOrigin).toEqual(HOME);
    expect(calls.at(-1)).toEqual([HOME.lng, HOME.lat]);
    const secondJob = await t.run(async (ctx) => (second ? await ctx.db.system.get(second) : null));
    expect(secondJob?.state.kind).toBe('canceled');
    // Clearing again is a no-op.
    await as.mutation(api.profiles.clearTravelBase, {});
  });

  test('an expiry job that already ran is not canceled twice', async () => {
    stubOrs();
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t);
    await as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 + HOUR });
    vi.setSystemTime(T0 + HOUR);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The base ran out; it is still stored (nothing deletes it), and a clear is clean.
    await as.mutation(api.profiles.clearTravelBase, {});
    expect((await t.run((ctx) => ctx.db.get(id)))?.travelBase).toBeUndefined();
  });

  test('refuses a bad coordinate, a past end, or one past the cap', async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    await expect(
      as.mutation(api.profiles.setTravelBase, { lat: 91, lng: 0, until: T0 + HOUR }),
    ).rejects.toThrow(/not valid/);
    await expect(
      as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 - 1 }),
    ).rejects.toThrow(/within 30 days/);
    await expect(
      as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 + TRAVEL_BASE_MAX_MS + 1 }),
    ).rejects.toThrow(/within 30 days/);
  });

  test('a ghost cannot set a base (D62); deletion scrubs it with home', async () => {
    stubOrs();
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t);
    await as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 + HOUR });
    await drainNow(t);
    await as.mutation(api.accountDeletion.requestDeletion, {});
    const p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.travelBase).toBeUndefined();
    expect(p?.cachedIsochronesOrigin).toBeUndefined();
    await expect(
      as.mutation(api.profiles.setTravelBase, { ...AWAY, until: T0 + HOUR }),
    ).rejects.toThrow();
  });
});

describe('isochrones.storeBands — a late answer for a place the skater has left', () => {
  test('is dropped, so the arrival order of two recomputes cannot matter', async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedUser(t, {
      travelBase: { coord: AWAY, until: T0 + HOUR },
    });
    // Home's answer arrives while the base is in force: dropped.
    await t.mutation(internal.isochrones.storeBands, {
      userId: id,
      origin: HOME,
      band30: square(HOME.lng, HOME.lat, 0.1),
      computedAt: T0,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.cachedIsochrones).toBeUndefined();
    // The base's own answer lands.
    await t.mutation(internal.isochrones.storeBands, {
      userId: id,
      origin: AWAY,
      band30: square(AWAY.lng, AWAY.lat, 0.1),
      computedAt: T0,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.cachedIsochronesOrigin).toEqual(AWAY);
    // A clear (no origin) for someone who still has one is dropped too.
    await t.mutation(internal.isochrones.storeBands, { userId: id, computedAt: T0 });
    expect((await t.run((ctx) => ctx.db.get(id)))?.cachedIsochronesOrigin).toEqual(AWAY);
  });

  test('a recompute for a profile that is gone writes nothing', async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedUser(t);
    await t.run((ctx) => ctx.db.delete(id));
    await t.mutation(internal.isochrones.storeBands, { userId: id, computedAt: T0 });
  });
});

describe('"bounties near me" measures from the base', () => {
  test('listOpen sortByHome sorts by the base while it is in force', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t, { travelBase: { coord: AWAY, until: T0 + HOUR } });
    const nearHome = await seedBody(t, HOME);
    const nearAway = await seedBody(t, AWAY);
    for (const waterBodyId of [nearHome, nearAway]) {
      await t.run((ctx) =>
        ctx.db.insert('bounties', {
          requesterId: id,
          waterBodyId,
          windowHours: 24,
          status: 'open',
          rewardPoints: 10,
          fulfillingReportIds: [],
          createdAt: T0,
          expiresAt: T0 + 24 * HOUR,
        }),
      );
    }
    const rows = await as.query(api.bounties.listOpen, { sortByHome: true });
    expect(rows.map((r) => r.waterBodyId)).toEqual([nearAway, nearHome]);
    vi.setSystemTime(T0 + HOUR);
    const later = await as.query(api.bounties.listOpen, { sortByHome: true });
    expect(later.map((r) => r.waterBodyId)).toEqual([nearHome, nearAway]);
  });
});
