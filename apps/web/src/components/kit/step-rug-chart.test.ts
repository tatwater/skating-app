import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { firstZero, gridOf, type StepEvent, scaleTop, stepsOf } from './step-rug-chart';

const ev = (at: number, delta: 1 | -1): StepEvent => ({ at, delta });

describe('the step chart’s model', () => {
  it('steps from the start through each event, in time order', () => {
    expect(stepsOf(2, [ev(3, -1), ev(1, 1), ev(2, -1)])).toEqual([
      { at: 1, value: 3 },
      { at: 2, value: 2 },
      { at: 3, value: 1 },
    ]);
  });

  it('never goes below zero', () => {
    expect(stepsOf(0, [ev(1, -1), ev(2, 1)]).map((s) => s.value)).toEqual([0, 1]);
  });

  it('marks the first time the count reaches zero after being above it', () => {
    expect(firstZero(1, [ev(1, -1), ev(2, 1), ev(3, -1)])).toBe(1);
    expect(firstZero(0, [ev(1, 1), ev(2, -1)])).toBe(2);
    expect(firstZero(0, [])).toBeNull();
    expect(firstZero(2, [ev(1, -1)])).toBeNull();
  });

  it('draws a gridline every five, wider for a tall scale', () => {
    expect(gridOf(25)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(gridOf(5)).toEqual([0, 5]);
    expect(gridOf(60)).toEqual([0, 15, 30, 45, 60]);
  });

  it('rounds the scale up to fives, at least five', () => {
    expect(scaleTop(0, [])).toBe(5);
    expect(scaleTop(20, [ev(1, 1)])).toBe(25);
    expect(scaleTop(20, [ev(1, -1)])).toBe(20);
  });

  it('ends at start plus rises minus falls, held to zero, and the scale holds every step (fast-check)', () => {
    const events = fc.array(
      fc.record({ at: fc.nat(1000), delta: fc.constantFrom<1 | -1>(1, -1) }),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(fc.nat(30), events, (start, evs) => {
        const steps = stepsOf(start, evs);
        const top = scaleTop(start, evs);
        for (const s of steps) {
          expect(s.value).toBeGreaterThanOrEqual(0);
          expect(s.value).toBeLessThanOrEqual(top);
        }
        // With no fall past zero, the last step is the plain sum.
        const sum = start + evs.reduce((n, e) => n + e.delta, 0);
        const sorted = [...evs].sort((a, b) => a.at - b.at);
        let run = start;
        const neverBelow = sorted.every((e) => {
          run += e.delta;
          return run >= 0;
        });
        if (neverBelow && steps.length > 0) expect(steps.at(-1)?.value).toBe(sum);
        const z = firstZero(start, evs);
        if (z !== null) expect(steps.some((s) => s.at === z && s.value === 0)).toBe(true);
      }),
    );
  });
});
