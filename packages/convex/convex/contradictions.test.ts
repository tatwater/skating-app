import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function harness() {
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

async function seedProfile(t: ReturnType<typeof convexTest>, subject: string, extra = {}) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
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
      ...extra,
    }),
  ) as Promise<Id<'profiles'>>;
}

async function seedReport(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  skateEndTime: number,
  quality: 'great' | 'good' | 'fair' | 'poor',
  iceTypes: string[],
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
      skateQuality: quality,
      iceTypes: iceTypes as never,
      surfaceTags: [],
      moderationStatus: 'visible' as const,
      photoIds: [],
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  ) as Promise<Id<'reports'>>;
}

/** Open-Meteo response with `n` hours of a uniform temperature ending just before the new skate. */
function weatherBetween(newSkateMs: number, tempC: number, n = 6) {
  const s = (hoursBeforeNew: number) => Math.floor((newSkateMs - hoursBeforeNew * HOUR_MS) / 1000);
  return {
    utc_offset_seconds: -18000,
    hourly: {
      time: Array.from({ length: n }, (_, i) => s(n - i)),
      temperature_2m: Array.from({ length: n }, () => tempC),
      precipitation: Array.from({ length: n }, () => 0),
      rain: Array.from({ length: n }, () => 0),
      snowfall: Array.from({ length: n }, () => 0),
      snow_depth: Array.from({ length: n }, () => 0),
      wind_speed_10m: Array.from({ length: n }, () => 5),
      wind_gusts_10m: Array.from({ length: n }, () => 8),
      cloud_cover: Array.from({ length: n }, () => 50),
      sunshine_duration: Array.from({ length: n }, () => 0),
      shortwave_radiation: Array.from({ length: n }, () => 0),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contradictions.evaluateContradictions', () => {
  test('records a weather-unexplained contradiction on both reports + the author counter', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const other = await seedProfile(t, 'other');
    const newSkate = Date.now() - DAY_MS;
    const priorId = await seedReport(t, bodyId, other, newSkate - DAY_MS, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, author, newSkate, 'poor', ['snow_ice']);
    // Quiet weather between them (~0°C) → nothing explains a great→poor flip → a real contradiction.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(weatherBetween(newSkate, -0.5)), { status: 200 }),
      ),
    );

    await t.action(internal.contradictions.evaluateContradictions, { reportId: newId });

    expect((await t.run((ctx) => ctx.db.get(newId)))?.conflicting).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(priorId)))?.conflicting).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(author)))?.contradictionCount).toBe(1);
  });

  test('does NOT record when the weather-since explains the change (honest "ice changed")', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedProfile(t, 'author');
    const other = await seedProfile(t, 'other');
    const newSkate = Date.now() - DAY_MS;
    const priorId = await seedReport(t, bodyId, other, newSkate - DAY_MS, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, author, newSkate, 'poor', ['snow_ice']);
    // A hard freeze between them plausibly changed the ice → not a contradiction.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(weatherBetween(newSkate, -20)), { status: 200 }),
      ),
    );

    await t.action(internal.contradictions.evaluateContradictions, { reportId: newId });

    expect((await t.run((ctx) => ctx.db.get(newId)))?.conflicting).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(priorId)))?.conflicting).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(author)))?.contradictionCount ?? 0).toBe(0);
  });

  test('escalates to a moderator flag once the pattern threshold is crossed', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedProfile(t, 'author', { contradictionCount: 2 }); // one away from the threshold
    const other = await seedProfile(t, 'other');
    const newSkate = Date.now() - DAY_MS;
    await seedReport(t, bodyId, other, newSkate - DAY_MS, 'great', ['black_ice']);
    const newId = await seedReport(t, bodyId, author, newSkate, 'poor', ['snow_ice']);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(weatherBetween(newSkate, -0.5)), { status: 200 }),
      ),
    );

    await t.action(internal.contradictions.evaluateContradictions, { reportId: newId });

    expect((await t.run((ctx) => ctx.db.get(author)))?.contradictionCount).toBe(3);
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags).toHaveLength(1);
    expect(flags[0]?.targetType).toBe('user');
    expect(flags[0]?.targetId).toBe(author);
    expect(flags[0]?.reason).toBe('unsafe_false_report');
    // Never a reputation penalty — trust stays boost-only (D50).
    expect((await t.run((ctx) => ctx.db.get(author)))?.reputationPoints).toBe(0);
  });
});
