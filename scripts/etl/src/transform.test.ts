import { readFileSync } from 'node:fs';
import { type LatLng, pointInPolygon, shorelineMeters } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  CONVEX_ARRAY_LIMIT,
  depthFromOsmTags,
  externalIdFromProperties,
  featureToCanonicalBody,
  largestRingSize,
  MAX_RING_VERTICES,
  maxArrayLength,
  parseOsmDepthMeters,
  SIMPLIFY_TOLERANCE_DEG,
  transformFeatures,
} from './transform';
import type { OsmWaterFeature } from './types';

/** The committed real Vermont fixture (osmium `geojsonseq`, one Feature per line). */
function loadFixture(): OsmWaterFeature[] {
  const raw = readFileSync(
    new URL('../fixtures/vermont-sample.geojsonseq', import.meta.url),
    'utf8',
  );
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OsmWaterFeature);
}

/** Count [lng, lat] positions in a (multi)polygon geometry — vertex-reduction assertions. */
function vertexCount(geom: Polygon | MultiPolygon): number {
  const flatten = (value: unknown): number =>
    Array.isArray(value)
      ? typeof value[0] === 'number'
        ? 1
        : value.reduce<number>((sum, inner) => sum + flatten(inner), 0)
      : 0;
  return flatten(geom.coordinates);
}

/** A minimal valid OSM water feature (a 3-point-plus-close triangle), tags overridable. */
function waterFeature(
  props: Record<string, unknown>,
  coordinates: number[][][] = [
    [
      [-72.1, 43.9],
      [-72.0, 43.9],
      [-72.05, 44.0],
      [-72.1, 43.9],
    ],
  ],
): OsmWaterFeature {
  return {
    type: 'Feature',
    properties: { '@type': 'way', '@id': 1, natural: 'water', water: 'pond', ...props },
    geometry: { type: 'Polygon', coordinates },
  } as OsmWaterFeature;
}

describe('externalIdFromProperties', () => {
  it('builds `way/<id>` and `relation/<id>` from osmium @type/@id', () => {
    expect(externalIdFromProperties({ '@type': 'way', '@id': 47338349 })).toBe('way/47338349');
    expect(externalIdFromProperties({ '@type': 'relation', '@id': 6265947 })).toBe(
      'relation/6265947',
    );
  });

  it('accepts a string id (defensive) as well as a number', () => {
    expect(externalIdFromProperties({ '@type': 'way', '@id': '12' })).toBe('way/12');
  });

  it('returns null when @type or @id is missing or the wrong type', () => {
    expect(externalIdFromProperties({ '@id': 5 })).toBeNull();
    expect(externalIdFromProperties({ '@type': '', '@id': 5 })).toBeNull();
    expect(externalIdFromProperties({ '@type': 'way' })).toBeNull();
    expect(
      externalIdFromProperties({ '@type': 'way', '@id': true as unknown as number }),
    ).toBeNull();
  });

  it('returns null for absent properties (null / undefined)', () => {
    expect(externalIdFromProperties(null)).toBeNull();
    expect(externalIdFromProperties(undefined)).toBeNull();
  });
});

