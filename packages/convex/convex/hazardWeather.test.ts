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

  test('scans stalest-first, so the per-tick cap rotates through the backlog (N1)', async () => {
    // Greptile PR #27: the sweep used to read `by_status`, whose order never changes — so once the
    // active set passed ACTIVE_HAZARD_SCAN_CAP, every hourly tick re-read the same prefix and the
    // hazards behind it kept absent decay and snow-hidden state forever. The cadence gate can't
    // rescue that: it filters rows that have *already* been read. Ordering by `weatherAdjustedAt`
    // makes a refresh push its hazard to the back of the queue, so the cap rotates.
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const now = Date.now();
    // Inserted freshest-first, so creation order is the exact opposite of the order wanted.
    const justRefreshed = await seedHazard(t, waterBodyId, authorId, {
      weatherAdjustedAt: now - HOUR_MS,
    });
    const longStale = await seedHazard(t, waterBodyId, authorId, {
      weatherAdjustedAt: now - 50 * HOUR_MS,
    });
    const neverRefreshed = await seedHazard(t, waterBodyId, authorId); // no weatherAdjustedAt

    const { jobs } = await t.query(internal.hazardWeather.listActiveHazardsForWeather, {});
    expect(jobs.map((j) => j.hazardId)).toEqual([neverRefreshed, longStale, justRefreshed]);
  });

  test('a hazard the sweep skips is rotated out of the queue, not left at its head (N1)', async () => {
    // Greptile PR #27 round 5: stalest-first only rotates what actually gets stamped. A hazard the
    // sweep declines to refresh is never stamped, so on an `undefined`-first index it sorts to the
    // front FOREVER and holds a slot in the cap against everything behind it — the same starvation
    // one level in. Hidden pins are excluded by the index now; the two that can only be judged after
    // reading get stamped so they move to the back.
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const removedBodyId = await seedBody(t, { removedAt: Date.now() });
    const authorId = await seedProfile(t);
    const featureId = await t.run((ctx) =>
      ctx.db.insert('bodyFeatures', {
        waterBodyId,
        type: 'spring_current' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point', coordinates: [-72.0, 44.0] },
        radiusMeters: 20,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        addedByUserId: authorId,
        active: true,
        createdAt: Date.now(),
      }),
    );
    // Three ineligible-but-active hazards, all never refreshed, so all ahead of the real one.
    const hidden = await seedHazard(t, waterBodyId, authorId, { moderationStatus: 'hidden' });
    const promoted = await seedHazard(t, waterBodyId, authorId, {
      promotedToFeatureId: featureId,
    });
    const onRemovedBody = await seedHazard(t, removedBodyId, authorId);
    const real = await seedHazard(t, waterBodyId, authorId);

    const listed = await t.query(internal.hazardWeather.listActiveHazardsForWeather, {});
    // Hidden never even enters the scan — the index excludes it, so it can't hold a slot.
    expect(listed.jobs.map((j) => j.hazardId)).toEqual([real]);
    expect(listed.deferred.sort()).toEqual([promoted, onRemovedBody].sort());

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(coldSnowyResponse(Date.now())), { status: 200 }),
      ),
    );
    await t.action(internal.hazardWeather.refreshHazardWeather, {});

    // Every row the sweep touched now carries a stamp, so next tick's cap starts past all of them.
    const stamps = await t.run(async (ctx) => ({
      promoted: (await ctx.db.get(promoted))?.weatherAdjustedAt,
      onRemovedBody: (await ctx.db.get(onRemovedBody))?.weatherAdjustedAt,
      real: (await ctx.db.get(real))?.weatherAdjustedAt,
      hidden: (await ctx.db.get(hidden))?.weatherAdjustedAt,
    }));
    expect(stamps.promoted).toBeGreaterThan(0);
    expect(stamps.onRemovedBody).toBeGreaterThan(0);
    expect(stamps.real).toBeGreaterThan(0);
    expect(stamps.hidden).toBeUndefined(); // never read, so nothing to rotate
    // A promoted pin gets no invented decay — only its place in the queue moves.
    const promotedDoc = await t.run((ctx) => ctx.db.get(promoted));
    expect(promotedDoc?.decayMultiplier).toBeUndefined();
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

  test('drops a stale multiplier write when a confirmation advanced lastConfirmedAt mid-refresh (§6 CAS)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const now = Date.now();
    // The hazard's clock has SINCE been advanced by a fresh confirmation (which also cleared the multiplier).
    const hazardId = await seedHazard(t, waterBodyId, authorId, { lastConfirmedAt: now });
    const staleEpoch = now - 6 * HOUR_MS; // the OLD window an in-flight refresh had snapshotted

    // The in-flight refresh finally commits its old-window multiplier — the CAS guard must reject it, or it
    // would resurrect stale weather against the new epoch that the confirmation just cleared.
    await t.mutation(internal.hazardWeather.storeHazardWeather, {
      hazardId,
      decayMultiplier: 1.9,
      snowHidden: true,
      weatherAdjustedAt: now,
      expectedLastConfirmedAt: staleEpoch,
    });

    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBeUndefined(); // dropped, not resurrected
    expect(h?.weatherAdjustedAt).toBeUndefined();
  });

  test('stores the multiplier when the confirmation epoch still matches (§6 CAS)', async () => {
    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const now = Date.now();
    const epoch = now - 6 * HOUR_MS;
    const hazardId = await seedHazard(t, waterBodyId, authorId, { lastConfirmedAt: epoch });

    await t.mutation(internal.hazardWeather.storeHazardWeather, {
      hazardId,
      decayMultiplier: 1.9,
      snowHidden: true,
      weatherAdjustedAt: now,
      expectedLastConfirmedAt: epoch, // unchanged ⇒ the write applies
    });

    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBe(1.9);
    expect(h?.snowHidden).toBe(true);
    expect(h?.weatherAdjustedAt).toBe(now);
  });
});

