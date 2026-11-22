import { roundTo } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { at, BOARD_ZONE } from './flagFixtures';

import {
  clock,
  countWords,
  dayKey,
  dayLabel,
  dayTime,
  measuredMeanCm,
  milesWords,
  ordinal,
  readingCm,
  skateSpan,
  skateTimes,
  utcDayMonth,
} from './flagFormat';

// Absolute instants in the boards' zone, formatted in it: the same answers in every zone that runs.
const Z = BOARD_ZONE;

describe('milesWords', () => {
  test('one decimal, with its unit', () => {
    expect(milesWords(1290)).toBe('0.8 mi');
    expect(milesWords(1930)).toBe('1.2 mi');
  });
  test('near is never nothing', () => {
    expect(milesWords(0)).toBe('<0.1 mi');
    expect(milesWords(50)).toBe('<0.1 mi');
  });
  test('a bad number reads as near, never NaN', () => {
    expect(milesWords(Number.NaN)).toBe('<0.1 mi');
    expect(milesWords(-500)).toBe('<0.1 mi');
  });
  test('property: always "<0.1 mi" or one decimal ≥ 0.1, and monotone', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e3, max: 1e7, noNaN: true }),
        fc.double({ min: 0, max: 1e5, noNaN: true }),
        (m, more) => {
          const w = milesWords(m);
          expect(w).toMatch(/^(<0\.1|\d+\.\d) mi$/);
          const n = (s: string) => (s.startsWith('<') ? 0 : Number.parseFloat(s));
          expect(n(milesWords(m + more))).toBeGreaterThanOrEqual(n(w));
        },
      ),
    );
  });
});

describe('ordinal', () => {
  test.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [111, '111th'],
    [0, '0th'],
  ])('%i → %s', (n, w) => expect(ordinal(n)).toBe(w));
  test('property: the number, then one of the four suffixes, the teens always "th"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (n) => {
        const w = ordinal(n);
        expect(w).toMatch(new RegExp(`^${n}(st|nd|rd|th)$`));
        if (n % 100 >= 11 && n % 100 <= 13) expect(w.endsWith('th')).toBe(true);
      }),
    );
  });
});

describe('countWords', () => {
  test('a floor reads with a plus', () => {
    expect(countWords({ count: 400, capped: true })).toBe('400+');
    expect(countWords({ count: 1204, capped: false })).toBe('1,204');
  });
  test('property: the digits of the count, a plus exactly when capped', () => {
    fc.assert(
      fc.property(fc.nat(), fc.boolean(), (count, capped) => {
        const w = countWords({ count, capped });
        expect(w.replace(/[,+]/g, '')).toBe(String(count));
        expect(w.endsWith('+')).toBe(capped);
      }),
    );
  });
});

describe('times', () => {
  test('a skate span: its day, then start–end', () => {
    expect(skateSpan(at(10, 10, 15, 40), at(10, 10, 17, 5), Z)).toBe('10 Oct 15:40–17:05');
    expect(skateTimes(null, at(10, 11, 8, 40), Z)).toBe('08:40');
    // A start at or after the end is no span.
    expect(skateTimes(at(10, 11, 9), at(10, 11, 8, 40), Z)).toBe('08:40');
  });
  test('labels', () => {
    expect(clock(at(10, 10, 18, 2), Z)).toBe('18:02');
    expect(dayTime(at(10, 10, 18, 2), Z)).toBe('10 Oct 18:02');
    expect(dayLabel(at(10, 11, 12), Z)).toBe('Sun 11 Oct');
    expect(dayKey(at(10, 11, 12), Z)).toBe('2026-10-11');
    expect(utcDayMonth(Date.UTC(2026, 9, 9))).toBe('9 Oct');
  });
});

describe('readings', () => {
  test('a value, a range middle, a floor', () => {
    expect(readingCm({ valueCm: 5, method: 'measured' })).toBe(5);
    expect(readingCm({ minCm: 4, maxCm: 6, method: 'measured' })).toBe(5);
    expect(readingCm({ minCm: 4, method: 'measured' })).toBe(4);
    expect(readingCm({ method: 'poke' })).toBeNull();
  });
  test('only measured readings make a measured mean', () => {
    expect(measuredMeanCm(null)).toBeNull();
    expect(measuredMeanCm({ readings: [{ valueCm: 9, method: 'estimated' }] })).toBeNull();
    expect(
      measuredMeanCm({
        readings: [
          { valueCm: 4, method: 'measured' },
          { valueCm: 6, method: 'measured' },
          { valueCm: 100, method: 'estimated' },
        ],
      }),
    ).toBe(5);
  });
});

describe('core’s roundTo, which these formatters round with', () => {
  test('finite in, finite out — exponent-form numbers included', () => {
    expect(roundTo(1e-7, 1)).toBe(0);
    expect(roundTo(2.5e21, 1)).toBe(2.5e21);
    expect(Math.abs(roundTo(-0.04, 1))).toBe(0);
    expect(roundTo(-1.26, 1)).toBe(-1.3);
  });
  test('property: always finite, within half a step of the input', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e9, max: 1e9, noNaN: true }),
        fc.integer({ min: 0, max: 3 }),
        (x, p) => {
          const r = roundTo(x, p);
          expect(Number.isFinite(r)).toBe(true);
          expect(Math.abs(r - x)).toBeLessThanOrEqual(
            0.5 / 10 ** p + 1e-6 * Math.max(1, Math.abs(x)),
          );
        },
      ),
    );
  });
});
