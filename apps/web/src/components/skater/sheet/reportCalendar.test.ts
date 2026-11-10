import {
  endTimeRow,
  FRESHNESS_WINDOW_MS,
  freshnessRefusal,
  WHEN_CHIP_COUNT,
  zonedParts,
} from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BOARD_NOW_NH } from '@/test/boardNow';
import {
  calendarCaption,
  calendarDays,
  clampToWindow,
  dayIsLive,
  dayStartOf,
  endOnDay,
  ladderOnDay,
  offeredEndChips,
} from './reportCalendar';

const ZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'America/Phoenix',
];
const HOUR = 3600_000;
// Saturday 16 January 2027, 11:52 AM in New Hampshire — the boards' "today".
const BOARD_NOW = BOARD_NOW_NH;
const NH = 'America/New_York';

describe('calendarDays — the boards', () => {
  const days = calendarDays(BOARD_NOW, NH);

  it('draws two rows, last week and this one, Sunday first', () => {
    expect(days).toHaveLength(14);
    expect(days.map((d) => d.dayOfMonth)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(days.filter((d) => d.today).map((d) => d.dayOfMonth)).toEqual([16]);
    expect(days.some((d) => d.future)).toBe(false);
  });

  it('lights the days an end time can still post on, and no others', () => {
    expect(days.filter((d) => d.live).map((d) => d.dayOfMonth)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  it('draws the days after today, never live', () => {
    const wednesday = calendarDays(Date.UTC(2027, 0, 13, 15), NH);
    const future = wednesday.filter((d) => d.future);
    expect(future.map((d) => d.dayOfMonth)).toEqual([14, 15, 16]);
    expect(future.every((d) => !d.live)).toBe(true);
  });

  it('captions the month, or the two it spans', () => {
    expect(calendarCaption(days, NH)).toBe('January 2027');
    expect(calendarCaption(calendarDays(Date.UTC(2027, 1, 2, 15), NH), NH)).toBe(
      'January – February 2027',
    );
    expect(calendarCaption([], NH)).toBe('');
  });
});

/** The calendar's invariants at one `now`: whole local days, Sunday first, today in row two. */
function expectWholeDays(now: number, zone: string) {
  const days = calendarDays(now, zone);
  expect(days).toHaveLength(14);
  for (let i = 0; i < 14; i++) {
    const day = days[i] as { startMs: number; endMs: number };
    if (i < 13) expect(day.endMs).toBe(days[i + 1]?.startMs);
    const p = zonedParts(day.startMs, zone);
    expect(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()).toBe(i % 7);
    expect(p.hour * 60 + p.minute).toBe(0);
    // A local day is 23, 24, or 25 hours (or 23.5/24.5 at Lord Howe) — never two days.
    expect(day.endMs - day.startMs).toBeGreaterThanOrEqual(23 * HOUR);
    expect(day.endMs - day.startMs).toBeLessThanOrEqual(25 * HOUR);
  }
  const today = days.findIndex((d) => d.today);
  expect(today).toBeGreaterThanOrEqual(7);
  expect(now).toBeGreaterThanOrEqual((days[today] as { startMs: number }).startMs);
  expect(now).toBeLessThan((days[today] as { endMs: number }).endMs);
  for (const day of days) {
    expect(day.live).toBe(day.startMs <= now && day.endMs - 1 >= now - FRESHNESS_WINDOW_MS);
  }
}

describe('calendarDays — across a DST change', () => {
  // Each `now` sits in the hour where stepping back by 24-hour blocks reads the wrong date: just
  // after midnight the week after spring-forward, just before midnight the week after fall-back.
  const cases: [string, number, string][] = [
    ['New York, 00:30 the day after spring-forward', Date.UTC(2026, 2, 9, 4, 30), NH],
    ['New York, 00:10 the Saturday after spring-forward', Date.UTC(2026, 2, 14, 4, 10), NH],
    ['New York, 23:30 the day after fall-back', Date.UTC(2026, 10, 3, 4, 30), NH],
    ['New York, 23:59 the Saturday after fall-back', Date.UTC(2026, 10, 8, 4, 59), NH],
    ['New York, 01:30 the second time on fall-back night', Date.UTC(2026, 10, 1, 6, 30), NH],
    ['Phoenix, no DST, the same instants', Date.UTC(2026, 2, 9, 7, 30), 'America/Phoenix'],
    ['Phoenix, 23:30 after fall-back elsewhere', Date.UTC(2026, 10, 3, 6, 30), 'America/Phoenix'],
    ['Kolkata, a half-hour offset', Date.UTC(2026, 2, 8, 18, 45), 'Asia/Kolkata'],
    [
      'Lord Howe, a half-hour DST, after it ends',
      Date.UTC(2026, 3, 5, 13, 20),
      'Australia/Lord_Howe',
    ],
    [
      'Chatham, a 45-minute offset, after DST starts',
      Date.UTC(2026, 8, 27, 11, 30),
      'Pacific/Chatham',
    ],
  ];
  for (const [name, now, zone] of cases) {
    it(name, () => expectWholeDays(now, zone));
  }
});

describe('calendarDays — the server rule, at every now (D199)', () => {
  const nowArb = fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2029, 0, 1) });
  const zoneArb = fc.constantFrom(...ZONES);

  it('tiles fourteen whole local days, Sunday to Saturday, with today in the second row', () => {
    fc.assert(fc.property(nowArb, zoneArb, (now, zone) => expectWholeDays(now, zone)));
  });

  it('draws a day live exactly when some end time on it passes the server predicate', () => {
    fc.assert(
      fc.property(
        nowArb,
        zoneArb,
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 8, maxLength: 8 }),
        (now, zone, fractions) => {
          for (const day of calendarDays(now, zone)) {
            // The accepted end times are one interval: [now − 7 days, now].
            const overlaps = day.startMs <= now && day.endMs - 1 >= now - FRESHNESS_WINDOW_MS;
            expect(day.live).toBe(overlaps);
            const samples = [
              day.startMs,
              day.endMs - 1,
              ...fractions.map((f) => day.startMs + Math.floor(f * (day.endMs - day.startMs - 1))),
            ].filter((ms) => ms <= now);
            const anyAccepted = samples.some((ms) => freshnessRefusal(ms, now) === null);
            // A sample the server accepts is on a live day, always.
            if (anyAccepted) expect(day.live).toBe(true);
            // A dead day's every instant up to now is refused.
            if (!day.live) expect(anyAccepted).toBe(false);
          }
          const live = calendarDays(now, zone).filter((d) => d.live).length;
          expect(live).toBeGreaterThanOrEqual(7);
          expect(live).toBeLessThanOrEqual(9);
        },
      ),
    );
  });
});

