import { describe, expect, it } from 'vitest'
import { datetimeLocalToMs, toDatetimeLocal } from './reportForm'

describe('datetime-local round trip', () => {
  it('parses back to the same minute it was formatted from', () => {
    const ms = Date.UTC(2026, 0, 5, 19, 30)
    const roundTripped = datetimeLocalToMs(toDatetimeLocal(ms))
    // Local formatting drops seconds; equal to the minute.
    expect(Math.abs(roundTripped - ms)).toBeLessThan(60_000)
  })

  it('returns NaN for a blank value', () => {
    expect(Number.isNaN(datetimeLocalToMs(''))).toBe(true)
  })
})
