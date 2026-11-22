import { cmToInches, roundTo } from '@skating/core';

/**
 * **How the flag handler and *Around it* write a time, a distance, a thickness and a count** — pure,
 * each one rule, so a property test can hold it. Imperial on screen (D25); a time is the console
 * reader's own zone unless a story pins one.
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

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = FORMATTERS.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

/** The calendar parts of `at` in `timeZone`. */
export function partsOf(at: number, timeZone?: string) {
  const f = formatter(timeZone).formatToParts(at);
  const get = (type: string) => f.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday'),
    day: Number(get('day')),
    month: Number(get('month')),
    year: Number(get('year')),
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** "15:40". */
export const clock = (at: number, timeZone?: string): string => partsOf(at, timeZone).time;

/** "10 Oct". */
export function dayMonth(at: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

/** "Sun 11 Oct". */
export function dayLabel(at: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return `${p.weekday} ${p.day} ${MONTHS[p.month - 1]}`;
}

/** "10 Oct 18:02". */
export const dayTime = (at: number, timeZone?: string): string =>
  `${dayMonth(at, timeZone)} ${clock(at, timeZone)}`;

/** A `weatherDays.dayMs` (midnight UTC of a calendar date) as "9 Oct" — a date in no zone. */
export function utcDayMonth(dayMs: number): string {
  const d = new Date(dayMs);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A local calendar key ("2026-10-10"), for grouping by day in the reader's zone. */
export function dayKey(at: number, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** A skate's time: "15:40–17:05", or "08:40" when only its end is known. */
export function skateTimes(start: number | null, end: number, timeZone?: string): string {
  if (start === null || start >= end) return clock(end, timeZone);
  return `${clock(start, timeZone)}–${clock(end, timeZone)}`;
}

/** A skate's day and time, for a head: "10 Oct 15:40–17:05". */
export const skateSpan = (start: number | null, end: number, timeZone?: string): string =>
  `${dayMonth(end, timeZone)} ${skateTimes(start, end, timeZone)}`;

/** A thickness in inches, one decimal, no unit: "3.5" (the unit sits in its own slot). */
export const inchesFigure = (cm: number): string => String(roundTo(cmToInches(cm), 1));

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(n: number): string {
  const whole = Math.max(0, Math.floor(n));
  const mod100 = whole % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${whole}th`;
  switch (whole % 10) {
    case 1:
      return `${whole}st`;
    case 2:
      return `${whole}nd`;
    case 3:
      return `${whole}rd`;
    default:
      return `${whole}th`;
  }
}

/** A count a read may have stopped short on: "14", or "400+" as a floor. */
export const countWords = (c: { count: number; capped: boolean }): string =>
  `${c.count.toLocaleString('en-US')}${c.capped ? '+' : ''}`;

/** One stored thickness reading, as core's validator shapes it. */
export type Reading = {
  valueCm?: number;
  minCm?: number;
  maxCm?: number;
  method: 'measured' | 'estimated' | 'poke';
};

/** A reading's centimeters: its value, a range's middle, a floor's floor; `null` for none. */
export function readingCm(r: Reading): number | null {
  if (r.valueCm !== undefined) return r.valueCm;
  if (r.minCm !== undefined) return r.maxCm === undefined ? r.minCm : (r.minCm + r.maxCm) / 2;
  return null;
}

/**
 * The mean of a report's **measured** readings, in cm, or `null` when it measured nothing — an
 * estimate or a poke never counts as measured (D160's rule, *Around it*'s).
 */
export function measuredMeanCm(
  thickness: { readings: readonly Reading[] } | null | undefined,
): number | null {
  const cms = (thickness?.readings ?? [])
    .filter((r) => r.method === 'measured')
    .map(readingCm)
    .filter((c): c is number => c !== null);
  if (cms.length === 0) return null;
  return cms.reduce((a, b) => a + b, 0) / cms.length;
}
