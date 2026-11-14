/**
 * The Body console's reads (B01-3): the frame's extras, bays' provenance, the body-scoped history,
 * places, landmarks' provenance and proposers, the winters' daily hazards, and the Standing tab's
 * retention facts.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { bayViaOf, daysCovered, winterWindow } from './bodyConsole';
import { syncAdminAreaCells, syncWaterBodyCells } from './lib/cellIndex';
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

/** A square centred at (lng, lat) with half-width `h` degrees. */
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

describe('pure helpers', () => {
  test('a bay’s way is its via, or its words for rows written before', () => {
    expect(bayViaOf({ metadata: { via: 'chord' }, reason: 'x' })).toBe('chord');
    expect(bayViaOf({ metadata: {}, reason: 'Seeded "X" on Y' })).toBe('seed');
    expect(bayViaOf({ metadata: undefined, reason: 'A07a campaign: …' })).toBe('catalog');
    expect(bayViaOf({ metadata: { via: 7 }, reason: 'Drew "X"' })).toBe('drawn');
  });
  test('a span counts on every day it overlaps inside the winter', () => {
    const w = winterWindow(2026);
    expect(w.start).toBe(Date.UTC(2026, 9, 1));
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
    const x = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    expect(x).toMatchObject({
      towns: ['Enfield'],
      hasBathymetry: false,
      outlineTrustedSince: NOW - DAY,
      outlineTrustedVia: 'approved',
      touchingBodyIds: [touching],
      touchingCapped: false,
    });
    const places = await as.query(api.bodyConsole.places, { waterBodyId: id });
    expect(places).toEqual({ towns: ['Enfield'], counties: [], states: ['NH'] });
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
    const x = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    expect(x).toMatchObject({
      towns: null,
      hasBathymetry: true,
      outlineTrustedSince: NOW - 10 * DAY,
      outlineTrustedVia: 'campaign',
      touchingBodyIds: [],
    });
    const none = await seedBody(t, { name: 'Unstamped' });
    expect(await as.query(api.bodyConsole.consoleExtras, { waterBodyId: none })).toMatchObject({
      outlineTrustedSince: null,
      outlineTrustedVia: null,
    });
    expect(await as.query(api.bodyConsole.places, { waterBodyId: none })).toBeNull();
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
    const all = await mod.as.query(api.bodyConsole.history, { waterBodyId: id });
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
    const boosts = await mod.as.query(api.bodyConsole.history, {
      waterBodyId: id,
      action: 'set_curated_boost',
      limit: 1,
    });
    expect(boosts.entries.map((e) => e.createdAt)).toEqual([NOW - DAY / 2]);
    expect(boosts.capped).toBe(true);
    const member = await seedUser(t, 'member');
    await expect(member.as.query(api.bodyConsole.history, { waterBodyId: id })).rejects.toThrow();
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
  test('counts each day a hazard was on the lake, ends at its healing, and names the watch’s opening', async () => {
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
    expect(r.unknownEnds).toBe(1);
    expect(r.watchOpensOn).toBe(Date.UTC(2026, 10, 20));
    const at = (d: number) => r.days.find((x) => x.at === start + d * DAY)?.count;
    expect(at(0)).toBe(3);
    expect(at(1)).toBe(3);
    expect(at(2)).toBe(1);
    expect(at(5)).toBe(1);
    expect(r.days.every((d) => d.at <= NOW)).toBe(true);
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
    });
    const bare = await seedBody(t, { name: 'Bare' });
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: bare })).toEqual({
      favorites: 0,
      favoritesCapped: false,
      savedPutIns: 0,
    });
    await t.run((ctx) => ctx.db.delete(bare));
    expect(await as.query(api.standing.retentionForBody, { waterBodyId: bare })).toBeNull();
  });
});
