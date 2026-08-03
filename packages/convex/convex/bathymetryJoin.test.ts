import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * `waterBodies.matchBathymetryLakes` — the N6b join.
 *
 * Shares N6a's seeding and its corpus, and deliberately **not** its resolver. That was the original
 * design — one notion of "these are the same lake" — and it was wrong in a way only the first real
 * run could show: N6a places a single depth *reading*, where the most specific body containing the
 * point is the answer, and this places a whole *survey*, where it is very often that lake's bay.
 *
 * So the three tests that matter most here are regressions against what shipped, not proofs that a
 * join works: the survey must reach the lake rather than its bay, must be bounded by its own
 * footprint rather than by nothing at all, and must survive a shoreline disagreement of a few metres.
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

  /**
   * `n` measurements spread across a square of half-width `half` — a survey's sampled footprint.
   *
   * Spread to 80% of the half-width so every point is comfortably inside a body of the same extent:
   * the gate is being tested, not our floating-point boundary handling.
   */
  function survey(half: number, centre = { lat: 44, lng: -72 }, n = 16) {
    return Array.from({ length: n }, (_, i) => {
      const t = ((i + 0.5) / n) * 2 - 1;
      const u = (((i * 5) % n) / n) * 2 - 1;
      return { lat: centre.lat + t * half * 0.8, lng: centre.lng + u * half * 0.8 };
    });
  }

  test('matches a source lake to the body its point falls inside', async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedSquareBody(t, 0.05, 1e7, 'Bald Mountain Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [
        { key: 'NHLAK802010303-10', point: { lat: 44, lng: -72 }, samplePoints: survey(0.05) },
      ],
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

  test('rejects a body holding almost none of the survey, saying how much it held', async () => {
    // The failure mode that produces a WRONG answer rather than no answer, and it costs more here
    // than it did for depth: a misattributed basin is a whole rendered map of somewhere else, drawn
    // confidently inside the wrong shoreline. Only the deepest point is inside "Little Pond"; the
    // rest of the survey is spread over water forty times its size.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.005, 1e5, 'Little Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'big-lake', point: { lat: 44, lng: -72 }, samplePoints: survey(0.05) }],
    });
    expect(result.matches).toEqual([]);
    expect(result.rejects[0]?.reason).toContain('Little Pond');
    expect(result.rejects[0]?.reason).toContain('holds the survey');
  });

  test('a SPARSE survey of the right lake still matches — the regression that cost 68 lakes', async () => {
    // The area gate this replaces measured the survey's own footprint and compared it to the body.
    // Soundings sample a lake's interior, so that footprint under-states the lake — worst where the
    // survey is thinnest. Spencer Pond's four soundings hulled to 54 m² against a real body, and 68
    // lakes that had rendered correctly were rejected as 1,000× mismatches. A fraction cannot do
    // that: four points inside the lake are 100% inside the lake.
    const t = convexTest(schema, modules);
    const { id } = await seedSquareBody(t, 0.05, 1e7, 'Spencer Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [
        {
          key: 'sparse',
          point: { lat: 44, lng: -72 },
          // Four measurements clustered in the middle of a lake 100× their spread.
          samplePoints: survey(0.0005),
        },
      ],
    });
    expect(result.rejects).toEqual([]);
    expect(result.matches[0]?.waterBodyId).toBe(id);
  });

  test('a survey spread across half a state matches nothing, however many points it has', async () => {
    // Two Maine MIDAS ids are junk buckets, not lakes: 30% of the state's soundings in clouds
    // spanning 348 km. `splitByBody` cannot break them up because it derives its gap threshold from
    // the contaminated extent. Containment does not care — a cloud that size is ~0% inside anything.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7, 'Not This Lake');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: '870', point: { lat: 44, lng: -72 }, samplePoints: survey(3.0) }],
    });
    expect(result.matches).toEqual([]);
    expect(result.rejects[0]?.reason).toContain('holds the survey');
  });

  test('without samplePoints the gate cannot run at all — the silent-failure shape itself', async () => {
    // Documenting the hole rather than only the fix. The first build published surveys against the
    // wrong water exactly this way — Caribou Lake's soundings inside Ripogenus Lake, among others —
    // because the gate was conditional on a field the ETL never sent, so it never ran and nothing
    // said so. Omitting the sample is choosing to run ungated.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.005, 1e5, 'Little Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'big-lake', point: { lat: 44, lng: -72 } }],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.rejects).toEqual([]);
  });

  test('resolves a survey to the LAKE, not to the bay holding its deepest sounding', async () => {
    // The Moosehead bug, at scale 1:1. The deepest point of a lake very often falls in one of its
    // bays, and ranking by smallest-area — correct for a single depth reading — put all 75,416 acres
    // of Moosehead Lake's soundings onto North Bay's 1,240.
    const t = convexTest(schema, modules);
    const lake = await seedSquareBody(t, 0.08, 3.05e8, 'Moosehead Lake');
    const bay = await seedSquareBody(t, 0.01, 5.0e6, 'North Bay');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      // The survey spans the whole lake: ~100% inside Moosehead, a few percent inside the bay.
      lakes: [{ key: '390', point: { lat: 44, lng: -72 }, samplePoints: survey(0.08) }],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.name).toBe('Moosehead Lake');
    expect(result.matches[0]?.waterBodyId).toBe(lake.id);
    // …and the bay is not discarded: a skater on North Bay is on Moosehead's basin.
    expect(result.matches[0]?.alsoCovers?.map((b) => b.waterBodyId)).toEqual([bay.id]);
    expect(result.matches[0]?.alsoCovers?.[0]?.polygon).toBeDefined();
  });

  test('alsoCovers is empty when nothing is nested', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7, 'Plain Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 }, samplePoints: survey(0.05) }],
    });
    expect(result.matches[0]?.alsoCovers).toEqual([]);
  });

  test('tolerates a survey that overruns our shoreline — three water masks, three shorelines', async () => {
    // The threshold is deliberately loose. Each source draws its shoreline from a different water
    // mask at a different date, so near-shore measurements routinely fall outside our polygon. Here
    // the survey is drawn 25% wider than the body, putting a slice of it outside, and it must still
    // match: a false reject costs a real lake its contours.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.05, 1e7);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 }, samplePoints: survey(0.0625) }],
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
    expect(result.rejects[0]?.key).toBe('nowhere');
    expect(result.rejects[0]?.reason).toContain('no listed body within');
  });

  test('a metres-wide shoreline disagreement still resolves — 7 real lakes were lost to this', async () => {
    // Two agencies drawing the same shore from different imagery on different dates. The deepest
    // sounding in a lake is the furthest point from any shore, so a few metres outside our polygon is
    // never the pond across the road. Burncoat Park Pond sat 0 m outside its own namesake; Wat-Tuh
    // Lake 1 m; Middle Pond 2 m — all rejected outright by the zero buffer this replaces.
    const t = convexTest(schema, modules);
    // ~0.0001° ≈ 8 m past the eastern edge at 44°N.
    await seedSquareBody(t, 0.01, 1e6, 'Barnstead Parade Dam Pond');
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [
        { key: 'just-outside', point: { lat: 44, lng: -71.9899 }, samplePoints: survey(0.01) },
      ],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.name).toBe('Barnstead Parade Dam Pond');
  });

  test('the buffer stops well short of the next lake over', async () => {
    // The band that begins at 126 m is where wrong answers start: Goodwin Pond, 7 acres, reaching
    // Mooselookmeguntic Lake at 16,213. ~1.6 km out here, an order of magnitude past the 25 m reach.
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.01, 1e6);
    const result = await t.query(internal.waterBodies.matchBathymetryLakes, {
      lakes: [{ key: 'offshore', point: { lat: 44, lng: -72.03 }, samplePoints: survey(0.01) }],
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
      lakes: [{ key: 'k', point: { lat: 44, lng: -72 }, samplePoints: survey(0.05) }],
    });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after).toEqual(before);
  });
});
