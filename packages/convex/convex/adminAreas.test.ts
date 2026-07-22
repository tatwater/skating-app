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

    // The re-import must also *replace* the geospatial centroid, not append a second stale point —
    // a duplicate would silently eat into `findContainingTown`'s read cap. Query the town level over
    // the box and assert exactly one entry survives, keyed to the surviving row. `adminAreasGeo` is
    // imported inside `t.run` so its backend-only constructor runs in the convex-test context.
    const geoHits = await t.run(async (ctx) => {
      const { adminAreasGeo } = await import('./lib/geospatial');
      return adminAreasGeo.query(ctx, {
        shape: { type: 'rectangle', rectangle: { west: 0, east: 1, south: 0, north: 1 } },
        limit: 128,
        filter: (q) => q.eq('level', 'town'),
      });
    });
    expect(geoHits.results).toHaveLength(1);
    expect(geoHits.results[0]?.key).toBe(rows[0]?._id);
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
