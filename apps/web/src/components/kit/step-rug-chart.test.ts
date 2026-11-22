import { zonedParts } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { firstZero, gridOf, hourTicks, type StepEvent, scaleTop, stepsOf } from './step-rug-chart';

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

/**
 * A zoned hour floor for the property — the test's stand-in for the caller's (Inbox zero passes its
 * own `floorLocalHour`): the local minutes and seconds taken off.
 */
const floorIn = (zone: string) => (at: number) => {
  const p = zonedParts(at, zone);
  return at - (p.minute * 60 + p.second) * 1000 - (((at % 1000) + 1000) % 1000);
};

describe('hourTicks', () => {
  it('is the whole UTC hours of the span when no clock is named (the default, unchanged)', () => {
    const from = Date.UTC(2026, 9, 14, 7, 20);
    const to = Date.UTC(2026, 9, 14, 10, 0);
    expect(hourTicks(from, to)).toEqual([8, 9, 10].map((h) => Date.UTC(2026, 9, 14, h)));
  });

  it('falls on whole local hours in a half-hour zone, where UTC hours are :30', () => {
    const kolkata = floorIn('Asia/Kolkata');
    // 08:10 to 11:40 in Kolkata (UTC+5:30).
    const from = Date.UTC(2026, 9, 14, 2, 40);
    const to = Date.UTC(2026, 9, 14, 6, 10);
    const ticks = hourTicks(from, to, kolkata);
    expect(ticks.map((t) => zonedParts(t, 'Asia/Kolkata').hour)).toEqual([9, 10, 11]);
    expect(ticks.every((t) => zonedParts(t, 'Asia/Kolkata').minute === 0)).toBe(true);
  });

  // Whole-hour, half-hour and 45-minute zones; St John's and New York change clocks (Nov 1 2026),
  // Lord Howe by half an hour (Apr 5 2026); Kolkata and Kathmandu don't.
  const ZONES = [
    'America/New_York',
    'America/St_Johns',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'Australia/Lord_Howe',
  ] as const;
  const DST_DAYS = [Date.UTC(2026, 10, 1), Date.UTC(2026, 3, 4), Date.UTC(2026, 2, 8)];

  it('the ticks are exactly the whole local hours of the span — across a DST change', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.constantFrom(...DST_DAYS),
        fc.integer({ min: 0, max: 48 * 60 }),
        fc.integer({ min: 1, max: 30 * 60 }),
        (zone, day, startMin, spanMin) => {
          const from = day + startMin * 60_000;
          const to = from + spanMin * 60_000;
          const ticks = hourTicks(from, to, floorIn(zone));
          // Every whole local hour in the span, found the slow way: each zone's offset is a multiple
          // of 15 minutes, so a local :00 is a UTC quarter-hour; try each one in the span.
          const expected: number[] = [];
          for (let q = Math.ceil(from / 900_000) * 900_000; q <= to; q += 900_000) {
            const p = zonedParts(q, zone);
            if (p.minute === 0 && p.second === 0) expected.push(q);
          }
          expect(ticks).toEqual(expected);
        },
      ),
      { numRuns: 400 },
    );
  });
});
