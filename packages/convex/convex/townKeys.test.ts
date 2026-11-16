/**
 * A town entry is keyed by its boundary, never by its name (B01-3l): two subdivisions of one state
 * with one name — Plattsburgh the town and the city — are two entries, told apart by their kind from
 * TIGER's full name. Before a boundary carries its full name the two read the same, and still count.
 */

import { townLabel } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { placesFrom, type ReachedTown } from './bodyGeo';
import {
  geoFactsOf,
  markGeoStale,
  pinnedFactsFor,
  placesOf,
  townNamesOf,
  townRowsOf,
} from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { syncWaterBodyCells } from './lib/cellIndex';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const town = (
  id: string,
  name: string,
  state: string,
  geoid: string,
  extra: Partial<ReachedTown> = {},
): ReachedTown => ({
  id: id as Id<'adminAreas'>,
  name,
  state,
  externalId: `tiger/${geoid}`,
  ...extra,
});

/** Lake Champlain's 40 subdivisions as the rule reaches them: Plattsburgh town and city among them. */
function champlain(withFullNames: boolean): ReachedTown[] {
  const towns: ReachedTown[] = [];
  for (let i = 0; i < 38; i++) {
    towns.push(
      town(
        `t${i}`,
        `Shore Town ${i}`,
        i % 2 === 0 ? 'VT' : 'NY',
        `50007${String(i + 1).padStart(5, '0')}`,
      ),
    );
  }
  const shared = { shared: true };
  towns.push(
    town('plattsburgh-city', 'Plattsburgh', 'NY', '3601958420', {
      ...shared,
      ...(withFullNames ? { fullName: 'Plattsburgh city' } : {}),
    }),
    town('plattsburgh-town', 'Plattsburgh', 'NY', '3601958431', {
      ...shared,
      ...(withFullNames ? { fullName: 'Plattsburgh town' } : {}),
    }),
  );
  return towns;
}

const rowsOf = (out: ReturnType<typeof placesFrom>) =>
  townRowsOf({
    towns: out.towns,
    townStates: out.townStates,
    townIds: out.townIds,
    townEntries: out.townEntries as never,
  }) ?? [];

describe('a body’s towns, keyed by boundary', () => {
  test('Lake Champlain: 40 towns from the 40 the rule reaches, the two Plattsburghs told apart', () => {
    const out = placesFrom(champlain(true), new Map());
    expect(out.townEntries).toHaveLength(40);
    const labels = rowsOf(out).map((r) => `${r.name}, ${r.state}`);
    expect(labels).toContain('Plattsburgh (city), NY');
    expect(labels).toContain('Plattsburgh (town), NY');
    expect(new Set(labels).size).toBe(40);
    // Every other town reads exactly as before.
    expect(labels).toContain('Shore Town 0, VT');
  });

  test('before the boundaries carry their full names: still 40, the two reading the same (transitional)', () => {
    const out = placesFrom(champlain(false), new Map());
    expect(out.townEntries).toHaveLength(40);
    const names =
      townNamesOf({
        towns: out.towns,
        townStates: out.townStates,
        townIds: out.townIds,
        townEntries: out.townEntries as never,
      }) ?? [];
    expect(names.filter((n) => n === 'Plattsburgh')).toHaveLength(2);
  });

  test('a names list shows the state only where two states share a name in it', () => {
    const out = placesFrom(
      [
        town('vt', 'Franklin', 'VT', '5001126800'),
        town('nh', 'Franklin', 'NH', '3301327380'),
        town('a', 'Alburgh', 'VT', '5001300850'),
      ],
      new Map(),
    );
    expect(
      townNamesOf({
        towns: out.towns,
        townStates: out.townStates,
        townIds: out.townIds,
        townEntries: out.townEntries as never,
      }),
    ).toEqual(['Franklin, VT', 'Franklin, NH', 'Alburgh']);
  });

  // Names from a small pool, so they collide; a name two subdivisions of one state share carries
  // TIGER's full name with distinct kinds, as the real layer does.
  const KINDS = ['town', 'city', 'village', 'plantation'];
  const subdivisions = fc
    .uniqueArray(
      fc.record({
        n: fc.integer({ min: 0, max: 5 }),
        state: fc.constantFrom('NY', 'VT'),
        g: fc.integer({ min: 0, max: 999 }),
      }),
      { selector: (s) => s.g, maxLength: 30 },
    )
    .map((rows) => {
      const seen = new Map<string, number>();
      return rows.map((r) => {
        const key = `${r.state}:${r.n}`;
        const k = seen.get(key) ?? 0;
        seen.set(key, k + 1);
        return { ...r, kind: KINDS[k % KINDS.length] as string };
      });
    })
    .filter((rows) => {
      // At most four of one name in a state (one per kind), as the generator's kinds allow.
      const count = new Map<string, number>();
      for (const r of rows)
        count.set(`${r.state}:${r.n}`, (count.get(`${r.state}:${r.n}`) ?? 0) + 1);
      return [...count.values()].every((c) => c <= KINDS.length);
    });
  const property = fc.property(subdivisions, (rows) => {
    const count = new Map<string, number>();
    for (const r of rows) count.set(`${r.state}:${r.n}`, (count.get(`${r.state}:${r.n}`) ?? 0) + 1);
    const reached = rows.map((r) =>
      town(`id${r.g}`, `Town ${r.n}`, r.state, `36019${10_000 + r.g}`, {
        fullName: `Town ${r.n} ${r.kind}`,
        shared: (count.get(`${r.state}:${r.n}`) ?? 0) > 1,
      }),
    );
    const out = placesFrom(reached, new Map());
    // As many entries as distinct boundaries, and no two reading the same.
    expect(out.townEntries).toHaveLength(new Set(rows.map((r) => r.g)).size);
    const labels = out.townEntries.map((e) => townLabel(e));
    expect(new Set(labels).size).toBe(labels.length);
  });
  for (const seed of [1, 42, 20_261_115]) {
    test(`any set of subdivisions: one entry per boundary, none reading the same (seed ${seed})`, () => {
      fc.assert(property, { seed, numRuns: 200 });
    });
  }
  test('any set of subdivisions: one entry per boundary, none reading the same (a random seed)', () => {
    fc.assert(property, { numRuns: 200 });
  });
});

