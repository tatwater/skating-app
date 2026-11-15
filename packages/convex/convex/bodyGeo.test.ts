/**
 * A body's geometry facts (B01-3b): computed at the write in an action, stored, and read without
 * geometry — the fix for the console extras timing out on the largest lake.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { COUNTY_PAGE, movedOn, placesFrom, TOWN_PAGE } from './bodyGeo';
import {
  coverTiles,
  markGeoStale,
  outlineStamp,
  PLACES_RULE,
  samplePoints,
  simplifiedRing,
  touches,
  townsWithStateOf,
  vertexCount,
} from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { syncAdminAreaCells, syncWaterBodyCells } from './lib/cellIndex';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.UTC(2027, 0, 15, 12);

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

/** An ellipse of `n` vertices centred at (cx, cy). */
function ellipse(cx: number, cy: number, rx: number, ry: number, n: number): Polygon {
  const ring: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  ring.push(ring[0] as number[]);
  return { type: 'Polygon', coordinates: [ring] };
}
/** An axis-aligned rectangle from its corners. */
function rectangle(x0: number, y0: number, x1: number, y1: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  };
}
const boxOf = (cx: number, cy: number, rx: number, ry: number) => ({
  minLng: cx - rx,
  maxLng: cx + rx,
  minLat: cy - ry,
  maxLat: cy + ry,
});

async function seedBody(
  t: T,
  name: string,
  at: [number, number],
  r: [number, number],
  opts: { n?: number; zoom?: number; over?: Partial<Doc<'waterBodies'>> } = {},
): Promise<Id<'waterBodies'>> {
  return t.run(async (ctx) => {
    const bbox = boxOf(at[0], at[1], r[0], r[1]);
    const id = await ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond',
      source: 'osm',
      polygon: ellipse(at[0], at[1], r[0], r[1], opts.n ?? 64),
      bbox,
      centroid: { lat: at[1], lng: at[0] },
      states: ['VT'],
      dedupStatus: 'clean',
      createdAt: NOW,
      minVisibleZoom: opts.zoom ?? 8,
      displayScore: r[0] * 100,
      ...opts.over,
    });
    await syncWaterBodyCells(ctx, id, { bbox, minVisibleZoom: opts.zoom ?? 8, listed: true });
    await rebuildBodyLibrary(ctx, id);
    return id;
  });
}

/** A boundary, indexed as the import indexes it. */
async function seedArea(
  t: T,
  name: string,
  level: 'town' | 'county' | 'state',
  state: string,
  externalId: string,
  polygon: Polygon,
): Promise<Id<'adminAreas'>> {
  return t.run(async (ctx) => {
    const xs = polygon.coordinates[0]?.map((p) => p[0] as number) ?? [];
    const ys = polygon.coordinates[0]?.map((p) => p[1] as number) ?? [];
    const bbox = {
      minLng: Math.min(...xs),
      maxLng: Math.max(...xs),
      minLat: Math.min(...ys),
      maxLat: Math.max(...ys),
    };
    const id = await ctx.db.insert('adminAreas', {
      name,
      level,
      state,
      externalId,
      polygon,
      bbox,
      centroid: { lat: (bbox.minLat + bbox.maxLat) / 2, lng: (bbox.minLng + bbox.maxLng) / 2 },
      createdAt: NOW,
    });
    await syncAdminAreaCells(ctx, id, { bbox, level });
    return id;
  });
}

async function seedModerator(t: T) {
  const subject = 'geo-mod';
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: 'M',
      username: 'geo-m',
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role: 'moderator',
      status: 'active',
      createdAt: NOW,
    }),
  );
  return t.withIdentity({ subject });
}

const facts = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id))
      .first(),
  );

const stale = (t: T, ids: Id<'waterBodies'>[]) => t.run((ctx) => markGeoStale(ctx, ids));
const compute = (t: T) => t.action(internal.bodyGeo.computeDue, {});

