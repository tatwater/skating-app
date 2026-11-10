import { describe, expect, it } from 'vitest';

import { BOARD_NOON } from '@/test/boardNow';

import { ageLabel, clockLabel, dayLabel, daysBetween, whenLabel } from './panelTime';

// Saturday 16 January 2027, noon local — the boards' "today".
const now = BOARD_NOON;
const at = (day: number, h: number, m = 0) => new Date(2027, 0, day, h, m).getTime();

describe('panelTime', () => {
  it('counts calendar days, not 24-hour spans', () => {
    expect(daysBetween(at(16, 0, 5), now)).toBe(0);
    expect(daysBetween(at(15, 23, 50), now)).toBe(1);
    expect(daysBetween(at(9, 12), now)).toBe(7);
  });

  it('says the clock', () => {
    expect(clockLabel(at(16, 11, 40))).toBe('11:40 AM');
  });

  it('names the day: today, yesterday, a weekday inside the week, then a date', () => {
    expect(dayLabel(at(16, 9), now)).toBe('Today');
    expect(dayLabel(now + 60_000, now)).toBe('Today');
    expect(dayLabel(at(15, 9), now)).toBe('Yesterday');
    expect(dayLabel(at(14, 15), now)).toBe('Thursday');
    expect(dayLabel(at(4, 9), now)).toBe('Jan 4');
  });

  it('gives a row’s corner its short age', () => {
    expect(ageLabel(now - 20_000, now)).toBe('just now');
    expect(ageLabel(now - 25 * 60_000, now)).toBe('25 min');
    expect(ageLabel(at(16, 9), now)).toBe('3 h');
    expect(ageLabel(at(14, 15), now)).toBe('Thu');
    expect(ageLabel(at(4, 9), now)).toBe('Jan 4');
  });

  /**
   * The corner counts hours across midnight. Read just after midnight, a report that ended at
   * 11 PM is ninety minutes old; it used to read "Fri", because the hour branch also demanded the
   * same calendar day. The day words stay calendar-true — that is `dayLabel`'s job, not the
   * corner's. Pinned deliberately so the behavior is not merely sampled at whatever hour CI runs.
   */
  it('counts hours across midnight, and still names the day as yesterday', () => {
    const justAfterMidnight = new Date(2027, 0, 16, 0, 30).getTime();
    const lateLastNight = new Date(2027, 0, 15, 23, 0).getTime();

    expect(ageLabel(lateLastNight, justAfterMidnight)).toBe('1 h');
    expect(ageLabel(new Date(2027, 0, 15, 23, 50).getTime(), justAfterMidnight)).toBe('40 min');
    expect(dayLabel(lateLastNight, justAfterMidnight)).toBe('Yesterday');
    expect(whenLabel(lateLastNight, justAfterMidnight)).toBe('Fri · 11:00 PM');

    // A full day back is still the weekday — only the under-24-hour window changed.
    expect(ageLabel(new Date(2027, 0, 14, 23, 0).getTime(), justAfterMidnight)).toBe('Thu');
  });

  it('gives a report’s corner its day and clock', () => {
    expect(whenLabel(at(16, 11, 40), now)).toBe('Today · 11:40 AM');
    expect(whenLabel(at(14, 15, 15), now)).toBe('Thu · 3:15 PM');
    expect(whenLabel(at(4, 9, 5), now)).toBe('Jan 4 · 9:05 AM');
  });
});
