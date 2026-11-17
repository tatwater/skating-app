import { wholeTotal } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type SplitPart, splitDay } from '@/components/kit/trace-chart';

import { bountiesTotalWords } from './eachDayWords';

/**
 * **A two-series row says one thing everywhere** (Greptile on #150, as a class): for every day and
 * every combination of not recorded, zero and a value in either series, what the strip draws agrees
 * with what its hover plate says (the plate shows each series' value, or *Not recorded yet* for
 * `null`), and each series' season total and its words agree with its days — one series' gap never
 * decides what is drawn or said for the other. Unrendered: `splitDay` is the rule the strip draws.
 */

const cell = fc.oneof(fc.constant(null), fc.constant(0), fc.integer({ min: 1, max: 40 }));
const days = fc.integer({ min: 1, max: 14 }).chain((n) =>
  fc.record({
    first: fc.array(cell, { minLength: n, maxLength: n }),
    second: fc.array(cell, { minLength: n, maxLength: n }),
  }),
);

/** What a part says of its series: its value, a zero, or not recorded. */
const answerOf = (part: SplitPart | undefined): number | null =>
  part === undefined || part.as === 'unrecorded' ? null : part.as === 'zero' ? 0 : part.value;

const valueSum = (parts: readonly SplitPart[]) =>
  parts.reduce((a, p) => a + (p.as === 'value' || p.as === 'unsplit' ? p.value : 0), 0);

describe('every combination of two series, drawn and said alike', () => {
  const property = fc.property(days, ({ first, second }) => {
    first.forEach((a, i) => {
      const b = second[i] ?? null;

      // Beside (bounties): each half is its own series' answer — exactly what the plate says.
      const beside = splitDay(a, b, 'beside').parts;
      expect(beside.map((p) => p.series)).toEqual(['first', 'second']);
      expect(answerOf(beside[0])).toBe(a);
      expect(answerOf(beside[1])).toBe(b);

      // Stacked (contributors: the whole, and new on top).
      const stack = splitDay(a, b, 'stack');
      const unrecorded = stack.parts.some((p) => p.as === 'unrecorded');
      // A whole not recorded is said as not recorded; a recorded whole never is.
      expect(unrecorded).toBe(a === null);
      // Never drawn shorter than what is known.
      expect(valueSum(stack.parts)).toBe(Math.max(a ?? 0, b ?? 0));
      // A known top part is drawn as itself whenever it is more than nothing.
      if (b !== null && b > 0) {
        expect(stack.parts.filter((p) => p.series === 'second')).toEqual([
          { series: 'second', as: 'value', value: b },
        ]);
      }
      // A recorded whole with its split not recorded is the whole, dashed — the plate's split row says
      // *Not recorded yet*, and no part of the bar claims a split.
      if (a !== null && a > 0 && b === null) {
        expect(stack.parts).toEqual([{ series: 'first', as: 'unsplit', value: a }]);
      }
    });

    // Each series' total stands or falls on its own days, and its words say the same.
    const [posted, fulfilled] = [wholeTotal(first), wholeTotal(second)];
    expect(posted === null).toBe(first.includes(null));
    expect(fulfilled === null).toBe(second.includes(null));
    const words = bountiesTotalWords(posted, fulfilled);
    expect(words.includes('Posted not recorded yet')).toBe(posted === null);
    expect(words.includes('fulfilled not recorded yet')).toBe(fulfilled === null);
    if (posted !== null)
      expect(words.startsWith(`${posted.toLocaleString('en-US')} posted`)).toBe(true);
    if (fulfilled !== null) {
      expect(words.endsWith(`${fulfilled.toLocaleString('en-US')} fulfilled`)).toBe(true);
    }
  });

  it('pinned seeds and one random', () => {
    for (const seed of [20261117, 150, 813]) fc.assert(property, { seed, numRuns: 300 });
    fc.assert(property, { numRuns: 300 });
  });

  it('the stacked table’s rows, one by one', () => {
    expect(splitDay(6, 2, 'stack').parts).toEqual([
      { series: 'first', as: 'value', value: 4 },
      { series: 'second', as: 'value', value: 2 },
    ]);
    expect(splitDay(6, null, 'stack').parts).toEqual([
      { series: 'first', as: 'unsplit', value: 6 },
    ]);
    expect(splitDay(0, null, 'stack').parts).toEqual([{ series: 'first', as: 'zero' }]);
    expect(splitDay(0, 2, 'stack')).toEqual({
      parts: [{ series: 'second', as: 'value', value: 2 }],
      height: 2,
    });
    expect(splitDay(null, 2, 'stack').parts).toEqual([
      { series: 'second', as: 'value', value: 2 },
      { series: 'first', as: 'unrecorded' },
    ]);
    expect(splitDay(null, 0, 'stack').parts).toEqual([{ series: 'first', as: 'unrecorded' }]);
    expect(splitDay(2, 5, 'stack').height).toBe(5);
  });
});
