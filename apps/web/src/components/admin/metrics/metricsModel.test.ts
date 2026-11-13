import { bucketIndex, HOUR_BUCKETS, histogram } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ageParts,
  axisTicks,
  countTicks,
  dayLabel,
  dayTitle,
  foldResolveBuckets,
  hourTicks,
  instantLabel,
  medianPhrase,
  metricsNotRecorded,
  OLDEST_FLAG_BAD_HOURS,
  oldestFlagTone,
  PULSE_KEYS,
  perThousand,
  pulseSub,
  pulseTicks,
  seasonWindowDays,
  shortAge,
  stateInk,
  sumBuckets,
  vantageSegments,
} from './metricsModel';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNIT_MS = { d: DAY, h: HOUR, min: MINUTE } as const;
/** The phrase for each `HOUR_BUCKETS` bucket, written out independently of the model's own table. */
const MEDIAN_WORDS = [
  'under 6 h',
  '6–12 h',
  '12–24 h',
  '1–2 d',
  '2–3 d',
  '3–7 d',
  '7–14 d',
  'over 14 d',
];

const spanOf = (parts: ReturnType<typeof ageParts>) =>
  parts.reduce((sum, p) => sum + p.n * UNIT_MS[p.unit], 0);

describe('days', () => {
  it('labels a UTC metric day as the boards write a date', () => {
    expect(dayLabel('2026-10-07')).toBe('7 Oct');
    expect(dayTitle('2026-10-07')).toBe('Wed 7 Oct');
    expect(dayTitle('2027-01-16')).toBe('Sat 16 Jan');
  });

  it('reads an instant in the zone it is given', () => {
    // 03:00 UTC on 14 Jan is still the evening of 13 Jan in New Hampshire.
    const at = Date.UTC(2027, 0, 14, 3, 0);
    expect(instantLabel(at, 'America/New_York')).toBe('13 Jan');
    expect(instantLabel(at, 'UTC')).toBe('14 Jan');
  });

  it("labels the board's fourteen days at 1, 4, 7, 10 and today", () => {
    expect(axisTicks(14)).toEqual([0, 3, 6, 9, 13]);
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(1)).toEqual([0]);
    expect(axisTicks(2)).toEqual([0, 1]);
  });

  it('starts at the first day, ends on today, and never crowds today', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 400 }), (count) => {
        const ticks = axisTicks(count);
        expect(ticks[0]).toBe(0);
        expect(ticks.at(-1)).toBe(count - 1);
        expect(ticks.length).toBeLessThanOrEqual(7);
        for (let i = 1; i < ticks.length; i++) {
          expect(ticks[i] as number).toBeGreaterThan(ticks[i - 1] as number);
        }
        const step = (ticks[1] as number) - (ticks[0] as number);
        if (ticks.length > 2) {
          const gap = (ticks.at(-1) as number) - (ticks.at(-2) as number);
          expect(gap).toBeGreaterThanOrEqual(Math.ceil(step / 2));
        }
      }),
    );
  });

  it('marks the pulse at the first, middle and last days, once each', () => {
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
    expect(pulseTicks(days)).toEqual(['2026-10-01', '2026-10-02', '2026-10-04']);
    expect(pulseTicks(['2026-10-01'])).toEqual(['2026-10-01']);
    expect(pulseTicks([])).toEqual([]);
  });
});

