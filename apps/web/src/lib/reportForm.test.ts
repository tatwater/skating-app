import { describe, expect, it } from 'vitest';
import { timeInputToMinuteOfDay, toTimeInput } from './reportForm';

describe('time input round trip', () => {
  it("formats on the body's clock, never the viewer's", () => {
    const ms = Date.UTC(2026, 0, 5, 19, 30);
    expect(toTimeInput(ms, 'America/New_York')).toBe('14:30');
    expect(toTimeInput(ms, 'UTC')).toBe('19:30');
  });

  it('parses back to the minute it was formatted from', () => {
    const ms = Date.UTC(2026, 0, 5, 19, 30);
    expect(timeInputToMinuteOfDay(toTimeInput(ms, 'America/New_York'))).toBe(14 * 60 + 30);
  });

  it('ignores the seconds a stepped input appends', () => {
    expect(timeInputToMinuteOfDay('06:15:30')).toBe(6 * 60 + 15);
  });

  it('returns NaN for a blank value', () => {
    expect(Number.isNaN(timeInputToMinuteOfDay(''))).toBe(true);
  });

  it('refuses a reading no clock shows', () => {
    expect(Number.isNaN(timeInputToMinuteOfDay('24:00'))).toBe(true);
    expect(Number.isNaN(timeInputToMinuteOfDay('12:60'))).toBe(true);
  });
});
