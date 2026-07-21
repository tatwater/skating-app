import { applyDraftMapClick, draftForType, resizeDraft } from '@skating/core'
import { describe, expect, it } from 'vitest'
import {
  bodyFeaturesToFeatureCollection,
  FRESHNESS_FILL_OPACITY,
  HAZARD_PALETTE,
  hazardColorExpression,
  hazardDraftToFeatureCollection,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
  type MappableHazard,
} from './hazardMap'

const A = { lat: 44.4759, lng: -73.2121 }
const B = { lat: 44.481, lng: -73.204 }

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

describe('hazardDraftToFeatureCollection', () => {
  it('renders nothing when nothing is being authored', () => {
    expect(hazardDraftToFeatureCollection(null, null).features).toEqual([])
  })

  it('shows a vertex the moment it is clicked, before any shape exists', () => {
    const draft = applyDraftMapClick(draftForType('pressure_ridge'), A)
    const fc = hazardDraftToFeatureCollection(draft, 'pressure_ridge')
    // One vertex is not yet a line, so there is no footprint — but the click must still be visible,
    // or a polyline would begin with no feedback at all.
    expect(fc.features.map((f) => f.properties?.role)).toEqual(['vertex'])
    expect(fc.features[0]?.geometry.type).toBe('Point')
  })

  it('adds the buffered band once the line is storable, keeping the vertices', () => {
    const draft = applyDraftMapClick(applyDraftMapClick(draftForType('pressure_ridge'), A), B)
    const fc = hazardDraftToFeatureCollection(draft, 'pressure_ridge')
    expect(fc.features.map((f) => f.properties?.role)).toEqual(['footprint', 'vertex', 'vertex'])
    const footprint = fc.features[0]?.geometry
    expect(footprint?.type === 'Polygon' || footprint?.type === 'MultiPolygon').toBe(true)
  })

  // The preview must be the shape that would be *saved*, at the width that would be saved — this is
  // the whole reason the draft goes through the same `hazardFootprint` the server and the proximity
  // evaluator use.
  it('grows the previewed band when the width stepper is pressed', () => {
    let draft = applyDraftMapClick(applyDraftMapClick(draftForType('wet_crack'), A), B)
    const narrow = hazardDraftToFeatureCollection(draft, 'wet_crack')
    draft = resizeDraft(draft, 1)
    const wide = hazardDraftToFeatureCollection(draft, 'wet_crack')
    expect(area(wide)).toBeGreaterThan(area(narrow))
  })

  it('renders a placed circle as its metric footprint', () => {
    const draft = applyDraftMapClick(draftForType('open_water'), A)
    const fc = hazardDraftToFeatureCollection(draft, 'open_water')
    expect(fc.features.map((f) => f.properties?.role)).toEqual(['footprint', 'vertex'])
  })

  // Watching yourself draw a warning while marking a way *across* a ridge would be actively wrong,
  // so the draft carries `passage` into the same colour expression saved hazards use (research §4).
  it('flags a ridge_crossing draft as a passage marker, not a danger', () => {
    const draft = applyDraftMapClick(draftForType('ridge_crossing'), A)
    for (const f of hazardDraftToFeatureCollection(draft, 'ridge_crossing').features) {
      expect(f.properties).toMatchObject({ passage: true, healing: false })
    }
    const danger = applyDraftMapClick(draftForType('open_water'), A)
    for (const f of hazardDraftToFeatureCollection(danger, 'open_water').features) {
      expect(f.properties).toMatchObject({ passage: false })
    }
  })
})

/** Crude bbox area of a feature collection — enough to compare a narrow band against a wide one. */
function area(fc: GeoJSON.FeatureCollection): number {
  const coords = fc.features.flatMap((f) =>
    f.geometry.type === 'Polygon' ? f.geometry.coordinates.flat() : [],
  )
  const lngs = coords.map(([lng]) => lng ?? 0)
  const lats = coords.map(([, lat]) => lat ?? 0)
  return (Math.max(...lngs) - Math.min(...lngs)) * (Math.max(...lats) - Math.min(...lats))
}

describe('hazardColorExpression', () => {
  // Order matters: a passage marker is checked first, so `ridge_crossing` can never fall through to
  // the danger colour — "⚠" on a way *across* a ridge would be actively wrong (research §4).
  it('resolves passage before healing before danger', () => {
    const expr = hazardColorExpression(HAZARD_PALETTE.white)
    expect(expr).toEqual([
      'case',
      ['get', 'passage'],
      HAZARD_PALETTE.white.passage,
      ['get', 'healing'],
      HAZARD_PALETTE.white.healing,
      HAZARD_PALETTE.white.danger,
    ])
  })

  // Danger / healing / passage mean three different things to someone standing on ice, so they must
  // never resolve to the same colour in either theme (D34).
  it('keeps danger, healing and passage visually distinct in both themes', () => {
    for (const palette of [HAZARD_PALETTE.white, HAZARD_PALETTE.dark]) {
      const { danger, healing, passage } = palette
      expect(new Set([danger, healing, passage]).size).toBe(3)
    }
  })
})
