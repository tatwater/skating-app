import { describe, expect, it } from 'vitest'
import { isHeic, photoUploadCoord } from './photo'

describe('isHeic', () => {
  it('detects HEIC/HEIF by MIME type', () => {
    expect(isHeic({ type: 'image/heic', name: 'IMG_0001' })).toBe(true)
    expect(isHeic({ type: 'image/heif', name: 'x' })).toBe(true)
  })

  it('detects by extension when the type is blank/generic', () => {
    expect(isHeic({ type: '', name: 'IMG_0001.HEIC' })).toBe(true)
    expect(isHeic({ type: 'application/octet-stream', name: 'photo.heif' })).toBe(true)
  })

  it('is false for JPEG/PNG', () => {
    expect(isHeic({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(false)
    expect(isHeic({ type: 'image/png', name: 'photo.png' })).toBe(false)
  })
})

describe('photoUploadCoord (D42 client gate)', () => {
  const coord = { lat: 44.4, lng: -73.2 }

  it('passes the coord only when placeOnMap is opted in', () => {
    expect(photoUploadCoord(true, coord)).toEqual(coord)
  })

  it('drops the coord when not opted in', () => {
    expect(photoUploadCoord(false, coord)).toBeUndefined()
  })

  it('is undefined when there is no coord regardless of opt-in', () => {
    expect(photoUploadCoord(true, undefined)).toBeUndefined()
  })
})
