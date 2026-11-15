/**
 * The Body console's reads (B01-3): the frame's extras, bays' provenance, the body-scoped history,
 * places, landmarks' provenance and proposers, the winters' daily hazards, and the Standing tab's
 * retention facts.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { bayViaOf, daysCovered, winterWindow } from './bodyConsole';
import { markGeoStale } from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { syncAdminAreaCells, syncWaterBodyCells } from './lib/cellIndex';
import { SAVED_PUT_IN_HIDDEN_READ } from './lib/standing';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const NOW = Date.UTC(2027, 0, 15, 12);
const DAY = 86_400_000;
const ACRE = 4046.8564224;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const NOTIF_PREFS = {
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
};

/** A square centered at (lng, lat) with half-width `h` degrees. */
function square(lng: number, lat: number, h: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng - h, lat - h],
        [lng + h, lat - h],
        [lng + h, lat + h],
        [lng - h, lat + h],
        [lng - h, lat - h],
      ],
    ],
  };
}
const boxOf = (lng: number, lat: number, h: number) => ({
  minLng: lng - h,
  maxLng: lng + h,
  minLat: lat - h,
  maxLat: lat + h,
});

let seq = 0;
async function seedUser(t: T, role: 'member' | 'moderator' | 'admin' = 'moderator') {
  const n = seq++;
  const subject = `console-${role}-${n}`;
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `Robin ${n}`,
      username: `robin-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(
  t: T,
  over: Partial<Doc<'waterBodies'>> & { name: string; at?: [number, number]; half?: number },
): Promise<Id<'waterBodies'>> {
  const { at = [-72, 44], half = 0.01, ...rest } = over;
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodies', {
      searchText: rest.name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(at[0], at[1], half),
      bbox: boxOf(at[0], at[1], half),
      centroid: { lat: at[1], lng: at[0] },
      states: ['VT'],
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      minVisibleZoom: 8,
      ...rest,
    });
    await syncWaterBodyCells(ctx, id, {
      bbox: boxOf(at[0], at[1], half),
      minVisibleZoom: 8,
      listed: true,
    });
    return id;
  });
}

/** Build every body's library row, then compute every body's geometry facts (as the jobs would). */
async function computeGeo(t: T) {
  await t.run(async (ctx) => {
    for (const b of await ctx.db.query('waterBodies').collect()) {
      await rebuildBodyLibrary(ctx, b._id);
      await markGeoStale(ctx, [b._id]);
    }
  });
  await t.action(internal.bodyGeo.computeDue, {});
}

/** Link every audit row to its bodies (rows inserted directly bypass `writeAudit`), then read History. */
async function historyOf(
  t: T,
  as: ReturnType<T['withIdentity']>,
  args: {
    waterBodyId: Id<'waterBodies'>;
    action?: Doc<'moderationActions'>['action'];
    bodyOnly?: boolean;
    limit?: number;
  },
) {
  for (let cursor: string | undefined, i = 0; i < 1000; i++) {
    const page = await t.mutation(internal.auditLinks.backfill, {
      chain: false,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (page.isDone) break;
    cursor = page.continueCursor ?? undefined;
  }
  return as.query(api.bodyConsole.history, args);
}

describe('pure helpers', () => {
  test('a bay’s way is its via, or its words for rows written before', () => {
    expect(bayViaOf({ metadata: { via: 'chord' }, reason: 'x' })).toBe('chord');
    expect(bayViaOf({ metadata: {}, reason: 'Seeded "X" on Y' })).toBe('seed');
    expect(bayViaOf({ metadata: undefined, reason: 'A07a campaign: …' })).toBe('catalog');
    expect(bayViaOf({ metadata: { via: 7 }, reason: 'Drew "X"' })).toBe('drawn');
  });
  test('a span counts on every day it overlaps inside the winter', () => {
    const w = winterWindow(2026);
    // The season's span, as the Hazards tab's list covers it: 1 July to the next 1 July.
    expect(w).toEqual({ start: Date.UTC(2026, 6, 1), end: Date.UTC(2027, 6, 1) });
    expect(daysCovered(w.start - DAY, w.start + DAY / 2, w)).toEqual([w.start]);
    expect(daysCovered(w.start + DAY / 2, w.start + 2 * DAY + 1, w)).toHaveLength(3);
    expect(daysCovered(w.end, w.end + DAY, w)).toEqual([]);
  });
});

describe('consoleExtras', () => {
  test('towns, bathymetry, the outline’s trust and the touching bodies', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, {
      name: 'Center Pond',
      externalId: 'way/1',
      source: 'user',
      geometrySource: 'user',
    });
    const touching = await seedBody(t, { name: 'Neighbor', at: [-71.98, 44], half: 0.01 });
    await seedBody(t, { name: 'Far', at: [-71.9, 44], half: 0.005 });
    await t.run(async (ctx) => {
      const town = await ctx.db.insert('adminAreas', {
        name: 'Enfield',
        level: 'town',
        state: 'NH',
        externalId: 'relation/9',
        polygon: square(-72, 44, 0.2),
        bbox: boxOf(-72, 44, 0.2),
        centroid: { lat: 44, lng: -72 },
        createdAt: NOW,
      });
      await syncAdminAreaCells(ctx, town, { bbox: boxOf(-72, 44, 0.2), level: 'town' });
      await ctx.db.insert('moderationActions', {
        actorId: mod,
        action: 'approve_waterbody',
        targetType: 'waterbody',
        targetId: id,
        reason: 'ok',
        createdAt: NOW - DAY,
      });
    });
    // Not computed yet: the stored answers read null, never "none".
    expect(await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id })).toMatchObject({
      towns: null,
      touchingBodyIds: null,
      touching: null,
      geoComputedAt: null,
    });
    expect(await as.query(api.bodyConsole.places, { waterBodyId: id })).toBeNull();
    await computeGeo(t);
    const x = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    expect(x.touching).toEqual([
      { waterBodyId: touching, name: 'Neighbor', ring: expect.any(Array) },
    ]);
    expect(x).toMatchObject({
      towns: ['Enfield'],
      hasBathymetry: false,
      outlineTrustedSince: NOW - DAY,
      outlineTrustedVia: 'approved',
      touchingBodyIds: [touching],
      touchingCapped: false,
    });
    const places = await as.query(api.bodyConsole.places, { waterBodyId: id });
    expect(places).toMatchObject({ towns: ['Enfield'], counties: [], states: ['NH'] });
    // A merged-away id reads its survivor's extras, the vouching included.
    const gone = await seedBody(t, { name: 'Merged Away', at: [-70, 42] });
    await t.run((ctx) => ctx.db.patch(gone, { dedupStatus: 'merged', mergedIntoId: id }));
    expect(await as.query(api.bodyConsole.consoleExtras, { waterBodyId: gone })).toEqual(
      await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id }),
    );
  });

  test('a pond beside a large lake touches it, though the lake’s sampled ring passes it by', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    // A lake 0.1° across whose ring has 4,000 vertices: sampled 48 times, its east shore is tested
    // every ~0.008°, and the pond sits between two samples, ~8 m off that shore.
    const h = 0.05;
    const n = 1000;
    const edge = (from: [number, number], to: [number, number]) =>
      Array.from({ length: n }, (_, i) => [
        from[0] + ((to[0] - from[0]) * i) / n,
        from[1] + ((to[1] - from[1]) * i) / n,
      ]);
    const [w, e, s, nn] = [-72 - h, -72 + h, 44 - h, 44 + h];
    const ring = [
      ...edge([w, s], [e, s]),
      ...edge([e, s], [e, nn]),
      ...edge([e, nn], [w, nn]),
      ...edge([w, nn], [w, s]),
      [w, s],
    ];
    const lake = await seedBody(t, {
      name: 'Big Lake',
      half: h,
      polygon: { type: 'Polygon', coordinates: [ring] },
    });
    const pond = await seedBody(t, { name: 'Side Pond', at: [e + 0.0011, 44.0035], half: 0.001 });
    await computeGeo(t);
    const x = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: pond });
    expect(x.touchingBodyIds).toEqual([lake]);
  });

  test('a catalog body is trusted since its campaign; no boundary is no town', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, {
      name: 'Campaigned',
      lastCampaignId: 'c-1',
      externalId: 'way/2',
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('importRuns', {
        kind: 'canonical_water',
        label: 'run',
        campaignId: 'c-1',
        deployment: 'dev',
        isProd: false,
        status: 'succeeded',
        startedAt: NOW - 10 * DAY,
        counts: [],
        stages: [],
        failures: [],
        failuresTotal: 0,
      });
      await ctx.db.insert('bathymetryCoverage', { source: 'osm', externalId: 'way/2' });
    });
    const none = await seedBody(t, { name: 'Unstamped', at: [-71, 43] });
    await computeGeo(t);
    const x = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    // Computed, and in no town: an empty list, not "not computed".
    expect(x).toMatchObject({
      towns: [],
      hasBathymetry: true,
      outlineTrustedSince: NOW - 10 * DAY,
      outlineTrustedVia: 'campaign',
      touchingBodyIds: [],
    });
    expect(await as.query(api.bodyConsole.consoleExtras, { waterBodyId: none })).toMatchObject({
      outlineTrustedSince: null,
      outlineTrustedVia: null,
    });
    expect(await as.query(api.bodyConsole.places, { waterBodyId: none })).toEqual({
      towns: [],
      townsWithState: [],
      counties: [],
      states: [],
      computedAt: expect.any(Number),
    });
  });

  test('a member is refused; a missing body says so', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Gone' });
    await expect(
      member.as.query(api.bodyConsole.consoleExtras, { waterBodyId: id }),
    ).rejects.toThrow();
    await t.run((ctx) => ctx.db.delete(id));
    await expect(as.query(api.bodyConsole.consoleExtras, { waterBodyId: id })).rejects.toThrow(
      'Water body not found',
    );
  });
});

describe('bays, landmarks and history', () => {
  async function scene(t: T) {
    const mod = await seedUser(t);
    const id = await seedBody(t, { name: 'Storied Lake', surfaceAreaSqM: 900 * ACRE });
    const bay = await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: id,
        name: 'North Bay',
        searchText: 'North Bay',
        polygon: square(-72, 44, 0.005),
        bbox: boxOf(-72, 44, 0.005),
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: 10 * ACRE,
        displayScore: 0,
        minVisibleZoom: 10,
        createdByUserId: mod.id,
        createdAt: NOW - 5 * DAY,
        updatedAt: NOW,
      }),
    );
    const landmarks = await t.run(async (ctx) => {
      const base = {
        waterBodyId: id,
        kind: 'island' as const,
        point: { lat: 44, lng: -72 },
        externalIds: [],
        aliases: [],
        createdAt: NOW - 4 * DAY,
        updatedAt: NOW - 4 * DAY,
      };
      return {
        placed: await ctx.db.insert('bodyLandmarks', {
          ...base,
          name: 'Placed',
          source: 'moderator',
          createdByUserId: mod.id,
        }),
        catalog: await ctx.db.insert('bodyLandmarks', { ...base, name: 'Catalog', source: 'osm' }),
      };
    });
    await t.run(async (ctx) => {
      const rows = [
        ['create_sub_area', 'waterBodySubArea', bay, NOW - 5 * DAY, { via: 'chord' }],
        ['set_curated_boost', 'waterbody', id, NOW - 3 * DAY, undefined],
        ['set_public_access', 'waterbody', id, NOW - 2 * DAY, undefined],
        ['create_landmark', 'bodyLandmark', landmarks.placed, NOW - DAY, undefined],
        ['set_curated_boost', 'waterbody', id, NOW - DAY / 2, undefined],
      ] as const;
      for (const [action, targetType, targetId, createdAt, metadata] of rows) {
        await ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action,
          targetType,
          targetId,
          reason: action,
          ...(metadata ? { metadata } : {}),
          createdAt,
        });
      }
    });
    return { mod, id, bay, landmarks };
  }

  test('a bay’s when, way and maker', async () => {
    const t = harness();
    const { mod, id, bay } = await scene(t);
    expect(await mod.as.query(api.bodyConsole.bayProvenance, { waterBodyId: id })).toEqual([
      {
        subAreaId: bay,
        createdAt: NOW - 5 * DAY,
        createdVia: 'chord',
        createdBy: {
          userId: mod.id,
          username: expect.any(String),
          displayName: expect.any(String),
        },
      },
    ]);
    const listed = await mod.as.query(api.subAreas.listForBody, { waterBodyId: id });
    expect(listed[0]?.createdAt).toBe(NOW - 5 * DAY);
  });

  test('the history spans the body, its bays and its landmarks, newest first, and filters by verb', async () => {
    const t = harness();
    const { mod, id } = await scene(t);
    const all = await historyOf(t, mod.as, { waterBodyId: id });
    expect(all.entries.map((e) => e.action)).toEqual([
      'set_curated_boost',
      'create_landmark',
      'set_public_access',
      'set_curated_boost',
      'create_sub_area',
    ]);
    expect(all.capped).toBe(false);
    expect(all.entries[0]?.actor?.userId).toBe(mod.id);
    expect(all.entries[0]?.undo).toBeDefined();
    const boosts = await historyOf(t, mod.as, {
      waterBodyId: id,
      action: 'set_curated_boost',
      limit: 1,
    });
    expect(boosts.entries.map((e) => e.createdAt)).toEqual([NOW - DAY / 2]);
    expect(boosts.capped).toBe(true);
    const member = await seedUser(t, 'member');
    await expect(member.as.query(api.bodyConsole.history, { waterBodyId: id })).rejects.toThrow();
  });

  test('a body with hundreds of put-ins is not capped when its rows fit', async () => {
    const t = harness();
    const { mod, id } = await scene(t);
    await t.run(async (ctx) => {
      for (let i = 0; i <= 200; i++) {
        await ctx.db.insert('putIns', {
          waterBodyId: id,
          coord: { lat: 44 + i * 1e-4, lng: -72 },
          source: 'osm',
          status: 'visible',
          createdAt: NOW,
        });
      }
    });
    const all = await historyOf(t, mod.as, { waterBodyId: id });
    // Every row fits the page: a large family is no longer capped for its size alone.
    expect(all.entries).toHaveLength(5);
    expect(all.capped).toBe(false);
  });

  test('a catalog landmark folded by a merge keeps its receipt in the history', async () => {
    const t = harness();
    const { mod, id, landmarks } = await scene(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(landmarks.catalog, {
        removedAt: NOW - DAY / 4,
        mergedIntoId: landmarks.placed,
      });
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'remove',
        targetType: 'bodyLandmark',
        targetId: landmarks.catalog,
        reason: 'folded by a merge',
        createdAt: NOW - DAY / 4,
      });
    });
    const all = await historyOf(t, mod.as, { waterBodyId: id });
    expect(all.entries[0]).toMatchObject({ targetId: landmarks.catalog, action: 'remove' });
  });

  test('the history is the audit rows of the whole family, and capped: false means all of them', async () => {
    const t = harness();
    const { mod, id, bay, landmarks } = await scene(t);
    const other = await seedBody(t, { name: 'Elsewhere', at: [-71, 43] });
    const family = await t.run(async (ctx) => {
      // A body merged into this one, a removed bay, a hidden put-in, a lot, and a catalog landmark a
      // merge folded — none carrying the fields a "touched" filter would have looked for.
      const absorbed = await ctx.db.insert('waterBodies', {
        name: 'Absorbed',
        searchText: 'Absorbed',
        type: 'lakePond',
        source: 'osm',
        polygon: square(-72, 44, 0.002),
        bbox: boxOf(-72, 44, 0.002),
        centroid: { lat: 44, lng: -72 },
        dedupStatus: 'merged',
        mergedIntoId: id,
        createdAt: NOW,
      });
      await ctx.db.patch(bay, { removedAt: NOW - DAY });
      const putIn = await ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44, lng: -72 },
        source: 'osm',
        status: 'hidden',
        createdAt: NOW,
      });
      const lot = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44, lng: -72 },
        source: 'osm',
        status: 'visible',
        amenities: [],
        createdAt: NOW,
      });
      await ctx.db.insert('parkingAreaBodies', {
        parkingAreaId: lot,
        waterBodyId: id,
        inferred: true,
        createdAt: NOW,
      });
      await ctx.db.patch(landmarks.catalog, {
        removedAt: NOW - DAY / 4,
        mergedIntoId: landmarks.placed,
      });
      const rows = [
        ['merge_waterbody', 'waterbody', absorbed, NOW - DAY / 3],
        ['remove', 'waterBodySubArea', bay, NOW - DAY / 5],
        ['hide', 'putIn', putIn, NOW - DAY / 6],
        ['set_parking_area', 'parkingArea', lot, NOW - DAY / 7],
        ['remove', 'bodyLandmark', landmarks.catalog, NOW - DAY / 8],
        ['set_curated_boost', 'waterbody', other, NOW - DAY / 9],
      ] as const;
      for (const [action, targetType, targetId, createdAt] of rows) {
        await ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action,
          targetType,
          targetId,
          reason: action,
          createdAt,
        });
      }
      const ids = new Set<string>([
        id,
        absorbed,
        bay,
        putIn,
        lot,
        landmarks.placed,
        landmarks.catalog,
      ]);
      const all = await ctx.db.query('moderationActions').collect();
      return all
        .filter((r) => ids.has(r.targetId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => r._id as string);
    });
    const read = await historyOf(t, mod.as, { waterBodyId: id, limit: 100 });
    expect(read.capped).toBe(false);
    expect(read.entries.map((e) => e.id)).toEqual(family);
    expect(read.entries.map((e) => e.targetType)).toEqual(
      expect.arrayContaining([
        'waterbody',
        'waterBodySubArea',
        'putIn',
        'parkingArea',
        'bodyLandmark',
      ]),
    );
  });

  test('the family is every target the library files under the body: features, requests, place names, flags, and bodies merged through another', async () => {
    const t = harness();
    const { mod, id } = await scene(t);
    const family = await t.run(async (ctx) => {
      const polygon = square(-72, 44, 0.002);
      const tombstone = (name: string, into: Id<'waterBodies'>) =>
        ctx.db.insert('waterBodies', {
          name,
          searchText: name,
          type: 'lakePond',
          source: 'osm',
          polygon,
          bbox: boxOf(-72, 44, 0.002),
          centroid: { lat: 44, lng: -72 },
          dedupStatus: 'merged',
          mergedIntoId: into,
          createdAt: NOW,
        });
      // Absorbed into a body that was later merged here: it still points at the middle one.
      const middle = await tombstone('Middle', id);
      const twice = await tombstone('Twice Removed', middle);
      const feature = await ctx.db.insert('bodyFeatures', {
        waterBodyId: id,
        type: 'spring_current',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [-72, 44] },
        radiusMeters: 20,
        bbox: boxOf(-72, 44, 0.001),
        addedByUserId: mod.id,
        active: false,
        createdAt: NOW,
      });
      const request = await ctx.db.insert('waterBodyRequests', {
        kind: 'contest_access',
        status: 'approved',
        requesterId: mod.id,
        coord: { lat: 44, lng: -72 },
        waterBodyId: id,
        createdAt: NOW,
      });
      const placeName = await ctx.db.insert('corpusPlaceNames', {
        name: 'The Narrows',
        askKey: 'the narrows',
        aliases: [],
        messages: 3,
        skatedMessages: 1,
        states: ['VT'],
        waterBodyId: id,
        status: 'dismissed',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const flag = await ctx.db.insert('contentFlags', {
        flaggerId: mod.id,
        targetType: 'waterbody',
        targetId: id,
        reason: 'no_public_access',
        status: 'dismissed',
        createdAt: NOW,
      });
      const rows = [
        ['merge_waterbody', 'waterbody', twice, NOW - DAY / 3],
        ['demote_body_feature', 'bodyFeature', feature, NOW - DAY / 4],
        ['approve_request', 'waterBodyRequest', request, NOW - DAY / 5],
        ['remove', 'corpusPlaceName', placeName, NOW - DAY / 6],
        ['dismiss_flag', 'contentFlag', flag, NOW - DAY / 7],
      ] as const;
      const ids: string[] = [];
      for (const [action, targetType, targetId, createdAt] of rows) {
        ids.push(
          await ctx.db.insert('moderationActions', {
            actorId: mod.id,
            action,
            targetType,
            targetId,
            reason: action,
            createdAt,
          }),
        );
      }
      return ids;
    });
    const read = await historyOf(t, mod.as, { waterBodyId: id, limit: 100 });
    expect(read.capped).toBe(false);
    expect(read.entries.map((e) => e.id)).toEqual(expect.arrayContaining(family));
    // Access's rulings: one verb, as an index range on the request.
    const rulings = await historyOf(t, mod.as, {
      waterBodyId: id,
      action: 'approve_request',
    });
    expect(rulings.entries.map((e) => e.id)).toEqual([family[2]]);
  });

  test('the absorbed walk stops at its count and says so', async () => {
    const t = harness();
    const { mod, id } = await scene(t);
    await t.run(async (ctx) => {
      let first: Id<'waterBodies'> | undefined;
      for (let i = 0; i <= 50; i++) {
        const name = `Absorbed ${i}`;
        const b = await ctx.db.insert('waterBodies', {
          name,
          searchText: name,
          type: 'lakePond',
          source: 'osm',
          polygon: square(-72, 44, 0.002),
          bbox: boxOf(-72, 44, 0.002),
          centroid: { lat: 44, lng: -72 },
          dedupStatus: 'merged',
          mergedIntoId: first ?? id,
          createdAt: NOW,
        });
        first ??= b;
      }
    });
    const read = await historyOf(t, mod.as, { waterBodyId: id, limit: 100 });
    // Fifty-one merged into it: past the chain's bound, so the read says it may be incomplete.
    expect(read.capped).toBe(true);
    expect(new Set(read.entries.map((e) => e.id)).size).toBe(read.entries.length);
  });

  test('a limit that is missing, zero, huge or not a number is held to the read’s bounds', async () => {
    const t = harness();
    const { mod, id } = await scene(t);
    for (const [limit, rows] of [
      [undefined, 5],
      [0, 1],
      [1e9, 5],
      [Number.NaN, 5],
      [2.7, 2],
    ] as const) {
      const res = await historyOf(t, mod.as, {
        waterBodyId: id,
        ...(limit !== undefined ? { limit } : {}),
      });
      expect(res.entries).toHaveLength(rows);
    }
  });

  test('landmarks say who placed them; a proposal says who asked', async () => {
    const t = harness();
    const { mod, id, landmarks } = await scene(t);
    const asker = await seedUser(t, 'member');
    await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark',
        status: 'open',
        requesterId: asker.id,
        coord: { lat: 44, lng: -72 },
        waterBodyId: id,
        name: 'The Rock',
        createdAt: NOW - DAY,
      }),
    );
    const prov = await mod.as.query(api.bodyConsole.landmarkProvenance, { waterBodyId: id });
    const byId = new Map(prov.map((p) => [p.landmarkId, p]));
    expect(byId.get(landmarks.placed)?.createdBy?.userId).toBe(mod.id);
    expect(byId.get(landmarks.catalog)).toMatchObject({
      createdBy: null,
      source: 'osm',
      movedAt: null,
    });
    const proposers = await mod.as.query(api.bodyConsole.landmarkProposers, { waterBodyId: id });
    expect(proposers).toEqual([
      {
        requestId: expect.any(String),
        requester: expect.objectContaining({ userId: asker.id }),
        createdAt: NOW - DAY,
      },
    ]);
  });
});

describe('dailyHazards', () => {
  test('counts the days a hazard is established on the lake, marks an archived one’s later days unknown, and names the watch’s opening', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Ridged' });
    const start = Date.UTC(2027, 0, 10);
    await t.run(async (ctx) => {
      const base = {
        waterBodyId: id,
        type: 'pressure_ridge' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [-72, 44] },
        radiusMeters: 20,
        bbox: boxOf(-72, 44, 0.001),
        createdByUserId: mod,
        photoIds: [],
        moderationStatus: 'visible' as const,
        confirmCount: 0,
        goneCount: 0,
        createdAt: start,
        firstReportedAt: start,
        lastConfirmedAt: start,
      };
      await ctx.db.insert('hazards', { ...base, status: 'active' });
      const healed = await ctx.db.insert('hazards', { ...base, status: 'archived' });
      await ctx.db.insert('hazardConfirmations', {
        hazardId: healed,
        userId: mod,
        verdict: 'fully_healed',
        via: 'report_flow',
        createdAt: start + 2 * DAY,
      } as never);
      await ctx.db.insert('hazards', {
        ...base,
        status: 'archived',
        lastConfirmedAt: start + DAY,
      });
      await ctx.db.insert('hazards', { ...base, status: 'active', moderationStatus: 'hidden' });
      await ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-11-20',
        openedBy: [],
        winterFrom: null,
        sitesSampled: 0,
        detectedAt: NOW,
      });
    });
    const r = await as.query(api.bodyConsole.dailyHazards, { waterBodyId: id, now: NOW });
    expect(r.season).toBe(2026);
    // Both archived hazards: their end isn't stored, and a healed vote can't establish it.
    expect(r.unknownEnds).toBe(2);
    expect(r.watchOpensOn).toBe(Date.UTC(2026, 10, 20));
    const day = (d: number) => r.days.find((x) => x.at === start + d * DAY);
    // The first day: all three established. After it: the active one established, the two archived
    // unknown — never counted as gone.
    expect(day(0)).toMatchObject({ count: 3, unknown: 0 });
    expect(day(1)).toMatchObject({ count: 1, unknown: 2 });
    expect(day(5)).toMatchObject({ count: 1, unknown: 2 });
    expect(r.days.every((d) => d.at <= NOW)).toBe(true);
  });

  test('a recorded end counts through its day; days run through the caller’s whole day; the season opens in July', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Stamped' });
    const today = Math.floor(NOW / DAY) * DAY;
    const ids = await t.run(async (ctx) => {
      const pin = (at: number, extra: Partial<Doc<'hazards'>>) =>
        ctx.db.insert('hazards', {
          waterBodyId: id,
          type: 'pressure_ridge',
          geometryKind: 'point_radius',
          geometry: { type: 'Point' as const, coordinates: [-72, 44] },
          radiusMeters: 20,
          bbox: boxOf(-72, 44, 0.001),
          createdByUserId: mod,
          photoIds: [],
          moderationStatus: 'visible',
          confirmCount: 0,
          goneCount: 0,
          createdAt: at,
          firstReportedAt: at,
          lastConfirmedAt: at,
          status: 'active',
          ...extra,
        });
      return {
        // Archived three days after its first report, the end recorded.
        ended: await pin(today - 6 * DAY, { status: 'archived', leftLakeAt: today - 3 * DAY + 5 }),
        // Reported later today than the caller's clock: still today's count.
        late: await pin(NOW + 3_600_000, {}),
        // Reported in July, before the old October window opened.
        july: await pin(Date.UTC(2026, 6, 15), { status: 'archived' }),
      };
    });
    const r = await as.query(api.bodyConsole.dailyHazards, { waterBodyId: id, now: NOW });
    const day = (at: number) => r.days.find((x) => x.at === at) ?? { count: 0, unknown: 0 };
    // The recorded end: counted from its first report through the day it left, and no further.
    expect(day(today - 6 * DAY)).toMatchObject({ count: 1 });
    expect(day(today - 3 * DAY)).toMatchObject({ count: 1, unknown: 1 });
    expect(day(today - 2 * DAY)).toMatchObject({ count: 0, unknown: 1 });
    // Today counts the pin reported later today.
    expect(day(today)).toMatchObject({ count: 1 });
    expect(r.days.some((d) => d.at > today)).toBe(false);
    // The July pin is in the season: its first day counted, every day after unknown.
    expect(day(Date.UTC(2026, 6, 15))).toMatchObject({ count: 1, unknown: 0 });
    expect(day(Date.UTC(2026, 6, 16))).toMatchObject({ count: 0, unknown: 1 });
    expect(r.unknownEnds).toBe(1);
    expect(r.hazards).toEqual(
      expect.arrayContaining([
        {
          hazardId: ids.ended,
          firstReportedDay: today - 6 * DAY,
          endRecorded: true,
          endDay: today - 3 * DAY,
          type: 'pressure_ridge',
          passage: false,
        },
        {
          hazardId: ids.late,
          firstReportedDay: today,
          endRecorded: false,
          endDay: null,
          type: 'pressure_ridge',
          passage: false,
        },
        {
          hazardId: ids.july,
          firstReportedDay: Date.UTC(2026, 6, 15),
          endRecorded: false,
          endDay: null,
          type: 'pressure_ridge',
          passage: false,
        },
      ]),
    );
    expect(r.hazards).toHaveLength(3);
  });

  test('a reported crossing is counted apart, for the days it was live; a hazard beside it still counts (B01-3d)', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Crossed' });
    const today = Math.floor(NOW / DAY) * DAY;
    const start = today - 10 * DAY;
    const ids = await t.run(async (ctx) => {
      const pin = (type: Doc<'hazards'>['type']) =>
        ctx.db.insert('hazards', {
          waterBodyId: id,
          type,
          geometryKind: 'point_radius',
          geometry: { type: 'Point' as const, coordinates: [-72, 44] },
          radiusMeters: 15,
          bbox: boxOf(-72, 44, 0.001),
          createdByUserId: mod,
          photoIds: [],
          moderationStatus: 'visible',
          confirmCount: 0,
          goneCount: 0,
          createdAt: start,
          firstReportedAt: start,
          lastConfirmedAt: start,
          status: 'active',
        });
      return { crossing: await pin('ridge_crossing'), ridge: await pin('pressure_ridge') };
    });
    const r = await as.query(api.bodyConsole.dailyHazards, { waterBodyId: id, now: NOW });
    const day = (d: number) =>
      r.days.find((x) => x.at === start + d * DAY) ?? { count: 0, unknown: 0, crossings: 0 };
    // Live 72 hours from its last confirmation: days 0–3, never counted as a hazard.
    expect(day(0)).toMatchObject({ count: 1, crossings: 1 });
    expect(day(3)).toMatchObject({ count: 1, crossings: 1 });
    expect(day(4)).toMatchObject({ count: 1, crossings: 0 });
    expect(r.days.every((d) => d.count === 1 && d.unknown === 0)).toBe(true);
    expect(r.hazards).toEqual(
      expect.arrayContaining([
        {
          hazardId: ids.crossing,
          firstReportedDay: start,
          endRecorded: true,
          endDay: start + 3 * DAY,
          type: 'ridge_crossing',
          passage: true,
        },
        expect.objectContaining({ hazardId: ids.ridge, type: 'pressure_ridge', passage: false }),
      ]),
    );
    expect(r.unknownEnds).toBe(0);
  });

  test('a season or clock out of range reads as this season, at the server’s day', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Ranged' });
    for (const season of [Number.NaN, 1e9, 2026.5, -4]) {
      const r = await as.query(api.bodyConsole.dailyHazards, {
        waterBodyId: id,
        season,
        now: Number.NaN,
      });
      expect(r.season).toBe(2026);
    }
    const past = await as.query(api.bodyConsole.dailyHazards, { waterBodyId: id, season: 2020 });
    expect(past.season).toBe(2020);
  });

  test('a vote cast today changes no day of a past winter', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Last Winter' });
    const start = Date.UTC(2026, 0, 10); // the 2025 winter
    const hazard = await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: id,
        type: 'pressure_ridge',
        geometryKind: 'point_radius',
        geometry: { type: 'Point' as const, coordinates: [-72, 44] },
        radiusMeters: 20,
        bbox: boxOf(-72, 44, 0.001),
        createdByUserId: mod,
        photoIds: [],
        moderationStatus: 'visible',
        confirmCount: 0,
        goneCount: 0,
        createdAt: start,
        firstReportedAt: start,
        lastConfirmedAt: start + DAY,
        status: 'archived',
      }),
    );
    const read = () =>
      as.query(api.bodyConsole.dailyHazards, { waterBodyId: id, season: 2025, now: NOW });
    const before = await read();
    await t.run(async (ctx) => {
      // A confirmation and a healed vote cast today, on the archived hazard, as the writers allow.
      await ctx.db.patch(hazard, { lastConfirmedAt: NOW, confirmCount: 1 });
      await ctx.db.insert('hazardConfirmations', {
        hazardId: hazard,
        userId: mod,
        verdict: 'fully_healed',
        via: 'report_flow',
        createdAt: NOW,
      });
    });
    expect(await read()).toEqual(before);
    expect(before.days[0]).toMatchObject({ at: start, count: 1, unknown: 0 });
  });
});

describe('standing.retentionForBody', () => {
  test('the newest use, the boost and when it was set, favorites and saved put-ins', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Kept', curatedBoost: 0.4 });
    await t.run(async (ctx) => {
      await ctx.db.insert('moderationActions', {
        actorId: mod,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: id,
        reason: 'r',
        createdAt: NOW - 9 * DAY,
      });
      await ctx.db.insert('waterBodyFavorites', {
        userId: mod,
        waterBodyId: id,
        createdAt: NOW,
      } as never);
      await ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44, lng: -72 },
        source: 'official',
        status: 'visible',
        createdAt: NOW,
      });
    });
    const r = await as.query(api.standing.retentionForBody, { waterBodyId: id });
    expect(r).toEqual({
      curatedBoost: { value: 0.4, at: NOW - 9 * DAY },
      favorites: 1,
      favoritesCapped: false,
      savedPutIns: 1,
      savedPutInsCapped: false,
      putInKeeps: true,
    });
    // A boost set to zero is no boost: absent, as the rollover reads it.
    const bare = await seedBody(t, { name: 'Bare', curatedBoost: 0 });
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: bare })).toEqual({
      favorites: 0,
      favoritesCapped: false,
      savedPutIns: 0,
      savedPutInsCapped: false,
      putInKeeps: false,
    });
    await t.run((ctx) => ctx.db.delete(bare));
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: bare })).toBeNull();
  });

  test('putInKeeps is the rollover’s answer, though the tab’s wider read counts the body whole', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Many Hides' });
    // One launch, suppressed only by a hide past the rollover's read of hidden coordinates.
    await t.run(async (ctx) => {
      await ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44.05, lng: -72 },
        source: 'osm',
        status: 'visible',
        createdAt: NOW,
      });
      for (let i = 0; i <= SAVED_PUT_IN_HIDDEN_READ; i++) {
        await ctx.db.insert('putIns', {
          waterBodyId: id,
          coord:
            i === SAVED_PUT_IN_HIDDEN_READ
              ? { lat: 44.05, lng: -72 }
              : { lat: 44, lng: -72 + i * 0.005 },
          source: 'derived',
          status: 'hidden',
          createdAt: NOW,
        });
      }
    });
    // The tab reads every hide: no launch, counted whole. The rollover can't see the last hide, so
    // it keeps the body — and the tab says so.
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: id })).toMatchObject({
      savedPutIns: 0,
      savedPutInsCapped: false,
      putInKeeps: true,
    });
  });

  test('saved put-ins by the rollover’s rule: a persisted derived row counts, a hidden coord does not', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Legacy Launch' });
    const row = (coord: { lat: number; lng: number }, source: 'derived' | 'osm') => ({
      waterBodyId: id,
      coord,
      source,
      status: 'visible' as const,
      createdAt: NOW,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('putIns', row({ lat: 44, lng: -72 }, 'derived'));
      await ctx.db.insert('putIns', row({ lat: 44.005, lng: -72 }, 'osm'));
    });
    const saved = async () =>
      (await as.query(api.standing.retentionForBody, { waterBodyId: id }))?.savedPutIns;
    expect(await saved()).toBe(2);
    await t.run((ctx) =>
      ctx.db.insert('putIns', { ...row({ lat: 44.005, lng: -72 }, 'osm'), status: 'hidden' }),
    );
    expect(await saved()).toBe(1);
  });
});

describe('a merge chain’s history', () => {
  /** Every related kind on one body, each with an audit row; returns every target id it holds. */
  async function relatives(
    t: T,
    bodyId: Id<'waterBodies'>,
    mod: Id<'profiles'>,
    at: number,
  ): Promise<string[]> {
    return t.run(async (ctx) => {
      const bay = await ctx.db.insert('waterBodySubAreas', {
        waterBodyId: bodyId,
        name: 'A Bay',
        searchText: 'A Bay',
        polygon: square(-72, 44, 0.001),
        bbox: boxOf(-72, 44, 0.001),
        centroid: { lat: 44, lng: -72 },
        surfaceAreaSqM: ACRE,
        displayScore: 0,
        minVisibleZoom: 10,
        createdByUserId: mod,
        createdAt: at,
        updatedAt: at,
        removedAt: at,
      });
      const putIn = await ctx.db.insert('putIns', {
        waterBodyId: bodyId,
        coord: { lat: 44, lng: -72 },
        source: 'osm',
        status: 'hidden',
        createdAt: at,
      });
      const landmark = await ctx.db.insert('bodyLandmarks', {
        waterBodyId: bodyId,
        name: 'Folded',
        kind: 'island',
        point: { lat: 44, lng: -72 },
        source: 'osm',
        externalIds: [],
        aliases: [],
        removedAt: at,
        createdAt: at,
        updatedAt: at,
      });
      const lot = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44, lng: -72 },
        source: 'osm',
        status: 'visible',
        amenities: [],
        createdAt: at,
      });
      await ctx.db.insert('parkingAreaBodies', {
        parkingAreaId: lot,
        waterBodyId: bodyId,
        inferred: true,
        createdAt: at,
      });
      const feature = await ctx.db.insert('bodyFeatures', {
        waterBodyId: bodyId,
        type: 'spring_current',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [-72, 44] },
        bbox: boxOf(-72, 44, 0.001),
        addedByUserId: mod,
        active: false,
        createdAt: at,
      });
      const request = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'declined',
        requesterId: mod,
        coord: { lat: 44, lng: -72 },
        waterBodyId: bodyId,
        name: 'Cove',
        createdAt: at,
      });
      const placeName = await ctx.db.insert('corpusPlaceNames', {
        name: 'The Gut',
        askKey: `gut-${bodyId}`,
        aliases: [],
        messages: 1,
        skatedMessages: 0,
        states: [],
        waterBodyId: bodyId,
        status: 'dismissed',
        createdAt: at,
        updatedAt: at,
      });
      const flag = await ctx.db.insert('contentFlags', {
        flaggerId: mod,
        targetType: 'waterbody',
        targetId: bodyId,
        reason: 'spam',
        status: 'dismissed',
        createdAt: at,
      });
      const rows = [
        ['set_curated_boost', 'waterbody', bodyId],
        ['remove', 'waterBodySubArea', bay],
        ['hide', 'putIn', putIn],
        ['remove', 'bodyLandmark', landmark],
        ['set_parking_area', 'parkingArea', lot],
        ['demote_body_feature', 'bodyFeature', feature],
        ['decline_request', 'waterBodyRequest', request],
        ['remove', 'corpusPlaceName', placeName],
        ['dismiss_flag', 'contentFlag', flag],
      ] as const;
      let k = 0;
      for (const [action, targetType, targetId] of rows) {
        await ctx.db.insert('moderationActions', {
          actorId: mod,
          action,
          targetType,
          targetId,
          reason: action,
          createdAt: at + k++,
        });
      }
      return [bodyId, bay, putIn, landmark, lot, feature, request, placeName, flag];
    });
  }

  test('the survivor’s history holds every absorbed body’s family, through a chain', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const survivor = await seedBody(t, { name: 'Survivor' });
    const middle = await seedBody(t, { name: 'Middle', at: [-71.9, 44] });
    const oldest = await seedBody(t, { name: 'Oldest', at: [-71.8, 44] });
    const ids = new Set<string>([
      ...(await relatives(t, survivor, mod, NOW - 3 * DAY)),
      ...(await relatives(t, middle, mod, NOW - 2 * DAY)),
      ...(await relatives(t, oldest, mod, NOW - DAY)),
    ]);
    // Oldest was merged into Middle, which was later merged into Survivor.
    await t.run(async (ctx) => {
      await ctx.db.patch(oldest, { dedupStatus: 'merged', mergedIntoId: middle });
      await ctx.db.patch(middle, { dedupStatus: 'merged', mergedIntoId: survivor });
    });
    const expected = await t.run(async (ctx) =>
      (await ctx.db.query('moderationActions').collect())
        .filter((r) => ids.has(r.targetId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => r._id as string),
    );
    const read = await historyOf(t, as, { waterBodyId: survivor, limit: 100 });
    expect(read.capped).toBe(false);
    expect(read.entries.map((e) => e.id)).toEqual(expected);
  });

  test('a lot serving the survivor and a body merged into it is read once', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const survivor = await seedBody(t, { name: 'Survivor' });
    const absorbed = await seedBody(t, { name: 'Duplicate', at: [-71.9, 44] });
    // A merge leaves the lot links where they were: the duplicate's inferred link stays beside the
    // survivor's to the same lot.
    const expected = await t.run(async (ctx) => {
      const lot = await ctx.db.insert('parkingAreas', {
        coord: { lat: 44, lng: -72 },
        source: 'osm',
        status: 'visible',
        amenities: [],
        createdAt: NOW,
      });
      for (const waterBodyId of [survivor, absorbed]) {
        await ctx.db.insert('parkingAreaBodies', {
          parkingAreaId: lot,
          waterBodyId,
          inferred: true,
          createdAt: NOW,
        });
      }
      await ctx.db.patch(absorbed, { dedupStatus: 'merged', mergedIntoId: survivor });
      return [
        await ctx.db.insert('moderationActions', {
          actorId: mod,
          action: 'set_parking_area',
          targetType: 'parkingArea',
          targetId: lot,
          reason: 'set_parking_area',
          createdAt: NOW - DAY,
        }),
      ];
    });
    const read = await historyOf(t, as, { waterBodyId: survivor, limit: 100 });
    expect(read.capped).toBe(false);
    expect(read.entries.map((e) => e.id)).toEqual(expected);
  });

  test('the survivor’s untouched landmarks never crowd out a body merged into it', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const survivor = await seedBody(t, { name: 'Survivor' });
    const absorbed = await seedBody(t, { name: 'Duplicate', at: [-71.9, 44] });
    const family = await relatives(t, absorbed, mod, NOW - DAY);
    await t.run(async (ctx) => {
      // More catalog labels than the bound holds, none a person touched.
      for (let i = 0; i < 1_250; i++) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: survivor,
          name: `Label ${i}`,
          kind: 'island',
          point: { lat: 44, lng: -72 },
          source: 'osm',
          externalIds: [],
          aliases: [],
          createdAt: NOW - 2 * DAY,
          updatedAt: NOW - 2 * DAY,
        });
      }
      await ctx.db.patch(absorbed, { dedupStatus: 'merged', mergedIntoId: survivor });
    });
    const read = await historyOf(t, as, { waterBodyId: survivor, limit: 100 });
    // The survivor's 1,250 labels cost History nothing: the absorbed body's family is all there.
    expect(read.capped).toBe(false);
    const held = new Set(read.entries.map((e) => e.targetId));
    for (const id of family) expect(held.has(id)).toBe(true);
  });

  test('a chain past fifty absorbed bodies, each with its family, caps honestly and never throws', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const survivor = await seedBody(t, { name: 'Giant' });
    let parent = survivor;
    for (let i = 0; i < 51; i++) {
      const child = await seedBody(t, { name: `Absorbed ${i}`, at: [-71 - i * 0.01, 44] });
      await relatives(t, child, mod, NOW - DAY + i * 100);
      await t.run((ctx) => ctx.db.patch(child, { dedupStatus: 'merged', mergedIntoId: parent }));
      parent = child;
    }
    const read = await historyOf(t, as, { waterBodyId: survivor, limit: 100 });
    // Fifty-one bodies deep: past the chain's bound, so the read says it may be incomplete.
    expect(read.capped).toBe(true);
    // A full page of the families it did take in, each row once.
    expect(read.entries).toHaveLength(100);
    expect(new Set(read.entries.map((e) => e.id)).size).toBe(100);
  });
});

describe('a capped read takes its rows in the order it presents them', () => {
  test('bays’ provenance covers every bay the tab lists, the newest past a hundred included', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Many Bays' });
    let newest = '';
    await t.run(async (ctx) => {
      for (let i = 0; i <= 100; i++) {
        newest = await ctx.db.insert('waterBodySubAreas', {
          waterBodyId: id,
          name: `Bay ${i}`,
          searchText: `Bay ${i}`,
          polygon: square(-72, 44, 0.001),
          bbox: boxOf(-72, 44, 0.001),
          centroid: { lat: 44, lng: -72 },
          surfaceAreaSqM: ACRE,
          displayScore: 0,
          minVisibleZoom: 10,
          createdByUserId: mod,
          createdAt: NOW + i,
          updatedAt: NOW + i,
        });
      }
    });
    const rows = await as.query(api.bodyConsole.bayProvenance, { waterBodyId: id });
    expect(rows).toHaveLength(101);
    expect(rows.map((r) => r.subAreaId)).toContain(newest);
  });

  test('landmark proposers cover every open proposal the tab lists, the newest past a hundred included', async () => {
    const t = harness();
    const { as, id: mod } = await seedUser(t);
    const id = await seedBody(t, { name: 'Many Asks' });
    let newest = '';
    await t.run(async (ctx) => {
      for (let i = 0; i <= 100; i++) {
        newest = await ctx.db.insert('waterBodyRequests', {
          kind: 'name_landmark',
          status: 'open',
          requesterId: mod,
          coord: { lat: 44, lng: -72 },
          waterBodyId: id,
          name: `Rock ${i}`,
          createdAt: NOW + i,
        });
      }
    });
    const rows = await as.query(api.bodyConsole.landmarkProposers, { waterBodyId: id });
    expect(rows.map((r) => r.requestId)).toContain(newest);
  });
});

describe('retention’s saved put-ins at the read’s bound', () => {
  test('exactly the bound is the whole count; one past it says the count is partial', async () => {
    const t = harness();
    const { as } = await seedUser(t);
    const id = await seedBody(t, { name: 'Many Launches' });
    const launch = (i: number) => ({
      waterBodyId: id,
      coord: { lat: 44 + i * 0.001, lng: -72 },
      source: 'official' as const,
      status: 'visible' as const,
      createdAt: NOW,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_000; i++) await ctx.db.insert('putIns', launch(i));
    });
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: id })).toMatchObject({
      savedPutIns: 1_000,
      savedPutInsCapped: false,
    });
    await t.run((ctx) => ctx.db.insert('putIns', launch(1_000)));
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: id })).toMatchObject({
      savedPutIns: 1_000,
      savedPutInsCapped: true,
    });
  });
});

describe('one rule for a target’s history: the Body console and listActions agree on a verb filter', () => {
  test('for the same body and verb, the same rows in the same order, with the same marker', async () => {
    const t = harness();
    const mod = await seedUser(t);
    const body = await seedBody(t, { name: 'Mascoma Lake' });
    let at = NOW;
    const row = (action: Doc<'moderationActions'>['action'], via?: string) =>
      t.run((ctx) =>
        ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action,
          targetType: 'waterbody',
          targetId: body,
          reason: 'x',
          createdAt: at++,
          ...(via !== undefined ? { via } : {}),
        }),
      );
    await row('set_public_access');
    await row('demote_body');
    await row('set_public_access', 'seed-destinations');
    await row('activate_body');
    await row('set_public_access');

    for (const action of ['set_public_access', 'demote_body', 'merge_waterbody'] as const) {
      const listed = await mod.as.query(api.moderation.listActions, {
        targetType: 'waterbody',
        targetId: body,
        action,
      });
      const { entries } = await historyOf(t, mod.as, {
        waterBodyId: body,
        action,
      });
      const onBody = entries.filter((e) => e.targetType === 'waterbody' && e.targetId === body);
      expect(onBody.map((e) => [e.id, e.via])).toEqual(listed.map((r) => [r.id, r.via]));
      expect(listed.every((r) => r.action === action)).toBe(true);
    }
    // The verb is read in the index: three of five rows, never a filtered page that comes back short.
    const listed = await mod.as.query(api.moderation.listActions, {
      targetType: 'waterbody',
      targetId: body,
      action: 'set_public_access',
      limit: 3,
    });
    expect(listed).toHaveLength(3);
    expect(listed.map((r) => r.via)).toEqual([undefined, 'seed-destinations', undefined]);
  });

  test('listActions refuses a verb with no target, and half a target', async () => {
    const t = harness();
    const mod = await seedUser(t);
    await expect(
      mod.as.query(api.moderation.listActions, { action: 'demote_body' }),
    ).rejects.toThrow('Filtering by action needs a target');
    await expect(
      mod.as.query(api.moderation.listActions, { targetType: 'waterbody' }),
    ).rejects.toThrow('A target needs both its type and its id');
  });
});
