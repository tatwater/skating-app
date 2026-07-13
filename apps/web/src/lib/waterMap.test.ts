import { describe, expect, it } from 'vitest'
import {
  boundsToViewport,
  buildMapStyle,
  type MappableBody,
  OSM_ATTRIBUTION,
  waterBodiesToFeatureCollection,
} from './waterMap'

describe('buildMapStyle', () => {
  const style = buildMapStyle('https://example.com/vt.pmtiles')

  it('is a v8 style with the Protomaps pmtiles source', () => {
    expect(style.version).toBe(8)
    const source = style.sources.protomaps
    expect(source).toMatchObject({
      type: 'vector',
      url: 'pmtiles://https://example.com/vt.pmtiles',
    })
  })

  it('carries OSM attribution on the basemap source (ODbL launch gate)', () => {
    expect((style.sources.protomaps as { attribution?: string }).attribution).toBe(OSM_ATTRIBUTION)
  })

  it('includes basemap layers and font/sprite assets', () => {
    expect(Array.isArray(style.layers)).toBe(true)
    expect(style.layers.length).toBeGreaterThan(0)
    expect(style.glyphs).toContain('{fontstack}')
    expect(style.sprite).toBeTruthy()
  })
})

describe('waterBodiesToFeatureCollection', () => {
  const bodies: MappableBody[] = [
    {
      _id: 'body_1',
      name: 'Lake Champlain',
      type: 'lake',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-73.3, 44.4],
            [-73.3, 44.5],
            [-73.2, 44.5],
            [-73.2, 44.4],
            [-73.3, 44.4],
          ],
        ],
      },
    },
  ]

  it('wraps each body as a Feature keeping geometry and metadata as properties', () => {
    const fc = waterBodiesToFeatureCollection(bodies)
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(1)
    const feature = fc.features[0]
    expect(feature?.geometry).toEqual(bodies[0]?.polygon)
    expect(feature?.properties).toEqual({ id: 'body_1', name: 'Lake Champlain', type: 'lake' })
  })

  it('produces an empty collection for no bodies', () => {
    expect(waterBodiesToFeatureCollection([]).features).toHaveLength(0)
  })
})

describe('boundsToViewport', () => {
  it('maps MapLibre bounds accessors to a { minLat, … } bbox', () => {
    const bounds = {
      getWest: () => -73.3,
      getSouth: () => 44.4,
      getEast: () => -73.1,
      getNorth: () => 44.6,
    }
    expect(boundsToViewport(bounds)).toEqual({
      minLng: -73.3,
      minLat: 44.4,
      maxLng: -73.1,
      maxLat: 44.6,
    })
  })
})
