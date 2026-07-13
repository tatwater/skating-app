import { readFileSync } from 'node:fs'
import { pointInPolygon } from '@skating/core'
import type { MultiPolygon, Polygon } from 'geojson'
import { describe, expect, it } from 'vitest'
import {
  CONVEX_ARRAY_LIMIT,
  externalIdFromProperties,
  featureToCanonicalBody,
  largestRingSize,
  MAX_RING_VERTICES,
  maxArrayLength,
  SIMPLIFY_TOLERANCE_DEG,
  transformFeatures,
} from './transform'
import type { OsmWaterFeature } from './types'

/** The committed real Vermont fixture (osmium `geojsonseq`, one Feature per line). */
function loadFixture(): OsmWaterFeature[] {
  const raw = readFileSync(
    new URL('../fixtures/vermont-sample.geojsonseq', import.meta.url),
    'utf8',
  )
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OsmWaterFeature)
}

/** Count [lng, lat] positions in a (multi)polygon geometry — vertex-reduction assertions. */
function vertexCount(geom: Polygon | MultiPolygon): number {
  const flatten = (value: unknown): number =>
    Array.isArray(value)
      ? typeof value[0] === 'number'
        ? 1
        : value.reduce<number>((sum, inner) => sum + flatten(inner), 0)
      : 0
  return flatten(geom.coordinates)
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
  } as OsmWaterFeature
}

describe('externalIdFromProperties', () => {
  it('builds `way/<id>` and `relation/<id>` from osmium @type/@id', () => {
    expect(externalIdFromProperties({ '@type': 'way', '@id': 47338349 })).toBe('way/47338349')
    expect(externalIdFromProperties({ '@type': 'relation', '@id': 6265947 })).toBe(
      'relation/6265947',
    )
  })

  it('accepts a string id (defensive) as well as a number', () => {
    expect(externalIdFromProperties({ '@type': 'way', '@id': '12' })).toBe('way/12')
  })

  it('returns null when @type or @id is missing or the wrong type', () => {
    expect(externalIdFromProperties({ '@id': 5 })).toBeNull()
    expect(externalIdFromProperties({ '@type': '', '@id': 5 })).toBeNull()
    expect(externalIdFromProperties({ '@type': 'way' })).toBeNull()
    expect(
      externalIdFromProperties({ '@type': 'way', '@id': true as unknown as number }),
    ).toBeNull()
  })

  it('returns null for absent properties (null / undefined)', () => {
    expect(externalIdFromProperties(null)).toBeNull()
    expect(externalIdFromProperties(undefined)).toBeNull()
  })
})

describe('featureToCanonicalBody', () => {
  it('classifies, simplifies, and derives bbox/centroid/area from the stored geometry', () => {
    const body = featureToCanonicalBody(waterFeature({ '@id': 42, name: 'Test Pond' }))
    expect(body).not.toBeNull()
    if (body === null) return
    expect(body).toMatchObject({
      source: 'osm',
      externalId: 'way/42',
      name: 'Test Pond',
      type: 'pond',
    })
    expect(body.surfaceAreaSqM).toBeGreaterThan(0)
    // The on-water centroid lies inside the polygon actually stored.
    expect(pointInPolygon(body.centroid, body.polygon)).toBe(true)
    // bbox spans the geometry.
    expect(body.bbox.minLng).toBeLessThanOrEqual(body.centroid.lng)
    expect(body.bbox.maxLng).toBeGreaterThanOrEqual(body.centroid.lng)
  })

  it('returns null for a feature the classifier defers (a river)', () => {
    expect(featureToCanonicalBody(waterFeature({ water: 'river' }))).toBeNull()
  })

  it('returns null (does not throw) when a feature has no properties', () => {
    const feature = { type: 'Feature', geometry: waterFeature({}).geometry } as OsmWaterFeature
    feature.properties = null as unknown as OsmWaterFeature['properties']
    expect(featureToCanonicalBody(feature)).toBeNull()
  })

  it('falls back to an empty name when the feature is unnamed', () => {
    const body = featureToCanonicalBody(waterFeature({}))
    expect(body?.name).toBe('')
  })

  it('throws when @type/@id is missing (feature not exported with -a type,id)', () => {
    const feature = waterFeature({})
    feature.properties = { natural: 'water', water: 'pond' }
    expect(() => featureToCanonicalBody(feature)).toThrow(/@type\/@id/)
  })

  it('throws on a non-area geometry', () => {
    const feature = {
      type: 'Feature',
      properties: { '@type': 'node', '@id': 1, natural: 'water', water: 'pond' },
      geometry: { type: 'Point', coordinates: [-72, 44] },
    } as unknown as OsmWaterFeature
    expect(() => featureToCanonicalBody(feature)).toThrow(/geometry type/)
  })

  it('throws on a degenerate polygon (empty ring) representativePoint cannot place', () => {
    const feature = waterFeature({}, [[]])
    expect(() => featureToCanonicalBody(feature)).toThrow()
  })

  it('simplifies a dense ring to fewer vertices at the ~5 m tolerance', () => {
    // A many-vertex ring whose points are far below the tolerance apart collapses toward its
    // corners. (Sanity check that the simplify pass is actually wired and reducing.)
    const dense: number[][] = []
    for (let i = 0; i <= 200; i++) dense.push([-72 + i * 0.000001, 44])
    dense.push([-72, 44.01], [-72, 44])
    const feature = waterFeature({}, [dense])
    const body = featureToCanonicalBody(feature)
    expect(body).not.toBeNull()
    if (body === null) return
    expect(vertexCount(body.polygon)).toBeLessThan(vertexCount(feature.geometry as Polygon))
  })

  it('exposes a sane simplify tolerance (~5 m ≈ 0.00005°)', () => {
    expect(SIMPLIFY_TOLERANCE_DEG).toBeGreaterThan(0)
    expect(SIMPLIFY_TOLERANCE_DEG).toBeLessThan(0.001)
  })

  it('coarsens a body whose ring would exceed the Convex 8192-element array limit', () => {
    // A dense spiky "star" ring (~9,000 vertices with 0.0003° spikes) survives the 5 m pass
    // above the cap — the Lake Champlain case — so adaptive coarsening must kick in.
    const n = 9000
    const ring: number[][] = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI
      const r = 0.5 + (i % 2 === 0 ? 0 : 0.0003)
      ring.push([-72 + r * Math.cos(t), 44 + r * Math.sin(t)])
    }
    ring.push(ring[0] as number[]) // close the ring
    expect(ring.length).toBeGreaterThan(MAX_RING_VERTICES)

    const body = featureToCanonicalBody(waterFeature({}, [ring]))
    expect(body).not.toBeNull()
    if (body === null) return
    expect(largestRingSize(body.polygon)).toBeLessThanOrEqual(MAX_RING_VERTICES)
    expect(body.surfaceAreaSqM).toBeGreaterThan(0)
  })

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
    ).toBe(4)
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
    }
    expect(largestRingSize(mp)).toBe(5)
  })

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
    }
    expect(maxArrayLength(fewComponents)).toBe(4)
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
    }
    expect(maxArrayLength(manyComponents)).toBe(20)
  })

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
    ])
    const feature = {
      type: 'Feature',
      properties: { '@type': 'relation', '@id': 7, natural: 'water', water: 'lake' },
      geometry: { type: 'MultiPolygon', coordinates },
    } as unknown as OsmWaterFeature
    expect(() => featureToCanonicalBody(feature)).toThrow(/array too large/)
  })
})

