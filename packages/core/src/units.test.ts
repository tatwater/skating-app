import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  cmToInches,
  cToF,
  formatAreaAcres,
  formatDistanceMiles,
  formatPrecipInches,
  formatTemperatureF,
  formatThicknessInches,
  formatWindMph,
  fToC,
  inchesToCm,
  kmToMiles,
  kphToMph,
  metersToFeet,
  metersToMiles,
  mmToInches,
  mphToKph,
  roundTo,
  sqMetersToAcres,
  sqMetersToSqFeet,
} from './units'

describe('temperature', () => {
  it('converts known points', () => {
    expect(cToF(0)).toBe(32)
    expect(cToF(100)).toBe(212)
    expect(cToF(-40)).toBe(-40)
    expect(fToC(32)).toBe(0)
    expect(fToC(212)).toBe(100)
  })
})

describe('length / distance / area conversions', () => {
  it('converts known points', () => {
    expect(cmToInches(2.54)).toBeCloseTo(1)
    expect(inchesToCm(1)).toBeCloseTo(2.54)
    expect(mmToInches(25.4)).toBeCloseTo(1)
    expect(metersToFeet(0.3048)).toBeCloseTo(1)
    expect(kmToMiles(1.609344)).toBeCloseTo(1)
    expect(metersToMiles(1609.344)).toBeCloseTo(1)
    expect(kphToMph(1.609344)).toBeCloseTo(1)
    expect(mphToKph(1)).toBeCloseTo(1.609344)
    expect(sqMetersToAcres(4046.8564224)).toBeCloseTo(1)
    expect(sqMetersToSqFeet(1)).toBeCloseTo(10.7639, 3)
  })
})

describe('roundTo', () => {
  it('rounds to the requested precision', () => {
    expect(roundTo(1.2345, 2)).toBe(1.23)
    expect(roundTo(1.2355, 2)).toBe(1.24)
    expect(roundTo(1.6)).toBe(2)
    expect(roundTo(1.4)).toBe(1)
  })
})

describe('formatters', () => {
  it('render imperial with a unit suffix (D25)', () => {
    expect(formatTemperatureF(0)).toBe('32°F')
    expect(formatThicknessInches(10)).toBe('3.9″')
    expect(formatWindMph(16.09344)).toBe('10 mph')
    expect(formatPrecipInches(25.4)).toBe('1 in')
    expect(formatDistanceMiles(1609.344)).toBe('1 mi')
    expect(formatAreaAcres(4046.8564224)).toBe('1 acres')
  })
})

describe('conversion round-trips (property)', () => {
  const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })

  it('cToF ∘ fToC is identity', () => {
    fc.assert(
      fc.property(finite, (c) => {
        expect(fToC(cToF(c))).toBeCloseTo(c, 6)
      }),
    )
  })

  it('cm ↔ inches is identity', () => {
    fc.assert(
      fc.property(finite, (cm) => {
        expect(inchesToCm(cmToInches(cm))).toBeCloseTo(cm, 6)
      }),
    )
  })

  it('kph ↔ mph is identity', () => {
    fc.assert(
      fc.property(finite, (kph) => {
        expect(mphToKph(kphToMph(kph))).toBeCloseTo(kph, 6)
      }),
    )
  })
})