describe('ages', () => {
  it('writes days and hours, hours, or minutes', () => {
    expect(ageParts(3 * DAY + 22 * HOUR + 59 * MINUTE)).toEqual([
      { n: 3, unit: 'd' },
      { n: 22, unit: 'h' },
    ]);
    expect(ageParts(2 * DAY)).toEqual([{ n: 2, unit: 'd' }]);
    expect(ageParts(5 * HOUR + 59 * MINUTE)).toEqual([{ n: 5, unit: 'h' }]);
    expect(ageParts(40 * MINUTE)).toEqual([{ n: 40, unit: 'min' }]);
    expect(shortAge(2 * DAY + 3 * HOUR)).toBe('2 d');
    expect(shortAge(-5 * MINUTE)).toBe('0 min');
  });

  it('never reads older than it is, nor more than one unit younger', () => {
    fc.assert(
      fc.property(fc.integer({ min: -DAY, max: 400 * DAY }), (ms) => {
        const parts = ageParts(ms);
        const span = spanOf(parts);
        const real = Math.max(0, ms);
        expect(span).toBeLessThanOrEqual(real);
        const smallest = UNIT_MS[(parts.at(-1) as (typeof parts)[number]).unit];
        expect(real - span).toBeLessThan(smallest);
        for (const p of parts) expect(p.n).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('only ages forward: an older flag never reads younger', () => {
    fc.assert(
      fc.property(fc.nat(400 * DAY), fc.nat(400 * DAY), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(spanOf(ageParts(lo))).toBeLessThanOrEqual(spanOf(ageParts(hi)));
      }),
    );
  });

  it('turns the oldest flag red at three days, not before', () => {
    expect(oldestFlagTone(OLDEST_FLAG_BAD_HOURS * HOUR - 1)).toBe('default');
    expect(oldestFlagTone(OLDEST_FLAG_BAD_HOURS * HOUR)).toBe('bad');
  });
});

describe('time to resolve', () => {
  it("folds the rollup's eight buckets into the board's six", () => {
    expect(foldResolveBuckets([5, 2, 0, 1, 1, 3, 2, 1])).toEqual([5, 2, 0, 1, 1, 6]);
    expect(foldResolveBuckets([])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('keeps every resolution, and each in its own bucket below three days', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 2000, noNaN: true })), (hours) => {
        const eight = histogram(hours, HOUR_BUCKETS);
        const six = foldResolveBuckets(eight);
        expect(six.reduce((a, b) => a + b, 0)).toBe(hours.length);
        expect(six[5]).toBe(hours.filter((h) => h >= 72).length);
        expect(six[0]).toBe(hours.filter((h) => h < 6).length);
      }),
    );
  });

  it('sums day histograms and skips the days nobody measured', () => {
    expect(sumBuckets([[1, 2], null, [0, 1, 4]])).toEqual([1, 3, 4, 0, 0, 0, 0, 0]);
  });

  it('says where the median fell, and nothing when nothing was resolved', () => {
    expect(medianPhrase([4, 1, 0, 1, 0, 0, 0, 0])).toBe('Median under 6 h');
    expect(medianPhrase([1, 1, 0, 0, 0, 0, 0, 0])).toBe('Median under 6 h');
    expect(medianPhrase([0, 0, 0, 2, 1, 0, 0, 0])).toBe('Median 1–2 d');
    expect(medianPhrase([0, 0, 0, 0, 0, 0, 0, 3])).toBe('Median over 14 d');
    expect(medianPhrase([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('names the bucket of the sorted middle resolution', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 1 }),
        (hours) => {
          const sorted = [...hours].sort((a, b) => a - b);
          const middle = sorted[Math.ceil(sorted.length / 2) - 1] as number;
          const expected = `Median ${MEDIAN_WORDS[bucketIndex(middle, HOUR_BUCKETS)]}`;
          expect(medianPhrase(histogram(hours, HOUR_BUCKETS))).toBe(expected);
        },
      ),
    );
  });
});

describe('scales', () => {
  it('gives a count axis headroom over the tallest bar', () => {
    expect(countTicks(5)).toEqual([0, 2, 4, 6]);
    expect(countTicks(2)).toEqual([0, 1, 2, 3]);
    expect(countTicks(0)).toEqual([0, 1, 2]);
    expect(countTicks(40)).toEqual([0, 20, 40, 60]);
  });

  it('always tops the tallest value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (max) => {
        const ticks = countTicks(max);
        expect(ticks[0]).toBe(0);
        expect(ticks.at(-1) as number).toBeGreaterThan(max);
        expect(ticks.length).toBeLessThanOrEqual(6);
      }),
    );
  });

  it('steps an hours axis in whole days', () => {
    expect(hourTicks(94)).toEqual([0, 24, 48, 72, 96]);
    expect(hourTicks(0)).toEqual([0, 24]);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5000, noNaN: true }), (max) => {
        const ticks = hourTicks(max);
        expect(ticks.at(-1) as number).toBeGreaterThanOrEqual(max);
        for (const t of ticks) expect(t % 24).toBe(0);
        expect(ticks.length).toBeLessThanOrEqual(6);
      }),
    );
  });
});