describe('featureToCanonicalBody', () => {
  it('classifies, simplifies, and derives bbox/centroid/area from the stored geometry', () => {
    const body = featureToCanonicalBody(waterFeature({ '@id': 42, name: 'Test Pond' }));
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body).toMatchObject({
      source: 'osm',
      externalId: 'way/42',
      name: 'Test Pond',
      type: 'pond',
    });
    expect(body.surfaceAreaSqM).toBeGreaterThan(0);
    // The on-water centroid lies inside the polygon actually stored.
    expect(pointInPolygon(body.centroid, body.polygon)).toBe(true);
    // bbox spans the geometry.
    expect(body.bbox.minLng).toBeLessThanOrEqual(body.centroid.lng);
    expect(body.bbox.maxLng).toBeGreaterThanOrEqual(body.centroid.lng);
  });

  it('returns null for a feature the classifier defers (a river)', () => {
    expect(featureToCanonicalBody(waterFeature({ water: 'river' }))).toBeNull();
  });

  it('returns null (does not throw) when a feature has no properties', () => {
    const feature = { type: 'Feature', geometry: waterFeature({}).geometry } as OsmWaterFeature;
    feature.properties = null as unknown as OsmWaterFeature['properties'];
    expect(featureToCanonicalBody(feature)).toBeNull();
  });

  it('falls back to an empty name when the feature is unnamed', () => {
    const body = featureToCanonicalBody(waterFeature({}));
    expect(body?.name).toBe('');
  });

  it('throws when @type/@id is missing (feature not exported with -a type,id)', () => {
    const feature = waterFeature({});
    feature.properties = { natural: 'water', water: 'pond' };
    expect(() => featureToCanonicalBody(feature)).toThrow(/@type\/@id/);
  });

  it('throws on a non-area geometry', () => {
    const feature = {
      type: 'Feature',
      properties: { '@type': 'node', '@id': 1, natural: 'water', water: 'pond' },
      geometry: { type: 'Point', coordinates: [-72, 44] },
    } as unknown as OsmWaterFeature;
    expect(() => featureToCanonicalBody(feature)).toThrow(/geometry type/);
  });

  it('throws on a degenerate polygon (empty ring) representativePoint cannot place', () => {
    const feature = waterFeature({}, [[]]);
    expect(() => featureToCanonicalBody(feature)).toThrow();
  });

  it('simplifies a dense ring to fewer vertices at the ~5 m tolerance', () => {
    // A many-vertex ring whose points are far below the tolerance apart collapses toward its
    // corners. (Sanity check that the simplify pass is actually wired and reducing.)
    const dense: number[][] = [];
    for (let i = 0; i <= 200; i++) dense.push([-72 + i * 0.000001, 44]);
    dense.push([-72, 44.01], [-72, 44]);
    const feature = waterFeature({}, [dense]);
    const body = featureToCanonicalBody(feature);
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(vertexCount(body.polygon)).toBeLessThan(vertexCount(feature.geometry as Polygon));
  });

  it('exposes a sane simplify tolerance (~5 m ≈ 0.00005°)', () => {
    expect(SIMPLIFY_TOLERANCE_DEG).toBeGreaterThan(0);
    expect(SIMPLIFY_TOLERANCE_DEG).toBeLessThan(0.001);
  });

  it('coarsens a body whose ring would exceed the Convex 8192-element array limit', () => {
    // A dense spiky "star" ring (~9,000 vertices with 0.0003° spikes) survives the 5 m pass
    // above the cap — the Lake Champlain case — so adaptive coarsening must kick in.
    const n = 9000;
    const ring: number[][] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      const r = 0.5 + (i % 2 === 0 ? 0 : 0.0003);
      ring.push([-72 + r * Math.cos(t), 44 + r * Math.sin(t)]);
    }
    ring.push(ring[0] as number[]); // close the ring
    expect(ring.length).toBeGreaterThan(MAX_RING_VERTICES);

    const body = featureToCanonicalBody(waterFeature({}, [ring]));
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(largestRingSize(body.polygon)).toBeLessThanOrEqual(MAX_RING_VERTICES);
    expect(body.surfaceAreaSqM).toBeGreaterThan(0);
    // Adaptive coarsening of a ~9k-vertex ring is genuinely CPU-heavy; CI runs ~8× slower than
    // local, so give this a longer-than-default (5s) timeout to avoid flaky timeouts.
  }, 30_000);

  it('largestRingSize reports the biggest ring across polygons and holes', () => {
    expect(
      largestRingSize({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    ).toBe(4);
    const mp: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 2],
            [0, 0],
          ],
        ],
      ],
    };
    expect(largestRingSize(mp)).toBe(5);
  });

  it('maxArrayLength accounts for component and ring counts, not just positions', () => {
    // 3 tiny components (each a 4-point triangle): positions=4, rings=1, components=3 → 4.
    const fewComponents: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: Array.from({ length: 3 }, () => [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ]),
    };
    expect(maxArrayLength(fewComponents)).toBe(4);
    // Many components dominates over the (small) ring size.
    const manyComponents: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: Array.from({ length: 20 }, () => [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ]),
    };
    expect(maxArrayLength(manyComponents)).toBe(20);
  });

  it('skips (throws) a body still over the array cap after coarsening — too many components', () => {
    // >8192 tiny components: coarsening thins positions, not component count, so this can't be
    // made to fit and must be skipped per-feature rather than poisoning a whole loader batch.
    const coordinates = Array.from({ length: CONVEX_ARRAY_LIMIT + 1 }, (_, i) => [
      [
        [-72 + i * 1e-6, 44],
        [-72 + i * 1e-6 + 5e-4, 44],
        [-72 + i * 1e-6, 44.0005],
        [-72 + i * 1e-6, 44],
      ],
    ]);
    const feature = {
      type: 'Feature',
      properties: { '@type': 'relation', '@id': 7, natural: 'water', water: 'lake' },
      geometry: { type: 'MultiPolygon', coordinates },
    } as unknown as OsmWaterFeature;
    expect(() => featureToCanonicalBody(feature)).toThrow(/array too large/);
  });
});

