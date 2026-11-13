import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { historyWhen, seasonTape } from './consoleTime';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso).getTime();

describe('seasonTape', () => {
  it('names the winter and puts today on the tape (14 Oct, day 10 of the boards’ watch)', () => {
    const tape = seasonTape(at('2026-10-14T16:00:00Z'), NY);
    expect(tape.season).toBe('Winter 2026–27');
    expect(tape.marks).toEqual([
      { at: expect.closeTo(13.67 / 212, 3), kind: 'now', title: 'Today', detail: '14 Oct' },
    ]);
  });

  it('ticks each month start after October — November at 31 of 212 days', () => {
    const { ticks } = seasonTape(at('2027-01-16T17:00:00Z'));
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toBeCloseTo(31 / 212, 6);
    expect(ticks[5]).toBeCloseTo(182 / 212, 6);
  });

  it('names the season by the July it started in, so January reads the winter before', () => {
    expect(seasonTape(at('2027-01-16T17:00:00Z')).season).toBe('Winter 2026–27');
    expect(seasonTape(at('2099-12-01T00:00:00Z')).season).toBe('Winter 2099–00');
  });

  it('draws no today mark outside the winter’s months', () => {
    expect(seasonTape(at('2026-08-01T12:00:00Z')).marks).toEqual([]);
    expect(seasonTape(at('2027-05-02T12:00:00Z')).marks).toEqual([]);
  });

  it('keeps today on the tape for every instant inside the winter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: at('2000-10-01T00:00:00Z'), max: at('2090-04-30T23:59:59Z') }),
        (now) => {
          const { marks } = seasonTape(now, 'UTC');
          for (const m of marks) {
            expect(m.at).toBeGreaterThanOrEqual(0);
            expect(m.at).toBeLessThan(1);
          }
        },
      ),
    );
  });
});

describe('historyWhen', () => {
  const now = at('2027-01-16T16:52:00Z'); // Saturday 11:52 in New Hampshire

  it('writes the clock for today', () => {
    expect(historyWhen(at('2027-01-16T14:41:00Z'), now, NY)).toBe('09:41');
  });

  it('writes the weekday for this past week', () => {
    expect(historyWhen(at('2027-01-15T22:00:00Z'), now, NY)).toBe('Fri');
    expect(historyWhen(at('2027-01-11T15:00:00Z'), now, NY)).toBe('Mon');
  });

  it('counts the past week in calendar days, so a day reads the same at any hour', () => {
    // Sunday the 10th, six days back: early (6 d 7 h ago) and late (5 d 14 h ago) alike.
    expect(historyWhen(at('2027-01-10T09:30:00Z'), now, NY)).toBe('Sun');
    expect(historyWhen(at('2027-01-11T02:30:00Z'), now, NY)).toBe('Sun');
    // Saturday the 9th is a week back: its date, never a weekday that reads as today's.
    expect(historyWhen(at('2027-01-10T04:00:00Z'), now, NY)).toBe('9 Jan');
  });

  it('writes the day and month before that, never the year', () => {
    expect(historyWhen(at('2027-01-03T15:00:00Z'), now, NY)).toBe('3 Jan');
    expect(historyWhen(at('2026-10-03T15:00:00Z'), now, NY)).toBe('3 Oct');
  });

  it('reads today in the reader’s zone, not UTC’s', () => {
    // 01:30 UTC on the 17th is still the 16th in New Hampshire.
    const late = at('2027-01-17T01:30:00Z');
    expect(historyWhen(at('2027-01-16T23:00:00Z'), late, NY)).toBe('18:00');
  });
});
