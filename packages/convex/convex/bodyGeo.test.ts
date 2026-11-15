/**
 * A body's geometry facts (B01-3b): computed at the write in an action, stored, and read without
 * geometry — the fix for the console extras timing out on the largest lake.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { placesFrom } from './bodyGeo';
import {
  coverTiles,
  markGeoStale,
  outlineStamp,
  samplePoints,
  simplifiedRing,
  touches,
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
  test('places: towns in sample order, the county at the interior point only', () => {
    const square = ellipse(0, 0, 1, 1, 4);
    const out = placesFrom(
      [
        { lat: 0, lng: 0 },
        { lat: 0.5, lng: 0 },
      ],
      {
        perPoint: [
          { town: ['t1'], county: ['c1'] },
          { town: ['t1', 't2'], county: ['c2'] },
        ],
        areas: [
          { id: 't1', name: 'Enfield', state: 'NH', bbox: boxOf(0, 0, 1, 1), polygon: square },
          { id: 't2', name: 'Elsewhere', state: 'VT', bbox: boxOf(5, 5, 1, 1), polygon: square },
          { id: 'c1', name: 'Grafton', state: 'NH', bbox: boxOf(0, 0, 1, 1), polygon: square },
          { id: 'c2', name: 'Other', state: 'NH', bbox: boxOf(0, 0, 1, 1), polygon: square },
        ],
      },
    );
    expect(out).toEqual({
      towns: ['Enfield'],
      townStates: ['NH'],
      townIds: [expect.any(String)],
      counties: ['Grafton'],
      states: ['NH'],
    });
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
    await t.run(async (ctx) => {
      for (const [name, level, r] of [
        ['Enfield', 'town', 0.2],
        ['Grafton', 'county', 0.5],
      ] as const) {
        const area = await ctx.db.insert('adminAreas', {
          name,
          level,
          state: 'NH',
          externalId: `relation/${name}`,
          polygon: ellipse(-72, 44, r, r, 4),
          bbox: boxOf(-72, 44, r, r),
          centroid: { lat: 44, lng: -72 },
          createdAt: NOW,
        });
        await syncAdminAreaCells(ctx, area, { bbox: boxOf(-72, 44, r, r), level });
      }
    });
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
});

describe('no read does geometry that grows with an outline', () => {
  test('every Body read completes within its bound on an outline the size of the largest dev lake', async () => {
    const t = harness();
    const as = await seedModerator(t);
    // 14,151 vertices — the largest outline on dev — with a dozen neighbors around it.
    const giant = await seedBody(t, 'Largest', [-73.3, 44.5], [0.6, 0.4], { n: 14_151 });
    for (let i = 0; i < 12; i++) {
      const a = (2 * Math.PI * i) / 12;
      await seedBody(
        t,
        `Near ${i}`,
        [-73.3 + 0.62 * Math.cos(a), 44.5 + 0.42 * Math.sin(a)],
        [0.03, 0.02],
        { n: 3000 },
      );
    }
    await stale(t, [giant]);
    await compute(t);
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
    // read is warmed once and timed as the best of three, so a CI runner's GC pause or coverage
    // instrumentation can't fail it; a read that does per-vertex work again still can.
    for (const [name, read] of reads) {
      await read();
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await read();
        best = Math.min(best, performance.now() - t0);
      }
      expect([name, best < 800]).toEqual([name, true]);
    }
    // The setup is the heavy part — the action computes the giant against twelve 3,000-vertex
    // neighbors (5–6 s locally, several times that on a CI runner with coverage) — so the test has
    // its own timeout; the bound under test is the per-read one above.
  }, 180_000);
});
