import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

const NOTIF_PREFS = {
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

/** Seed a profile with an optional private home coord; returns its id. */
async function seedProfile(t: ReturnType<typeof convexTest>, home?: { lat: number; lng: number }) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'clerk_a',
      displayName: 'a',
      username: 'a',
      ...(home ? { homeCoord: home } : {}),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
}

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  };
}

/** A fake ORS isochrone FeatureCollection with 30/60-min band polygons. */
function orsResponse() {
  return {
    features: [
      { properties: { value: 1800 }, geometry: square(0.5) },
      { properties: { value: 3600 }, geometry: square(1) },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('isochrones.recompute', () => {
  test('stores ORS 30/60 bands + the crow-flies outer radius when a home is set', async () => {
    const t = convexTestWithGeo();
    const userId = (await seedProfile(t, { lat: 44, lng: -72 })) as Id<'profiles'>;
    vi.stubEnv('ORS_API_KEY', 'test-key');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(orsResponse()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.isochrones.recompute, { userId });

    const p = await t.run((ctx) => ctx.db.get(userId));
    expect(p?.cachedIsochrones?.band30).toEqual(square(0.5));
    expect(p?.cachedIsochrones?.band60).toEqual(square(1));
    expect(p?.outerRadiusMeters).toBeGreaterThan(100_000); // 45 mph × 90 min ≈ 108 km
    expect(p?.cachedIsochronesAt).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('still stores the outer radius when ORS fails (90-band survives)', async () => {
    const t = convexTestWithGeo();
    const userId = (await seedProfile(t, { lat: 44, lng: -72 })) as Id<'profiles'>;
    vi.stubEnv('ORS_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );

    await t.action(internal.isochrones.recompute, { userId });

    const p = await t.run((ctx) => ctx.db.get(userId));
    expect(p?.cachedIsochrones).toBeUndefined(); // no polygons
    expect(p?.outerRadiusMeters).toBeGreaterThan(100_000); // but the outer radius still lands
  });

  test('skips the ORS call entirely when ORS_API_KEY is unset', async () => {
    const t = convexTestWithGeo();
    const userId = (await seedProfile(t, { lat: 44, lng: -72 })) as Id<'profiles'>;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.isochrones.recompute, { userId });

    expect(fetchMock).not.toHaveBeenCalled();
    const p = await t.run((ctx) => ctx.db.get(userId));
    expect(p?.outerRadiusMeters).toBeGreaterThan(100_000);
  });

  test('clears the cached bands when no home is set', async () => {
    const t = convexTestWithGeo();
    const userId = (await seedProfile(t)) as Id<'profiles'>;
    // Pre-seed some stale cache to prove it gets cleared.
    await t.run((ctx) =>
      ctx.db.patch(userId, { outerRadiusMeters: 999, cachedIsochrones: { band30: square(1) } }),
    );

    await t.action(internal.isochrones.recompute, { userId });

    const p = await t.run((ctx) => ctx.db.get(userId));
    expect(p?.cachedIsochrones).toBeUndefined();
    expect(p?.outerRadiusMeters).toBeUndefined();
  });
});

describe('isochrones.getHomeForIsochrones', () => {
  test('returns the home coord, or null when unset', async () => {
    const t = convexTestWithGeo();
    const withHome = (await seedProfile(t, { lat: 44, lng: -72 })) as Id<'profiles'>;
    const withoutHome = (await seedProfile(t)) as Id<'profiles'>;
    expect(await t.query(internal.isochrones.getHomeForIsochrones, { userId: withHome })).toEqual({
      lat: 44,
      lng: -72,
    });
    expect(
      await t.query(internal.isochrones.getHomeForIsochrones, { userId: withoutHome }),
    ).toBeNull();
  });
});
