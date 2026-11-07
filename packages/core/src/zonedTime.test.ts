import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { zonedInstantOnDayOf, zonedParts } from './zonedTime';

const NY = 'America/New_York';
const dateOf = (ms: number, zone: string) => {
  const p = zonedParts(ms, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('zonedInstantOnDayOf — calendar days, not 24-hour steps', () => {
  it('steps back across spring-forward from just after midnight', () => {
    // Monday 9 March 2026, 00:30 EDT: the clocks sprang forward on Sunday the 8th.
    const now = Date.UTC(2026, 2, 9, 4, 30);
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, -1), NY)).toBe('2026-03-08 00:00');
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, -2), NY)).toBe('2026-03-07 00:00');
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, -8), NY)).toBe('2026-03-01 00:00');
  });

  it('steps back across fall-back from just before midnight', () => {
    // Monday 2 November 2026, 23:30 EST: the clocks fell back on Sunday the 1st.
    const now = Date.UTC(2026, 10, 3, 4, 30);
    expect(dateOf(now, NY)).toBe('2026-11-02 23:30');
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, -1), NY)).toBe('2026-11-01 00:00');
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, -2), NY)).toBe('2026-10-31 00:00');
  });

  it('steps forward across a transition', () => {
    // Saturday 7 March 2026, 23:30 EST, forward to Monday.
    const now = Date.UTC(2026, 2, 8, 4, 30);
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, 2), NY)).toBe('2026-03-09 00:00');
    expect(dateOf(zonedInstantOnDayOf(now, 12 * 60, NY, 1), NY)).toBe('2026-03-08 12:00');
  });

  it('crosses a month and a year by the calendar', () => {
    const now = Date.UTC(2027, 0, 1, 15);
    expect(dateOf(zonedInstantOnDayOf(now, 0, NY, -1), NY)).toBe('2026-12-31 00:00');
    expect(dateOf(zonedInstantOnDayOf(now, 0, 'Asia/Kolkata', -1), 'Asia/Kolkata')).toBe(
      '2026-12-31 00:00',
    );
  });

  it('lands exactly dayDelta local dates away, in any zone, at any instant', () => {
    const zones = [NY, 'America/Phoenix', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Kolkata'];
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2029, 0, 1) }),
        fc.constantFrom(...zones),
        fc.integer({ min: -14, max: 14 }),
        (at, zone, delta) => {
          const a = zonedParts(at, zone);
          const b = zonedParts(zonedInstantOnDayOf(at, 12 * 60, zone, delta), zone);
          const days =
            (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) /
            86_400_000;
          expect(days).toBe(delta);
          expect(b.hour * 60 + b.minute).toBe(12 * 60);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