describe('moving the end time to another day', () => {
  it('dayIsLive refuses a day that has not started', () => {
    expect(dayIsLive(BOARD_NOW + HOUR, BOARD_NOW + 2 * HOUR, BOARD_NOW)).toBe(false);
  });

  it('keeps the clock and moves the date, inside the window', () => {
    const end = Date.UTC(2027, 0, 16, 16, 30); // 11:30 AM
    const thursday = dayStartOf(Date.UTC(2027, 0, 14, 15), NH);
    expect(endOnDay(end, thursday, BOARD_NOW, NH)).toBe(Date.UTC(2027, 0, 14, 16, 30));
    // A week ago Saturday, at 11:30 AM, is before the window opens (11:52): clamped to its edge.
    const lastSaturday = dayStartOf(Date.UTC(2027, 0, 9, 15), NH);
    expect(endOnDay(end, lastSaturday, BOARD_NOW, NH)).toBe(BOARD_NOW - FRESHNESS_WINDOW_MS);
    expect(clampToWindow(BOARD_NOW + HOUR, BOARD_NOW)).toBe(BOARD_NOW);
  });

  it('clamps on the minute grain when now carries seconds — a clamped end stays off them', () => {
    const now = BOARD_NOW + 31_000; // 11:52:31 — the window's raw edges would carry the :31
    // Below the window: up to the next whole minute inside it, so it still posts.
    const early = clampToWindow(BOARD_NOW - 8 * 24 * HOUR, now);
    expect(early).toBe(now - FRESHNESS_WINDOW_MS + 29_000);
    expect(early % 60_000).toBe(0);
    expect(freshnessRefusal(early, now)).toBeNull();
    // In the future: down to now's whole minute, never past it.
    expect(clampToWindow(now + HOUR, now)).toBe(BOARD_NOW);
  });

  it('moves the ladder with it, dropping what falls out of the window', () => {
    const row = endTimeRow({ openedAtMs: BOARD_NOW, nowMs: BOARD_NOW, timeZone: NH, sun: null });
    const today = dayStartOf(BOARD_NOW, NH);
    expect(ladderOnDay(row.chips, today, BOARD_NOW, NH)).toEqual(row.chips);
    const thursday = dayStartOf(Date.UTC(2027, 0, 14, 15), NH);
    const moved = ladderOnDay(row.chips, thursday, BOARD_NOW, NH);
    expect(moved).toHaveLength(row.chips.length);
    expect(moved.every((c) => !c.pinned && c.precision === 'half_hour')).toBe(true);
    expect(moved[1]?.ms).toBe((row.chips[1]?.ms ?? 0) - 2 * 24 * HOUR);
    const lastSaturday = dayStartOf(Date.UTC(2027, 0, 9, 15), NH);
    expect(ladderOnDay(row.chips, lastSaturday, BOARD_NOW, NH)).toEqual([
      expect.objectContaining({ ms: BOARD_NOW - 7 * 24 * HOUR }),
    ]);
    expect(ladderOnDay([], today, BOARD_NOW, NH)).toEqual([]);
  });

  it('never offers a moved chip the server would refuse', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2029, 0, 1) }),
        fc.constantFrom(...ZONES),
        fc.integer({ min: 0, max: 13 }),
        (now, zone, cell) => {
          const row = endTimeRow({ openedAtMs: now, nowMs: now, timeZone: zone, sun: null });
          const day = calendarDays(now, zone)[cell] as { startMs: number };
          for (const chip of ladderOnDay(row.chips, day.startMs, now, zone)) {
            expect(chip.ms).toBeLessThanOrEqual(now);
            expect(freshnessRefusal(chip.ms, now)).toBeNull();
          }
        },
      ),
    );
  });
});

