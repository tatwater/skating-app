import { describe, expect, it } from 'vitest';

import { at, NOW, ZONE } from './cronFixtures';
import {
  axisDay,
  dayClock,
  intervalWords,
  isFixedTime,
  plateWhen,
  scheduleWords,
  shortWhen,
  tookWords,
} from './cronFormat';
import { countsLine, countWords, runPressedWords } from './cronWords';

describe('times, in the viewer’s zone', () => {
  it('writes a run’s day as the boards do', () => {
    expect(dayClock(at(12, 40), NOW, ZONE)).toBe('Today 12:40');
    expect(dayClock(at(18, 40, 0, 1), NOW, ZONE)).toBe('Tue 13 18:40');
    expect(dayClock(Date.UTC(2026, 8, 29, 16), NOW, ZONE)).toBe('Tue 29 Sep 12:00');
    expect(dayClock(Date.UTC(2025, 9, 14, 16), NOW, ZONE)).toBe('Tue 14 Oct 12:00');
  });
  it('writes a time alone today, else with its day', () => {
    expect(shortWhen(at(12, 40), NOW, ZONE)).toBe('12:40');
    expect(shortWhen(at(7, 30) + 86_400_000, NOW, ZONE)).toBe('Thu 15 07:30');
  });
  it('writes the axis and the plate', () => {
    expect(axisDay(at(12, 40, 0, 5), ZONE)).toBe('Fri 9 Oct');
    expect(plateWhen(at(14, 5), NOW, ZONE)).toBe('Today · 14:05');
    expect(plateWhen(at(18, 40, 0, 1), NOW, ZONE)).toBe('Tue 13 Oct · 18:40');
  });
  it('turns a UTC instant into the viewer’s day across midnight', () => {
    // 02:00 UTC on the 15th is 22:00 on the 14th in New York.
    expect(dayClock(Date.UTC(2026, 9, 15, 2), NOW, ZONE)).toBe('Today 22:00');
  });
});

describe('durations', () => {
  it('writes each scale', () => {
    expect(tookWords(12)).toBe('12 ms');
    expect(tookWords(1_800)).toBe('1.8 s');
    expect(tookWords(8_249)).toBe('8.2 s');
    expect(tookWords(41_000)).toBe('41 s');
    expect(tookWords(372_000)).toBe('6 m 12');
    expect(tookWords(6_480_000)).toBe('1 h 48 m');
  });
  it('never writes a negative or a missing number', () => {
    expect(tookWords(-5)).toBe('0 ms');
    expect(tookWords(Number.NaN)).toBe('0 ms');
  });
});

describe('schedules (ruling 17)', () => {
  it('writes an interval', () => {
    expect(intervalWords(60_000)).toBe('minute');
    expect(intervalWords(180_000)).toBe('3 minutes');
    expect(intervalWords(3_600_000)).toBe('hour');
    expect(intervalWords(21_600_000)).toBe('6 hours');
    expect(intervalWords(86_400_000)).toBe('day');
    expect(intervalWords(90_000)).toBe('90 seconds');
    expect(scheduleWords({ every: 21_600_000 })).toBe('Every 6 hours');
  });
  it('writes a fixed time in UTC', () => {
    expect(scheduleWords({ daily: { hourUTC: 11, minuteUTC: 30 } })).toBe('Daily at 11:30 UTC');
    expect(scheduleWords({ weekly: { dayOfWeek: 0, hourUTC: 3, minuteUTC: 12 } })).toBe(
      'Sundays at 03:12 UTC',
    );
    expect(scheduleWords({ weekly: { dayOfWeek: 9, hourUTC: 3, minuteUTC: 12 } })).toBe(
      'Weekly at 03:12 UTC',
    );
    expect(isFixedTime({ every: 1 })).toBe(false);
    expect(isFixedTime({ daily: { hourUTC: 1, minuteUTC: 0 } })).toBe(true);
  });
});

describe('counts', () => {
  it('writes a run’s counts, the zeros left out, at most three', () => {
    expect(countWords('queued', 6)).toBe('6 queued');
    expect(countWords('alreadyQueued', 1200)).toBe('1,200 already queued');
    expect(countsLine({ found: 10, queued: 6 })).toBe('10 found · 6 queued');
    expect(countsLine({ a: 1, b: 0, c: 2, d: 3, e: 4 })).toBe('1 a · 2 c · 3 d');
    expect(countsLine({ found: 0 })).toBeNull();
    expect(countsLine(null)).toBeNull();
  });
});

describe('who started a run', () => {
  it('names a press, and claims none for a scheduled run or one another job started', () => {
    expect(runPressedWords({ trigger: 'manual', by: { name: 'Teagan' } })).toBe('Run now · Teagan');
    expect(runPressedWords({ trigger: 'manual', by: { name: '' } })).toBe('Run now');
    expect(runPressedWords({ trigger: 'manual', by: null })).toBeNull();
    expect(runPressedWords({ trigger: 'cron', by: null })).toBeNull();
  });
});
