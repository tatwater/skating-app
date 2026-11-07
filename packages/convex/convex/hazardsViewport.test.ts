import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { HAZARD_VIEWPORT_SCAN_CAP } from './hazards';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 0, 10, 15);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof convexTest>;

async function seedAuthor(t: T) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'clerk_a',
      displayName: 'a',
      username: 'a',
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
    }),
  );
}

async function seedBody(t: T, lat: number, lng: number) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      source: 'osm',
      name: `Lake ${lat}`,
      searchText: `Lake ${lat}`,
      type: 'lakePond',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [lng - 0.05, lat - 0.05],
            [lng + 0.05, lat - 0.05],
            [lng + 0.05, lat + 0.05],
            [lng - 0.05, lat + 0.05],
            [lng - 0.05, lat - 0.05],
          ],
        ],
      },
      bbox: { minLat: lat - 0.05, minLng: lng - 0.05, maxLat: lat + 0.05, maxLng: lng + 0.05 },
      centroid: { lat, lng },
      dedupStatus: 'clean',
      createdAt: T0,
    }),
  );
}

async function seedHazard(
  t: T,
  waterBodyId: Id<'waterBodies'>,
  authorId: Id<'profiles'>,
  at: { lat: number; lng: number },
  extra: Partial<Doc<'hazards'>> = {},
) {
  const d = 0.0005;
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
      radiusMeters: 30,
      bbox: { minLat: at.lat - d, minLng: at.lng - d, maxLat: at.lat + d, maxLng: at.lng + d },
      createdByUserId: authorId,
      photoIds: [],
      status: 'active',
      moderationStatus: 'visible',
      firstReportedAt: T0 - HOUR,
      lastConfirmedAt: T0 - HOUR,
      confirmCount: 0,
      goneCount: 0,
      createdAt: T0 - HOUR,
      ...extra,
    }),
  );
}

const VIEW = { minLat: 43.9, minLng: -72.1, maxLat: 44.1, maxLng: -71.9 };

