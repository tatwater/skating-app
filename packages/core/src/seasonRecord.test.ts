import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { metricDay, metricDayStart } from './metrics';
import { seasonEndMs, seasonOf, seasonStartMs } from './season';
import {
  lastDays,
  seasonRecordOpensMs,
  seasonRecordSpan,
  seasonRecordWindow,
} from './seasonRecord';

const DAY = 86_400_000;

/** Any instant from 2000 to 2100. */
const instant = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) });
const season = fc.integer({ min: 2000, max: 2099 });

describe('the season record window (the founder, 2026-11-13)', () => {
  it('opens on 1 October of the season', () => {
    expect(metricDay(seasonRecordOpensMs(2026))).toBe('2026-10-01');
    expect(seasonRecordWindow(2026, Date.UTC(2026, 6, 1)).opensOn).toBe('2026-10-01');
  });

  it('is empty from 1 July to 30 September — the new season, shown empty', () => {
    expect(seasonRecordWindow(2026, Date.UTC(2026, 6, 1)).days).toEqual([]);
    expect(seasonRecordWindow(2026, Date.UTC(2026, 8, 30, 23, 59)).days).toEqual([]);
    expect(seasonRecordSpan(2026, Date.UTC(2026, 8, 30))).toBeNull();
  });

  it('runs from 1 October through today', () => {
    const { days } = seasonRecordWindow(2026, Date.UTC(2026, 9, 3, 12));
    expect(days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(seasonRecordSpan(2026, Date.UTC(2026, 9, 3, 12))).toEqual({
      from: Date.UTC(2026, 9, 1),
      to: Date.UTC(2026, 9, 4),
    });
  });

  it('draws a past season whole, to 30 June', () => {
    const { days } = seasonRecordWindow(2025, Date.UTC(2026, 10, 13));
    expect(days[0]).toBe('2025-10-01');
    expect(days.at(-1)).toBe('2026-06-30');
    expect(days).toHaveLength(273);
  });

  it('is empty for a season that has not begun', () => {
    expect(seasonRecordWindow(2027, Date.UTC(2026, 10, 13)).days).toEqual([]);
  });

  it('is contiguous, ascending, inside its season, and never past today', () => {
    fc.assert(
      fc.property(season, instant, (s, now) => {
        const { opensOn, days } = seasonRecordWindow(s, now);
        expect(opensOn).toBe(`${s}-10-01`);
        days.forEach((day, i) => {
          const start = metricDayStart(day);
          expect(seasonOf(start)).toBe(s);
          expect(start).toBeGreaterThanOrEqual(seasonRecordOpensMs(s));
          expect(day <= metricDay(now)).toBe(true);
          if (i > 0) expect(start - metricDayStart(days[i - 1] as string)).toBe(DAY);
        });
        if (days.length > 0) expect(days[0]).toBe(opensOn);
      }),
    );
  });

  it('is empty exactly when its record has not opened by today', () => {
    fc.assert(
      fc.property(season, instant, (s, now) => {
        const empty = seasonRecordWindow(s, now).days.length === 0;
        expect(empty).toBe(Math.floor(now / DAY) * DAY < seasonRecordOpensMs(s));
      }),
    );
  });

  it('ends today for the season now falls in, once its record has opened', () => {
    fc.assert(
      fc.property(instant, (now) => {
        const { days } = seasonRecordWindow(seasonOf(now), now);
        if (days.length > 0) expect(days.at(-1)).toBe(metricDay(now));
      }),
    );
  });

  it("spans exactly its days' instants", () => {
    fc.assert(
      fc.property(season, instant, (s, now) => {
        const { days } = seasonRecordWindow(s, now);
        const span = seasonRecordSpan(s, now);
        if (days.length === 0) {
          expect(span).toBeNull();
          return;
        }
        expect(span).not.toBeNull();
        const { from, to } = span as { from: number; to: number };
        expect(to - from).toBe(days.length * DAY);
        expect(from).toBeGreaterThanOrEqual(seasonStartMs(s));
        expect(to).toBeLessThanOrEqual(seasonEndMs(s));
        for (const day of days) {
          expect(metricDayStart(day)).toBeGreaterThanOrEqual(from);
          expect(metricDayStart(day)).toBeLessThan(to);
        }
      }),
    );
  });
});

describe('lastDays', () => {
  it('is the last N metric days ending today, with their instants', () => {
    const week = lastDays(Date.UTC(2026, 10, 13, 18), 7);
    expect(week.days).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    expect(week.from).toBe(Date.UTC(2026, 10, 7));
    expect(week.to).toBe(Date.UTC(2026, 10, 14));
  });

  it('always holds now, and spans exactly its days', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: 1, max: 60 }), (now, count) => {
        const { days, from, to } = lastDays(now, count);
        expect(days).toHaveLength(count);
        expect(days.at(-1)).toBe(metricDay(now));
        expect(now).toBeGreaterThanOrEqual(from);
        expect(now).toBeLessThan(to);
        expect(to - from).toBe(count * DAY);
      }),
    );
  });
});
