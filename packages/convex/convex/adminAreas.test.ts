import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
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
