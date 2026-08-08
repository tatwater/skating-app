import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { WEATHER_WINDOW_MAX_LOOKBACK_MS } from './weather';

const modules = import.meta.glob('./**/*.*s');
const HOUR_MS = 3_600_000;

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
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

/** An authenticated caller — `getWeatherSinceForBody` gates on a signed-in identity (resource-abuse guard). */
function asViewer(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: 'viewer' });
}

async function seedBody(t: ReturnType<typeof convexTest>, centroid = { lat: 44.0, lng: -72.0 }) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      searchText: 'Test Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01),
      bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
      centroid,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

let seq = 0;
async function seedAuthor(t: ReturnType<typeof convexTest>): Promise<Id<'profiles'>> {
  const n = seq++;
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: `author-${n}`,
      displayName: 'a',
      username: `a-${n}`,
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

/** A visible report on a body (the strip's server-validated anchor). Direct insert — no create side effects. */
async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  moderationStatus: 'visible' | 'hidden' = 'visible',
): Promise<Id<'reports'>> {
  const authorId = await seedAuthor(t);
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 44.0, lng: -72.0 },
      skateEndTime,
      reportTime: now,
      source: 'native' as const,
      iceTypes: ['black_ice'] as const,
      surfaceTags: [],
      photoIds: [],
      moderationStatus,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  ) as Promise<Id<'reports'>>;
}

/** A visible active hazard on a body (the strip's other server-validated anchor). */
async function seedHazard(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  lastConfirmedAt: number,
): Promise<Id<'hazards'>> {
  const authorId = await seedAuthor(t);
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
      firstReportedAt: lastConfirmedAt,
      lastConfirmedAt,
      confirmCount: 0,
      goneCount: 0,
      createdAt: lastConfirmedAt,
    }),
  ) as Promise<Id<'hazards'>>;
}

/** An Open-Meteo forecast response with `hoursAgo` hourly readings ending ~1h before now. */
function openMeteoResponse(nowMs: number) {
  const s = (msAgo: number) => Math.floor((nowMs - msAgo) / 1000); // unix seconds
  return {
    utc_offset_seconds: -18000, // −5h (US Eastern)
    hourly: {
      time: [s(3 * HOUR_MS), s(2 * HOUR_MS), s(1 * HOUR_MS)],
      temperature_2m: [-3, 1, -2],
      precipitation: [0, 1, 0],
      rain: [0, 1, 0],
      snowfall: [0, 0, 0.5],
      snow_depth: [0.1, 0.1, 0.12],
      wind_speed_10m: [5, 10, 8],
      wind_gusts_10m: [12, 20, 15],
      cloud_cover: [10, 80, 50],
      sunshine_duration: [3600, 0, 1800],
      shortwave_radiation: [200, 50, 120],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('weather.getWeatherSinceForBody', () => {
  test('fetches, summarizes and caches the weather-since a report', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const reportId = await seedReport(t, waterBodyId, now - 4 * HOUR_MS);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoResponse(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    expect(summary.hours).toBe(3);
    expect(summary.peakTempC).toBe(1);
    expect(summary.minTempC).toBe(-3);
    expect(summary.freezingDegreeHours).toBeCloseTo(5); // 3 + 2
    expect(summary.thawDegreeHours).toBeCloseTo(1);
    expect(summary.rainMm).toBeCloseTo(1);
    expect(summary.snowfallCm).toBeCloseTo(0.5);
    expect(summary.maxWindGustKph).toBe(20);
    expect(summary.nightsBelowFreezing).not.toBeNull(); // timestamps present
    expect(fetchMock).toHaveBeenCalledOnce();

    const cached = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(cached).toHaveLength(1);
    expect(cached[0]?.summary.hours).toBe(3);
  });

  test('derives a hazard window from lastConfirmedAt server-side', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const hazardId = await seedHazard(t, waterBodyId, now - 4 * HOUR_MS);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoResponse(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await asViewer(t).action(api.weather.getWeatherSinceForBody, { hazardId });

    expect(summary.hours).toBe(3);
    expect(fetchMock).toHaveBeenCalledOnce();
    const cached = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(cached).toHaveLength(1);
  });

  test('a second call for the same report hits the cache (no refetch)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const reportId = await seedReport(t, waterBodyId, now - 4 * HOUR_MS);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoResponse(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });
    const second = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce(); // served from cache the second time
  });

  test('fails open (empty summary, no cache write) when Open-Meteo errors', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(t, waterBodyId, Date.now() - 4 * HOUR_MS);
    const fetchMock = vi.fn(async () => new Response('nope', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    expect(summary.hours).toBe(0); // empty ⇒ strip shows nothing, decay multiplier stays 1
    const cached = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(cached).toHaveLength(0); // a failure is never cached — the next open retries
  });

  test('returns the empty summary for a report whose window is not yet an hour old', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(t, waterBodyId, Date.now()); // skate == now ⇒ no full hour
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const summary = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    expect(summary.hours).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects an unauthenticated caller before any fetch or cache write (resource-abuse guard)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(t, waterBodyId, Date.now() - 4 * HOUR_MS);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoResponse(Date.now())), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // No identity ⇒ a blank summary with no Open-Meteo call and no persistent `weatherCache` insert.
    const summary = await t.action(api.weather.getWeatherSinceForBody, { reportId });

    expect(summary.hours).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const cached = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(cached).toHaveLength(0);
  });

  test('returns empty and never fetches for a non-visible report (server-validated anchor)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    // A moderator-hidden report has no strip — the server refuses to derive a window from it, so it can't
    // drive a fetch. The reachable window set is exactly the reports/hazards that are actually visible.
    const reportId = await seedReport(t, waterBodyId, Date.now() - 4 * HOUR_MS, 'hidden');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoResponse(Date.now())), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    expect(summary.hours).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const cached = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(cached).toHaveLength(0);
  });

  test('clamps an over-old report window so cache-key cardinality stays bounded (resource guard)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    // A report dated 60 days back — beyond any legitimate strip window. Even so, the resolver clamps the
    // window start to the max lookback, so the persisted cache key can't be pushed to an arbitrary bucket.
    const reportId = await seedReport(t, waterBodyId, now - 60 * 24 * HOUR_MS);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoResponse(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    const cached = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(cached).toHaveLength(1);
    const clampFloor = now - WEATHER_WINDOW_MAX_LOOKBACK_MS;
    expect(cached[0]?.windowStartMs).toBeGreaterThanOrEqual(clampFloor - HOUR_MS);
    expect(cached[0]?.windowStartMs).toBeLessThanOrEqual(clampFloor + HOUR_MS);
  });
});
