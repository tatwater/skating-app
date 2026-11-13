import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  DEFAULT_WINTER_FRACTION,
  type SiteSeries,
  winterNeeds,
  winterOnOrAfter,
  winterRunNights,
} from './ingestGate';

const START = '2026-10-01';

/** Consecutive days from `START`, each with the given low; `null` is a night with no reading. */
function series(siteId: string, lows: Array<number | null>, sentinel?: boolean): SiteSeries {
  return {
    siteId,
    ...(sentinel ? { sentinel: true } : {}),
    days: lows.flatMap((minTempC, i) =>
      minTempC === null ? [] : [{ date: addDaysIso(START, i), minTempC }],
    ),
  };
}

describe('winterRunNights — how long the region stayed in winter', () => {
  it('counts the nights in a row the winter rule held', () => {
    const sites = [series('a', [-1, -2, -3, 4]), series('b', [-2, -1, -1, 5])];
    expect(winterRunNights(sites, START)).toBe(3);
  });

  it('reads one night when a warm one undid it — the fragile winter', () => {
    const sites = [series('a', [-1, 6, -3]), series('b', [-2, 7, -1])];
    expect(winterRunNights(sites, START)).toBe(1);
  });

  it('is zero when the first night did not meet the rule', () => {
    const sites = [series('a', [3, -1]), series('b', [4, -1])];
    expect(winterRunNights(sites, START)).toBe(0);
  });

  it('ends at a night nobody reported — a gap never reads as winter holding', () => {
    const sites = [series('a', [-1, null, -3]), series('b', [-2, null, -1])];
    expect(winterRunNights(sites, START)).toBe(1);
  });

  it('never consults a sentinel', () => {
    const sites = [series('summit', [-9, -9, -9], true), series('a', [-1, 3, -2])];
    expect(winterRunNights(sites, START)).toBe(1);
  });

  it('is zero with no ordinary site at all', () => {
    expect(winterRunNights([series('summit', [-9, -9], true)], START)).toBe(0);
    expect(winterRunNights([], START)).toBe(0);
  });

  it('reads the thresholds it is given', () => {
    const sites = [series('a', [-1, -1]), series('b', [2, -1]), series('c', [2, 3])];
    expect(winterRunNights(sites, START, { winterFraction: 0.5 })).toBe(0);
    expect(winterRunNights(sites, START, { winterFraction: 0.3 })).toBe(2);
    expect(winterRunNights(sites, START, { winterFraction: 0.3, freezeC: -2 })).toBe(0);
  });

  it('never calls a night winter under a fraction that is not a number', () => {
    const sites = [series('a', [-5, -5]), series('b', [-5, -5])];
    expect(winterRunNights(sites, START, { winterFraction: Number.NaN })).toBe(0);
    expect(winterOnOrAfter(sites, START, { winterFraction: Number.NaN })).toBeNull();
  });

  const lows = fc.array(fc.option(fc.integer({ min: -10, max: 10 }), { nil: null }), {
    maxLength: 20,
  });
  const roster = fc
    .array(fc.tuple(lows, fc.boolean()), { maxLength: 6 })
    .map((rows) => rows.map(([l, sentinel], i) => series(`s${i}`, l, sentinel)));
  const fraction = fc.double({ min: 0.05, max: 1, noNaN: true });

  it('agrees with winterOnOrAfter: a run starts exactly on a winter night', () => {
    fc.assert(
      fc.property(roster, fc.integer({ min: 0, max: 20 }), fraction, (sites, offset, f) => {
        const from = addDaysIso(START, offset);
        const nights = winterRunNights(sites, from, { winterFraction: f });
        const found = winterOnOrAfter(sites, from, { winterFraction: f });
        if (nights > 0) expect(found?.date).toBe(from);
        if (found !== null)
          expect(winterRunNights(sites, found.date, { winterFraction: f })).toBeGreaterThan(0);
      }),
    );
  });

  it('is bounded by the record and steps down by one a night', () => {
    fc.assert(
      fc.property(roster, fraction, (sites, f) => {
        const nights = winterRunNights(sites, START, { winterFraction: f });
        expect(nights).toBeGreaterThanOrEqual(0);
        expect(nights).toBeLessThanOrEqual(20);
        if (nights > 0) {
          expect(winterRunNights(sites, addDaysIso(START, 1), { winterFraction: f })).toBe(
            nights - 1,
          );
        }
      }),
    );
  });

  it('is unmoved by any sentinel', () => {
    fc.assert(
      fc.property(roster, lows, (sites, summit) => {
        const ordinary = sites.filter((s) => !s.sentinel);
        expect(winterRunNights([...ordinary, series('summit', summit, true)], START)).toBe(
          winterRunNights(ordinary, START),
        );
      }),
    );
  });
});

describe('winterNeeds — how many bodies a winter night takes', () => {
  it('is the smallest count that meets the fraction', () => {
    expect(winterNeeds(24, DEFAULT_WINTER_FRACTION)).toBe(12);
    expect(winterNeeds(23, 0.5)).toBe(12);
    // `0.3 × 10` is `3.0000000000000004` in floating point; three of ten still meets 30%.
    expect(winterNeeds(10, 0.3)).toBe(3);
    expect(winterNeeds(0, 0.5)).toBe(0);
  });

  it('matches the rule exactly: k meets it, k − 1 does not', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: 0.001, max: 1, noNaN: true }),
        (reporting, f) => {
          const k = winterNeeds(reporting, f);
          expect(k).toBeGreaterThanOrEqual(0);
          expect(k).toBeLessThanOrEqual(reporting);
          expect(k / reporting >= f).toBe(true);
          if (k > 0) expect((k - 1) / reporting >= f).toBe(false);
        },
      ),
    );
  });
});