describe('pure helpers', () => {
  test('a box past the finest rung’s cell bound is tiled until every tile reads whole', () => {
    const small = coverTiles(boxOf(-72, 44, 0.001, 0.001));
    expect(small).toEqual({ tiles: [boxOf(-72, 44, 0.001, 0.001)], truncated: false });
    const big = coverTiles(boxOf(-73.3, 44.5, 0.6, 0.4));
    expect(big.tiles.length).toBeGreaterThan(1);
    expect(big.truncated).toBe(false);
    const huge = coverTiles(boxOf(-73, 44, 20, 20));
    expect(huge.truncated).toBe(true);
  });
  test('a simplified ring keeps at most its points and closes', () => {
    const ring = simplifiedRing(ellipse(0, 0, 1, 1, 1000), 48);
    expect(ring.length).toBe(49);
    expect(ring[0]).toEqual(ring[48]);
  });
  test('the kept ring is the largest by area, not the most detailed (Greptile on #122)', () => {
    const island = ellipse(5, 5, 0.01, 0.01, 400);
    const mainland = ellipse(0, 0, 1, 1, 20);
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [island.coordinates, mainland.coordinates],
    };
    const ring = simplifiedRing(multi, 200);
    expect(ring).toHaveLength(21);
    expect(ring[0]).toEqual(mainland.coordinates[0]?.[0]);
  });
  test('a multipolygon counts every ring, and keeps its largest outer ring', () => {
    const small = ellipse(5, 5, 0.1, 0.1, 10);
    const big = ellipse(0, 0, 1, 1, 100);
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [small.coordinates, big.coordinates],
    };
    expect(vertexCount(multi)).toBe(11 + 101);
    expect(samplePoints(multi, 200)).toHaveLength(112);
    expect(simplifiedRing(multi, 200)).toHaveLength(101);
  });
  test('the stamp moves with the outline, not with anything else', () => {
    const a = { polygon: ellipse(0, 0, 1, 1, 10), bbox: boxOf(0, 0, 1, 1) };
    expect(outlineStamp(a)).toBe(outlineStamp({ ...a }));
    expect(outlineStamp(a)).not.toBe(outlineStamp({ ...a, polygon: ellipse(0, 0, 1, 1, 11) }));
    // A reshape at the same vertex count inside the same box moves it too.
    const ring = a.polygon.coordinates[0] as number[][];
    const nudged = ring.map((p, i) => (i === 3 ? [(p[0] as number) * 0.9, p[1] as number] : p));
    expect(outlineStamp(a)).not.toBe(
      outlineStamp({ ...a, polygon: { type: 'Polygon', coordinates: [nudged] } }),
    );
  });
  test('a candidate too large to test whole is tested by its samples only', () => {
    const lake = ellipse(0, 0, 0.01, 0.01, 64);
    const far = ellipse(1, 1, 0.01, 0.01, 64);
    expect(touches(lake, far, true)).toBe(false);
    expect(touches(lake, ellipse(0.0201, 0, 0.0101, 0.01, 64), false)).toBe(true);
  });
  test('places: towns in the rule’s order, counties from each town’s GEOID, states from the towns', () => {
    const town = (id: string, name: string, state: string, externalId: string) => ({
      id: id as Id<'adminAreas'>,
      name,
      state,
      externalId,
    });
    const out = placesFrom(
      [
        town('a', 'Alburgh', 'VT', 'tiger/5001300850'),
        // A water unit between towns: in region, its county and state count — never listed.
        town('u', 'County subdivisions not defined', 'NY', 'tiger/3601900000'),
        town('b', 'Champlain', 'NY', 'tiger/3601913420'),
        // A legacy key names no county.
        town('c', 'Legacy', 'VT', 'relation/1'),
      ],
      new Map([
        ['tiger/50013', 'Grand Isle'],
        ['tiger/36019', 'Clinton'],
      ]),
    );
    expect(out).toEqual({
      towns: ['Alburgh', 'Champlain', 'Legacy'],
      townStates: ['VT', 'NY', 'VT'],
      townIds: ['a', 'b', 'c'],
      townEntries: [
        { name: 'Alburgh', state: 'VT', id: 'a' },
        { name: 'Champlain', state: 'NY', id: 'b' },
        { name: 'Legacy', state: 'VT', id: 'c' },
      ],
      counties: ['Grand Isle', 'Clinton'],
      states: ['NY', 'VT'],
    });
  });
  test('a border lake’s same-named towns in two states are two entries; `towns` keeps one name (B01-3d)', () => {
    const out = placesFrom(
      [
        {
          id: 'vt' as Id<'adminAreas'>,
          name: 'Franklin',
          state: 'VT',
          externalId: 'tiger/5001126800',
        },
        {
          id: 'nh' as Id<'adminAreas'>,
          name: 'Franklin',
          state: 'NH',
          externalId: 'tiger/3301327380',
        },
      ],
      new Map(),
    );
    expect(out.towns).toEqual(['Franklin']);
    expect(out.townEntries).toEqual([
      { name: 'Franklin', state: 'VT', id: 'vt' },
      { name: 'Franklin', state: 'NH', id: 'nh' },
    ]);
    expect(
      townsWithStateOf({
        towns: out.towns,
        townStates: out.townStates,
        townEntries: out.townEntries as never,
      }),
    ).toEqual([
      { name: 'Franklin', state: 'VT' },
      { name: 'Franklin', state: 'NH' },
    ]);
  });
  test('a candidates page must move on, or the body fails rather than loop', () => {
    expect(movedOn(undefined, { z: 4, i: 0 })).toBe(true);
    expect(movedOn({ z: 9, i: 10 }, { z: 9, i: 11 })).toBe(true);
    expect(movedOn({ z: 9, i: 10 }, { z: 10, i: 0 })).toBe(true);
    expect(movedOn({ z: 9, i: 10 }, { z: 9, i: 10 })).toBe(false);
    expect(movedOn({ z: 9, i: 10 }, { z: 8, i: 99 })).toBe(false);
  });
});

