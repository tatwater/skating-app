import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ADULT_AGE, ageInYears, isMinor, MINIMUM_SIGNUP_AGE, meetsMinimumAge } from './age';

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m, d, h, min);
const DAY = 86_400_000;

describe('ageInYears', () => {
  it('counts whole years, accounting for whether the birthday has passed', () => {
    const dob = utc(2000, 0, 1); // Jan 1, 2000
    expect(ageInYears(dob, utc(2020, 0, 1))).toBe(20); // exactly on the 20th birthday
    expect(ageInYears(dob, utc(2019, 11, 31))).toBe(19); // day before
    expect(ageInYears(dob, utc(2020, 5, 15))).toBe(20); // later that year
  });

  it('handles a Feb 29 birthday across the leap boundary', () => {
    const dob = utc(2000, 1, 29); // Feb 29, 2000
    expect(ageInYears(dob, utc(2018, 1, 28))).toBe(17); // Feb 28 — birthday not yet reached
    expect(ageInYears(dob, utc(2018, 2, 1))).toBe(18); // Mar 1 — reached
  });
});

describe('isMinor / meetsMinimumAge', () => {
  const dob = utc(2000, 5, 15); // June 15, 2000

  it('treats the 18th birthday itself as adult (D41)', () => {
    expect(isMinor(dob, utc(2018, 5, 14))).toBe(true); // day before 18th
    expect(isMinor(dob, utc(2018, 5, 15))).toBe(false); // 18th birthday
  });

  it('enforces the hard 18+ minimum at the boundary (D294)', () => {
    expect(meetsMinimumAge(dob, utc(2018, 5, 14))).toBe(false); // day before the 18th (UTC)
    expect(meetsMinimumAge(dob, utc(2018, 5, 16))).toBe(true); // day after the 18th (UTC)
    expect(meetsMinimumAge(utc(2000, 5, 16), utc(2018, 5, 15, 13))).toBe(false); // 17 everywhere
  });

  it('admits nobody who is still 17 on any calendar: the gate waits for UTC−12 (D294)', () => {
    // At UTC midnight of the 18th birthday it is still the day before across the Americas.
    expect(meetsMinimumAge(dob, utc(2018, 5, 15))).toBe(false);
    expect(meetsMinimumAge(dob, utc(2018, 5, 15, 11, 59))).toBe(false);
    // Noon UTC is midnight at UTC−12, the last calendar to reach the birthday.
    expect(meetsMinimumAge(dob, utc(2018, 5, 15, 12))).toBe(true);
  });

  it('keeps the constants in the expected relationship: no admitted age is a minor', () => {
    expect(MINIMUM_SIGNUP_AGE).toBe(18);
    expect(ADULT_AGE).toBe(18);
    expect(MINIMUM_SIGNUP_AGE).toBeGreaterThanOrEqual(ADULT_AGE);
  });
});

describe('meetsMinimumAge (property)', () => {
  it('never admits a minor: whoever passes the gate is an adult at that instant (D294)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: utc(1940, 0, 1), max: utc(2030, 0, 1) }),
        fc.integer({ min: utc(1990, 0, 1), max: utc(2040, 0, 1) }),
        (birth, now) => {
          const dob = birth - (birth % DAY); // a date of birth is stored as UTC midnight
          if (meetsMinimumAge(dob, now)) expect(isMinor(dob, now)).toBe(false);
        },
      ),
    );
  });

  it('refuses the whole day before the birthday in every timezone, UTC−12 to UTC+14', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1940, max: 2010 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: -12 * 60, max: 14 * 60 }), // the device's offset from UTC, in minutes
        fc.integer({ min: 0, max: 24 * 60 - 1 }), // a local minute of the day before
        (year, month, day, offsetMin, minuteOfDay) => {
          const dob = utc(year, month, day);
          // Local wall-clock `minuteOfDay` on the eve of the 18th birthday, as a UTC instant.
          const now = utc(year + 18, month, day - 1) + (minuteOfDay - offsetMin) * 60_000;
          expect(meetsMinimumAge(dob, now)).toBe(false);
        },
      ),
    );
  });
});

describe('ageInYears (property)', () => {
  it('equals k exactly on the k-th birthday, and k−1 the day before', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1940, max: 2005 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 28 }), // ≤28 avoids month-length / leap-day edges
        fc.integer({ min: 1, max: 80 }),
        (year, month, day, k) => {
          const dob = utc(year, month, day);
          const kthBirthday = utc(year + k, month, day);
          expect(ageInYears(dob, kthBirthday)).toBe(k);
          expect(ageInYears(dob, kthBirthday - DAY)).toBe(k - 1);
        },
      ),
    );
  });

  it('is non-decreasing as now advances', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: utc(1940, 0, 1), max: utc(2005, 0, 1) }),
        fc.integer({ min: utc(2006, 0, 1), max: utc(2030, 0, 1) }),
        fc.integer({ min: 0, max: 20 * 365 * DAY }),
        (dob, now, delta) => {
          expect(ageInYears(dob, now + delta)).toBeGreaterThanOrEqual(ageInYears(dob, now));
        },
      ),
    );
  });
});
