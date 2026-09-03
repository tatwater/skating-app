import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
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

/** A 200 carrying `body` as JSON — the shape every Open-Meteo stub in this file returns. */
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
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

/**
 * A response carrying both past and forward hours, for the B5b split.
 *
 * The forward half deliberately includes a snow onset, because "when does it start snowing" is the
 * whole question the feature exists to answer.
 */
function openMeteoWithForecast(nowMs: number) {
  const s = (msOffset: number) => Math.floor((nowMs + msOffset) / 1000);
  return {
    utc_offset_seconds: -18000, // −5h (US Eastern) — the offset the horizon must be applied in
    hourly: {
      time: [
        s(-2 * HOUR_MS),
        s(-1 * HOUR_MS),
        s(1 * HOUR_MS),
        s(2 * HOUR_MS),
        s(3 * HOUR_MS),
        s(4 * HOUR_MS),
      ],
      temperature_2m: [-6, -5, -4, -3, -2, -1],
      precipitation: [0, 0, 0, 0, 2, 3],
      rain: [0, 0, 0, 0, 0, 0],
      snowfall: [0, 0, 0, 0, 2, 3],
      snow_depth: [0.1, 0.1, 0.1, 0.1, 0.12, 0.15],
      wind_speed_10m: [5, 6, 7, 8, 9, 10],
      wind_gusts_10m: [12, 13, 14, 15, 16, 17],
      cloud_cover: [10, 20, 40, 60, 90, 100],
      sunshine_duration: [3600, 3600, 1800, 0, 0, 0],
      shortwave_radiation: [200, 150, 100, 50, 0, 0],
    },
  };
}

describe('weather.getForecastForBody (N6c B5b)', () => {
  test('returns the forward hours and names when snow starts', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoWithForecast(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const forecast = await asViewer(t).action(api.weather.getForecastForBody, { waterBodyId });

    expect(forecast).not.toBeNull();
    expect(forecast?.hours.length).toBeGreaterThan(0);
    // Every hour is in the future relative to the request.
    for (const h of forecast?.hours ?? []) expect(h.startMs).toBeGreaterThan(now - 18_000_000);
    expect(forecast?.precipStartsMs).toBeDefined();
    expect(forecast?.precipIsSnow).toBe(true);
  });

  test('caches per sample point + hour bucket, so a second open does not refetch', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoWithForecast(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weather.getForecastForBody, { waterBodyId });
    await asViewer(t).action(api.weather.getForecastForBody, { waterBodyId });

    expect(fetchMock).toHaveBeenCalledOnce();
    const cached = await t.run((ctx) => ctx.db.query('weatherForecastCache').collect());
    expect(cached).toHaveLength(1);
  });

  test('an unauthenticated caller gets nothing and triggers no fetch', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await t.action(api.weather.getForecastForBody, { waterBodyId })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * **The D74 wall.** The weather-since summary is the input to the decay math, the bounty gate and
   * the contradiction settle, all of which must be re-derivable from what actually happened. This
   * asserts that widening `forecast_days` to 2 did not let a single forward hour into that number —
   * the failure would be silent, and it would make every downstream decision unreproducible.
   */
  test('forward hours never reach the weather-since summary', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const reportId = await seedReport(t, waterBodyId, now - 3 * HOUR_MS);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(openMeteoWithForecast(now)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    // Two past hours in the fixture; the four forward ones carry all 5 cm of the snow and both
    // warm hours. If any leaked in, `hours` would exceed 2 and `snowfallCm` would be non-zero.
    expect(summary.hours).toBe(2);
    expect(summary.snowfallCm).toBe(0);
    expect(summary.maxWindGustKph).toBe(13);
  });
});

