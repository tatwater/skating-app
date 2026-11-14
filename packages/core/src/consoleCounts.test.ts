import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cappedCount, medianAge, medianOpenedAt, sumRecorded } from './consoleCounts';

describe('cappedCount', () => {
  it('says when the read stopped short', () => {
    expect(cappedCount(3)).toEqual({ count: 3, capped: false });
    expect(cappedCount(200)).toEqual({ count: 200, capped: false });
    expect(cappedCount(201)).toEqual({ count: 200, capped: true });
  });
});

describe('medianAge — the Inbox foot', () => {
  it('is the lower median of the ages', () => {
    expect(medianAge([], 10)).toBeNull();
    expect(medianAge([4], 10)).toBe(6);
    // Ages 9, 6, 2, 1: the middle two are 2 and 6; the lower median is the younger, 2.
    expect(medianAge([1, 4, 8, 9], 10)).toBe(2);
    expect(medianAge([1, 4, 8], 10)).toBe(6);
  });

  it('never reads negative, and sits between the youngest and the oldest', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1e9 }), { minLength: 1 }),
        fc.integer({ min: 0, max: 1e9 }),
        (at, now) => {
          const m = medianAge(at, now) as number;
          const ages = at.map((a) => Math.max(0, now - a));
          expect(m).toBeGreaterThanOrEqual(Math.min(...ages));
          expect(m).toBeLessThanOrEqual(Math.max(...ages));
          // At least half the ages are at or above it.
          expect(ages.filter((a) => a >= m).length * 2).toBeGreaterThanOrEqual(ages.length);
        },
      ),
    );
  });
});

describe("medianOpenedAt — the foot ages on the reader's clock", () => {
  it('is the opened-at of the lower-median age', () => {
    expect(medianOpenedAt([])).toBeNull();
    expect(medianOpenedAt([1, 4, 8, 9])).toBe(8);
    expect(medianOpenedAt([1, 4, 8])).toBe(4);
  });

  it('gives the same age as the median of the ages, at any later clock — so the age advances', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1e9 }), { minLength: 1 }),
        fc.integer({ min: 0, max: 1e9 }),
        (at, later) => {
          const now = Math.max(...at) + later;
          const ages = at.map((a) => now - a).sort((a, b) => a - b);
          expect(now - (medianOpenedAt(at) as number)).toBe(
            ages[Math.floor((ages.length - 1) / 2)],
          );
          expect(medianAge(at, now + 1)).toBe((medianAge(at, now) as number) + 1);
        },
      ),
    );
  });
});

describe('sumRecorded — a season of day histograms', () => {
  it('adds the recorded days, bucket by bucket', () => {
    expect(sumRecorded([[1, 0, 2], null, [0, 3, 1]])).toEqual([1, 3, 3]);
    expect(sumRecorded([[1], [0, 2]])).toEqual([1, 2]);
  });

  it('is null when no day was recorded — never a row of zeros', () => {
    expect(sumRecorded([])).toBeNull();
    expect(sumRecorded([null, undefined])).toBeNull();
    expect(sumRecorded([[0, 0]])).toEqual([0, 0]);
  });

  it('keeps the total, and ignores the order of the days', () => {
    const day = fc.option(fc.array(fc.nat(50), { maxLength: 8 }), { nil: null });
    fc.assert(
      fc.property(fc.array(day, { maxLength: 20 }), (days) => {
        const sum = sumRecorded(days);
        const recorded = days.filter((d): d is number[] => d !== null);
        if (recorded.length === 0) {
          expect(sum).toBeNull();
          return;
        }
        const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        expect(total(sum as number[])).toBe(total(recorded.flat()));
        expect(sumRecorded([...days].reverse())).toEqual(sum);
      }),
    );
  });
});