describe('transformFeatures (batch resilience)', () => {
  it('transforms the real Vermont fixture: classifies, drops rivers/subtag-less wetland', () => {
    const { bodies, summary, errors } = transformFeatures(loadFixture());
    expect(summary).toEqual({
      total: 10,
      imported: 8,
      droppedByType: 2,
      skipped: 0,
      depthsTagged: 0,
    });
    expect(errors).toEqual([]);

    const byId = new Map(bodies.map((body) => [body.externalId, body]));
    // Lake Morey — the iconic Nordic lake — classifies as a lake with its real ~2.2 km² area.
    const morey = byId.get('way/47338349');
    expect(morey).toMatchObject({ type: 'lake', name: 'Lake Morey' });
    expect(morey?.surfaceAreaSqM).toBeGreaterThan(2_000_000);
    expect(morey?.surfaceAreaSqM).toBeLessThan(2_500_000);
    // A relation keeps its `relation/<id>` externalId.
    expect(byId.get('relation/6265947')).toMatchObject({
      type: 'reservoir',
      name: 'Sugar Hill Reservoir',
    });
    // wetland=marsh → marsh; bare natural=water → other; unnamed → empty name.
    expect(byId.get('way/40089880')?.type).toBe('marsh');
    expect(byId.get('way/34856116')).toMatchObject({ type: 'other', name: '' });
    // The two deferred features are absent from the output.
    expect(byId.has('way/143518175')).toBe(false); // water=river
    expect(byId.has('way/43152092')).toBe(false); // natural=wetland, no subtag

    // Every stored centroid lies on its stored (simplified) polygon (D48 on-water invariant).
    for (const body of bodies) {
      expect(pointInPolygon(body.centroid, body.polygon)).toBe(true);
    }
  });

  it('skips a throwing feature (logged + tallied) without aborting the batch', () => {
    const good = waterFeature({ '@id': 100, name: 'Good Pond' });
    const degenerate = waterFeature({ '@id': 101 }, [[]]); // empty ring → throws
    const { bodies, summary, errors } = transformFeatures([good, degenerate]);
    expect(summary).toEqual({
      total: 2,
      imported: 1,
      droppedByType: 0,
      skipped: 1,
      depthsTagged: 0,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.externalId).toBe('way/100');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.externalId).toBe('way/101');
  });

  it('labels an error by feature.id when @type/@id are absent', () => {
    const feature = {
      type: 'Feature',
      id: 'a12345',
      properties: { natural: 'water', water: 'pond' }, // no @type/@id → throws
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-72, 44],
            [-72, 44.01],
            [-72.01, 44],
            [-72, 44],
          ],
        ],
      },
    } as unknown as OsmWaterFeature;
    const { summary, errors } = transformFeatures([feature]);
    expect(summary.skipped).toBe(1);
    expect(errors[0]?.externalId).toBe('a12345');
  });

  it('labels an error "(unknown)" when it has neither @type/@id nor a feature id', () => {
    const feature = {
      type: 'Feature',
      properties: { natural: 'water', water: 'pond' }, // classifies, then throws on missing id
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-72, 44],
            [-72, 44.01],
            [-72.01, 44],
            [-72, 44],
          ],
        ],
      },
    } as unknown as OsmWaterFeature;
    const { errors } = transformFeatures([feature]);
    expect(errors[0]?.externalId).toBe('(unknown)');
  });

  it('returns an empty result for no features', () => {
    expect(transformFeatures([])).toEqual({
      bodies: [],
      depths: [],
      summary: { total: 0, imported: 0, droppedByType: 0, skipped: 0, depthsTagged: 0 },
      errors: [],
    });
  });
});

