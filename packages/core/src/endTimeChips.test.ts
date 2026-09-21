import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DUSK_MARGIN_MS,
  END_TIME_LADDER_STEPS,
  endTimeRow,
  FRESHNESS_WINDOW_MS,
  floorToLocalHalfHour,
  floorToMinute,
  freshnessRefusal,
  openedInDaylight,
  precisionForChoice,
} from './endTimeChips';
import { SKATE_TIME_FUTURE_TOLERANCE_MS } from './report';
import { sunTimes } from './solar';
import { zonedMinuteOfDay, zonedParts } from './zonedTime';

const TZ = 'America/New_York';
const MINUTE = 60_000;
const HALF_HOUR = 30 * MINUTE;
/** Lake Morey. */
const LAT = 43.92;
const LNG = -72.15;

/** Local wall-clock instant in `TZ`. */
function local(y: number, m: number, d: number, h: number, min: number): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = zonedParts(guess, TZ);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
  return guess - offset;
}

describe('floorToLocalHalfHour', () => {
  it('lands on :00 or :30 of the local clock, at or before the instant (property, across DST)', () => {
    // Spans both 2026 transitions in New York (Mar 8, Nov 1) and a New Year's midnight.
    const from = Date.UTC(2025, 11, 31);
    const to = Date.UTC(2026, 11, 1);
    fc.assert(
      fc.property(fc.integer({ min: from, max: to }), (ms) => {
        const floored = floorToLocalHalfHour(ms, TZ);
        expect(floored).toBeLessThanOrEqual(ms);
        expect(ms - floored).toBeLessThan(HALF_HOUR);
        expect(zonedMinuteOfDay(floored, TZ) % 30).toBe(0);
        expect(floored % MINUTE).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it('floorToMinute drops the seconds', () => {
    expect(floorToMinute(local(2026, 1, 10, 16, 12) + 45_000)).toBe(local(2026, 1, 10, 16, 12));
  });
});

describe('openedInDaylight', () => {
  const sun = { sunriseMs: 100, sunsetMs: 1000 };
  it('is the sunrise-to-dusk window, and true when the sun is unknown', () => {
    expect(openedInDaylight(99, sun)).toBe(false);
    expect(openedInDaylight(100, sun)).toBe(true);
    expect(openedInDaylight(1000 + DUSK_MARGIN_MS, sun)).toBe(true);
    expect(openedInDaylight(1000 + DUSK_MARGIN_MS + 1, sun)).toBe(false);
    expect(openedInDaylight(5, null)).toBe(true);
  });
});

describe('endTimeRow', () => {
  it('in daylight: the pinned minute first and preselected, then half hours back', () => {
    const openedAt = local(2026, 1, 10, 16, 12) + 30_000; // 4:12:30 pm, a January afternoon
    const sun = sunTimes(openedAt, LAT, LNG, TZ);
    const row = endTimeRow({ openedAtMs: openedAt, nowMs: openedAt, timeZone: TZ, sun });
    expect(row.reason).toBe('daylight');
    expect(row.preselected).toBe(0);
    expect(row.chips[0]).toEqual({
      ms: local(2026, 1, 10, 16, 12),
      precision: 'minute',
      pinned: true,
    });
    expect(row.chips.slice(1).map((c) => c.ms)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => local(2026, 1, 10, 16, 0) - i * HALF_HOUR),
    );
    expect(row.chips.slice(1).every((c) => c.precision === 'half_hour' && !c.pinned)).toBe(true);
    expect(row.pickerMaxMs).toBe(openedAt);
    expect(row.pickerMinMs).toBe(openedAt - FRESHNESS_WINDOW_MS);
  });

  it('after dark: nothing preselected, the pinned minute still offered, the ladder from sunset', () => {
    const openedAt = local(2026, 1, 10, 21, 5); // 9:05 pm
    const sun = sunTimes(openedAt, LAT, LNG, TZ);
    if (!sun) throw new Error('sun');
    const row = endTimeRow({ openedAtMs: openedAt, nowMs: openedAt, timeZone: TZ, sun });
    expect(row.reason).toBe('after_dark');
    expect(row.preselected).toBeUndefined();
    expect(row.chips[0]).toEqual({ ms: openedAt, precision: 'minute', pinned: true });
    const sunsetHalfHour = floorToLocalHalfHour(sun.sunsetMs, TZ);
    expect(row.chips[1]?.ms).toBe(sunsetHalfHour);
    expect(row.chips).toHaveLength(1 + END_TIME_LADDER_STEPS);
  });

  it('with no sun (no coordinate, polar day) it behaves as daylight but says so', () => {
    const openedAt = local(2026, 1, 10, 16, 12);
    const row = endTimeRow({ openedAtMs: openedAt, nowMs: openedAt, timeZone: TZ, sun: null });
    expect(row.reason).toBe('no_sun');
    expect(row.preselected).toBe(0);
  });

  it('a resumed draft keeps the minute it was opened at, not the minute it was resumed', () => {
    const openedAt = local(2026, 1, 10, 16, 12);
    const resumedAt = openedAt + 5 * 60 * MINUTE;
    const sun = sunTimes(openedAt, LAT, LNG, TZ);
    const row = endTimeRow({ openedAtMs: openedAt, nowMs: resumedAt, timeZone: TZ, sun });
    expect(row.chips[0]?.ms).toBe(openedAt);
    expect(row.pickerMaxMs).toBe(resumedAt);
  });

  it('refuses a sheet opened more than a week ago', () => {
    const openedAt = local(2026, 1, 1, 12, 0);
    const row = endTimeRow({
      openedAtMs: openedAt,
      nowMs: openedAt + FRESHNESS_WINDOW_MS + MINUTE,
      timeZone: TZ,
      sun: null,
    });
    expect(row).toMatchObject({ chips: [], reason: 'expired' });
  });

  it('does not offer the pinned minute twice when it is itself a half hour', () => {
    const openedAt = local(2026, 1, 10, 16, 30);
    const row = endTimeRow({ openedAtMs: openedAt, nowMs: openedAt, timeZone: TZ, sun: null });
    expect(row.chips.map((c) => c.ms)).toEqual([
      openedAt,
      ...[1, 2, 3, 4, 5, 6].map((i) => openedAt - i * HALF_HOUR),
    ]);
  });

  it('clamps a pinned minute from a fast clock to now', () => {
    const now = local(2026, 1, 10, 16, 12);
    const row = endTimeRow({ openedAtMs: now + 10 * MINUTE, nowMs: now, timeZone: TZ, sun: null });
    expect(row.chips[0]?.ms).toBe(now);
  });

  it('never offers a chip outside the window, across DST, midnight and the week boundary (property)', () => {
    const from = Date.UTC(2025, 11, 31);
    const to = Date.UTC(2026, 11, 1);
    fc.assert(
      fc.property(
        fc.integer({ min: from, max: to }),
        fc.integer({ min: 0, max: 8 * 24 * 60 }), // minutes since open, past the window's edge
        fc.boolean(),
        (openedAt, minutesLater, withSun) => {
          const now = openedAt + minutesLater * MINUTE;
          const sun = withSun ? sunTimes(openedAt, LAT, LNG, TZ) : null;
          const row = endTimeRow({ openedAtMs: openedAt, nowMs: now, timeZone: TZ, sun });
          if (floorToMinute(openedAt) < now - FRESHNESS_WINDOW_MS) {
            // Opened more than a week ago: nothing to offer, and the draft is refused upstream.
            expect(row.chips).toEqual([]);
            expect(row.reason).toBe('expired');
            expect(row.preselected).toBeUndefined();
            return;
          }
          // Strictly decreasing, nothing after now, nothing older than the window.
          for (let i = 1; i < row.chips.length; i++) {
            expect(row.chips[i]?.ms).toBeLessThan(row.chips[i - 1]?.ms as number);
          }
          for (const chip of row.chips) {
            expect(chip.ms).toBeLessThanOrEqual(now);
            expect(chip.ms).toBeGreaterThanOrEqual(row.pickerMinMs);
            expect(freshnessRefusal(chip.ms, now)).toBeNull();
            if (chip.precision === 'half_hour') expect(zonedMinuteOfDay(chip.ms, TZ) % 30).toBe(0);
          }
          expect(row.chips[0]?.pinned).toBe(true);
          expect(row.chips.filter((c) => c.pinned)).toHaveLength(1);
          // Preselection is the daylight rule and nothing else.
          expect(row.preselected).toBe(openedInDaylight(openedAt, sun) ? 0 : undefined);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('freshnessRefusal (D199)', () => {
  const now = local(2026, 1, 10, 16, 0);
  it('accepts the window inclusive of its old edge and the skew tolerance', () => {
    expect(freshnessRefusal(now, now)).toBeNull();
    expect(freshnessRefusal(now - FRESHNESS_WINDOW_MS, now)).toBeNull();
    expect(freshnessRefusal(now + SKATE_TIME_FUTURE_TOLERANCE_MS, now)).toBeNull();
  });
  it('refuses older than a week and beyond the tolerance', () => {
    expect(freshnessRefusal(now - FRESHNESS_WINDOW_MS - 1, now)).toBe('too_old');
    expect(freshnessRefusal(now + SKATE_TIME_FUTURE_TOLERANCE_MS + 1, now)).toBe('in_future');
  });
});

describe('precisionForChoice', () => {
  it('reads the chip that produced the instant, else the picker half hour', () => {
    const openedAt = local(2026, 1, 10, 16, 12);
    const row = endTimeRow({ openedAtMs: openedAt, nowMs: openedAt, timeZone: TZ, sun: null });
    expect(precisionForChoice(row, openedAt)).toBe('minute');
    expect(precisionForChoice(row, local(2026, 1, 10, 15, 30))).toBe('half_hour');
    expect(precisionForChoice(row, local(2026, 1, 8, 9, 0))).toBe('half_hour');
  });
});
