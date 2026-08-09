import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  return t;
}

/** An axis-aligned square polygon over [west,east]×[south,north] (coords are [lng, lat]). */
function square(west: number, south: number, east: number, north: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** An admin-area import row from a square, centroid at the box center. */
function area(
  externalId: string,
  name: string,
  level: 'state' | 'county' | 'town',
  state: string,
  [west, south, east, north]: [number, number, number, number],
) {
  return {
    externalId,
    name,
    level,
    state,
    polygon: square(west, south, east, north),
    bbox: { minLat: south, minLng: west, maxLat: north, maxLng: east },
    centroid: { lat: (south + north) / 2, lng: (west + east) / 2 },
  };
}

/** Seed a nested VT town/county/state stack + an adjacent NY state (west of lng 0). */
async function seedAreas(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.adminAreas.importCanonical, {
    areas: [
      area('relation/vt', 'Vermont', 'state', 'VT', [0, 0, 10, 10]),
      area('relation/ny', 'New York', 'state', 'NY', [-10, 0, 0, 10]),
      area('relation/chittenden', 'Chittenden County', 'county', 'VT', [0, 0, 2, 2]),
      area('relation/burlington', 'Burlington', 'town', 'VT', [0, 0, 1, 1]),
    ],
  });
}

describe('adminAreas.importCanonical', () => {
  test('inserts new rows, then upserts (updates) on the external id', async () => {
    const t = convexTestWithGeo();
    const first = await t.mutation(internal.adminAreas.importCanonical, {
      areas: [area('relation/burlington', 'Burlington', 'town', 'VT', [0, 0, 1, 1])],
    });
    expect(first).toEqual({ inserted: 1, updated: 0 });

    // Re-running with the same external id updates in place — no duplicate row.
    const second = await t.mutation(internal.adminAreas.importCanonical, {
      areas: [area('relation/burlington', 'Burlington City', 'town', 'VT', [0, 0, 1, 1])],
    });
    expect(second).toEqual({ inserted: 0, updated: 1 });

    const rows = await t.run((ctx) => ctx.db.query('adminAreas').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Burlington City');

    // The re-import must *reconcile* the boundary's cells, not append a second stale set — stale
    // rows would send containment lookups chasing a boundary that has moved (N1).
    const cells = await t.run((ctx) => ctx.db.query('adminAreaCells').collect());
    expect(new Set(cells.map((c) => c.adminAreaId))).toEqual(new Set([rows[0]?._id]));
    expect(new Set(cells.map((c) => c.z)).size).toBe(1); // one rung, no leftovers from before
    expect(cells.length).toBeLessThanOrEqual(4); // theorem 2
  });
});

describe('adminAreas.resolvePlace', () => {
  test('resolves a point inside a town to town + county + state', async () => {
    const t = convexTestWithGeo();
    await seedAreas(t);
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 0.5, lng: 0.5 } });
    expect(place).toEqual({ town: 'Burlington', county: 'Chittenden County', state: 'VT' });
  });

  test('falls back to county + state where a point is in a county but no town', async () => {
    const t = convexTestWithGeo();
    await seedAreas(t);
    // (1.5, 1.5) is in Chittenden County [0,2]² but outside Burlington town [0,1]².
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 1.5, lng: 1.5 } });
    expect(place).toEqual({ county: 'Chittenden County', state: 'VT' });
  });

  test('resolves the correct state for a point across a state border', async () => {
    const t = convexTestWithGeo();
    await seedAreas(t);
    // lng -5 is inside NY [-10,0]×[0,10], not VT — no town/county seeded there.
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 5, lng: -5 } });
    expect(place).toEqual({ state: 'NY' });
  });

  test('returns undefined for a point outside every imported boundary (ocean / no-match)', async () => {
    const t = convexTestWithGeo();
    await seedAreas(t);
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 50, lng: 50 } });
    expect(place).toBeNull(); // Convex normalizes a returned undefined to null over the wire
  });

  test('returns undefined when no admin areas are imported at all', async () => {
    const t = convexTestWithGeo();
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 0.5, lng: 0.5 } });
    expect(place).toBeNull();
  });
});

