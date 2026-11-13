import { seasonOf } from '@skating/core';
import type { TapeMark } from '@/components/kit/top-bar-parts';

/**
 * The console's clock words: the season tape in the top bar, and the time column of a History row.
 * Pure, with `now` (and the zone, for the labels) passed in, so a story or a test pins them.
 */

const DAY_MS = 86_400_000;

/** The tape's span: the winter's months, 1 October to the end of April. */
const TAPE_FIRST_MONTH = 9; // October, 0-based
const TAPE_MONTHS = 7;

export type SeasonTapeModel = {
  /** "Winter 2026–27". */
  season: string;
  /** Each month start after the first, as a fraction of the tape. */
  ticks: number[];
  /** Today, while it falls inside the tape. */
  marks: TapeMark[];
};

/**
 * The tape for the season `now` is in (D63's July-to-June season, drawn over its winter). What a
 * calendar alone can say: the season's name, its months and today. The watch's own marks — when it
 * opened, the first imagery-line night, last winter's first skate — and the day badge need the
 * watch's record, which a moderator can't read yet.
 */
export function seasonTape(now: number, timeZone?: string): SeasonTapeModel {
  const year = seasonOf(now);
  const start = Date.UTC(year, TAPE_FIRST_MONTH, 1);
  const end = Date.UTC(year, TAPE_FIRST_MONTH + TAPE_MONTHS, 1);
  const span = end - start;
  const ticks: number[] = [];
  for (let m = 1; m < TAPE_MONTHS; m++) {
    ticks.push((Date.UTC(year, TAPE_FIRST_MONTH + m, 1) - start) / span);
  }
  const marks: TapeMark[] =
    now >= start && now < end
      ? [{ at: (now - start) / span, kind: 'now', title: 'Today', detail: dayMonth(now, timeZone) }]
      : [];
  return { season: `Winter ${year}–${String((year + 1) % 100).padStart(2, '0')}`, ticks, marks };
}

/** "14 Oct". */
function dayMonth(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(at);
}

/** The calendar date `at` falls on in `timeZone`, as a sortable key. */
function dateKey(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(at);
}

/**
 * A History row's time, as the boards write it: the clock today ("14:41"), the weekday this past
 * week ("Sat"), and the day and month before that ("3 Oct") — history rows keep day-month, never
 * the year (the founder's Review 13 rule; status dates carry it, rows don't).
 */
export function historyWhen(at: number, now: number, timeZone?: string): string {
  if (dateKey(at, timeZone) === dateKey(now, timeZone)) {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(at);
  }
  if (now - at < 6 * DAY_MS && at <= now) {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at);
  }
  return dayMonth(at, timeZone);
}