describe('words', () => {
  it("says what each strip's total is spread over", () => {
    expect(pulseSub('reports', { daily: [], total: 14, over: 11 })).toBe('In 11 posts');
    expect(pulseSub('reports', { daily: [], total: 1, over: 1 })).toBe('In 1 post');
    expect(pulseSub('comments', { daily: [], total: 23, over: 9 })).toBe('On 9 reports');
    expect(pulseSub('photos', { daily: [], total: 1, over: 1 })).toBe('On 1 report');
    expect(pulseSub('kudos', { daily: [], total: 58, over: 14 })).toBe('14 people');
    expect(pulseSub('kudos', { daily: [], total: 2, over: 1 })).toBe('1 person');
    expect(pulseSub('hazards', { daily: [], total: 3, over: 2 })).toBe('On 2 bodies');
    expect(pulseSub('hazards', { daily: [], total: 1, over: 1 })).toBe('On 1 body');
    expect(pulseSub('accounts', { daily: [], total: 3 })).toBe('This season');
    expect(pulseSub('signedIn', { daily: [], total: 24 })).toBe('People');
    expect(pulseSub('contributors', { daily: [], total: 1 })).toBe('Person');
    expect(pulseSub('comments', { daily: [], total: 0 })).toBe('On 0 reports');
  });

  it('draws the unstated vantage only when there is some', () => {
    const counts = { on_ice: 2, shore: 0, secondhand: 1, unstated: 0 };
    expect(vantageSegments(counts).map((s) => s.key)).toEqual(['on_ice', 'shore', 'secondhand']);
    expect(vantageSegments({ ...counts, unstated: 4 }).at(-1)).toEqual({
      key: 'unstated',
      count: 4,
    });
  });

  it('writes reports per thousand bodies as the board does', () => {
    expect(perThousand(9, 6120)).toBe('1.47');
    expect(perThousand(0, 3900)).toBe('0');
    expect(perThousand(3, 0)).toBe('0');
  });

  it('keeps a state its own swatch, whatever its rank', () => {
    expect(stateInk('VT')).toBe('var(--fg)');
    expect(stateInk('MA')).toBe('var(--line)');
    expect(stateInk('QC')).toBe('var(--line)');
  });
});

describe('the season window (from 1 October)', () => {
  const DAY = 86_400_000;

  it('runs from the latest 1 October through today', () => {
    const days = seasonWindowDays(Date.UTC(2027, 0, 16, 16, 52));
    expect(days[0]).toBe('2026-10-01');
    expect(days.at(-1)).toBe('2027-01-16');
    expect(days).toHaveLength(108);
  });

  it('is one day on 1 October, and opens a new season that day', () => {
    expect(seasonWindowDays(Date.UTC(2026, 9, 1, 0, 0))).toEqual(['2026-10-01']);
    expect(seasonWindowDays(Date.UTC(2026, 8, 30, 23, 59)).at(0)).toBe('2025-10-01');
  });

  it('always starts on a 1 October, ends today, and skips or repeats no day', () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) }), (now) => {
        const days = seasonWindowDays(now);
        expect(days[0]?.slice(5)).toBe('10-01');
        expect(days.at(-1)).toBe(new Date(now).toISOString().slice(0, 10));
        expect(days.length).toBeLessThanOrEqual(366);
        for (let i = 1; i < days.length; i++) {
          expect(Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)).toBe(
            DAY,
          );
        }
      }),
    );
  });
});

describe('metricsNotRecorded', () => {
  it('reads nothing: every figure null, every series a null per day, no rows', () => {
    const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
    const { keepingUp, showingUp, coverage } = metricsNotRecorded(days, { support: true });
    expect(keepingUp.openFlags).toBeNull();
    expect(keepingUp.resolvedWeek).toBeNull();
    expect(keepingUp.resolveSeason).toBeNull();
    expect(keepingUp.queueByDay).toEqual([null, null, null]);
    expect(keepingUp.support).toEqual({
      open: null,
      oldestOpenedAt: null,
      resolveSeason: null,
      depthByDay: [null, null, null],
    });
    expect(Object.values(showingUp.week)).toEqual([null, null, null, null]);
    for (const key of PULSE_KEYS) expect(showingUp.pulse[key]).toBeNull();
    expect(showingUp.vantage).toBeNull();
    expect(showingUp.mostReported).toBeNull();
    expect(coverage).toEqual({ listedBodies: null, states: [] });
  });
});