/**
 * OSM depth tags (N6a rung 7). The roadmap said this rode the water ETL and it never did — `osm_tag`
 * was an enum value with no producer until the N6a review, so these tests pin the parse rules that
 * make the bottom rung safe to trust at all.
 */
describe('parseOsmDepthMeters', () => {
  it('reads a bare number as metres (the OSM default unit)', () => {
    expect(parseOsmDepthMeters('4')).toBe(4);
    expect(parseOsmDepthMeters('3.5')).toBe(3.5);
    expect(parseOsmDepthMeters(6)).toBe(6);
  });

  it('converts an explicit unit', () => {
    expect(parseOsmDepthMeters('3 m')).toBe(3);
    expect(parseOsmDepthMeters('10 ft')).toBeCloseTo(3.048, 6);
    expect(parseOsmDepthMeters("12'")).toBeCloseTo(3.6576, 6);
    expect(parseOsmDepthMeters('2 metres')).toBe(2);
  });

  it('refuses anything that is not one unambiguous depth', () => {
    // Guessing here is the failure: a range or an approximation is a mapper telling us they don't
    // know, and the bottom rung of a safety input is the wrong place to fill that in.
    for (const value of ['2-3', '~5', '>10', 'deep', '', 'NaN', '3 fathoms', '-4', '0']) {
      expect(parseOsmDepthMeters(value)).toBeUndefined();
    }
    expect(parseOsmDepthMeters(undefined)).toBeUndefined();
    expect(parseOsmDepthMeters({ depth: 4 })).toBeUndefined();
  });

  it('refuses a depth deeper than any lake in the region', () => {
    expect(parseOsmDepthMeters('500')).toBeUndefined();
  });
});

describe('depthFromOsmTags', () => {
  it('maps `maxdepth` to the max', () => {
    expect(depthFromOsmTags({ maxdepth: '9' }, 'way/1')).toEqual({
      source: 'osm',
      externalId: 'way/1',
      maxDepthM: 9,
      maxDepthSource: 'osm_tag',
    });
  });

  it('maps a bare `depth` to the MAX, never the mean', () => {
    // The safety-relevant call: `isShallowDepth` prefers a mean whenever one exists, so putting an
    // ambiguous tag there would let one loose value overrule the generous max fallback and lose the
    // shallow signal on a lake that deserved it.
    expect(depthFromOsmTags({ depth: '5' }, 'way/1')).toEqual({
      source: 'osm',
      externalId: 'way/1',
      maxDepthM: 5,
      maxDepthSource: 'osm_tag',
    });
  });

  it('prefers `maxdepth` over `depth` when a feature carries both', () => {
    expect(depthFromOsmTags({ depth: '5', maxdepth: '11' }, 'way/1')?.maxDepthM).toBe(11);
  });

  it('trusts only the explicit `depth:mean` as a mean', () => {
    const record = depthFromOsmTags({ 'depth:mean': '2', maxdepth: '9' }, 'way/1');
    expect(record).toMatchObject({ meanDepthM: 2, meanDepthSource: 'osm_tag', maxDepthM: 9 });
  });

  it('refuses a transposed pair, like the operator field does', () => {
    expect(depthFromOsmTags({ 'depth:mean': '30', maxdepth: '6' }, 'way/1')).toBeNull();
  });

  it('is null for a feature with no usable depth tag', () => {
    expect(depthFromOsmTags({}, 'way/1')).toBeNull();
    expect(depthFromOsmTags({ depth: 'about 4' }, 'way/1')).toBeNull();
  });

  it('rides transformFeatures, keyed to the body it came from', () => {
    const { bodies, depths, summary } = transformFeatures([
      waterFeature({ '@id': 7, name: 'Tagged Pond', maxdepth: '4' }),
      waterFeature({ '@id': 8, name: 'Untagged Pond' }),
    ]);
    expect(bodies).toHaveLength(2);
    expect(summary.depthsTagged).toBe(1);
    expect(depths).toEqual([
      { source: 'osm', externalId: 'way/7', maxDepthM: 4, maxDepthSource: 'osm_tag' },
    ]);
  });
});

