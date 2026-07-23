import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { nearestSamplePoint } from './lib/sampling';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const HOUR_MS = 3_600_000;

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
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

async function seedBody(
  t: ReturnType<typeof convexTest>,
  extra: Record<string, unknown> = {},
  centroid = { lat: 44.0, lng: -72.0 },
) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: square(0.05),
      bbox: { minLat: 43.95, minLng: -72.05, maxLat: 44.05, maxLng: -71.95 },
      centroid,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  ) as Promise<Id<'waterBodies'>>;
}

async function seedProfile(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'c',
      displayName: 'a',
      username: 'a',
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
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
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'profiles'>>;
}

async function seedHazard(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  extra: Record<string, unknown> = {},
) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point', coordinates: [-72.0, 44.0] },
      radiusMeters: 30,
      bbox: { minLat: 43.999, minLng: -72.001, maxLat: 44.001, maxLng: -71.999 },
      createdByUserId: authorId,
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: now - 6 * HOUR_MS,
      lastConfirmedAt: now - 6 * HOUR_MS,
      confirmCount: 0,
      goneCount: 0,
      createdAt: now - 6 * HOUR_MS,
      ...extra,
    }),
  ) as Promise<Id<'hazards'>>;
}

/** Open-Meteo response: 6 recent hours of hard freeze with a little snow (cold ⇒ open_water fades faster). */
function coldSnowyResponse(nowMs: number) {
  const s = (hoursAgo: number) => Math.floor((nowMs - hoursAgo * HOUR_MS) / 1000);
  const n = 6;
  return {
    utc_offset_seconds: -18000,
    hourly: {
      time: Array.from({ length: n }, (_, i) => s(n - i)),
      temperature_2m: Array.from({ length: n }, () => -20),
      precipitation: Array.from({ length: n }, () => 0.5),
      rain: Array.from({ length: n }, () => 0),
      snowfall: Array.from({ length: n }, () => 0.5),
      snow_depth: Array.from({ length: n }, () => 0.2),
      wind_speed_10m: Array.from({ length: n }, () => 10),
      wind_gusts_10m: Array.from({ length: n }, () => 20),
      cloud_cover: Array.from({ length: n }, () => 80),
      sunshine_duration: Array.from({ length: n }, () => 0),
      shortwave_radiation: Array.from({ length: n }, () => 0),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nearestSamplePoint', () => {
  test('defaults to the centroid when no sample points are set', () => {
    const body = { centroid: { lat: 44, lng: -72 }, weatherSamplePoints: undefined } as never;
    expect(nearestSamplePoint(body, { lat: 10, lng: 10 })).toEqual({ lat: 44, lng: -72 });
  });

  test('picks the closest of several sample points to the target', () => {
    const body = {
      centroid: { lat: 44, lng: -72 },
      weatherSamplePoints: [
        { lat: 44.5, lng: -73 },
        { lat: 43.5, lng: -71 },
      ],
    } as never;
    expect(nearestSamplePoint(body, { lat: 43.6, lng: -71.1 })).toEqual({ lat: 43.5, lng: -71 });
  });
});

describe('hazardWeather.refreshHazardWeather', () => {
  test('stores a weather multiplier + snow-hidden flag for an active hazard', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const hazardId = await seedHazard(t, waterBodyId, authorId);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(coldSnowyResponse(Date.now())), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.hazardWeather.refreshHazardWeather, {});

    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBeGreaterThan(1); // cold ⇒ open_water fades faster
    expect(h?.snowHidden).toBe(true); // snowfall in the window
    expect(h?.weatherAdjustedAt).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('skips a hazard refreshed within the min interval (no refetch)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const hazardId = await seedHazard(t, waterBodyId, authorId, {
      decayMultiplier: 1.5,
      weatherAdjustedAt: Date.now() - HOUR_MS, // 1h ago < 3h gate
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.hazardWeather.refreshHazardWeather, {});

    expect(fetchMock).not.toHaveBeenCalled();
    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBe(1.5); // untouched
  });

  test('skips moderator-hidden and feature-promoted hazards', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    await seedHazard(t, waterBodyId, authorId, { moderationStatus: 'hidden' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.hazardWeather.refreshHazardWeather, {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failed fetch leaves the prior multiplier untouched and does not stamp a refresh', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const staleAt = Date.now() - 6 * HOUR_MS; // older than the 3h gate ⇒ due for a refresh
    const hazardId = await seedHazard(t, waterBodyId, authorId, {
      decayMultiplier: 1.8, // a real signal from a prior successful tick
      weatherAdjustedAt: staleAt,
    });
    // Open-Meteo is down: the cron must NOT overwrite 1.8 with a fail-open 1, and must NOT re-stamp
    // `weatherAdjustedAt` (which would block retry for the whole cadence window). The next tick retries.
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.hazardWeather.refreshHazardWeather, {});

    expect(fetchMock).toHaveBeenCalledOnce(); // it tried
    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBe(1.8); // prior signal preserved, not clobbered to 1
    expect(h?.weatherAdjustedAt).toBe(staleAt); // NOT re-stamped ⇒ still due next tick
  });
});
