import type { api } from '@skating/convex/api';
import { celsiusToFahrenheit, seasonOf } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import type { TapeMark } from '@/components/kit/top-bar-parts';

/**
 * The console's clock words: the season tape in the top bar, and the time column of a History row.
 * Pure, with `now` (and the zone, for the labels) passed in, so a story or a test pins them.
 */

const DAY_MS = 86_400_000;

/**
 * The short months, written out rather than asked of `Intl`: ICU's `en-GB` writes September as
 * "Sept" in current releases and "Sep" in older ones, and the console writes it one way.
 */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** What `seasonWatch.tape` sends: the watch's record days, for the tape's marks and badge. */
export type TapeFacts = FunctionReturnType<typeof api.seasonWatch.tape>;

/** The tape's span: the winter's months, 1 October to the end of April. */
const TAPE_FIRST_MONTH = 9; // October, 0-based
const TAPE_MONTHS = 7;

export type SeasonTapeModel = {
  /** "Winter 2026–27". */
  season: string;
  /** Each month start after the first, as a fraction of the tape. */
  ticks: number[];
  /** The watch's marks, today, and last winter's first skate as a ghost — in time order. */
  marks: TapeMark[];
  /** "Day 10" while the watch is open; none while it waits or after it closes. */
  badge?: string;
};

/** A record day (`YYYY-MM-DD`) as that calendar day's UTC midnight — the tape's own clock. */
const keyDay = (key: string) => Date.parse(`${key}T00:00:00Z`);

/** "3 Oct" for a record day: the calendar day it names, in no zone. */
function keyDayMonth(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d ?? 1} ${MONTHS[(m ?? 1) - 1]}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The tape for the season `now` is in (D63's July-to-June season, drawn over its winter): its name,
 * its months and today, and — given the watch's record (`seasonWatch.tape`) — when the watch opened,
 * the first imagery-line night, the night winter set in, the close, last winter's first skate as a
 * ghost at the same moment of the year, and the day of the watch as the badge. Record days are
 * calendar days; today and last winter's report are instants, read in `timeZone`.
 */
export function seasonTape(
  now: number,
  timeZone?: string,
  facts?: TapeFacts | null,
): SeasonTapeModel {
  const year = seasonOf(now);
  const start = Date.UTC(year, TAPE_FIRST_MONTH, 1);
  const end = Date.UTC(year, TAPE_FIRST_MONTH + TAPE_MONTHS, 1);
  const span = end - start;
  const ticks: number[] = [];
  for (let m = 1; m < TAPE_MONTHS; m++) {
    ticks.push((Date.UTC(year, TAPE_FIRST_MONTH + m, 1) - start) / span);
  }
  const onTape = (ms: number) => ms >= start && ms < end;
  const frac = (ms: number) => (ms - start) / span;
  const marks: TapeMark[] = [];
  const event = (key: string | null | undefined, mark: Omit<TapeMark, 'at' | 'kind'>) => {
    if (key && onTape(keyDay(key))) marks.push({ at: frac(keyDay(key)), kind: 'event', ...mark });
  };

  // Facts for another season than the tape's (a read from before 1 July) draw nothing.
  const f = facts != null && facts.season === year ? facts : undefined;
  const watch = f?.watch ?? null;
  if (watch) {
    const fired = watch.opening?.sentinels.length ?? 0;
    const of = watch.sentinels.length;
    const by =
      fired === 0
        ? 'the region’s bodies'
        : of > 0
          ? `${fired} of ${plural(of, 'sentinel', 'sentinels')}`
          : plural(fired, 'sentinel', 'sentinels');
    event(watch.opensOn, {
      tone: 'acc',
      title: 'Ice watch opened',
      detail: `${keyDayMonth(watch.opensOn)} · ${by}`,
    });
  }
  event(f?.imageryNudgeOn, {
    tone: 'warn',
    title: 'First imagery-line night',
    detail:
      f?.imageryNudgeOn != null
        ? `${keyDayMonth(f.imageryNudgeOn)}${f.imageryNudgeLowC !== null ? ` · ${Math.round(celsiusToFahrenheit(f.imageryNudgeLowC))} °F` : ''}`
        : '',
  });
  event(f?.winterFrom, {
    title: 'Winter set in, region-wide',
    detail: f?.winterFrom ? keyDayMonth(f.winterFrom) : '',
  });
  event(watch?.closesOn, {
    title: 'Ice watch closed',
    detail: watch?.closesOn ? keyDayMonth(watch.closesOn) : '',
  });

  // The day of the watch: from the night it opened to today, in the reader's calendar.
  const today = dayNumber(now, timeZone);
  const watchDay =
    watch && !watch.closesOn ? today - keyDay(watch.opensOn) / DAY_MS + 1 : undefined;
  const live = watchDay !== undefined && watchDay >= 1 ? watchDay : undefined;
  if (onTape(now)) {
    marks.push({
      at: frac(now),
      kind: 'now',
      title: 'Today',
      detail: `${dayMonth(now, timeZone)}${live !== undefined ? ` · Day ${live} of the watch` : ''}`,
    });
  }

  // Last winter's first skate, at the same moment of this winter's tape.
  const last = f?.lastWinterFirst ?? null;
  if (last) {
    const lastKey = last.source === 'field' ? last.day : dateKey(last.at, timeZone);
    const [y, m, d] = lastKey.split('-').map(Number);
    const ghost = Date.UTC((y ?? year) + 1, (m ?? 1) - 1, d ?? 1);
    if (onTape(ghost)) {
      marks.push({
        at: frac(ghost),
        kind: 'ghost',
        title: last.source === 'field' ? 'Last winter’s first skate' : 'Last winter’s first report',
        // A staff date stands in only for a season with no on-ice report, and says so.
        detail: `${keyDayMonth(lastKey)}${last.body ? ` · ${last.body}` : ''}${last.source === 'field' ? ' · recorded by staff' : ''}`,
      });
    }
  }

  marks.sort((a, b) => a.at - b.at);
  return {
    season: `Winter ${year}–${String((year + 1) % 100).padStart(2, '0')}`,
    ticks,
    marks,
    ...(live !== undefined ? { badge: `Day ${live}` } : {}),
  };
}

/** "14 Oct": the day and month `at` falls on in `timeZone`, months from `MONTHS`. */
export function dayMonth(at: number, timeZone?: string): string {
  return keyDayMonth(dateKey(at, timeZone));
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

/** The calendar day `at` falls on in `timeZone`, as a day number (days since the epoch). */
function dayNumber(at: number, timeZone?: string): number {
  const [y, m, d] = dateKey(at, timeZone).split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY_MS;
}

/**
 * A History row's time, as the boards write it: the clock today ("14:41"), the weekday this past
 * week ("Sat"), and the day and month before that ("3 Oct") — history rows keep day-month, never
 * the year (the founder's Review 13 rule; status dates carry it, rows don't).
 *
 * "This past week" is the six calendar days before today in the reader's zone — the audit feed's
 * rule (`feedWhen`) — so a day reads the same whatever hour its row was written at.
 */
export function historyWhen(at: number, now: number, timeZone?: string): string {
  const daysAgo = dayNumber(now, timeZone) - dayNumber(at, timeZone);
  if (daysAgo === 0) {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(at);
  }
  if (daysAgo > 0 && daysAgo <= 6) {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at);
  }
  return dayMonth(at, timeZone);
}