describe('offeredEndChips — the row the web draws (founder, 2026-11-07)', () => {
  const row = endTimeRow({ openedAtMs: BOARD_NOW, nowMs: BOARD_NOW, timeZone: NH, sun: null });

  it('under a finger: the pinned minute, then half hours, capped at the count', () => {
    const offered = offeredEndChips(row.chips, true);
    expect(offered).toHaveLength(WHEN_CHIP_COUNT);
    expect(offered[0]?.pinned).toBe(true);
    expect(offered.slice(1).every((c) => !c.pinned)).toBe(true);
  });

  it('on a desk: no "now" — the pinned minute is not when anyone got off', () => {
    const offered = offeredEndChips(row.chips, false);
    expect(offered).toHaveLength(WHEN_CHIP_COUNT);
    expect(offered.every((c) => !c.pinned)).toBe(true);
    expect(offered.map((c) => c.ms)).toEqual(
      row.chips
        .filter((c) => !c.pinned)
        .slice(0, WHEN_CHIP_COUNT)
        .map((c) => c.ms),
    );
  });

  it('never offers more than the count, from whatever the ladder holds (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2029, 0, 1) }),
        fc.constantFrom(...ZONES),
        fc.boolean(),
        (now, zone, coarse) => {
          const chips = endTimeRow({
            openedAtMs: now,
            nowMs: now,
            timeZone: zone,
            sun: null,
          }).chips;
          const offered = offeredEndChips(chips, coarse);
          expect(offered.length).toBeLessThanOrEqual(WHEN_CHIP_COUNT);
          if (!coarse) expect(offered.every((c) => !c.pinned)).toBe(true);
        },
      ),
    );
  });
});