/** Open-Meteo response: 6 recent hours well above freezing (thaw ⇒ open_water persists, m < 1). */
function warmResponse(nowMs: number) {
  const s = (hoursAgo: number) => Math.floor((nowMs - hoursAgo * HOUR_MS) / 1000);
  const n = 6;
  return {
    utc_offset_seconds: -18000,
    hourly: {
      time: Array.from({ length: n }, (_, i) => s(n - i)),
      temperature_2m: Array.from({ length: n }, () => 5),
      precipitation: Array.from({ length: n }, () => 0),
      rain: Array.from({ length: n }, () => 0),
      snowfall: Array.from({ length: n }, () => 0),
      snow_depth: Array.from({ length: n }, () => 0),
      wind_speed_10m: Array.from({ length: n }, () => 8),
      wind_gusts_10m: Array.from({ length: n }, () => 15),
      cloud_cover: Array.from({ length: n }, () => 20),
      sunshine_duration: Array.from({ length: n }, () => 1800),
      shortwave_radiation: Array.from({ length: n }, () => 200),
    },
  };
}

/** Run one sweep against a body seeded with `extra`, returning the stored multiplier. */
async function multiplierFor(bodyExtra: Record<string, unknown>, response: 'warm' | 'cold') {
  const t = convexTestWithGeo();
  const waterBodyId = await seedBody(t, bodyExtra);
  const authorId = await seedProfile(t);
  const hazardId = await seedHazard(t, waterBodyId, authorId);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            response === 'warm' ? warmResponse(Date.now()) : coldSnowyResponse(Date.now()),
          ),
          { status: 200 },
        ),
    ),
  );
  await t.action(internal.hazardWeather.refreshHazardWeather, {});
  const h = await t.run((ctx) => ctx.db.get(hazardId));
  return { t, waterBodyId, multiplier: h?.decayMultiplier };
}

describe('hazardWeather — shallow bodies (N6a / D69)', () => {
  test('a shallow lake persists an open-water warning longer than a deep one', async () => {
    const deep = await multiplierFor({ meanDepthM: 25, meanDepthSource: 'lagos_us' }, 'warm');
    const shallow = await multiplierFor({ meanDepthM: 2, meanDepthSource: 'lagos_us' }, 'warm');
    expect(deep.multiplier).toBeLessThan(1); // thaw ⇒ persist (D56)
    expect(shallow.multiplier).toBeLessThan(deep.multiplier as number); // …and more so when shallow
  });

  test('the max-depth fallback classifies a body with no mean depth', async () => {
    const deep = await multiplierFor({ maxDepthM: 40, maxDepthSource: 'globathy' }, 'warm');
    const shallow = await multiplierFor({ maxDepthM: 4, maxDepthSource: 'globathy' }, 'warm');
    expect(shallow.multiplier).toBeLessThan(deep.multiplier as number);
  });

  test('a `shallow_early_thaw` bodyFeature counts even with no depth at all', async () => {
    // The path for the 73% of the corpus below every global source's area floor — and the whole reason
    // shallowness is a boolean rather than a curve. Before N6a this feature was wired to nothing.
    const plain = await multiplierFor({}, 'warm');

    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const hazardId = await seedHazard(t, waterBodyId, authorId);
    await t.run((ctx) =>
      ctx.db.insert('bodyFeatures', {
        waterBodyId,
        type: 'shallow_early_thaw' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point', coordinates: [-72.0, 44.0] },
        radiusMeters: 100,
        bbox: { minLat: 43.999, minLng: -72.001, maxLat: 44.001, maxLng: -71.999 },
        addedByUserId: authorId,
        active: true,
        createdAt: Date.now(),
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(warmResponse(Date.now())), { status: 200 })),
    );
    await t.action(internal.hazardWeather.refreshHazardWeather, {});
    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBeLessThan(plain.multiplier as number);
  });

  test('an INACTIVE shallow feature does not count (demotion is reversible, D53)', async () => {
    const plain = await multiplierFor({}, 'warm');

    const t = convexTestWithGeo();
    const waterBodyId = await seedBody(t);
    const authorId = await seedProfile(t);
    const hazardId = await seedHazard(t, waterBodyId, authorId);
    await t.run((ctx) =>
      ctx.db.insert('bodyFeatures', {
        waterBodyId,
        type: 'shallow_early_thaw' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point', coordinates: [-72.0, 44.0] },
        radiusMeters: 100,
        bbox: { minLat: 43.999, minLng: -72.001, maxLat: 44.001, maxLng: -71.999 },
        addedByUserId: authorId,
        active: false,
        createdAt: Date.now(),
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(warmResponse(Date.now())), { status: 200 })),
    );
    await t.action(internal.hazardWeather.refreshHazardWeather, {});
    const h = await t.run((ctx) => ctx.db.get(hazardId));
    expect(h?.decayMultiplier).toBe(plain.multiplier);
  });

  test('in COLD weather a shallow body is treated exactly like a deep one (D69 is one-sided)', async () => {
    // The invariant the decision turns on: shallowness must never speed cold-side healing.
    const deep = await multiplierFor({ meanDepthM: 25, meanDepthSource: 'lagos_us' }, 'cold');
    const shallow = await multiplierFor({ meanDepthM: 2, meanDepthSource: 'lagos_us' }, 'cold');
    expect(deep.multiplier).toBeGreaterThan(1);
    expect(shallow.multiplier).toBe(deep.multiplier);
  });
});
