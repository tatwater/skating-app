import { MIN_DECILE_SAMPLE } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * `regionStats.recompute` — the per-state decile basis behind the derived caption (N6c A5).
 *
 * The interesting behaviour is not "does it compute percentiles" (that is `computeDeciles`, tested
 * in core) but the three ways this job can produce a *confidently wrong* basis: counting a body in
 * the wrong state, counting a body we have agreed to hide, and publishing a block from a sample too
 * thin to describe anything.
 */
describe('regionStats.recompute', () => {
  const POLYGON = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-73.0, 44.0],
        [-72.9, 44.0],
        [-72.9, 44.1],
        [-73.0, 44.1],
        [-73.0, 44.0],
      ],
    ],
  };

  async function seed(
    t: ReturnType<typeof convexTest>,
    bodies: Array<{ states: string[]; elevationM?: number; extra?: Record<string, unknown> }>,
  ) {
    await t.run(async (ctx) => {
      for (const [i, b] of bodies.entries()) {
        await ctx.db.insert('waterBodies', {
          name: `body${i}`,
          type: 'lake',
          source: 'osm',
          externalId: `way/${i}`,
          states: b.states,
          polygon: POLYGON,
          bbox: { minLat: 44, minLng: -73, maxLat: 44.1, maxLng: -72.9 },
          centroid: { lat: 44.05, lng: -72.95 },
          dedupStatus: 'clean',
          createdAt: Date.now(),
          ...(b.elevationM !== undefined ? { elevationM: b.elevationM } : {}),
          ...(b.extra ?? {}),
        });
      }
    });
  }

  /** `n` bodies in one state with a spread of elevations — enough to clear the sample floor. */
  function rampBodies(state: string, n: number) {
    return Array.from({ length: n }, (_, i) => ({ states: [state], elevationM: 10 + i }));
  }

  test('writes one row per state with the metrics that cleared the sample floor', async () => {
    const t = convexTest(schema, modules);
    await seed(t, rampBodies('VT', 50));

    const result = await t.action(internal.regionStats.recompute, {});
    expect(result.bodiesRead).toBe(50);

    const rows = await t.query(api.regionStats.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('VT');
    expect(rows[0]?.bodiesScanned).toBe(50);
    expect(rows[0]?.metrics.elevationM?.count).toBe(50);
    expect(rows[0]?.metrics.elevationM?.deciles).toHaveLength(9);
    // No depth or long axis was seeded, so those blocks are ABSENT rather than empty — which is
    // what makes `decileRankOf` return null and the caption stay silent.
    expect(rows[0]?.metrics.maxDepthM).toBeUndefined();
    expect(rows[0]?.metrics.longAxisM).toBeUndefined();
  });

  test('omits a metric whose sample is too thin to describe a distribution', async () => {
    const t = convexTest(schema, modules);
    await seed(t, rampBodies('VT', MIN_DECILE_SAMPLE - 1));
    await t.action(internal.regionStats.recompute, {});
    const rows = await t.query(api.regionStats.list, {});
    // The row still exists (we scanned the state) but it publishes no elevation basis.
    expect(rows[0]?.bodiesScanned).toBe(MIN_DECILE_SAMPLE - 1);
    expect(rows[0]?.metrics.elevationM).toBeUndefined();
  });

  test('counts a border-spanning body in every state it belongs to', async () => {
    // Champlain genuinely IS among the deepest in both Vermont and New York; counting it once
    // would make one of those comparisons wrong.
    const t = convexTest(schema, modules);
    await seed(t, [
      ...rampBodies('VT', 40),
      ...rampBodies('NY', 40),
      { states: ['VT', 'NY'], elevationM: 500 },
    ]);
    await t.action(internal.regionStats.recompute, {});
    const rows = await t.query(api.regionStats.list, {});
    const vt = rows.find((r) => r.state === 'VT');
    const ny = rows.find((r) => r.state === 'NY');
    expect(vt?.metrics.elevationM?.count).toBe(41);
    expect(ny?.metrics.elevationM?.count).toBe(41);
  });

  test('excludes an unlisted body — content we agreed to hide must not shape a sentence we render', async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      ...rampBodies('VT', 40),
      { states: ['VT'], elevationM: 1500, extra: { removedAt: Date.now() } },
    ]);
    await t.action(internal.regionStats.recompute, {});
    const rows = await t.query(api.regionStats.list, {});
    expect(rows[0]?.bodiesScanned).toBe(40);
    expect(rows[0]?.metrics.elevationM?.count).toBe(40);
    // The removed body's 1500 m would have been the top cut point had it counted.
    expect(rows[0]?.metrics.elevationM?.deciles.at(-1)).toBeLessThan(100);
  });

  test('ignores an unknown state code rather than inventing a region', async () => {
    const t = convexTest(schema, modules);
    await seed(t, [...rampBodies('VT', 40), ...rampBodies('ZZ', 40)]);
    await t.action(internal.regionStats.recompute, {});
    const rows = await t.query(api.regionStats.list, {});
    expect(rows.map((r) => r.state)).toEqual(['VT']);
  });

  test('is idempotent — a second run replaces rather than duplicates', async () => {
    const t = convexTest(schema, modules);
    await seed(t, rampBodies('VT', 40));
    await t.action(internal.regionStats.recompute, {});
    await t.action(internal.regionStats.recompute, {});
    expect(await t.query(api.regionStats.list, {})).toHaveLength(1);
  });

  test('pages the corpus rather than collecting it', async () => {
    // The N1 lesson: 116,070 bodies cannot be read in one transaction. Forcing a tiny page size
    // proves the cursor loop actually advances instead of re-reading page one forever.
    const t = convexTest(schema, modules);
    await seed(t, rampBodies('VT', 60));
    const result = await t.action(internal.regionStats.recompute, { batchSize: 7 });
    expect(result.bodiesRead).toBe(60);
    const rows = await t.query(api.regionStats.list, {});
    expect(rows[0]?.metrics.elevationM?.count).toBe(60);
  });
});
