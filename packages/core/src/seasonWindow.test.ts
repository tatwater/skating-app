import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dayOfSeason, seasonStartMs } from './season';
import {
  DAYS_IN_SEASON,
  halfMonthOf,
  MIN_WINDOW_HALF_MONTHS,
  percentileDay,
  timingWindowLabel,
} from './seasonWindow';

/** Day-of-season for a calendar date inside the `'26/'27` season, via the real season clock. */
function day(month: number, dayOfMonth: number): number {
  const year = month >= 7 ? 2026 : 2027;
  return dayOfSeason(Date.UTC(year, month - 1, dayOfMonth, 12), 2026);
}

describe('dayOfSeason', () => {
  it('starts at zero on July 1', () => {
    expect(dayOfSeason(seasonStartMs(2026), 2026)).toBe(0);
  });

  it('reads late December and early January as adjacent', () => {
    // The whole reason the unit is day-of-*season*: day-of-year puts these 355 days apart, and no
    // percentile can read that as one window.
    expect(day(1, 5) - day(12, 27)).toBeLessThan(20);
    expect(day(1, 5)).toBeGreaterThan(day(12, 27));
  });
});

describe('percentileDay', () => {
  it('is 0 for an empty set rather than NaN', () => {
    expect(percentileDay([], 0.25)).toBe(0);
  });

  it('ignores an outlier at the quartiles, which is why it is not a min–max', () => {
    // One anomalous November sighting must not stretch the window across the whole winter.
    const january = [190, 191, 192, 193, 194, 195, 196];
    const withOutlier = [120, ...january];
    expect(percentileDay(withOutlier, 0.25)).toBeGreaterThan(150);
  });

  it('is order-independent', () => {
    const days = [200, 150, 190, 175];
    expect(percentileDay(days, 0.75)).toBe(percentileDay([...days].reverse(), 0.75));
  });
});

describe('halfMonthOf', () => {
  it('covers the whole season in 24 buckets', () => {
    expect(halfMonthOf(0)).toBe(0);
    expect(halfMonthOf(DAYS_IN_SEASON - 1)).toBe(23);
  });

  it('clamps rather than indexing off the end', () => {
    expect(halfMonthOf(-50)).toBe(0);
    expect(halfMonthOf(DAYS_IN_SEASON + 500)).toBe(23);
  });

  it('is non-decreasing across the season (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: DAYS_IN_SEASON - 2 }), (d) => {
        expect(halfMonthOf(d + 1)).toBeGreaterThanOrEqual(halfMonthOf(d));
      }),
    );
  });
});

describe('timingWindowLabel', () => {
  it('renders the sentence the founder ask named', () => {
    // Late December through late February: February is covered end to end, December is not.
    expect(timingWindowLabel(day(12, 27), day(2, 20))).toBe('late December to February');
  });

  it('never quotes a date', () => {
    // A window quoted to the day implies the rest of the season is clear, which nothing supports —
    // the members are sightings by people who happened to be on the ice, not a survey.
    const label = timingWindowLabel(day(1, 8), day(2, 3)) ?? '';
    expect(label).not.toMatch(/\d/);
  });

  it('widens a tight cluster rather than describing one week', () => {
    // Three sightings in the same week: "the second week of January" would describe when somebody
    // skated, not when the ridge is there.
    const label = timingWindowLabel(day(1, 8), day(1, 11)) ?? '';
    expect(label).toBe('January');
  });

  it('collapses a fully covered month to its bare name', () => {
    expect(timingWindowLabel(day(1, 2), day(1, 30))).toBe('January');
    // Early January to early February: February is only half covered, so it keeps its qualifier.
    expect(timingWindowLabel(day(1, 2), day(2, 5))).toBe('January to early February');
  });

  it('is symmetric in its arguments', () => {
    expect(timingWindowLabel(day(2, 20), day(12, 27))).toBe(
      timingWindowLabel(day(12, 27), day(2, 20)),
    );
  });

  it('returns null for a value it cannot describe', () => {
    expect(timingWindowLabel(Number.NaN, 100)).toBeNull();
  });

  it('always spans at least the minimum, and never says nothing (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DAYS_IN_SEASON - 1 }),
        fc.integer({ min: 0, max: DAYS_IN_SEASON - 1 }),
        (a, b) => {
          const label = timingWindowLabel(a, b);
          expect(label).not.toBeNull();
          expect((label as string).length).toBeGreaterThan(0);
          // A single half-month is about fifteen days, under the three-week floor §C6 draws.
          const span = Math.abs(halfMonthOf(b) - halfMonthOf(a)) + 1;
          if (span < MIN_WINDOW_HALF_MONTHS) {
            // Widened: the label names a whole month or a two-half-month range, never one half alone.
            expect(label).not.toMatch(/^(early|late) \w+$/);
          }
        },
      ),
    );
  });
});