describe('the weather cell key (D152 / N6h)', () => {
  test("sends the cell centre and the band elevation, not the body's own coordinates", async () => {
    const t = convexTestWithGeo();
    // 44.0163 / 0.05 = 880.33 → 880 → 44.0;  -72.0331 / 0.05 = -1440.66 → -1441 → -72.05
    const waterBodyId = await seedBody(t, { lat: 44.0163, lng: -72.0331 });
    await t.run((ctx) => ctx.db.patch(waterBodyId, { elevationM: 338 }));
    const now = Date.now();
    const reportId = await seedReport(t, waterBodyId, now - 6 * HOUR_MS);

    const fetchMock = vi.fn(async (_url: string) => okJson(openMeteoResponse(now)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    const params = new URL(url).searchParams;
    expect(params.get('latitude')).toBe('44');
    expect(params.get('longitude')).toBe('-72.05');
    // 338 m → band 3 → the band CENTRE, 300, is what the key was built from and so what we send.
    // Sending 338 while keying on band 3 would mean two lakes sharing an entry that describes one.
    expect(params.get('elevation')).toBe('300');
    // The direction variable that crosses the 10-var billing threshold on purpose (N6h Workstream C).
    expect(params.get('hourly')).toContain('wind_direction_10m');
  });

  test('omits elevation entirely for a body that has none', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t, { lat: 44.0, lng: -72.0 });
    const now = Date.now();
    const reportId = await seedReport(t, waterBodyId, now - 6 * HOUR_MS);
    const fetchMock = vi.fn(async (_url: string) => okJson(openMeteoResponse(now)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });
    const params = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(params.has('elevation')).toBe(false);
  });

  test('two bodies in one cell and band share ONE fetch and ONE cache row', async () => {
    const t = convexTestWithGeo();
    const now = Date.now();
    // ~1.5 km apart, same 0.05° cell, elevations 338 and 320 → both band 3.
    const a = await seedBody(t, { lat: 44.0163, lng: -72.0331 });
    const b = await seedBody(t, { lat: 44.0051, lng: -72.0409 });
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { elevationM: 338 });
      await ctx.db.patch(b, { elevationM: 320 });
    });
    const skateEnd = now - 6 * HOUR_MS;
    const reportA = await seedReport(t, a, skateEnd);
    const reportB = await seedReport(t, b, skateEnd);

    const fetchMock = vi.fn(async () => okJson(openMeteoResponse(now)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId: reportA });
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId: reportB });

    // The whole point of D152: the second body is a cache hit, not a second call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(rows).toHaveLength(1);
  });

  test('two bodies in one cell but different elevation bands do NOT share', async () => {
    const t = convexTestWithGeo();
    const now = Date.now();
    const a = await seedBody(t, { lat: 44.0163, lng: -72.0331 });
    const b = await seedBody(t, { lat: 44.0161, lng: -72.0329 });
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { elevationM: 180 }); // band 2
      await ctx.db.patch(b, { elevationM: 620 }); // band 6
    });
    const skateEnd = now - 6 * HOUR_MS;
    const reportA = await seedReport(t, a, skateEnd);
    const reportB = await seedReport(t, b, skateEnd);
    const fetchMock = vi.fn(async () => okJson(openMeteoResponse(now)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId: reportA });
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId: reportB });
    // A valley lake and a ridge pond in the same grid cell get genuinely different temperatures.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    expect(rows).toHaveLength(2);
  });

  test('the strip and the decay cron key into the SAME row (Phase 10 §5, structurally)', async () => {
    // The invariant D152 made dangerous and `bodyWeatherCell` made structural: four consumers reach
    // Open-Meteo, and if any two resolved one body to different cells the strip would describe one
    // window while the decay applied another — silently, and with nothing to notice it.
    const t = convexTestWithGeo();
    const now = Date.now();
    const waterBodyId = await seedBody(t, { lat: 44.0163, lng: -72.0331 });
    await t.run((ctx) => ctx.db.patch(waterBodyId, { elevationM: 338 }));
    // A hazard whose window start (max(lastConfirmedAt, now-7d)) lands on the same hour bucket as
    // the report's skate time, so only the CELL can differ.
    const anchorMs = now - 6 * HOUR_MS;
    const reportId = await seedReport(t, waterBodyId, anchorMs);
    await seedHazard(t, waterBodyId, anchorMs);

    const fetchMock = vi.fn(async () => okJson(openMeteoResponse(now)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });
    await t.action(internal.hazardWeather.refreshHazardWeather, {});

    const rows = await t.run((ctx) => ctx.db.query('weatherCache').collect());
    const keys = new Set(rows.map((r) => r.samplePointKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^b:\d+:-?\d+:3$/);
  });

  test('meters every Open-Meteo call, weighted the way Open-Meteo bills them (D158)', async () => {
    const t = convexTestWithGeo();
    const now = Date.now();
    const waterBodyId = await seedBody(t, { lat: 44.0, lng: -72.0 });
    const reportId = await seedReport(t, waterBodyId, now - 6 * HOUR_MS);
    const fetchMock = vi.fn(async () => okJson(openMeteoResponse(now)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });

    const rows = await t.run((ctx) => ctx.db.query('externalApiCalls').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('open-meteo');
    expect(rows[0]?.calls).toBe(1);
    // 11 variables over a 1+2 day span: ceil(3/14)=1 × 11/10 = 1.1 billed calls.
    expect(rows[0]?.weightedCalls).toBeCloseTo(1.1, 6);
  });

  test('counts a FAILED call too — it consumed quota just the same', async () => {
    const t = convexTestWithGeo();
    const now = Date.now();
    const waterBodyId = await seedBody(t, { lat: 44.0, lng: -72.0 });
    const reportId = await seedReport(t, waterBodyId, now - 6 * HOUR_MS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    await asViewer(t).action(api.weather.getWeatherSinceForBody, { reportId });
    const rows = await t.run((ctx) => ctx.db.query('externalApiCalls').collect());
    expect(rows[0]?.calls).toBe(1);
  });
});
