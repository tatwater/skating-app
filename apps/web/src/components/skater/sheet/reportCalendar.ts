/**
 * The report calendar (Review 4, D199): **two rows** — last week and this one, Sunday to Saturday,
 * in the lake's zone — with only the days an end time can still post on live.
 *
 * The rule is the server's, not a second one: a day is live exactly when some instant on it passes
 * `freshnessRefusal` at `now`. The accepted end times form one interval (seven days back to now), so
 * a day is live when it overlaps that interval, which is what `dayIsLive` asks; the property test
 * holds the drawn rows to the predicate at every `now` and zone.
 *
 * Picking a day keeps the end time's clock and moves its date (`endOnDay`), clamped into the window,
 * so "Thursday, about when I got off" is one click; the ladder's chips move with it (`ladderOnDay`).
 */

import {
  type EndTimeChip,
  FRESHNESS_WINDOW_MS,
  freshnessRefusal,
  WHEN_CHIP_COUNT,
  zonedInstantOnDayOf,
  zonedMinuteOfDay,
  zonedParts,
} from '@skating/core';

/**
 * The End chips as the web offers them (founder, 2026-11-07): the pinned "9:25 AM · now" minute
 * only under a finger — nobody brings their laptop to the lake, so on a desk "now" is not when
 * anyone got off — and at most `WHEN_CHIP_COUNT`, so the row never wraps. One list for the chip
 * row and the ruler's tappable ticks, so the two never disagree about what the ladder is.
 */
export function offeredEndChips(
  chips: readonly EndTimeChip[],
  coarsePointer: boolean,
): EndTimeChip[] {
  return chips.filter((c) => coarsePointer || !c.pinned).slice(0, WHEN_CHIP_COUNT);
}

export interface CalendarDay {
  /** The day's first instant (local midnight) and the first instant of the next day. */
  startMs: number;
  endMs: number;
  /** The date's number, for the cell. */
  dayOfMonth: number;
  /** An end time on this day could still post (D199). */
  live: boolean;
  today: boolean;
  /** After today: drawn to close the row, never live. */
  future: boolean;
}

/** Sunday-first weekday index of the local calendar day containing `ms`. */
function weekday(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Is any end time on `[startMs, endMs)` inside the D199 window at `now`? */
export function dayIsLive(startMs: number, endMs: number, nowMs: number): boolean {
  if (startMs > nowMs) return false;
  // The day's latest instant that is not in the future — the one most likely to pass.
  const latest = Math.min(endMs - 1, nowMs);
  return freshnessRefusal(latest, nowMs) === null;
}

/** The fourteen cells: last week's row, then this week's, Sunday to Saturday. */
export function calendarDays(nowMs: number, timeZone: string): CalendarDay[] {
  const offset = weekday(nowMs, timeZone) + 7; // days back to last week's Sunday
  const todayStart = zonedInstantOnDayOf(nowMs, 0, timeZone);
  const days: CalendarDay[] = [];
  for (let i = 0; i < 14; i++) {
    const delta = i - offset;
    const startMs = zonedInstantOnDayOf(nowMs, 0, timeZone, delta);
    const endMs = zonedInstantOnDayOf(nowMs, 0, timeZone, delta + 1);
    days.push({
      startMs,
      endMs,
      dayOfMonth: zonedParts(startMs + 12 * 3600_000, timeZone).day,
      live: dayIsLive(startMs, endMs, nowMs),
      today: startMs === todayStart,
      future: startMs > nowMs,
    });
  }
  return days;
}

/** The calendar's caption: the month (or months) its two rows span. */
export function calendarCaption(days: readonly CalendarDay[], timeZone: string): string {
  const format = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', year: 'numeric' }).format(ms);
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return '';
  const a = format(first.startMs + 12 * 3600_000);
  const b = format(last.startMs + 12 * 3600_000);
  return a === b ? a : `${a.split(' ')[0]} – ${b}`;
}

/** The day `ms` falls on, as a calendar cell's start (local midnight). */
export function dayStartOf(ms: number, timeZone: string): number {
  return zonedInstantOnDayOf(ms, 0, timeZone);
}

/** Whole local days from the day containing `fromMs` to the day containing `toMs`. */
function dayDelta(fromMs: number, toMs: number, timeZone: string): number {
  const a = zonedParts(fromMs, timeZone);
  const b = zonedParts(toMs, timeZone);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** Clamp an instant into the window an end time can post with (D199). */
export function clampToWindow(ms: number, nowMs: number): number {
  return Math.min(Math.max(ms, nowMs - FRESHNESS_WINDOW_MS), nowMs);
}

/**
 * The end time moved to `dayStartMs`'s date at the same local clock reading, clamped into the
 * window — so picking yesterday keeps "11:30 AM" and picking today never lands after now.
 */
export function endOnDay(
  endMs: number,
  dayStartMs: number,
  nowMs: number,
  timeZone: string,
): number {
  const minute = zonedMinuteOfDay(endMs, timeZone);
  return clampToWindow(zonedInstantOnDayOf(dayStartMs, minute, timeZone), nowMs);
}

/**
 * The ladder's chips moved to another day: the same clock readings on that date, keeping only those
 * still inside the window. On the open day it is the ladder itself.
 */
export function ladderOnDay(
  chips: readonly EndTimeChip[],
  dayStartMs: number,
  nowMs: number,
  timeZone: string,
): EndTimeChip[] {
  const first = chips[0];
  if (first === undefined) return [];
  if (dayDelta(first.ms, dayStartMs, timeZone) === 0) return [...chips];
  return chips
    .map((chip) => ({
      ms: zonedInstantOnDayOf(dayStartMs, zonedMinuteOfDay(chip.ms, timeZone), timeZone),
      precision: 'half_hour' as const,
      pinned: false,
    }))
    .filter((chip) => chip.ms <= nowMs && freshnessRefusal(chip.ms, nowMs) === null);
}
