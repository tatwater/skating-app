import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeDeciles,
  DECILE_COUNT,
  decileRankOf,
  isBottomDecile,
  isTopDecile,
  MIN_DECILE_SAMPLE,
} from './regionStats';

/** 1…n, the sample whose percentiles are arithmetic and checkable by hand. */
function ramp(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

describe('computeDeciles', () => {
  it('returns nine ascending cut points', () => {
    const block = computeDeciles(ramp(100));
    expect(block?.deciles).toHaveLength(DECILE_COUNT);
    expect(block?.count).toBe(100);
    const d = block?.deciles ?? [];
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThan(d[i - 1] as number);
  });

  it('puts the cut points where a stats package would (type 7 quantiles)', () => {
    // On 1…101 the k-th of nine cut points is exactly 1 + 100k/10.
    const d = computeDeciles(ramp(101))?.deciles ?? [];
    expect(d[0]).toBeCloseTo(11, 6);
    expect(d[4]).toBeCloseTo(51, 6);
    expect(d[8]).toBeCloseTo(91, 6);
  });

  it('refuses a sample too thin to describe a distribution', () => {
    // Deciles over eight lakes are noise wearing a distribution's clothes. Same denominator
    // discipline as D78's recurrence bar and D86's quorum floor.
    expect(computeDeciles(ramp(MIN_DECILE_SAMPLE - 1))).toBeNull();
    expect(computeDeciles([])).toBeNull();
    expect(computeDeciles(ramp(MIN_DECILE_SAMPLE))).not.toBeNull();
  });

  it('drops non-finite values rather than sorting them into place', () => {
    // A NaN sorted into the array silently corrupts every cut point above it.
    const block = computeDeciles([...ramp(100), Number.NaN, Number.POSITIVE_INFINITY]);
    expect(block?.count).toBe(100);
    expect(block?.deciles.every(Number.isFinite)).toBe(true);
  });

  it('does not mutate its input', () => {
    const values = [5, 1, 4, ...ramp(40)];
    const copy = [...values];
    computeDeciles(values);
    expect(values).toEqual(copy);
  });

  it('handles a degenerate all-identical sample without producing NaN', () => {
    const block = computeDeciles(Array.from({ length: 50 }, () => 7));
    expect(block?.deciles).toEqual(Array.from({ length: DECILE_COUNT }, () => 7));
  });

  it('always yields ascending finite cut points for any finite sample', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
          minLength: MIN_DECILE_SAMPLE,
          maxLength: 400,
        }),
        (values) => {
          const d = computeDeciles(values)?.deciles ?? [];
          expect(d).toHaveLength(DECILE_COUNT);
          for (let i = 1; i < d.length; i++) {
            expect(d[i]).toBeGreaterThanOrEqual(d[i - 1] as number);
            expect(Number.isFinite(d[i])).toBe(true);
          }
        },
      ),
    );
  });
});

describe('decileRankOf', () => {
  const block = computeDeciles(ramp(100));

  it('ranks 0 at the bottom and 9 at the top', () => {
    expect(decileRankOf(1, block)).toBe(0);
    expect(decileRankOf(1000, block)).toBe(DECILE_COUNT);
  });

  it('is monotonic in the value', () => {
    let previous = -1;
    for (const v of [1, 15, 25, 35, 45, 55, 65, 75, 85, 95]) {
      const rank = decileRankOf(v, block) ?? -1;
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it('returns null with no usable basis — which callers must read as "say nothing"', () => {
    // NOT as "average". A comparison we cannot support is a clause the caption omits.
    expect(decileRankOf(50, null)).toBeNull();
    expect(decileRankOf(50, undefined)).toBeNull();
    expect(decileRankOf(50, { deciles: [1, 2, 3], count: 999 })).toBeNull();
    expect(decileRankOf(50, { deciles: ramp(9), count: MIN_DECILE_SAMPLE - 1 })).toBeNull();
    expect(decileRankOf(Number.NaN, block)).toBeNull();
  });
});

describe('isTopDecile / isBottomDecile', () => {
  const block = computeDeciles(ramp(100));

  it('fires for roughly one lake in ten, not one in three', () => {
    // The comparative clauses are the ones most likely to read as a recommendation, so the bar is
    // deliberately high; at the 70th percentile a superlative would land on a third of the corpus.
    const hits = ramp(100).filter((v) => isTopDecile(v, block)).length;
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(16);
  });

  it('is false rather than throwing when there is no basis', () => {
    expect(isTopDecile(999, null)).toBe(false);
    expect(isBottomDecile(-999, null)).toBe(false);
  });

  it('agrees with the rank it is derived from', () => {
    expect(isTopDecile(1000, block)).toBe(true);
    expect(isBottomDecile(1, block)).toBe(true);
    expect(isTopDecile(50, block)).toBe(false);
    expect(isBottomDecile(50, block)).toBe(false);
  });
});