describe('transformFeatures (batch resilience)', () => {
  it('transforms the real Vermont fixture: classifies, drops rivers/subtag-less wetland', () => {
    const { bodies, summary, errors } = transformFeatures(loadFixture())
    expect(summary).toEqual({ total: 10, imported: 8, droppedByType: 2, skipped: 0 })
    expect(errors).toEqual([])

    const byId = new Map(bodies.map((body) => [body.externalId, body]))
    // Lake Morey — the iconic Nordic lake — classifies as a lake with its real ~2.2 km² area.
    const morey = byId.get('way/47338349')
    expect(morey).toMatchObject({ type: 'lake', name: 'Lake Morey' })
    expect(morey?.surfaceAreaSqM).toBeGreaterThan(2_000_000)
    expect(morey?.surfaceAreaSqM).toBeLessThan(2_500_000)
    // A relation keeps its `relation/<id>` externalId.
    expect(byId.get('relation/6265947')).toMatchObject({
      type: 'reservoir',
      name: 'Sugar Hill Reservoir',
    })
    // wetland=marsh → marsh; bare natural=water → other; unnamed → empty name.
    expect(byId.get('way/40089880')?.type).toBe('marsh')
    expect(byId.get('way/34856116')).toMatchObject({ type: 'other', name: '' })
    // The two deferred features are absent from the output.
    expect(byId.has('way/143518175')).toBe(false) // water=river
    expect(byId.has('way/43152092')).toBe(false) // natural=wetland, no subtag

    // Every stored centroid lies on its stored (simplified) polygon (D48 on-water invariant).
    for (const body of bodies) {
      expect(pointInPolygon(body.centroid, body.polygon)).toBe(true)
    }
  })

  it('skips a throwing feature (logged + tallied) without aborting the batch', () => {
    const good = waterFeature({ '@id': 100, name: 'Good Pond' })
    const degenerate = waterFeature({ '@id': 101 }, [[]]) // empty ring → throws
    const { bodies, summary, errors } = transformFeatures([good, degenerate])
    expect(summary).toEqual({ total: 2, imported: 1, droppedByType: 0, skipped: 1 })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.externalId).toBe('way/100')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.externalId).toBe('way/101')
  })

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
    } as unknown as OsmWaterFeature
    const { summary, errors } = transformFeatures([feature])
    expect(summary.skipped).toBe(1)
    expect(errors[0]?.externalId).toBe('a12345')
  })

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
    } as unknown as OsmWaterFeature
    const { errors } = transformFeatures([feature])
    expect(errors[0]?.externalId).toBe('(unknown)')
  })

  it('returns an empty result for no features', () => {
    expect(transformFeatures([])).toEqual({
      bodies: [],
      summary: { total: 0, imported: 0, droppedByType: 0, skipped: 0 },
      errors: [],
    })
  })
})
