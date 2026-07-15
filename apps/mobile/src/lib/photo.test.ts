import { describe, expect, it } from 'vitest'
import { exifCoord } from './photo'

describe('exifCoord', () => {
  it('returns undefined for missing/empty EXIF', () => {
    expect(exifCoord(null)).toBeUndefined()
    expect(exifCoord(undefined)).toBeUndefined()
    expect(exifCoord({})).toBeUndefined()
  })

  it('applies N/W refs to the magnitude (Vermont)', () => {
    expect(
      exifCoord({
        GPSLatitude: 44.46,
        GPSLatitudeRef: 'N',
        GPSLongitude: 73.15,
        GPSLongitudeRef: 'W',
      }),
    ).toEqual({ lat: 44.46, lng: -73.15 })
  })

  it('applies an S ref to a positive magnitude', () => {
    expect(
      exifCoord({
        GPSLatitude: 33.87,
        GPSLatitudeRef: 'S',
        GPSLongitude: 151.2,
        GPSLongitudeRef: 'E',
      }),
    ).toEqual({ lat: -33.87, lng: 151.2 })
  })

  it('parses numeric-string tags', () => {
    expect(
      exifCoord({
        GPSLatitude: '44.46',
        GPSLatitudeRef: 'N',
        GPSLongitude: '73.15',
        GPSLongitudeRef: 'W',
      }),
    ).toEqual({ lat: 44.46, lng: -73.15 })
  })

  it('trusts an already-signed decimal when no ref is present', () => {
    expect(exifCoord({ GPSLatitude: 44.46, GPSLongitude: -73.15 })).toEqual({
      lat: 44.46,
      lng: -73.15,
    })
  })

  it('rejects out-of-range and null-island coordinates', () => {
    expect(exifCoord({ GPSLatitude: 200, GPSLongitude: 10 })).toBeUndefined()
    expect(exifCoord({ GPSLatitude: 0, GPSLongitude: 0 })).toBeUndefined()
  })
})
