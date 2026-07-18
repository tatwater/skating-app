import { describe, expect, it } from 'vitest'
import { nextZonedHourMs, zonedHour, zonedParts } from './schedule'

const ET = 'America/New_York'

describe('zonedParts / zonedHour', () => {
  it('renders a known UTC instant in ET (EST, winter, UTC-5)', () => {
    // 2026-01-15 18:00 UTC = 13:00 EST.
    const ms = Date.UTC(2026, 0, 15, 18, 0, 0)
    expect(zonedParts(ms, ET)).toMatchObject({ year: 2026, month: 1, day: 15, hour: 13 })
    expect(zonedHour(ms, ET)).toBe(13)
  })

  it('reflects EDT in summer (UTC-4)', () => {
    // 2026-07-15 18:00 UTC = 14:00 EDT.
    expect(zonedHour(Date.UTC(2026, 6, 15, 18, 0, 0), ET)).toBe(14)
  })

  it('normalizes midnight to hour 0', () => {
    // 2026-01-15 05:00 UTC = 00:00 EST.
    expect(zonedHour(Date.UTC(2026, 0, 15, 5, 0, 0), ET)).toBe(0)
  })
})

describe('nextZonedHourMs', () => {
  it('returns today 8pm ET when the target hour is still ahead in-zone', () => {
    // 2026-01-15 18:00 UTC = 13:00 EST → next 20:00 EST is today = 2026-01-16 01:00 UTC.
    const now = Date.UTC(2026, 0, 15, 18, 0, 0)
    const next = nextZonedHourMs(now, 20, ET)
    expect(zonedHour(next, ET)).toBe(20)
    expect(next).toBe(Date.UTC(2026, 0, 16, 1, 0, 0)) // 20:00 EST = 01:00 UTC next day
    expect(next).toBeGreaterThan(now)
  })

  it('rolls to tomorrow when the target hour already passed in-zone', () => {
    // 2026-01-15 03:00 UTC = 2026-01-14 22:00 EST (past 20:00) → next is 2026-01-15 20:00 EST.
    const now = Date.UTC(2026, 0, 15, 3, 0, 0)
    const next = nextZonedHourMs(now, 20, ET)
    expect(zonedHour(next, ET)).toBe(20)
    expect(next).toBe(Date.UTC(2026, 0, 16, 1, 0, 0))
  })

  it('always lands strictly in the future and reads the target hour', () => {
    for (const h of [0, 6, 12, 18, 20, 23]) {
      const now = Date.UTC(2026, 6, 1, 9, 30, 0) // summer (EDT)
      const next = nextZonedHourMs(now, h, ET)
      expect(next).toBeGreaterThan(now)
      expect(zonedHour(next, ET)).toBe(h)
    }
  })
})