describe('derived shape stats (N6c / D85)', () => {
  /**
   * A crenellated shoreline whose detail is finer than `SIMPLIFY_TOLERANCE_DEG` (~5 m), so
   * simplification demonstrably eats it. This is the fixture the D85 ordering test needs: on a
   * smooth polygon, measuring before and after simplification gives the same answer and the test
   * would pass no matter which side of `simplify()` the measurement sat on.
   */
  function crenellatedFeature(): OsmWaterFeature {
    const ring: number[][] = [];
    // Teeth sized so simplification demonstrably eats them: ~4.4 m of amplitude (just inside the
    // ~5 m `SIMPLIFY_TOLERANCE_DEG`, so Douglas–Peucker collapses the whole run) over a ~4.0 m
    // step (so each segment is ~1.5× the flat distance it replaces). Shallower teeth also get
    // removed but change the perimeter by a fraction of a percent, which would make this test pass
    // on either side of `simplify()` and guard nothing.
    const teeth = 1000;
    for (let i = 0; i <= teeth; i++) {
      ring.push([-72.1 + i * 0.00005, 43.9 + (i % 2) * 0.00004]);
    }
    ring.push([-72.05, 43.95], [-72.1, 43.95], [-72.1, 43.9]);
    return waterFeature({}, [ring]);
  }

  it('measures the SOURCE geometry, not the simplified copy', () => {
    // The whole of D85 in one assertion. If `lakeGeometryStats` is ever moved below
    // `simplifyForStorage`, the stored shoreline collapses toward the smoothed outline and this
    // fails — which is the only mechanical guard on a one-line ordering constraint.
    const body = featureToCanonicalBody(crenellatedFeature());
    expect(body).not.toBeNull();
    const measuredOnStoredCopy = shorelineMeters(body?.polygon as Polygon);
    expect(body?.shorelineM).toBeGreaterThan(measuredOnStoredCopy * 1.05);
  });

  it('carries the full stat block onto the canonical body', () => {
    const body = featureToCanonicalBody(waterFeature({}));
    expect(body?.shorelineM).toBeGreaterThan(0);
    expect(body?.longAxisM).toBeGreaterThan(0);
    expect(body?.shortAxisM).toBeGreaterThan(0);
    expect(body?.longAxisBearingDeg).toBeGreaterThanOrEqual(0);
    expect(body?.longAxisBearingDeg).toBeLessThan(180);
    expect(body?.fetchProfileM).toHaveLength(16);
    expect(body?.fetchProfileM?.every((d) => d > 0)).toBe(true);
  });

  it('puts interiorPoint inside the water, where centroid may not be', () => {
    const body = featureToCanonicalBody(waterFeature({}));
    expect(body?.interiorPoint).toBeDefined();
    expect(pointInPolygon(body?.interiorPoint as LatLng, body?.polygon as Polygon)).toBe(true);
  });

  it('still produces a body when the stats cannot all be measured', () => {
    // Resilience over completeness: a stat is omitted, never zeroed, and never fails the feature.
    const body = featureToCanonicalBody(waterFeature({}));
    expect(body).not.toBeNull();
    expect(body?.externalId).toBe('way/1');
  });
});
