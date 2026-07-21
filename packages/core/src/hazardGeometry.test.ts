import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bboxIntersects, type LatLng } from './geometry'
import {
  defaultShapeForType,
  distanceToHazard,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_GEOMETRY_KIND,
  HAZARD_DEFAULT_RADIUS_M,
  HAZARD_MAX_SIZE_M,
  HAZARD_MAX_VERTICES,
  hazardBbox,
  hazardFootprint,
  isValidHazardShape,
  lineShape,
  pointRadiusShape,
} from './hazardGeometry'
import { HAZARD_TYPES } from './types'

const CENTRE: LatLng = { lat: 44.4759, lng: -73.2121 } // Burlington, VT

const arbNearbyCoord: fc.Arbitrary<LatLng> = fc.record({
  lat: fc.double({ min: 44.4, max: 44.55, noNaN: true }),
  lng: fc.double({ min: -73.3, max: -73.1, noNaN: true }),
})

describe('per-type defaults', () => {
  it('define a geometry kind, radius and buffer for every hazard type', () => {
    for (const type of HAZARD_TYPES) {
      expect(HAZARD_DEFAULT_GEOMETRY_KIND[type], type).toBeDefined()
      expect(HAZARD_DEFAULT_RADIUS_M[type], type).toBeGreaterThan(0)
      expect(HAZARD_DEFAULT_BUFFER_M[type], type).toBeGreaterThan(0)
    }
  })

  it('routes exactly the genuinely linear hazards to the polyline primitive (D51)', () => {
    const linear = HAZARD_TYPES.filter((t) => HAZARD_DEFAULT_GEOMETRY_KIND[t] === 'line')
    expect([...linear].sort()).toEqual(['ice_heave', 'pressure_ridge', 'wet_crack'])
  })

  it('never defaults to freeform polygon — it is opt-in advanced only (D51)', () => {
    for (const type of HAZARD_TYPES) {
      expect(HAZARD_DEFAULT_GEOMETRY_KIND[type]).not.toBe('polygon')
    }
  })

  // A folded ridge is loose plates metres wide; a tectonic crack is a hairline. Drawing them with the
  // same uncertainty band would misrepresent both (research §2/§4).
  it('buffers a pressure ridge far wider than a wet crack', () => {
    expect(HAZARD_DEFAULT_BUFFER_M.pressure_ridge).toBeGreaterThan(
      HAZARD_DEFAULT_BUFFER_M.wet_crack * 2,
    )
  })

  it('sizes a thaw-rotten zone larger than a drilled hole', () => {
    expect(HAZARD_DEFAULT_RADIUS_M.thawed_rotten).toBeGreaterThan(
      HAZARD_DEFAULT_RADIUS_M.drilled_hole * 5,
    )
  })
})

describe('defaultShapeForType', () => {
  // The two-tap guarantee: picking a type must always yield something valid and submittable, even for
  // types that ultimately want a polyline (one GPS fix can't make a line).
  it('yields an immediately valid shape for every type', () => {
    for (const type of HAZARD_TYPES) {
      const shape = defaultShapeForType(type, CENTRE)
      expect(isValidHazardShape(shape), type).toBe(true)
      expect(shape.geometryKind, type).toBe('point_radius')
    }
  })

  it('places the pin at the given coordinate', () => {
    const shape = defaultShapeForType('open_water', CENTRE)
    expect(shape.geometry).toEqual({ type: 'Point', coordinates: [CENTRE.lng, CENTRE.lat] })
  })
})

