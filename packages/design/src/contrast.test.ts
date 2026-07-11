import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  hexToRgb,
  meetsContrast,
  relativeLuminance,
  WCAG_AA_LARGE,
  WCAG_AA_NORMAL,
} from './contrast'

describe('hexToRgb', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb('#ff8800')).toEqual([255, 136, 0])
  })

  it('parses 3-digit shorthand and a leading-hashless string', () => {
    expect(hexToRgb('#f80')).toEqual([255, 136, 0])
    expect(hexToRgb('ffffff')).toEqual([255, 255, 255])
  })

  it('rejects malformed input', () => {
    expect(() => hexToRgb('#12')).toThrow()
    expect(() => hexToRgb('#zzzzzz')).toThrow()
  })
})

describe('relativeLuminance', () => {
  it('anchors black at 0 and white at 1', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10)
  })
})

describe('contrastRatio', () => {
  it('is 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
  })

  it('is 1:1 for identical colors', () => {
    expect(contrastRatio('#3366cc', '#3366cc')).toBeCloseTo(1, 10)
  })

  const hex = fc
    .integer({ min: 0, max: 0xffffff })
    .map((n) => `#${n.toString(16).padStart(6, '0')}`)

  it('is order-independent', () => {
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
      }),
    )
  })

  it('always lands in [1, 21]', () => {
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const ratio = contrastRatio(a, b)
        expect(ratio).toBeGreaterThanOrEqual(1)
        expect(ratio).toBeLessThanOrEqual(21)
      }),
    )
  })
})

describe('meetsContrast', () => {
  it('defaults to the AA normal-text threshold', () => {
    // Black on white clears everything.
    expect(meetsContrast('#000000', '#ffffff')).toBe(true)
    // Mid-gray on white fails normal but a laxer threshold can pass.
    expect(meetsContrast('#949494', '#ffffff')).toBe(false)
    expect(meetsContrast('#949494', '#ffffff', WCAG_AA_LARGE)).toBe(true)
  })

  it('exposes the AA thresholds', () => {
    expect(WCAG_AA_NORMAL).toBe(4.5)
    expect(WCAG_AA_LARGE).toBe(3)
  })
})
