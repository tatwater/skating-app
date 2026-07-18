import type { Polygon } from 'geojson'
import { describe, expect, it } from 'vitest'
import {
  bandForCoord,
  bandWithinRadius,
  DRIVE_TIME_BANDS,
  type DriveTimeBands,
  isDriveTimeBand,
  isWithinRadius,
} from './driveTime'
import type { LatLng } from './geometry'

/** An axis-aligned square polygon centred on `[0,0]` with half-width `half` degrees. */
function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  }
}

const HOME: LatLng = { lat: 0, lng: 0 }

describe('DRIVE_TIME_BANDS / isDriveTimeBand', () => {
  it('is the 30/60/90 tuple', () => {
    expect(DRIVE_TIME_BANDS).toEqual([30, 60, 90])
  })

  it('accepts only canonical band minutes', () => {
    expect(isDriveTimeBand(30)).toBe(true)
    expect(isDriveTimeBand(60)).toBe(true)
    expect(isDriveTimeBand(90)).toBe(true)
    expect(isDriveTimeBand(45)).toBe(false)
    expect(isDriveTimeBand('30')).toBe(false)
    expect(isDriveTimeBand(undefined)).toBe(false)
  })
})

describe('isWithinRadius', () => {
  it('is true at the centre and false far away', () => {
    expect(isWithinRadius(HOME, HOME, 1000)).toBe(true)
    expect(isWithinRadius(HOME, { lat: 1, lng: 0 }, 1000)).toBe(false)
  })

  it('treats the exact radius as within (inclusive)', () => {
    // ~1 degree of latitude ≈ 111,195 m on the mean-radius sphere.
    const oneDegLatMeters = 111_195
    expect(isWithinRadius(HOME, { lat: 1, lng: 0 }, oneDegLatMeters + 5)).toBe(true)
    expect(isWithinRadius(HOME, { lat: 1, lng: 0 }, oneDegLatMeters - 5)).toBe(false)
  })
})

describe('bandForCoord', () => {
  // Nested bands: 30 ⊂ 60, plus a crow-flies outer radius for the 90 band.
  const bands: DriveTimeBands = {
    band30: square(0.5),
    band60: square(1),
    outerRadiusMeters: 200_000, // ~1.8° of latitude
  }

  it('returns the tightest band when a point nests inside both polygons', () => {
    expect(bandForCoord({ lat: 0.1, lng: 0.1 }, bands, HOME)).toBe(30)
  })

  it('returns 60 for a point in band60 but outside band30', () => {
    expect(bandForCoord({ lat: 0.75, lng: 0 }, bands, HOME)).toBe(60)
  })

  it('returns 90 for a point beyond both polygons but inside the outer radius', () => {
    expect(bandForCoord({ lat: 1.5, lng: 0 }, bands, HOME)).toBe(90)
  })

  it('returns null for a point beyond the outer radius', () => {
    expect(bandForCoord({ lat: 5, lng: 0 }, bands, HOME)).toBe(null)
  })

  it('returns null when the viewer has no cached geometry', () => {
    expect(bandForCoord({ lat: 0.1, lng: 0.1 }, {}, HOME)).toBe(null)
  })

  it('resolves polygon bands without a home, but not the 90 radius band', () => {
    // band30/band60 are self-positioned; only the outer-radius test needs `home`.
    expect(bandForCoord({ lat: 0.1, lng: 0.1 }, bands)).toBe(30)
    expect(bandForCoord({ lat: 1.5, lng: 0 }, bands)).toBe(null)
  })

  it('falls through band30 to band60 when only band60 is cached', () => {
    expect(bandForCoord({ lat: 0.1, lng: 0.1 }, { band60: square(1) }, HOME)).toBe(60)
  })
})

describe('bandWithinRadius', () => {
  it('accepts equal or tighter bands', () => {
    expect(bandWithinRadius(30, 60)).toBe(true)
    expect(bandWithinRadius(60, 60)).toBe(true)
  })

  it('rejects a looser band', () => {
    expect(bandWithinRadius(90, 60)).toBe(false)
  })

  it('rejects a null band (out of range / no home)', () => {
    expect(bandWithinRadius(null, 90)).toBe(false)
  })
})