describe('adminAreas.resolvePlace — boundaries too big for the old centroid margin (N1)', () => {
  test('labels a point in a town far wider than 0.4°, which used to silently lose its town', async () => {
    // The regression this migration exists for. `findContainingTown` used to query town *centroids*
    // within ±0.2° of the point, on the stated premise that "our towns run well under 0.4° across".
    // Phase 2.5 loaded the Adirondacks, where towns like Long Lake span more than that — and the
    // failure was silent: the label just quietly degraded to county+state. Here the point sits deep
    // in a 2°-wide town, more than the old margin from its centroid.
    const t = convexTestWithGeo();
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        area('relation/ny', 'New York', 'state', 'NY', [0, 0, 10, 10]),
        area('relation/hamilton', 'Hamilton County', 'county', 'NY', [0, 0, 4, 4]),
        area('relation/longlake', 'Long Lake', 'town', 'NY', [0, 0, 2, 2]),
      ],
    });

    // Centroid of Long Lake is (1, 1); this point is ~0.9° away in both axes — outside the ±0.2°
    // rectangle the old lookup would have searched, but squarely inside the town.
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 0.1, lng: 0.1 } });
    expect(place).toEqual({ town: 'Long Lake', county: 'Hamilton County', state: 'NY' });
  });

  test('resolves state and county without scanning every row of their level', async () => {
    // The other half: county/state containment used to `collect()` an entire level, because a state
    // centroid can sit degrees from an interior point. That scan grew with every state imported.
    const t = convexTestWithGeo();
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        area('relation/big', 'Big State', 'state', 'ME', [0, 0, 10, 10]),
        area('relation/far', 'Far State', 'state', 'MA', [20, 20, 30, 30]),
        area('relation/farther', 'Farther State', 'state', 'NH', [40, 40, 50, 50]),
      ],
    });
    const place = await t.query(api.adminAreas.resolvePlace, { point: { lat: 9.5, lng: 9.5 } });
    expect(place).toEqual({ state: 'ME' });

    // Only the containing state has cells anywhere near the point — the others are never read.
    const cells = await t.run((ctx) => ctx.db.query('adminAreaCells').collect());
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells.map((c) => c.adminAreaId)).size).toBe(3);
  });
});

/**
 * **The two delete paths, and the query the merge clips against** (N7-3).
 *
 * None of these had a test. `deleteByExternalIds` and `retireOsmSourcedAreas` are the only mutations
 * in this file that destroy rows, and they destroy the table **every place label in the app reads
 * from** — through `adminAreaCells`, which is why both delete cells before rows. A row removed
 * without its cells leaves containment pointing at an id that no longer loads.
 */
