/**
 * *When did you get off?* — the end-time chip row (A10 / D192) and the freshness window (D199).
 *
 * 96% of the corpus never says when the skater left the ice, so the one field the whole freshness
 * model sorts by has no muscle memory from email and must be nearly free. The row is: the **minute
 * the sheet was opened** ("04:12 PM"), pinned — most reports are written within an hour of leaving,
 * and a draft resumed later keeps the minute it was opened at, not the minute it was resumed — then
 * **half-hour steps backward**, then the date picker. `skateEndPrecision` is stamped from which chip
 * was taken (`minute` / `half_hour`); a track fills the time exactly and stamps `gps` upstream.
 *
 * **Solar gating.** The pinned minute is preselected only when the sheet was opened in plausible
 * daylight for the body — between sunrise and a margin past sunset — because after dark the honest
 * default is "sometime before it got dark", not "just now". After dark the pinned minute stays
 * offered (a full-moon skate ends at 9 pm and the skater should be able to say so) but nothing is
 * preselected, and the ladder starts at sunset rather than at the open time.
 *
 * **The freshness window (D199).** A Report's end time may be at most seven days before now and never
 * in the future beyond the clock-skew tolerance. The picker cannot offer an older date, and the same
 * predicate refuses a saved draft, a queued item or an imported track at flush, so a phone that comes
 * back online after a week does not post a stale report. Editing an existing Report is never gated
 * here. `reportTime − skateEndTime` is reviewed after a season before the window is tightened.
 *
 * Nothing here is a safety claim (D3): the time is when the author looked, and its precision is
 * shown so a reader knows how much to trust it.
 */

import { SKATE_TIME_FUTURE_TOLERANCE_MS } from './report';
import type { SunTimes } from './solar';
import type { SkateEndPrecision } from './types';
import { zonedMinuteOfDay } from './zonedTime';

const MINUTE_MS = 60_000;
const HALF_HOUR_MS = 30 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** D199: the oldest end time a new Report may carry, relative to now. */
export const FRESHNESS_WINDOW_MS = 7 * DAY_MS;

/** How many half-hour chips follow the pinned minute — three hours, which covers most skates' end. */
export const END_TIME_LADDER_STEPS = 6;

/** Daylight, for the preselect: up to this long after civil sunset still counts as "just got off". */
export const DUSK_MARGIN_MS = 30 * MINUTE_MS;

export interface EndTimeChip {
  /** Epoch ms of the chip's instant. */
  ms: number;
  precision: Exclude<SkateEndPrecision, 'gps'>;
  /** The pinned open-time chip. Kept at the same instant when a draft is resumed. */
  pinned: boolean;
}

export interface EndTimeRow {
  chips: EndTimeChip[];
  /** Index into `chips` of the preselected chip, or `undefined` when nothing is (after dark). */
  preselected?: number;
  /** The date picker's bounds — the D199 window, closed at `now` (the validator adds the skew tolerance). */
  pickerMinMs: number;
  pickerMaxMs: number;
  /**
   * Why the row looks the way it does, for its helper line. `expired` ⇒ the sheet was opened more
   * than a week ago and no chip is offered: the draft is refused with a plain message (D199).
   */
  reason: 'daylight' | 'after_dark' | 'no_sun' | 'expired';
}

export interface EndTimeRowInput {
  /** The minute the sheet was first opened for this draft — persisted with the draft. */
  openedAtMs: number;
  /** Now. Injected, so the row is pure. */
  nowMs: number;
  /** The body's time zone — half-hour boundaries are local, and a DST day has 23 or 25 of them. */
  timeZone: string;
  /** Civil sunrise/sunset for the open day at the body, or `null` when unknown (no solar day, no coord). */
  sun: SunTimes | null;
}

/** Floor an instant to the minute — the pinned chip shows "04:12 PM", never seconds. */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The most recent local half-hour boundary at or before `ms` in `timeZone`. Computed on the local
 * wall clock rather than by epoch arithmetic so a zone whose offset is not a whole number of
 * half-hours from UTC (they exist) still lands on :00 / :30 — and a DST transition, where the wall
 * clock repeats or skips an hour, still yields a boundary on the clock a skater looked at.
 */