describe('computed at the write, read without geometry', () => {
  test('a giant whose box covers more cells than the scan allows still finds a pond at the finest rung', async () => {
    const t = harness();
    const as = await seedModerator(t);
    // 1.2° × 0.8°: past the 256-cell bound at the finest rung, so one cover would skip that rung.
    const giant = await seedBody(t, 'Giant', [-73.3, 44.5], [0.6, 0.4], { n: 2000 });
    // A pond indexed at the finest rung (it first draws at zoom 14), 10 m off the giant's east shore.
    const pond = await seedBody(t, 'Fine Pond', [-73.3 + 0.6 + 0.00225, 44.5], [0.002, 0.002], {
      zoom: 14,
    });
    await stale(t, [giant]);
    await compute(t);
    const x = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: giant });
    expect(x.touchingBodyIds).toEqual([pond]);
    expect(x.touching?.[0]?.name).toBe('Fine Pond');
    expect(x.touchingCapped).toBe(false);
    // The relation is kept on both sides: the pond, marked stale by the giant's answer, was
    // recomputed in the same run and lists the giant.
    expect((await facts(t, pond))?.neighbors?.map((n) => n.waterBodyId)).toEqual([giant]);
  });

  test('an answer computed for an outline since changed is not stored', async () => {
    const t = harness();
    const id = await seedBody(t, 'Moving', [-72, 44], [0.01, 0.01]);
    await stale(t, [id]);
    await t.mutation(internal.bodyGeo.store, {
      waterBodyId: id,
      stamp: 'an older outline',
      staleAt: NOW,
      neighbors: [],
      neighborsCapped: false,
      towns: [],
      counties: [],
      states: [],
      areasAt: 0,
    });
    expect((await facts(t, id))?.computedAt).toBeUndefined();
    expect((await facts(t, id))?.staleAt).toBe(NOW);
  });

  test('a mark that arrives while a body is computed keeps it stale for the next run', async () => {
    const t = harness();
    const id = await seedBody(t, 'Busy', [-72, 44], [0.01, 0.01]);
    await stale(t, [id]);
    const input = await t.query(internal.bodyGeo.inputs, { waterBodyId: id });
    expect(input?.staleAt).toBe(NOW);
    // A neighbor's answer moves its relation to this body while this body is being computed.
    vi.setSystemTime(NOW + 1_000);
    await stale(t, [id]);
    await t.mutation(internal.bodyGeo.store, {
      waterBodyId: id,
      stamp: input?.stamp as string,
      staleAt: input?.staleAt ?? null,
      neighbors: [],
      neighborsCapped: false,
      towns: [],
      counties: [],
      states: [],
      areasAt: 0,
    });
    // Stored, and still stale: the answer may be behind the mark.
    expect(await facts(t, id)).toMatchObject({ computedAt: NOW + 1_000, staleAt: NOW + 1_000 });
    // The next run recomputes it under the mark it reads, and clears it.
    await compute(t);
    expect((await facts(t, id))?.staleAt).toBeUndefined();
  });

  test('a rejected neighbor leaves the touching list, as a merged one does', async () => {
    const t = harness();
    const as = await seedModerator(t);
    const a = await seedBody(t, 'A', [-72, 44], [0.01, 0.01]);
    const b = await seedBody(t, 'B', [-72 + 0.0201, 44], [0.0101, 0.01]);
    await stale(t, [a, b]);
    await compute(t);
    await compute(t);
    expect(
      (await as.query(api.bodyConsole.consoleExtras, { waterBodyId: a })).touchingBodyIds,
    ).toEqual([b]);
    await t.run(async (ctx) => {
      await ctx.db.patch(b, { reviewStatus: 'rejected' });
      await rebuildBodyLibrary(ctx, b);
    });
    const after = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: a });
    expect(after.touchingBodyIds).toEqual([]);
    expect(after.touching).toEqual([]);
  });

  test('failures are recorded by class, park after three, and a parked body waits for the daily retry', async () => {
    const t = harness();
    const bad = await seedBody(t, 'Broken', [-72, 44], [0.01, 0.01]);
    const good = await seedBody(t, 'Fine', [-71, 43], [0.01, 0.01]);
    await stale(t, [bad, good]);
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.bodyGeo.recordFailure, {
        waterBodyId: bad,
        errorClass: 'TypeError',
        byDailyRetry: false,
      });
    }
    expect(await facts(t, bad)).toMatchObject({
      attempts: 3,
      errorClass: 'TypeError',
      parkedAt: NOW,
    });
    // The run passes the parked body by and computes the rest.
    expect(await compute(t)).toMatchObject({ computed: 1, failed: 0, done: true });
    expect((await facts(t, good))?.computedAt).toBe(NOW);
    expect((await facts(t, bad))?.computedAt).toBeUndefined();
    // The daily retry takes it; a success clears its record.
    expect(await t.action(internal.bodyGeo.computeDue, { parked: true })).toMatchObject({
      computed: 1,
    });
    const after = await facts(t, bad);
    expect(after).toMatchObject({ computedAt: NOW });
    expect(after?.parkedAt).toBeUndefined();
    expect(after?.attempts).toBeUndefined();
  });

  test('a merged or deleted body loses its facts, and its neighbors drop it', async () => {
    const t = harness();
    const a = await seedBody(t, 'A', [-72, 44], [0.01, 0.01]);
    const b = await seedBody(t, 'B', [-72 + 0.0201, 44], [0.0101, 0.01]);
    await stale(t, [a, b]);
    await compute(t);
    await compute(t);
    expect((await facts(t, a))?.neighbors?.map((n) => n.waterBodyId)).toEqual([b]);
    await t.run(async (ctx) => {
      await ctx.db.patch(b, { dedupStatus: 'merged', mergedIntoId: a });
      await rebuildBodyLibrary(ctx, b);
      await markGeoStale(ctx, [b]);
    });
    // One run: B's facts go, A is marked stale by it and recomputed in the same run without B.
    expect(await compute(t)).toMatchObject({ failed: 0, done: true });
    expect(await facts(t, b)).toBeNull();
    expect(await facts(t, a)).toMatchObject({ neighbors: [], computedAt: NOW });
    expect((await facts(t, a))?.staleAt).toBeUndefined();
  });

  test('seeding marks every library body stale, paged', async () => {
    const t = harness();
    const ids = [
      await seedBody(t, 'One', [-72, 44], [0.01, 0.01]),
      await seedBody(t, 'Two', [-71, 43], [0.01, 0.01]),
    ];
    expect(await t.mutation(internal.bodyGeo.seedAll, {})).toEqual({ marked: 2, isDone: true });
    for (const id of ids) expect((await facts(t, id))?.staleAt).toBe(NOW);
  });

  test('places are computed and stored, and read back by the console', async () => {
    const t = harness();
    const as = await seedModerator(t);
    const id = await seedBody(t, 'Placed', [-72, 44], [0.01, 0.01]);
    await seedArea(t, 'Enfield', 'town', 'NH', 'tiger/3300924900', ellipse(-72, 44, 0.2, 0.2, 4));
    await seedArea(t, 'Grafton', 'county', 'NH', 'tiger/33009', ellipse(-72, 44, 0.5, 0.5, 4));
    // Before the computation: the preview has no town and says the towns aren't computed yet.
    expect(await as.query(api.bodies.preview, { waterBodyId: id })).toMatchObject({
      town: null,
      townsComputedAt: null,
    });
    await stale(t, [id]);
    await compute(t);
    expect(await as.query(api.bodies.preview, { waterBodyId: id })).toMatchObject({
      town: 'Enfield',
      moreTowns: [],
      townsComputedAt: NOW,
    });
    expect(await as.query(api.bodyConsole.places, { waterBodyId: id })).toEqual({
      towns: ['Enfield'],
      townsWithState: [{ name: 'Enfield', state: 'NH' }],
      counties: ['Grafton'],
      states: ['NH'],
      computedAt: NOW,
    });
    expect((await facts(t, id))?.placesRule).toBe(PLACES_RULE);
    // Each town's state reaches the preview and the frame too (B01-3c).
    expect(await as.query(api.bodies.preview, { waterBodyId: id })).toMatchObject({
      town: 'Enfield',
      townState: 'NH',
      moreTownsWithState: [],
    });
    expect(
      (await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id })).townsWithState,
    ).toEqual([{ name: 'Enfield', state: 'NH' }]);
    // Town lines: no outline stored for a boundary loaded before them, until the backfill writes it.
    expect(await as.query(api.bodyConsole.townLines, { waterBodyId: id })).toEqual({
      towns: [{ name: 'Enfield', state: 'NH', ring: null }],
      capped: false,
      computedAt: NOW,
    });
    expect(await t.mutation(internal.adminAreas.backfillOutlines, {})).toMatchObject({
      written: 2,
      isDone: true,
    });
    const lines = await as.query(api.bodyConsole.townLines, { waterBodyId: id });
    expect(lines?.towns[0]?.ring?.length).toBeGreaterThan(3);
    expect(lines?.towns[0]?.ring?.length).toBeLessThanOrEqual(97);
  });

  test('a town the shore crosses into is listed; one it only grazes is not; a body in none is computed empty', async () => {
    const t = harness();
    const as = await seedModerator(t);
    // Two towns meeting on the meridian 72°W; a pond across the line, and one 5 m short of it.
    await seedArea(t, 'West', 'town', 'VT', 'tiger/5000100001', rectangle(-72.2, 43.9, -72, 44.1));
    await seedArea(t, 'East', 'town', 'NH', 'tiger/3300100002', rectangle(-72, 43.9, -71.8, 44.1));
    const across = await seedBody(t, 'Across', [-72, 44], [0.005, 0.005]);
    // ~5 m of shore east of the line (a degree of longitude is ~80 km here).
    const grazing = await seedBody(t, 'Grazing', [-72.005 + 0.00006, 44.05], [0.005, 0.002]);
    const nowhere = await seedBody(t, 'Nowhere', [-70, 44], [0.005, 0.005]);
    await stale(t, [across, grazing, nowhere]);
    await compute(t);
    const placesOfBody = (id: Id<'waterBodies'>) =>
      as.query(api.bodyConsole.places, { waterBodyId: id });
    expect((await placesOfBody(across))?.towns.sort()).toEqual(['East', 'West']);
    expect((await placesOfBody(across))?.states).toEqual(['NH', 'VT']);
    expect(await placesOfBody(grazing)).toMatchObject({ towns: ['West'], states: ['VT'] });
    expect(await placesOfBody(nowhere)).toEqual({
      towns: [],
      townsWithState: [],
      counties: [],
      states: [],
      computedAt: NOW,
    });
  });

  test('places computed by the sampled rule before read as not computed; the touching bodies still show', async () => {
    const t = harness();
    const as = await seedModerator(t);
    const id = await seedBody(t, 'Old', [-72, 44], [0.01, 0.01]);
    const near = await seedBody(t, 'Near', [-72.02, 44], [0.01, 0.01]);
    await t.run(async (ctx) => {
      // The cell index's mark left a row; replace it with the one the sampled rule stored.
      for (const r of await ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .collect()) {
        await ctx.db.delete(r._id);
      }
      await ctx.db.insert('bodyGeoFacts', {
        waterBodyId: id,
        computedAt: NOW,
        checkedAt: NOW,
        stamp: 'old',
        neighbors: [{ waterBodyId: near, name: 'Near', ring: [[0, 0]] }],
        neighborsCapped: false,
        towns: ['Sampled'],
        townStates: ['VT'],
        townIds: [],
        townEntries: [],
        counties: ['Sampled County'],
        states: ['VT'],
        areasAt: 0,
        // A parked row keeps its old answer until its recompute goes through.
        parkedAt: NOW,
      });
    });
    expect(await as.query(api.bodyConsole.places, { waterBodyId: id })).toBeNull();
    expect(await as.query(api.bodyConsole.townLines, { waterBodyId: id })).toBeNull();
    expect(await as.query(api.bodies.preview, { waterBodyId: id })).toMatchObject({
      town: null,
      townsComputedAt: null,
    });
    const extras = await as.query(api.bodyConsole.consoleExtras, { waterBodyId: id });
    expect(extras).toMatchObject({ towns: null, townsWithState: null, touchingBodyIds: [near] });
  });

  test('the largest dev lake against the most candidates: towns paged, every one tested, within the action’s limits', async () => {
    const t = harness();
    // 14,151 vertices — the largest outline on dev — over a 9 × 9 grid of towns, as Lake Champlain
    // meets 75 candidate towns on dev. The lake (rx 0.3°, ry 0.2°) reaches into the inner towns only.
    const giant = await seedBody(t, 'Largest', [-73.3, 44.5], [0.3, 0.2], { n: 14_151 });
    const step = 0.1;
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 9; j++) {
        const x0 = -73.75 + i * step;
        const y0 = 44.05 + j * step;
        await seedArea(
          t,
          `T${i}${j}`,
          'town',
          'VT',
          `tiger/50007${String(i * 9 + j).padStart(5, '1')}`,
          rectangle(x0, y0, x0 + step, y0 + step),
        );
      }
    }
    await seedArea(t, 'Chittenden', 'county', 'VT', 'tiger/50007', rectangle(-74, 44, -72.5, 45));
    expect(TOWN_PAGE).toBe(11);
    expect(COUNTY_PAGE).toBe(11);
    await stale(t, [giant]);
    const started = performance.now();
    expect(await compute(t)).toMatchObject({ computed: 1, failed: 0 });
    const ms = performance.now() - started;
    const row = await facts(t, giant);
    // The ellipse spans x −73.6…−73.0 and y 44.3…44.7: towns i 1–7 by j 2–6 at most, and every one of
    // those it reaches more than 15 m into.
    expect(row?.towns?.length).toBeGreaterThan(TOWN_PAGE);
    expect(row?.towns?.length).toBeLessThanOrEqual(35);
    expect(row?.counties).toEqual(['Chittenden']);
    expect(row?.states).toEqual(['VT']);
    expect(row?.placesRule).toBe(PLACES_RULE);
    // Generous: the rule itself measured 150 ms for Lake Champlain against its 75 towns.
    expect(ms).toBeLessThan(20_000);
  });

  test('a town cell holding more rows than its cap throws rather than answer short', async () => {
    const t = harness();
    for (let i = 0; i < 65; i++) {
      await seedArea(
        t,
        `Tiny ${i}`,
        'town',
        'VT',
        `tiger/50001${String(i).padStart(5, '2')}`,
        rectangle(-72, 44, -71.999, 44.001),
      );
    }
    await expect(
      t.query(internal.bodyGeo.townCandidates, { box: boxOf(-72, 44, 0.01, 0.01) }),
    ).rejects.toThrow(/more than 64 rows/);
  });

  test('candidates past one page’s cell reads hand on where they stopped, and the pages together are complete', async () => {
    const t = harness();
    await seedArea(
      t,
      'Far corner',
      'town',
      'VT',
      'tiger/5000100003',
      rectangle(-71.01, 44.99, -71, 45),
    );
    // A box wide enough that its finest rung alone covers more cells than one page reads.
    const box = { minLng: -73.5, maxLng: -71, minLat: 43, maxLat: 45 };
    const first = await t.query(internal.bodyGeo.townCandidates, { box });
    expect(first.next).not.toBeNull();
    const ids = new Set(first.ids);
    let from = first.next;
    while (from !== null) {
      const page = await t.query(internal.bodyGeo.townCandidates, { box, from });
      for (const id of page.ids) ids.add(id);
      expect(page.next === null || movedOn(from, page.next)).toBe(true);
      from = page.next;
    }
    expect(ids.size).toBe(1);
  });
});