describe('distanceToHazard', () => {
  it('is 0 at the centre of a point+radius hazard', () => {
    expect(distanceToHazard(CENTRE, pointRadiusShape(CENTRE, 50))).toBe(0)
  })

  it('is 0 anywhere inside the radius, and positive outside it', () => {
    const shape = pointRadiusShape(CENTRE, 100)
    // ~0.0005° latitude ≈ 55 m — inside.
    expect(distanceToHazard({ lat: CENTRE.lat + 0.0005, lng: CENTRE.lng }, shape)).toBe(0)
    // ~0.005° latitude ≈ 555 m — outside.
    expect(distanceToHazard({ lat: CENTRE.lat + 0.005, lng: CENTRE.lng }, shape)).toBeGreaterThan(0)
  })

  it('subtracts exactly the radius from the centre distance', () => {
    const far = { lat: CENTRE.lat + 0.01, lng: CENTRE.lng }
    const bare = distanceToHazard(far, pointRadiusShape(CENTRE, 0.0001))
    const withRadius = distanceToHazard(far, pointRadiusShape(CENTRE, 200))
    expect(bare - withRadius).toBeCloseTo(200, 0)
  })

  it('never returns a negative distance (property)', () => {
    fc.assert(
      fc.property(arbNearbyCoord, fc.integer({ min: 1, max: 500 }), (coord, radius) => {
        expect(distanceToHazard(coord, pointRadiusShape(CENTRE, radius))).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  // Growing the hazard can only bring it closer to you, never push it away.
  it('is monotonically non-increasing in radius (property)', () => {
    fc.assert(
      fc.property(
        arbNearbyCoord,
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 1, max: 400 }),
        (coord, r1, r2) => {
          const [small, large] = r1 <= r2 ? [r1, r2] : [r2, r1]
          expect(distanceToHazard(coord, pointRadiusShape(CENTRE, large))).toBeLessThanOrEqual(
            distanceToHazard(coord, pointRadiusShape(CENTRE, small)),
          )
        },
      ),
    )
  })

  it('measures to a buffered line, reaching 0 on the line itself', () => {
    const line = lineShape(
      [
        { lat: 44.47, lng: -73.22 },
        { lat: 44.48, lng: -73.2 },
      ],
      20,
    )
    expect(distanceToHazard({ lat: 44.475, lng: -73.21 }, line)).toBe(0)
    expect(distanceToHazard({ lat: 44.6, lng: -73.21 }, line)).toBeGreaterThan(0)
  })
})

describe('hazardFootprint / hazardBbox', () => {
  it('grows a point into a polygon that contains its own centre', () => {
    const bbox = hazardBbox(pointRadiusShape(CENTRE, 100))
    expect(bbox.minLat).toBeLessThan(CENTRE.lat)
    expect(bbox.maxLat).toBeGreaterThan(CENTRE.lat)
    expect(bbox.minLng).toBeLessThan(CENTRE.lng)
    expect(bbox.maxLng).toBeGreaterThan(CENTRE.lng)
  })

  it('produces a bbox that grows with the radius (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 200 }),
        fc.integer({ min: 10, max: 200 }),
        (r1, r2) => {
          const [small, large] = r1 <= r2 ? [r1, r2] : [r2, r1]
          const inner = hazardBbox(pointRadiusShape(CENTRE, small))
          const outer = hazardBbox(pointRadiusShape(CENTRE, large))
          expect(outer.maxLat).toBeGreaterThanOrEqual(inner.maxLat)
          expect(outer.minLat).toBeLessThanOrEqual(inner.minLat)
        },
      ),
    )
  })

  // The bbox is the prefilter for the footprint; if a point inside the footprint fell outside the
  // bbox, proximity queries would silently miss real hazards.
  it('always contains the footprint it indexes', () => {
    const shape = pointRadiusShape(CENTRE, 150)
    const bbox = hazardBbox(shape)
    const pointBox = {
      minLat: CENTRE.lat,
      maxLat: CENTRE.lat,
      minLng: CENTRE.lng,
      maxLng: CENTRE.lng,
    }
    expect(bboxIntersects(bbox, pointBox)).toBe(true)
  })

  it('returns an unbuffered polygon as its own footprint', () => {
    const ring = [
      [-73.22, 44.47],
      [-73.2, 44.48],
      [-73.21, 44.46],
      [-73.22, 44.47],
    ]
    const geometry = { type: 'Polygon' as const, coordinates: [ring] }
    expect(hazardFootprint({ geometryKind: 'polygon', geometry })).toEqual(geometry)
  })

  it('grows a line by its uncertainty buffer', () => {
    const line = lineShape(
      [
        { lat: 44.47, lng: -73.22 },
        { lat: 44.48, lng: -73.2 },
      ],
      25,
    )
    const footprint = hazardFootprint(line)
    expect(footprint.type === 'Polygon' || footprint.type === 'MultiPolygon').toBe(true)
    expect(hazardBbox(line).maxLat).toBeGreaterThan(44.48)
  })

  it('never produces a degenerate zero-area footprint', () => {
    const bbox = hazardBbox({
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [CENTRE.lng, CENTRE.lat] },
      radiusMeters: 0,
    })
    expect(bbox.maxLat).toBeGreaterThan(bbox.minLat)
    expect(bbox.maxLng).toBeGreaterThan(bbox.minLng)
  })
})

