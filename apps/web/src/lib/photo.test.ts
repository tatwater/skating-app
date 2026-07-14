import { describe, expect, it } from 'vitest'
import { isHeic } from './photo'

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