describe('adminAreas delete paths (N7)', () => {
  /** Seed one area and give it a cell row, the way the importer does. */
  async function seedWithCell(
    t: ReturnType<typeof convexTestWithGeo>,
    externalId: string,
    name: string,
    level: 'state' | 'county' | 'town' = 'state',
  ) {
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [area(externalId, name, level, 'VT', [-73.5, 44.0, -72.5, 45.0])],
    });
    return t.run(async (ctx) => {
      const row = await ctx.db
        .query('adminAreas')
        .withIndex('by_external_id', (q) => q.eq('externalId', externalId))
        .unique();
      const cells = await ctx.db
        .query('adminAreaCells')
        .withIndex('by_area', (q) => q.eq('adminAreaId', row?._id as never))
        .collect();
      return { id: row?._id, cells: cells.length };
    });
  }

  test('deleteByExternalIds removes the cells before the row, leaving nothing dangling', async () => {
    const t = convexTestWithGeo();
    const seeded = await seedWithCell(t, 'relation/60759', 'Vermont');
    expect(seeded.cells).toBeGreaterThan(0);

    const result = await t.mutation(internal.adminAreas.deleteByExternalIds, {
      externalIds: ['relation/60759'],
    });
    expect(result).toMatchObject({ deleted: 1, missing: [] });
    expect(result.cellsDeleted).toBe(seeded.cells);

    // The property that matters: no cell survives pointing at a row that no longer loads.
    const leftovers = await t.run(async (ctx) => {
      const cells = await ctx.db.query('adminAreaCells').collect();
      const rows = await ctx.db.query('adminAreas').collect();
      return { cells: cells.length, rows: rows.length };
    });
    expect(leftovers).toEqual({ cells: 0, rows: 0 });
  });

  test('names an externalId it could not find rather than reporting a delete', async () => {
    // The blast radius here is every place label in the app, so "I deleted nothing and said so" and
    // "I deleted something" must never look alike.
    const t = convexTestWithGeo();
    const result = await t.mutation(internal.adminAreas.deleteByExternalIds, {
      externalIds: ['relation/does-not-exist'],
    });
    expect(result).toMatchObject({
      deleted: 0,
      cellsDeleted: 0,
      missing: ['relation/does-not-exist'],
    });
  });

  test('deletes only what it was named, never a prefix', async () => {
    // ⚠ The docstring's own rule: a prefix match would have made this a one-line way to empty the
    // table. Naming the rows IS the safety.
    const t = convexTestWithGeo();
    await seedWithCell(t, 'relation/1', 'Vermont');
    await seedWithCell(t, 'relation/2', 'Maine');
    await seedWithCell(t, 'tiger/50', 'Vermont (TIGER)');

    await t.mutation(internal.adminAreas.deleteByExternalIds, { externalIds: ['relation/1'] });
    const left = await t.run((ctx) => ctx.db.query('adminAreas').collect());
    expect(left.map((r) => r.externalId).sort()).toEqual(['relation/2', 'tiger/50']);
  });

  test('retireOsmSourcedAreas is DRY by default and keeps every TIGER row', async () => {
    // TIGER keys on `tiger/<GEOID>` and OSM on `relation/<id>`, so loading TIGER ADDS rows beside
    // the OSM ones. Two outlines for one state is worse than the gap it replaced — `resolvePlace`
    // would resolve through whichever cell it read first.
    const t = convexTestWithGeo();
    await seedWithCell(t, 'relation/60759', 'Vermont');
    await seedWithCell(t, 'tiger/50', 'Vermont', 'state');
    await seedWithCell(t, 'relation/999', 'Chittenden', 'county');

    const dry = await t.mutation(internal.adminAreas.retireOsmSourcedAreas, {});
    expect(dry).toMatchObject({ wouldDelete: 2, deleted: 0, cellsDeleted: 0, isDone: true });
    expect(dry.byLevel).toEqual({ state: 1, county: 1 });
    expect(await t.run((ctx) => ctx.db.query('adminAreas').collect())).toHaveLength(3);
  });

  test('retireOsmSourcedAreas with apply removes the OSM rows and their cells', async () => {
    const t = convexTestWithGeo();
    await seedWithCell(t, 'relation/60759', 'Vermont');
    await seedWithCell(t, 'tiger/50', 'Vermont');

    const applied = await t.mutation(internal.adminAreas.retireOsmSourcedAreas, { apply: true });
    expect(applied.deleted).toBe(1);
    expect(applied.cellsDeleted).toBeGreaterThan(0);

    const rows = await t.run((ctx) => ctx.db.query('adminAreas').collect());
    expect(rows.map((r) => r.externalId)).toEqual(['tiger/50']);
    // Containment reads through the cells, so the survivor's must still be there.
    const cells = await t.run((ctx) => ctx.db.query('adminAreaCells').collect());
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.adminAreaId).toBe(rows[0]?._id);
  });

  test('retireOsmSourcedAreas deletes nothing when TIGER is all there is', async () => {
    const t = convexTestWithGeo();
    await seedWithCell(t, 'tiger/50', 'Vermont');
    const result = await t.mutation(internal.adminAreas.retireOsmSourcedAreas, { apply: true });
    expect(result).toMatchObject({ wouldDelete: 0, deleted: 0 });
  });
});

describe('adminAreas.listBoundariesForClip (what the merge clips against)', () => {
  test('pages the outlines the region clip needs, and nothing else', async () => {
    // `build-region` writes `boundaries.ndjson` from this, and the merge asserts it found five state
    // outlines. Returning a shape without `polygon` would fail the clip for every body at once.
    const t = convexTestWithGeo();
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        area('tiger/50', 'Vermont', 'state', 'VT', [-73.5, 44.0, -72.5, 45.0]),
        area('tiger/33', 'New Hampshire', 'state', 'NH', [-72.5, 43.0, -71.0, 45.0]),
      ],
    });

    const page = await t.query(internal.adminAreas.listBoundariesForClip, {});
    expect(page.isDone).toBe(true);
    expect(page.areas).toHaveLength(2);
    for (const a of page.areas) {
      expect(a.polygon).toBeDefined();
      expect(a.bbox).toBeDefined();
      expect(a.level).toBe('state');
    }
    expect(page.areas.map((a) => a.name).sort()).toEqual(['New Hampshire', 'Vermont']);
  });

  test('honours a batch size and hands back a usable cursor', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        area('tiger/50', 'Vermont', 'state', 'VT', [-73.5, 44.0, -72.5, 45.0]),
        area('tiger/33', 'New Hampshire', 'state', 'NH', [-72.5, 43.0, -71.0, 45.0]),
      ],
    });

    const first = await t.query(internal.adminAreas.listBoundariesForClip, { batchSize: 1 });
    expect(first.areas).toHaveLength(1);
    expect(first.isDone).toBe(false);

    const second = await t.query(internal.adminAreas.listBoundariesForClip, {
      cursor: first.cursor,
      batchSize: 1,
    });
    expect(second.areas).toHaveLength(1);
    expect(second.areas[0]?.name).not.toBe(first.areas[0]?.name);
  });
});
