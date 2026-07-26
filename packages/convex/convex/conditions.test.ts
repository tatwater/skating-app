import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

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

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: square(0.05),
      bbox: { minLat: 43.95, minLng: -72.05, maxLat: 44.05, maxLng: -71.95 },
      centroid: { lat: 44, lng: -72 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
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

async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  skateEndTime: number,
  extra: Record<string, unknown> = {},
) {
  const now = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 44, lng: -72 },
      skateEndTime,
      reportTime: now,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      moderationStatus: 'visible' as const,
      photoIds: [],
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
      ...extra,
    }),
  ) as Promise<Id<'reports'>>;
}

/** Open-Meteo conditions response with one hour sitting exactly at `atMs`. */
function conditionsResponse(atMs: number) {
  const s = Math.floor(atMs / 1000);
  return {
    hourly: {
      time: [s - 3600, s, s + 3600],
      temperature_2m: [-6, -5, -4],
      wind_speed_10m: [18, 20, 22],
      wind_direction_10m: [260, 270, 280],
      cloud_cover: [85, 90, 95],
      rain: [0, 0, 0],
      snowfall: [0.8, 1.0, 1.2],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conditions.autofillConditions', () => {
  test('fills blank conditions from the weather at the skate time (source openmeteo)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const skateEndTime = Date.now() - 2 * HOUR_MS;
    const reportId = await seedReport(t, waterBodyId, authorId, skateEndTime);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(conditionsResponse(skateEndTime)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.conditions.autofillConditions, { reportId });

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.conditions).toEqual({
      airTempC: -5,
      windSpeedKph: 20,
      windDir: 'W', // 270°
      sky: 'precip', // snowing
      precip: 'snow',
      source: 'openmeteo',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('never clobbers user-entered conditions', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const userConditions = { airTempC: 2, windSpeedKph: 5, source: 'user' as const };
    const reportId = await seedReport(t, waterBodyId, authorId, Date.now() - 2 * HOUR_MS, {
      conditions: userConditions,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.conditions.autofillConditions, { reportId });

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.conditions).toEqual(userConditions); // untouched
    expect(fetchMock).not.toHaveBeenCalled(); // short-circuited before any fetch
  });

  test('leaves conditions blank when Open-Meteo has no hour near the skate time', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const skateEndTime = Date.now() - 2 * HOUR_MS;
    const reportId = await seedReport(t, waterBodyId, authorId, skateEndTime);
    // All hours are a day off from the skate time → beyond MAX_HOUR_GAP_MS.
    const farOff = skateEndTime + 24 * HOUR_MS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(conditionsResponse(farOff)), { status: 200 })),
    );

    await t.action(internal.conditions.autofillConditions, { reportId });

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.conditions).toBeUndefined();
  });
});
