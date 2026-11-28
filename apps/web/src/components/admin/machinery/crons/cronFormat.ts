import type { CronSchedule } from '@skating/core';

import { clock } from '../corpus/runFormat';

/**
 * **How the cron pieces write a time, a day, a duration and a schedule** — pure, with the zone
 * passed in (the viewer's own when it isn't), so a story or a test pins it. Times are the viewer's
 * local clock, as the console writes them elsewhere; a fixed-time schedule is written in UTC, the
 * zone it is registered in (ruling 17), and its next run in the viewer's clock beside it.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The calendar parts of an instant in `timeZone`. */
function partsOf(at: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    timeZone,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), weekday: get('weekday') };
}

const sameDay = (a: ReturnType<typeof partsOf>, b: ReturnType<typeof partsOf>) =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * A run's time in a list, as the boards write it: "Today 12:40", "Tue 13 18:40", and with its month
 * once it is from another month or year than now ("Tue 13 Oct 18:40").
 */
export function dayClock(at: number, now: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  const n = partsOf(now, timeZone);
  const time = clock(at, timeZone);
  if (sameDay(p, n)) return `Today ${time}`;
  const month = p.month !== n.month || p.year !== n.year ? ` ${p.month}` : '';
  return `${p.weekday} ${p.day}${month} ${time}`;
}

/** A short clock beside a name: the time alone today, else its day too ("Tue 13 12:40"). */
export function shortWhen(at: number, now: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return sameDay(p, partsOf(now, timeZone)) ? clock(at, timeZone) : dayClock(at, now, timeZone);
}

/** A day on the strip's axis: "Fri 9 Oct" (the strip sets it in caps). */
export function axisDay(at: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** A tick's when on its hover plate: "Tue 13 Oct · 18:40", or "Today · 14:05". */
export function plateWhen(at: number, now: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  const day = sameDay(p, partsOf(now, timeZone)) ? 'Today' : `${p.weekday} ${p.day} ${p.month}`;
  return `${day} · ${clock(at, timeZone)}`;
}

/** How long a tick or a run took: "12 ms", "8.2 s", "41 s", "6 m 12", "1 h 48 m". */
export function tookWords(ms: number): string {
  const t = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (t < SECOND) return `${Math.round(t)} ms`;
  if (t < 10 * SECOND) return `${(Math.floor(t / 100) / 10).toFixed(1)} s`;
  if (t < MINUTE) return `${Math.floor(t / SECOND)} s`;
  if (t < HOUR) {
    return `${Math.floor(t / MINUTE)} m ${String(Math.floor((t % MINUTE) / SECOND)).padStart(2, '0')}`;
  }
  return `${Math.floor(t / HOUR)} h ${Math.floor((t % HOUR) / MINUTE)} m`;
}

/** An interval in words, for "Every …": "minute", "3 minutes", "hour", "6 hours", "90 seconds". */
export function intervalWords(ms: number): string {
  const unit = (n: number, one: string) => (n === 1 ? one : `${n} ${one}s`);
  if (ms % DAY === 0) return unit(ms / DAY, 'day');
  if (ms % HOUR === 0) return unit(ms / HOUR, 'hour');
  if (ms % MINUTE === 0) return unit(ms / MINUTE, 'minute');
  return unit(Math.round(ms / SECOND), 'second');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A fixed UTC time: "11:30 UTC". */
const utcTime = (hourUTC: number, minuteUTC: number) => `${pad(hourUTC)}:${pad(minuteUTC)} UTC`;

/**
 * A schedule in words, capitalized: "Every 6 hours", "Every minute", "Daily at 11:30 UTC",
 * "Sundays at 03:12 UTC".
 */
export function scheduleWords(schedule: CronSchedule): string {
  if ('every' in schedule) return `Every ${intervalWords(schedule.every)}`;
  if ('daily' in schedule) {
    return `Daily at ${utcTime(schedule.daily.hourUTC, schedule.daily.minuteUTC)}`;
  }
  const w = schedule.weekly;
  const day = WEEKDAYS[w.dayOfWeek];
  return `${day === undefined ? 'Weekly' : `${day}s`} at ${utcTime(w.hourUTC, w.minuteUTC)}`;
}

/** Whether a schedule is a fixed time (daily or weekly), whose next run can be named. */
export const isFixedTime = (schedule: CronSchedule) => !('every' in schedule);
