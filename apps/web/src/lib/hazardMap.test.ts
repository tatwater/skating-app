import { describe, expect, it } from 'vitest'
import {
  bodyFeaturesToFeatureCollection,
  FRESHNESS_FILL_OPACITY,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
  type MappableHazard,
} from './hazardMap'

function hazard(overrides: Partial<MappableHazard> = {}): MappableHazard {
  return {
    _id: 'h1',
    type: 'open_water',
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [-73.21, 44.47] },
    radiusMeters: 50,
    freshness: 'fresh',
    provisional: false,
    ...overrides,
  }
}

describe('hazardsToFeatureCollection', () => {
  it('buffers a point+radius hazard into a polygon footprint', () => {
    const fc = hazardsToFeatureCollection([hazard()])
    expect(fc.features).toHaveLength(1)
    const geometry = fc.features[0]?.geometry
    expect(geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon').toBe(true)
  })

  it('carries the styling properties the layer keys off', () => {
    const fc = hazardsToFeatureCollection([
      hazard({ freshness: 'aging', provisional: true, healingState: 'healing_unsafe' }),
    ])
    expect(fc.features[0]?.properties).toMatchObject({
      hazardId: 'h1',
      hazardType: 'open_water',
      freshness: 'aging',
      provisional: true,
      healing: true,
      passage: false,
    })
  })

  it('marks a ridge crossing as a passage rather than a danger', () => {
    const fc = hazardsToFeatureCollection([hazard({ type: 'ridge_crossing' })])
    expect(fc.features[0]?.properties?.passage).toBe(true)
  })

  it('buffers a line hazard by its uncertainty half-width', () => {
    const fc = hazardsToFeatureCollection([
      hazard({
        geometryKind: 'line',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-73.22, 44.47],
            [-73.2, 44.48],
          ],
        },
        radiusMeters: undefined,
        bufferMeters: 20,
      }),
    ])
    expect(fc.features).toHaveLength(1)
  })

  // Losing one pin is bad; losing every pin on the lake because one row is malformed is a safety
  // failure — so a bad geometry is skipped and its neighbours still render.
  it('drops an unusable geometry without taking the rest of the layer down', () => {
    const fc = hazardsToFeatureCollection([
      hazard({
        _id: 'bad',
        geometryKind: 'line',
        geometry: { type: 'LineString', coordinates: [] },
        radiusMeters: undefined,
        bufferMeters: 10,
      }),
      hazard({ _id: 'good' }),
    ])
    expect(fc.features.map((f) => f.properties?.hazardId)).toEqual(['good'])
  })

  it('drops a geometry type the footprint math cannot buffer', () => {
    const fc = hazardsToFeatureCollection([
      hazard({
        geometry: { type: 'MultiPoint', coordinates: [[-73.2, 44.4]] } as GeoJSON.Geometry,
      }),
    ])
    expect(fc.features).toHaveLength(0)
  })

  it('returns an empty collection for no hazards', () => {
    expect(hazardsToFeatureCollection([]).features).toEqual([])
  })
})

describe('bodyFeaturesToFeatureCollection', () => {
  it('buffers a point feature by its radius', () => {
    const fc = bodyFeaturesToFeatureCollection([
      {
        _id: 'bf1',
        type: 'spring_current',
        geometry: { type: 'Point', coordinates: [-73.21, 44.47] },
        radiusMeters: 30,
      },
    ])
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0]?.properties).toMatchObject({
      bodyFeatureId: 'bf1',
      featureType: 'spring_current',
    })
  })
})

describe('freshness styling', () => {
  // The visual half of "decay is confidence, not safety": a stale hazard fades, but never to
  // invisible — the fade means "unverified", not "probably gone" (D3).
  it('never fades a stale hazard to nothing', () => {
    expect(FRESHNESS_FILL_OPACITY.stale).toBeGreaterThan(0.1)
  })

  it('orders opacity fresh > aging > stale', () => {
    expect(FRESHNESS_FILL_OPACITY.fresh).toBeGreaterThan(FRESHNESS_FILL_OPACITY.aging)
    expect(FRESHNESS_FILL_OPACITY.aging).toBeGreaterThan(FRESHNESS_FILL_OPACITY.stale)
  })

  it('builds a match expression covering every freshness with a stale fallback', () => {
    const expr = hazardFillOpacityExpression()
    expect(JSON.stringify(expr)).toContain('fresh')
    expect(JSON.stringify(expr)).toContain('aging')
    expect(expr[0]).toBe('*')
  })
})