describe('isValidHazardShape', () => {
  it('accepts a well-formed point+radius', () => {
    expect(isValidHazardShape(pointRadiusShape(CENTRE, 30))).toBe(true)
  })

  it('rejects a point+radius with no positive radius', () => {
    expect(isValidHazardShape(pointRadiusShape(CENTRE, 0))).toBe(false)
    expect(
      isValidHazardShape({
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [CENTRE.lng, CENTRE.lat] },
      }),
    ).toBe(false)
  })

  it('accepts a two-vertex line with distinct points', () => {
    expect(
      isValidHazardShape(
        lineShape(
          [
            { lat: 44.47, lng: -73.22 },
            { lat: 44.48, lng: -73.2 },
          ],
          15,
        ),
      ),
    ).toBe(true)
  })

  // Turf's buffer throws on a zero-length line, so an on-ice double-tap in one spot must be rejected
  // before it can become a row that crashes the renderer.
  it('rejects a line whose vertices are all identical', () => {
    expect(isValidHazardShape(lineShape([CENTRE, CENTRE, CENTRE], 15))).toBe(false)
  })

  it('rejects a single-vertex line', () => {
    expect(isValidHazardShape(lineShape([CENTRE], 15))).toBe(false)
  })

  it('rejects an unclosed / too-small polygon ring', () => {
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-73.22, 44.47],
              [-73.2, 44.48],
            ],
          ],
        },
      }),
    ).toBe(false)
  })

  it('validates a MultiPolygon by its first ring', () => {
    const ring = [
      [-73.22, 44.47],
      [-73.2, 44.48],
      [-73.21, 44.46],
      [-73.22, 44.47],
    ]
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
      }),
    ).toBe(true)
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: { type: 'MultiPolygon', coordinates: [] },
      }),
    ).toBe(false)
  })

  it('rejects a geometry whose kind disagrees with its type', () => {
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: { type: 'Point', coordinates: [-73.21, 44.47] },
      }),
    ).toBe(false)
    expect(
      isValidHazardShape({
        geometryKind: 'line',
        geometry: { type: 'Point', coordinates: [-73.21, 44.47] },
      }),
    ).toBe(false)
  })

  it('accepts a closed triangular ring', () => {
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-73.22, 44.47],
              [-73.2, 44.48],
              [-73.21, 44.46],
              [-73.22, 44.47],
            ],
          ],
        },
      }),
    ).toBe(true)
  })

  // A line is stored as a band, so a zero/absent buffer has no area to render or measure — and letting
  // it through was the bug that returned a LineString-as-Polygon and threw in the proximity watcher,
  // silencing every alert on the lake.
  it('requires a positive bufferMeters on a line', () => {
    const verts = [
      { lat: 44.47, lng: -73.22 },
      { lat: 44.48, lng: -73.2 },
    ]
    expect(isValidHazardShape(lineShape(verts, 0))).toBe(false)
    expect(
      isValidHazardShape({ geometryKind: 'line', geometry: lineShape(verts, 5).geometry }),
    ).toBe(false)
    expect(isValidHazardShape(lineShape(verts, 5))).toBe(true)
  })

  it('rejects sizes past the absolute ceiling and non-finite sizes', () => {
    expect(isValidHazardShape(pointRadiusShape(CENTRE, HAZARD_MAX_SIZE_M + 1))).toBe(false)
    expect(isValidHazardShape(pointRadiusShape(CENTRE, HAZARD_MAX_SIZE_M))).toBe(true)
    expect(isValidHazardShape(pointRadiusShape(CENTRE, Number.POSITIVE_INFINITY))).toBe(false)
    expect(isValidHazardShape(pointRadiusShape(CENTRE, Number.NaN))).toBe(false)
  })

  it('rejects out-of-range coordinates', () => {
    expect(isValidHazardShape(pointRadiusShape({ lat: 91, lng: 0 }, 30))).toBe(false)
    expect(isValidHazardShape(pointRadiusShape({ lat: 0, lng: 200 }, 30))).toBe(false)
  })

  it('rejects a polyline with more vertices than the cap', () => {
    const many = Array.from({ length: HAZARD_MAX_VERTICES + 1 }, (_, i) => ({
      lat: 44.47 + i * 1e-5,
      lng: -73.22 + i * 1e-5,
    }))
    expect(isValidHazardShape(lineShape(many, 10))).toBe(false)
  })

  const triangle: [number, number][] = [
    [-73.22, 44.47],
    [-73.2, 44.48],
    [-73.21, 44.46],
    [-73.22, 44.47],
  ]

  it('rejects a polygon with an out-of-range buffer but accepts a valid one', () => {
    const geometry = { type: 'Polygon' as const, coordinates: [triangle] }
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry,
        bufferMeters: HAZARD_MAX_SIZE_M + 1,
      }),
    ).toBe(false)
    expect(isValidHazardShape({ geometryKind: 'polygon', geometry, bufferMeters: 10 })).toBe(true)
  })

  it('rejects a polygon with an out-of-range coordinate', () => {
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-73.22, 44.47],
              [-73.2, 44.48],
              [-73.21, 999],
              [-73.22, 44.47],
            ],
          ],
        },
      }),
    ).toBe(false)
  })

  it('rejects a polygon ring past the vertex cap', () => {
    const ring = Array.from({ length: HAZARD_MAX_VERTICES + 2 }, (_, i) => [
      -73.22 + i * 1e-5,
      44.47 + i * 1e-5,
    ])
    ring.push(ring[0] as number[])
    expect(
      isValidHazardShape({
        geometryKind: 'polygon',
        geometry: { type: 'Polygon', coordinates: [ring as [number, number][]] },
      }),
    ).toBe(false)
  })
})

describe('hazardFootprint never yields a non-areal geometry', () => {
  // The invariant that keeps a hazard from existing "in the database and nowhere else": whatever the
  // inputs, the footprint the renderer draws and the proximity evaluator measures is always a Polygon
  // or MultiPolygon — never a raw Point or LineString that `distanceToPolygonMeters` would throw on.
  it('always returns a polygonal footprint for every geometry kind', () => {
    const line = lineShape(
      [
        { lat: 44.47, lng: -73.22 },
        { lat: 44.48, lng: -73.2 },
      ],
      12,
    )
    for (const shape of [pointRadiusShape(CENTRE, 30), line]) {
      const footprint = hazardFootprint(shape)
      expect(['Polygon', 'MultiPolygon']).toContain(footprint.type)
    }
    // And a distance query against any of them is finite, not a throw.
    expect(Number.isFinite(distanceToHazard(CENTRE, line))).toBe(true)
  })
})
