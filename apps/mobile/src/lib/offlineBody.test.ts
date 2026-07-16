import type { Polygon } from 'geojson'
import { describe, expect, it } from 'vitest'
import { AUTOSELECT_BUFFER_M, type CachedBody, nearestCachedBody } from './offlineBody'

/** ~111 m unit square on the equator (a degree ≈ the same metres each axis). */
function square(id: string, minLng: number, minLat: number, sizeDeg: number): CachedBody {
  return {
    waterBodyId: id,
    name: id,
    states: ['VT'],
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [minLng, minLat],
          [minLng + sizeDeg, minLat],
          [minLng + sizeDeg, minLat + sizeDeg],
          [minLng, minLat + sizeDeg],
          [minLng, minLat],
        ],
      ],
    } satisfies Polygon,
    centroid: { lat: minLat + sizeDeg / 2, lng: minLng + sizeDeg / 2 },
    surfaceAreaSqM: sizeDeg * sizeDeg,
    cachedAt: 0,
  }
}

describe('nearestCachedBody', () => {
  const near = square('near', 0, 0, 0.001)
  const far = square('far', 10, 10, 0.001)

  it('resolves a coord inside a cached body', () => {
    expect(nearestCachedBody([near, far], { lat: 0.0005, lng: 0.0005 })?.waterBodyId).toBe('near')
  })

  it('resolves a coord in the parking buffer just outside the body', () => {
    // ~222 m east of the body — inside the default 300 m buffer.
    expect(nearestCachedBody([near, far], { lat: 0.0005, lng: 0.003 })?.waterBodyId).toBe('near')
  })

  it('returns null when nothing is within the buffer', () => {
    expect(nearestCachedBody([near, far], { lat: 0.0005, lng: 0.003 }, 10)).toBeNull()
    expect(nearestCachedBody([near, far], { lat: 5, lng: 5 })).toBeNull()
  })

  it('returns null for an empty cache', () => {
    expect(nearestCachedBody([], { lat: 0, lng: 0 })).toBeNull()
  })

  it('exposes a sane default buffer', () => {
    expect(AUTOSELECT_BUFFER_M).toBe(300)
  })
})
