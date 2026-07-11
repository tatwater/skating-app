import { describe, expect, it } from 'vitest'
import {
  duration,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  radius,
  space,
  zIndex,
} from './scales'

/** Numeric scales: every step is a non-negative number and steps are distinct. */
const NUMERIC_SCALES = { space, radius, fontSize, lineHeight, fontWeight, zIndex, duration }

describe('numeric scales', () => {
  it.each(Object.entries(NUMERIC_SCALES))('%s steps are non-negative numbers', (_name, scale) => {
    const values = Object.values(scale) as number[]
    expect(values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)).toBe(true)
  })

  it.each(Object.entries(NUMERIC_SCALES))('%s steps are distinct', (_name, scale) => {
    const values = Object.values(scale)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('fontFamily', () => {
  it('provides sans and mono stacks', () => {
    expect(fontFamily.sans).toContain('sans-serif')
    expect(fontFamily.mono).toContain('monospace')
  })
})
