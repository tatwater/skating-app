import { describe, expect, it } from 'vitest'
import {
  CONVEX_ARRAY_LIMIT,
  externalIdFromProperties,
  featureToAdminArea,
  largestRingSize,
  levelFromAdminLevel,
  MAX_RING_VERTICES,
  maxArrayLength,
  transformFeatures,
} from './transform'
import type { OsmBoundaryFeature, OsmBoundaryProperties } from './types'

/** A square-ring admin boundary feature over [w,e]×[s,n] with the given properties. */
function boundary(
  props: Partial<OsmBoundaryProperties>,
  [w, s, e, n]: [number, number, number, number] = [0, 0, 1, 1],
): OsmBoundaryFeature {
  return {
    type: 'Feature',
    properties: {
      '@type': 'relation',
      '@id': 100,
      boundary: 'administrative',
      ...props,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  }
}

describe('levelFromAdminLevel', () => {
  it('maps the US admin tiers we resolve', () => {
    expect(levelFromAdminLevel('4')).toBe('state')
    expect(levelFromAdminLevel('6')).toBe('county')
    expect(levelFromAdminLevel('7')).toBe('town')
    expect(levelFromAdminLevel('8')).toBe('town')
    expect(levelFromAdminLevel(8)).toBe('town') // numeric form too
  })

  it('returns null for tiers we do not resolve (nation, neighborhood, missing)', () => {
    expect(levelFromAdminLevel('2')).toBeNull()
    expect(levelFromAdminLevel('9')).toBeNull()
    expect(levelFromAdminLevel(undefined)).toBeNull()
  })
})

describe('externalIdFromProperties', () => {
  it('builds a `type/id` key, accepting a numeric or string id', () => {
    expect(externalIdFromProperties({ '@type': 'relation', '@id': 456 })).toBe('relation/456')
    expect(externalIdFromProperties({ '@type': 'way', '@id': '9' })).toBe('way/9')
  })

  it('returns null when the attributes are missing', () => {
    expect(externalIdFromProperties(undefined)).toBeNull()
    expect(externalIdFromProperties({ '@type': 'relation' })).toBeNull()
    expect(externalIdFromProperties({ '@id': 1 })).toBeNull()
  })
})

describe('featureToAdminArea', () => {
  it('transforms a named town boundary into a record (bbox + centroid derived)', () => {
    const area = featureToAdminArea(
      boundary({ '@id': 1, admin_level: '8', name: 'Burlington' }, [0, 0, 2, 2]),
    )
    expect(area).not.toBeNull()
    if (!area) return
    expect(area).toMatchObject({ externalId: 'relation/1', name: 'Burlington', level: 'town' })
    expect(area.bbox).toEqual({ minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 })
    // representativePoint lands inside the square.
    expect(area.centroid.lat).toBeGreaterThan(0)
    expect(area.centroid.lat).toBeLessThan(2)
  })

  it('skips a non-administrative boundary (returns null)', () => {
    expect(
      featureToAdminArea(boundary({ boundary: 'postal_code', admin_level: '8', name: 'X' })),
    ).toBeNull()
  })

  it('skips an admin_level we do not resolve (returns null)', () => {
    expect(featureToAdminArea(boundary({ admin_level: '9', name: 'Ward 3' }))).toBeNull()
  })

  it('throws on a missing @type/@id', () => {
    const f = boundary({ admin_level: '6', name: 'Somewhere' })
    f.properties = { boundary: 'administrative', admin_level: '6', name: 'Somewhere' }
    expect(() => featureToAdminArea(f)).toThrow(/@type\/@id/)
  })

  it('throws on a boundary with no name', () => {
    expect(() => featureToAdminArea(boundary({ admin_level: '6', name: '  ' }))).toThrow(/no name/)
  })

  it('throws on a non-area geometry', () => {
    const f = boundary({ admin_level: '4', name: 'Line' })
    f.geometry = {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    }
    expect(() => featureToAdminArea(f)).toThrow(/unsupported geometry/)
  })
})

describe('transformFeatures', () => {
  it('imports valid boundaries, classifies drops, and isolates per-feature errors', () => {
    const nameless = boundary({ '@id': 3, admin_level: '6', name: '' })
    const { areas, summary, errors } = transformFeatures([
      boundary({ '@id': 1, admin_level: '4', name: 'Vermont' }),
      boundary({ '@id': 2, admin_level: '9', name: 'Ward' }), // dropped by type
      nameless, // throws → skipped
    ])
    expect(areas.map((a) => a.level)).toEqual(['state'])
    expect(summary).toEqual({ total: 3, imported: 1, droppedByType: 1, skipped: 1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.externalId).toBe('relation/3')
  })
})

describe('array-limit escape hatch (mirrors the water ETL)', () => {
  it(
    'coarsens a boundary whose ring would exceed the Convex 8192-element array limit',
    () => {
      // A dense spiky ring (~9,000 vertices) survives the 5 m pass above the cap — a state outline's
      // case — so adaptive coarsening must kick in.
      const n = 9000
      const ring: number[][] = []
      for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI
        const r = 0.5 + (i % 2 === 0 ? 0 : 0.0003)
        ring.push([-72 + r * Math.cos(t), 44 + r * Math.sin(t)])
      }
      ring.push(ring[0] as number[]) // close the ring
      expect(ring.length).toBeGreaterThan(MAX_RING_VERTICES)

      const f: OsmBoundaryFeature = {
        type: 'Feature',
        properties: {
          '@type': 'relation',
          '@id': 4,
          boundary: 'administrative',
          admin_level: '4',
          name: 'Vermont',
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      }
      const area = featureToAdminArea(f)
      expect(area).not.toBeNull()
      if (!area) return
      expect(largestRingSize(area.polygon)).toBeLessThanOrEqual(MAX_RING_VERTICES)
    },
    // Adaptive coarsening of a ~9k-vertex ring is CPU-heavy; CI runs ~8× slower, so widen the timeout.
    { timeout: 30_000 },
  )

  it('skips (throws) a boundary still over the array cap after coarsening — too many components', () => {
    // >8192 tiny components: coarsening thins positions, not component count, so this can't fit.
    const coordinates = Array.from({ length: CONVEX_ARRAY_LIMIT + 1 }, (_, i) => [
      [
        [-72 + i * 1e-6, 44],
        [-72 + i * 1e-6 + 5e-4, 44],
        [-72 + i * 1e-6, 44.0005],
        [-72 + i * 1e-6, 44],
      ],
    ])
    const f = {
      type: 'Feature',
      properties: {
        '@type': 'relation',
        '@id': 5,
        boundary: 'administrative',
        admin_level: '6',
        name: 'Big County',
      },
      geometry: { type: 'MultiPolygon', coordinates },
    } as unknown as OsmBoundaryFeature
    expect(() => featureToAdminArea(f)).toThrow(/array too large/)
  })
})

describe('geometry array helpers', () => {
  const poly = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  }
  it('largestRingSize / maxArrayLength read the densest dimension', () => {
    expect(largestRingSize(poly)).toBe(4)
    expect(maxArrayLength(poly)).toBe(4)
  })
})