describe('the loaded layer decides when a name is shared', () => {
  test('two of one name and one kind gain nothing from it: they read as before', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        area('tiger/3601916353', 'Clinton', 'Clinton town'),
        area('tiger/3606516551', 'Clinton', 'Clinton town'),
      ],
    });
    expect(
      await t.query(internal.bodyGeo.townNamesShared, {
        towns: [{ state: 'NY', name: 'Clinton' }],
      }),
    ).toEqual([false]);
    const pins = await t.run((ctx) => pinnedFactsFor(ctx, ['tiger/3601916353']));
    expect(pins.pinnedTowns.map((p) => townLabel(p))).toEqual(['Clinton, NY']);
  });

  const SQUARE = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-73.5, 44.6],
        [-73.4, 44.6],
        [-73.4, 44.7],
        [-73.5, 44.7],
        [-73.5, 44.6],
      ],
    ],
  };
  const area = (externalId: string, name: string, fullName?: string) => ({
    externalId,
    name,
    ...(fullName !== undefined ? { fullName } : {}),
    level: 'town' as const,
    state: 'NY',
    polygon: SQUARE,
    bbox: { minLat: 44.6, minLng: -73.5, maxLat: 44.7, maxLng: -73.4 },
    centroid: { lat: 44.65, lng: -73.45 },
  });

  test('a pinned town shows its kind only when its state has two of its name', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        area('tiger/3601958420', 'Plattsburgh', 'Plattsburgh city'),
        area('tiger/3601958431', 'Plattsburgh', 'Plattsburgh town'),
        area('tiger/3601900001', 'Peru', 'Peru town'),
      ],
    });
    const pins = await t.run((ctx) =>
      pinnedFactsFor(ctx, ['tiger/3601958420', 'tiger/3601900001']),
    );
    expect(pins.pinnedTowns.map((p) => townLabel(p))).toEqual([
      'Plattsburgh (city), NY',
      'Peru, NY',
    ]);
    // Both Plattsburghs pinned: the namesakes are read once for the name, and each keeps its kind.
    const both = await t.run((ctx) =>
      pinnedFactsFor(ctx, ['tiger/3601958420', 'tiger/3601958431']),
    );
    expect(both.pinnedTowns.map((p) => townLabel(p))).toEqual([
      'Plattsburgh (city), NY',
      'Plattsburgh (town), NY',
    ]);
    const ask = (state: string, name: string) =>
      t.query(internal.bodyGeo.townNamesShared, { towns: [{ state, name }] });
    expect(await ask('NY', 'Plattsburgh')).toEqual([true]);
    expect(await ask('NY', 'Peru')).toEqual([false]);
    expect(await ask('VT', 'Plattsburgh')).toEqual([false]);
  });

  test('the recompute asks the layer: a body across the two Plattsburghs stores both, each with its kind', async () => {
    const t = convexTest(schema, modules);
    const rect = (x0: number, x1: number) => ({
      ...area('', ''),
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [x0, 44.6],
            [x1, 44.6],
            [x1, 44.7],
            [x0, 44.7],
            [x0, 44.6],
          ],
        ],
      },
      bbox: { minLat: 44.6, minLng: x0, maxLat: 44.7, maxLng: x1 },
      centroid: { lat: 44.65, lng: (x0 + x1) / 2 },
    });
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        {
          ...rect(-73.5, -73.45),
          externalId: 'tiger/3601958420',
          name: 'Plattsburgh',
          fullName: 'Plattsburgh city',
        },
        {
          ...rect(-73.45, -73.4),
          externalId: 'tiger/3601958431',
          name: 'Plattsburgh',
          fullName: 'Plattsburgh town',
        },
      ],
    });
    // A pond across the line between them: well over 25 m of shore in each.
    const ring: number[][] = [];
    for (let i = 0; i < 32; i++) {
      const a = (2 * Math.PI * i) / 32;
      ring.push([-73.45 + 0.005 * Math.cos(a), 44.65 + 0.003 * Math.sin(a)]);
    }
    ring.push(ring[0] as number[]);
    const bbox = { minLng: -73.455, maxLng: -73.445, minLat: 44.647, maxLat: 44.653 };
    const id = await t.run(async (ctx) => {
      const body = await ctx.db.insert('waterBodies', {
        name: 'Across',
        searchText: 'Across',
        type: 'lakePond',
        source: 'osm',
        polygon: { type: 'Polygon', coordinates: [ring] },
        bbox,
        centroid: { lat: 44.65, lng: -73.45 },
        states: ['NY'],
        dedupStatus: 'clean',
        createdAt: 0,
        minVisibleZoom: 8,
        displayScore: 1,
      });
      await syncWaterBodyCells(ctx, body, { bbox, minVisibleZoom: 8, listed: true });
      await rebuildBodyLibrary(ctx, body);
      await markGeoStale(ctx, [body]);
      return body;
    });
    await t.action(internal.bodyGeo.computeDue, {});
    const geo = await t.run((ctx) => geoFactsOf(ctx, id));
    expect(townNamesOf(placesOf(geo))?.sort()).toEqual([
      'Plattsburgh (city)',
      'Plattsburgh (town)',
    ]);
  });
});
