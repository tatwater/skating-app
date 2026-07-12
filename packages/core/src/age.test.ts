import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ADULT_AGE, ageInYears, isMinor, MINIMUM_SIGNUP_AGE, meetsMinimumAge } from './age'

const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d)
const DAY = 86_400_000

describe('ageInYears', () => {
  it('counts whole years, accounting for whether the birthday has passed', () => {
    const dob = utc(2000, 0, 1) // Jan 1, 2000
    expect(ageInYears(dob, utc(2020, 0, 1))).toBe(20) // exactly on the 20th birthday
    expect(ageInYears(dob, utc(2019, 11, 31))).toBe(19) // day before
    expect(ageInYears(dob, utc(2020, 5, 15))).toBe(20) // later that year
  })

  it('handles a Feb 29 birthday across the leap boundary', () => {
    const dob = utc(2000, 1, 29) // Feb 29, 2000
    expect(ageInYears(dob, utc(2018, 1, 28))).toBe(17) // Feb 28 — birthday not yet reached
    expect(ageInYears(dob, utc(2018, 2, 1))).toBe(18) // Mar 1 — reached
  })
})

describe('isMinor / meetsMinimumAge', () => {
  const dob = utc(2000, 5, 15) // June 15, 2000

  it('treats the 18th birthday itself as adult (D41)', () => {
    expect(isMinor(dob, utc(2018, 5, 14))).toBe(true) // day before 18th
    expect(isMinor(dob, utc(2018, 5, 15))).toBe(false) // 18th birthday
  })

  it('enforces the hard 16+ minimum at the boundary', () => {
    expect(meetsMinimumAge(dob, utc(2016, 5, 14))).toBe(false) // day before 16th (UTC)
    expect(meetsMinimumAge(dob, utc(2016, 5, 15))).toBe(true) // 16th birthday (UTC)
  })

  it('does not reject a signup already 16 on their local calendar ahead of UTC (finding 4)', () => {
    // A few hours before UTC-midnight of the 16th birthday it is still "yesterday" in
    // UTC, but already the birthday in a timezone ahead of UTC — must not be rejected.
    const hoursBeforeUtcMidnight = utc(2016, 5, 15) - 3 * 60 * 60 * 1000
    expect(meetsMinimumAge(dob, hoursBeforeUtcMidnight)).toBe(true)
    // But a full day earlier is genuinely too young in every timezone.
    expect(meetsMinimumAge(dob, utc(2016, 5, 13))).toBe(false)
  })

  it('keeps the constants in the expected relationship', () => {
    expect(MINIMUM_SIGNUP_AGE).toBe(16)
    expect(ADULT_AGE).toBe(18)
  })
})

describe('ageInYears (property)', () => {
  it('equals k exactly on the k-th birthday, and k−1 the day before', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1940, max: 2005 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 28 }), // ≤28 avoids month-length / leap-day edges
        fc.integer({ min: 1, max: 80 }),
        (year, month, day, k) => {
          const dob = utc(year, month, day)
          const kthBirthday = utc(year + k, month, day)
          expect(ageInYears(dob, kthBirthday)).toBe(k)
          expect(ageInYears(dob, kthBirthday - DAY)).toBe(k - 1)
        },
      ),
    )
  })

  it('is non-decreasing as now advances', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: utc(1940, 0, 1), max: utc(2005, 0, 1) }),
        fc.integer({ min: utc(2006, 0, 1), max: utc(2030, 0, 1) }),
        fc.integer({ min: 0, max: 20 * 365 * DAY }),
        (dob, now, delta) => {
          expect(ageInYears(dob, now + delta)).toBeGreaterThanOrEqual(ageInYears(dob, now))
        },
      ),
    )
  })
})
