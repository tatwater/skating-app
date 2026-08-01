import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * `waterBodies.matchBathymetryLakes` — the N6b join.
 *
 * Mirrors the N6a depth-join suite deliberately: same seeding, same helpers, same area gate. The
 * point of these tests is not that a new join works, but that it is the **same** join — a second
 * notion of "these are the same lake" is what the ladder work exists to prevent.
 */
describe('waterBodies.matchBathymetryLakes', () => {
  /** Insert a body directly, for a typed id. `importCanonical` below is what makes it reachable. */
  async function insertBody(
    t: ReturnType<typeof convexTest>,
    externalId: string,
    extra: Record<string, unknown>,
  ) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        type: 'lake' as const,
        source: 'osm' as const,
        externalId,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
        ...extra,
      }),
    ) as Promise<Id<'waterBodies'>>;
  }

  /**
   * A square body centred on `centre`. Inserted for a typed id, then run through `importCanonical`
   * to build the N1 cell rows — `listedBodiesNearCoord` reads those, so a hand-inserted body is
   * unreachable from any spatial lookup.
   */
  async function seedSquareBody(
    t: ReturnType<typeof convexTest>,
    half: number,
    areaSqM: number,
    name = 'Test Lake',
    centre = { lat: 44, lng: -72 },
  ) {
    const externalId = `way/${name.replace(/\s+/g, '-')}`;
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [centre.lng - half, centre.lat - half],
          [centre.lng + half, centre.lat - half],
          [centre.lng + half, centre.lat + half],
          [centre.lng - half, centre.lat + half],
          [centre.lng - half, centre.lat - half],
        ],
      ],
    };
    const bbox = {
      minLat: centre.lat - half,
      minLng: centre.lng - half,
      maxLat: centre.lat + half,
      maxLng: centre.lng + half,
    };
    const id = await insertBody(t, externalId, {
      name,
      polygon,
      bbox,
      centroid: centre,
      surfaceAreaSqM: areaSqM,
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          name,
          type: 'lake' as const,
          source: 'osm' as const,
          externalId,
          polygon,
          bbox,
          centroid: centre,
          surfaceAreaSqM: areaSqM,
        },
      ],
    });
    return { id, externalId, polygon };
  }

  test('matches a source lake to the body its point falls inside', async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedSquareBody(t, 0.05, 1e7, 'Bald Mountain Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'NHLAK802010303-10', point: { lat: 44, lng: -72 }, areaSqM: 1.2e7 }],
    });
    expect(result.rejects).toEqual([]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.waterBodyId).toBe(id);
    expect(result.matches[0]?.key).toBe('NHLAK802010303-10');
  });

  test('returns the stable externalId, not just the Convex id', async () => {
    // Tiles are stamped with this so the client can filter to the open lake (D81). It must be the
    // OSM id: a Convex `_id` changes if a row is recreated, and re-tiling five states because a
    // re-import churned ids is not a thing we should be one accident away from.
    const t = convexTest(schema, modules);
    const { externalId } = await seedSquareBody(t, 0.05, 1e7, 'Long Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: '2097007', point: { lat: 44, lng: -72 } }],
    });
    expect(result.matches[0]?.externalId).toBe(externalId);
    expect(result.matches[0]?.source).toBe('osm');
  });

  test('returns the polygon, which is what the shoreline constraint needs', async () => {
    // §Maine step 3: the shore is a depth-0 boundary constraint. Without it contours never close and
    // nothing nests — the failure that made the first renders unusable.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 } }],
    });
    const polygon = result.matches[0]?.polygon as { type: string; coordinates: number[][][] };
    expect(polygon.type).toBe('Polygon');
    expect(polygon.coordinates[0]).toHaveLength(5);
  });

  test('omits the polygon when the caller only wants identity', async () => {
    // A coverage count over 1,600 lakes shouldn't drag 1,600 polygons across the wire.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 } }],
      includePolygon: false,
    });
    expect(result.matches[0]?.polygon).toBeUndefined();
    expect(result.matches[0]?.waterBodyId).toBeDefined();
  });

  test('rejects an order-of-magnitude area mismatch, naming the body it declined', async () => {
    // The failure mode that produces a WRONG answer rather than no answer, and it costs more here
    // than it did for depth: a misattributed basin is a whole rendered map of somewhere else, drawn
    // confidently inside the wrong shoreline.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.005, 1e5, 'Little Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'big-lake', point: { lat: 44, lng: -72 }, areaSqM: 4e7 }],
    });
    expect(result.matches).toEqual([]);
    expect(result.rejects[0]?.reason).toContain('Little Pond');
    expect(result.rejects[0]?.reason).toContain('area mismatch');
  });

  test('accepts a modest area disagreement — three water masks, three shorelines', async () => {
    // The gate is deliberately loose. Each source draws its shoreline from a different water mask at
    // a different date, so a 2× disagreement is normal and a false reject costs a lake its contours.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 }, areaSqM: 2.5e7 }],
    });
    expect(result.matches).toHaveLength(1);
  });

  test('names a lake that matched nothing rather than dropping it', async () => {
    // An ETL that silently matches 60% of its input looks exactly like one that matched all of it.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'nowhere', point: { lat: 10, lng: 10 } }],
    });
    expect(result.matches).toEqual([]);
    expect(result.rejects).toEqual([{ key: 'nowhere', reason: 'no listed body at this point' }]);
  });

  test('uses no approach buffer — a point just offshore is not the lake', async () => {
    // `resolveBodyForCoord`'s 300 m parking buffer exists so a skater in the car resolves the lake.
    // Here it would let a sounding just off one shoreline claim the body across the road.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.01, 1e6);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'offshore', point: { lat: 44, lng: -72.02 } }],
    });
    expect(result.matches).toEqual([]);
  });

  test('resolves a batch, keeping each lake’s own key with its own outcome', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.02, 1e6, 'A');
    await seedSquareBody(t, 0.02, 1e6, 'B', { lat: 45, lng: -71 });
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [
        { key: 'a', point: { lat: 44, lng: -72 } },
        { key: 'missing', point: { lat: 10, lng: 10 } },
        { key: 'b', point: { lat: 45, lng: -71 } },
      ],
    });
    expect(result.matches.map((m) => m.key)).toEqual(['a', 'b']);
    expect(result.matches.map((m) => m.name)).toEqual(['A', 'B']);
    expect(result.rejects.map((r) => r.key)).toEqual(['missing']);
  });

  test('is read-only — a join can be inspected before anything is written', async () => {
    // A bad join silently attributes one lake's basin to another, so resolving and writing are
    // separate calls on purpose.
    const t = convexTest(schema, modules);
    const { id } = await seedSquareBody(t, 0.05, 1e7);
    const before = await t.run((ctx) => ctx.db.get(id));
    await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 }, areaSqM: 1e7 }],
    });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after).toEqual(before);
  });
});