describe('no read does geometry that grows with an outline', () => {
  test('every Body read completes within its bound on an outline the size of the largest dev lake', async () => {
    const t = harness();
    const as = await seedModerator(t);
    // 14,151 vertices — the largest outline on dev — with a dozen neighbors around it. Their facts
    // are stored directly as the computation would leave them: this test is about the reads, and the
    // computation's own cost (an action, seconds here) is not what it bounds.
    const giant = await seedBody(t, 'Largest', [-73.3, 44.5], [0.6, 0.4], { n: 14_151 });
    const neighbors: {
      waterBodyId: Id<'waterBodies'>;
      name: string;
      ring: number[][];
      stamp: string;
    }[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (2 * Math.PI * i) / 12;
      const center: [number, number] = [-73.3 + 0.62 * Math.cos(a), 44.5 + 0.42 * Math.sin(a)];
      const id = await seedBody(t, `Near ${i}`, center, [0.03, 0.02], { n: 400 });
      neighbors.push({
        waterBodyId: id,
        name: `Near ${i}`,
        ring: simplifiedRing(ellipse(center[0], center[1], 0.03, 0.02, 400)),
        stamp: `stamp-${i}`,
      });
    }
    await t.run((ctx) =>
      ctx.db.insert('bodyGeoFacts', {
        waterBodyId: giant,
        computedAt: NOW,
        checkedAt: NOW,
        stamp: 'giant',
        neighbors,
        neighborsCapped: false,
        towns: [],
        townStates: [],
        townIds: [],
        townEntries: [],
        counties: [],
        states: ['VT'],
        areasAt: 0,
      }),
    );
    const reads: [string, () => Promise<unknown>][] = [
      ['preview', () => as.query(api.bodies.preview, { waterBodyId: giant })],
      ['consoleExtras', () => as.query(api.bodyConsole.consoleExtras, { waterBodyId: giant })],
      ['places', () => as.query(api.bodyConsole.places, { waterBodyId: giant })],
      ['bayProvenance', () => as.query(api.bodyConsole.bayProvenance, { waterBodyId: giant })],
      [
        'landmarkProvenance',
        () => as.query(api.bodyConsole.landmarkProvenance, { waterBodyId: giant }),
      ],
      ['dailyHazards', () => as.query(api.bodyConsole.dailyHazards, { waterBodyId: giant })],
      ['retentionForBody', () => as.query(api.standing.retentionForBody, { waterBodyId: giant })],
      [
        'listPage',
        () =>
          as.query(api.bodies.listPage, {
            lane: 'all',
            paginationOpts: { numItems: 50, cursor: null },
          }),
      ],
      ['listSummary', () => as.query(api.bodies.listSummary, { lane: 'all' })],
      ['history', () => as.query(api.bodyConsole.history, { waterBodyId: giant })],
      // The reads B01-3c added.
      ['townLines', () => as.query(api.bodyConsole.townLines, { waterBodyId: giant })],
      ['removedFacts', () => as.query(api.bodyConsole.removedFacts, { waterBodyId: giant })],
      ['rowsByIds', () => as.query(api.bodies.rowsByIds, { ids: [giant] })],
      [
        'searchOtherStandings',
        () => as.query(api.bodies.searchOtherStandings, { lane: 'active', q: 'largest' }),
      ],
    ];
    // The bound: under a query's one second, in this simulated backend — the touching test alone
    // took 1.4 s here before it moved to the write, and every read now takes ~20–35 ms locally. Each
    // read is warmed once and timed as the best of two, so a CI runner's GC pause or coverage
    // instrumentation can't fail it; a read that does per-vertex work again still can.
    for (const [name, read] of reads) {
      await read();
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        await read();
        best = Math.min(best, performance.now() - t0);
      }
      expect([name, best < 800]).toEqual([name, true]);
    }
    // ~1.5 s locally; a CI runner with coverage is several times slower, so the test keeps a timeout of
    // its own — the bound under test is the per-read one above.
  }, 60_000);
});