describe('hazards.listInViewport (B03 §11)', () => {
  test('returns the live pins whose footprint touches the viewport, across lakes', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const a = await seedBody(t, 44.0, -72.0);
    const b = await seedBody(t, 44.05, -71.95);
    const far = await seedBody(t, 45.0, -73.0);
    const inA = await seedHazard(t, a, author, { lat: 44.0, lng: -72.0 });
    const inB = await seedHazard(
      t,
      b,
      author,
      { lat: 44.05, lng: -71.95 },
      {
        lastConfirmedAt: T0 - 2 * HOUR,
      },
    );
    await seedHazard(t, far, author, { lat: 45.0, lng: -73.0 });
    const { hazards, truncated } = await t.query(api.hazards.listInViewport, { viewport: VIEW });
    expect(hazards.map((h) => h._id)).toEqual([inA, inB]);
    expect(truncated).toBe(false);
  });

  test('a stale pin comes back annotated, never dropped (D3)', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const a = await seedBody(t, 44.0, -72.0);
    await seedHazard(
      t,
      a,
      author,
      { lat: 44.0, lng: -72.0 },
      {
        firstReportedAt: T0 - 20 * DAY,
        lastConfirmedAt: T0 - 20 * DAY,
      },
    );
    const { hazards } = await t.query(api.hazards.listInViewport, { viewport: VIEW });
    expect(hazards).toHaveLength(1);
    expect(hazards[0]?.freshness).not.toBe('fresh');
  });

  test('archived, hidden, merged, last-season and expired-crossing pins stay off', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const a = await seedBody(t, 44.0, -72.0);
    const at = { lat: 44.0, lng: -72.0 };
    const survivor = await seedHazard(t, a, author, at);
    await seedHazard(t, a, author, at, { status: 'archived' });
    await seedHazard(t, a, author, at, { moderationStatus: 'hidden' });
    await seedHazard(t, a, author, at, { mergedIntoHazardId: survivor });
    await seedHazard(t, a, author, at, {
      firstReportedAt: Date.UTC(2025, 0, 10),
      lastConfirmedAt: T0 - HOUR,
    });
    await seedHazard(
      t,
      a,
      author,
      { lat: 44.01, lng: -72.01 },
      {
        type: 'ridge_crossing',
        geometryKind: 'line',
        firstReportedAt: T0 - 4 * DAY,
        lastConfirmedAt: T0 - 4 * DAY,
      },
    );
    const { hazards } = await t.query(api.hazards.listInViewport, { viewport: VIEW });
    expect(hazards.map((h) => h._id)).toEqual([survivor]);
    // A past season is reachable by asking for it.
    const past = await t.query(api.hazards.listInViewport, { viewport: VIEW, season: 2024 });
    expect(past.hazards).toHaveLength(1);
  });

  test('a lake with nothing in view costs no clustering, and an empty region is empty', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const far = await seedBody(t, 45.0, -73.0);
    await seedHazard(t, far, author, { lat: 45.0, lng: -73.0 });
    expect(await t.query(api.hazards.listInViewport, { viewport: VIEW })).toEqual({
      hazards: [],
      truncated: false,
    });
  });

  test('a cluster pools across the viewport edge, the same as the lake view', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const other = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'clerk_b',
        displayName: 'b',
        username: 'b',
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
      }),
    );
    const a = await seedBody(t, 44.0, -72.0);
    // Two reporters, one ridge, straddling the viewport's north edge: one pin in view, one not.
    const box = (lat: number) => ({
      minLat: lat - 0.0003,
      minLng: -72.0004,
      maxLat: lat + 0.0003,
      maxLng: -71.9996,
    });
    const inside = await seedHazard(
      t,
      a,
      author,
      { lat: 44.09985, lng: -72.0 },
      {
        bbox: box(44.09985),
      },
    );
    await seedHazard(t, a, other, { lat: 44.10045, lng: -72.0 }, { bbox: box(44.10045) });
    const region = await t.query(api.hazards.listInViewport, { viewport: VIEW });
    const lake = await t.query(api.hazards.listForBody, { waterBodyId: a });
    expect(region.hazards.map((h) => h._id)).toEqual([inside]);
    expect(region.hazards[0]?.clusterMemberIds).toHaveLength(2);
    expect(region.hazards[0]).toEqual(lake.find((h) => h._id === inside));
  });

  test('says truncated past the scan cap rather than reading as the whole truth (D5)', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const a = await seedBody(t, 44.0, -72.0);
    await t.run(async (ctx) => {
      for (let i = 0; i <= HAZARD_VIEWPORT_SCAN_CAP; i++) {
        await ctx.db.insert('hazards', {
          waterBodyId: a,
          type: 'pressure_ridge',
          geometryKind: 'point_radius',
          geometry: { type: 'Point', coordinates: [-72.0 + i * 0.001, 45.5] },
          radiusMeters: 5,
          bbox: {
            minLat: 45.5,
            minLng: -72.0 + i * 0.001,
            maxLat: 45.5,
            maxLng: -72.0 + i * 0.001,
          },
          createdByUserId: author,
          photoIds: [],
          status: 'active',
          moderationStatus: 'visible',
          firstReportedAt: T0 - HOUR - i,
          lastConfirmedAt: T0 - HOUR,
          confirmCount: 0,
          goneCount: 0,
          createdAt: T0,
        });
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { truncated } = await t.query(api.hazards.listInViewport, { viewport: VIEW });
    expect(truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('hazards.get — the place line (B03 §11)', () => {
  async function seedLandmark(
    t: T,
    waterBodyId: Id<'waterBodies'>,
    name: string,
    point: { lat: number; lng: number },
    extra: Partial<Doc<'bodyLandmarks'>> = {},
  ) {
    return t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId,
        name,
        kind: 'bridge',
        point,
        source: 'osm',
        externalIds: [],
        aliases: [],
        createdAt: T0,
        updatedAt: T0,
        ...extra,
      }),
    );
  }

  test("the bay and the nearest live landmark within the radius: 'The Narrows, by Shaker Bridge'", async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const a = await seedBody(t, 44.0, -72.0);
    await seedLandmark(t, a, 'Shaker Bridge', { lat: 44.001, lng: -72.0 }); // ~110 m
    await seedLandmark(t, a, 'Farther Point', { lat: 44.003, lng: -72.0 }); // ~330 m
    await seedLandmark(t, a, 'Gone Island', { lat: 44.0001, lng: -72.0 }, { removedAt: T0 });
    const id = await seedHazard(
      t,
      a,
      author,
      { lat: 44.0, lng: -72.0 },
      {
        subAreaName: 'The Narrows',
      },
    );
    expect((await t.query(api.hazards.get, { hazardId: id }))?.placeLine).toBe(
      'The Narrows, by Shaker Bridge',
    );
  });

  test('nothing derivable, nothing said; a landmark past the radius is not "by"', async () => {
    const t = convexTest(schema, modules);
    const author = await seedAuthor(t);
    const a = await seedBody(t, 44.0, -72.0);
    await seedLandmark(t, a, 'Far Bridge', { lat: 44.02, lng: -72.0 }); // ~2.2 km
    const id = await seedHazard(t, a, author, { lat: 44.0, lng: -72.0 });
    expect((await t.query(api.hazards.get, { hazardId: id }))?.placeLine).toBeUndefined();
    const withBay = await seedHazard(
      t,
      a,
      author,
      { lat: 44.0, lng: -72.0 },
      {
        subAreaName: 'North Bay',
      },
    );
    expect((await t.query(api.hazards.get, { hazardId: withBay }))?.placeLine).toBe('North Bay');
  });
});