export function floorToLocalHalfHour(ms: number, timeZone: string): number {
  const minuteOfDay = zonedMinuteOfDay(ms, timeZone);
  const overshoot = minuteOfDay % 30;
  const seconds = ms % MINUTE_MS;
  return ms - seconds - overshoot * MINUTE_MS;
}

/** Was the sheet opened in plausible daylight for the body? Unknown sun ⇒ treated as daylight. */
export function openedInDaylight(openedAtMs: number, sun: SunTimes | null): boolean {
  if (sun === null) return true;
  return openedAtMs >= sun.sunriseMs && openedAtMs <= sun.sunsetMs + DUSK_MARGIN_MS;
}

/**
 * Build the row. Chips are strictly decreasing in time, every ladder chip sits on a local half-hour
 * boundary, and nothing falls outside the D199 window or after `now`.
 */
export function endTimeRow(input: EndTimeRowInput): EndTimeRow {
  const { openedAtMs, nowMs, timeZone, sun } = input;
  const pickerMinMs = nowMs - FRESHNESS_WINDOW_MS;
  const pickerMaxMs = nowMs;

  // The pinned minute can never be in the future of `now` (a resumed draft is older, never newer)
  // but a skewed clock could put it there; clamp rather than offer a chip the validator refuses.
  const pinnedMs = Math.min(floorToMinute(openedAtMs), floorToMinute(nowMs));
  if (pinnedMs < pickerMinMs) {
    // Opened more than a week ago: every chip the row could offer is outside the window.
    return { chips: [], pickerMinMs, pickerMaxMs, reason: 'expired' };
  }
  const daylight = openedInDaylight(openedAtMs, sun);

  // The ladder starts at the last half hour strictly before the pinned minute — or, after dark, at
  // the last half hour before sunset, so "sometime before it got dark" is the first thing on offer.
  let ladderTop =
    daylight || sun === null
      ? floorToLocalHalfHour(pinnedMs, timeZone)
      : floorToLocalHalfHour(Math.min(sun.sunsetMs, pinnedMs), timeZone);
  if (ladderTop >= pinnedMs) ladderTop -= HALF_HOUR_MS; // the pinned minute *is* a half hour

  const chips: EndTimeChip[] = [{ ms: pinnedMs, precision: 'minute', pinned: true }];
  for (let i = 0; i < END_TIME_LADDER_STEPS; i++) {
    const ms = ladderTop - i * HALF_HOUR_MS;
    if (ms < pickerMinMs) break;
    chips.push({ ms, precision: 'half_hour', pinned: false });
  }

  return {
    chips,
    ...(daylight ? { preselected: 0 } : {}),
    pickerMinMs,
    pickerMaxMs,
    reason: sun === null ? 'no_sun' : daylight ? 'daylight' : 'after_dark',
  };
}

/** Why an end time is refused by the freshness window, or `null` when it is inside it. */
export type FreshnessRefusal = 'too_old' | 'in_future';

/**
 * D199, as one predicate for the picker, the queue flush, the imported track and `posts.create`.
 * Inclusive at the old edge (exactly seven days is still inside); the future edge keeps the
 * validator's clock-skew tolerance so a phone a few minutes fast is not refused twice.
 */
export function freshnessRefusal(skateEndTime: number, nowMs: number): FreshnessRefusal | null {
  if (skateEndTime > nowMs + SKATE_TIME_FUTURE_TOLERANCE_MS) return 'in_future';
  if (skateEndTime < nowMs - FRESHNESS_WINDOW_MS) return 'too_old';
  return null;
}

/** The precision a chosen instant carries: the chip that produced it, else the picker's half hour. */
export function precisionForChoice(row: EndTimeRow, ms: number): Exclude<SkateEndPrecision, 'gps'> {
  return row.chips.find((chip) => chip.ms === ms)?.precision ?? 'half_hour';
}
