import {
  frameDateLabel,
  nearestLandableStop,
  nearestLandableStopToDate,
  stopCaveat,
  type TimelineStop,
} from '@skating/core';

/**
 * The imagery timeline's axis (boards 3.14/3.15, the founder's Review 4 rule), pure.
 *
 * One tick per **day**, not per pass: the track is a calendar, so the gaps between passes read as
 * time. A day with a usable picture of this lake is a **tall** tick; a day whose pass is hidden
 * (cloud, or the pass clipped the lake) is a **short** one; a day with no pass has no tick. **Radar
 * has no short ticks** — it sees through cloud and dark, so a radar pass is never "hidden" by
 * weather, and a day between passes (about every six days) simply has nothing on it.
 *
 * The URL says `tc` / `vh` (D242's `?band=`); the archive calls true color `visual`.
 */

export type ImageryUrlBand = 'tc' | 'vh';

export const ARCHIVE_BAND: Readonly<Record<ImageryUrlBand, string>> = { tc: 'visual', vh: 'vh' };

export interface ImageryTick {
  /** `yyyy-mm-dd` (UTC — a Sentinel pass over the region is mid-morning, the same day locally). */
  day: string;
  /** Days from the axis start. */
  dayIndex: number;
  /** A usable picture (tall) or a hidden one (short). */
  tall: boolean;
  /** The stop this tick stands for: the day's latest usable pass, else its first pass. */
  stopIndex: number;
}

export interface ImageryAxis {
  /** The first day on the track, `yyyy-mm-dd`; `null` when there are no passes at all. */
  start: string | null;
  /** How many days the track spans, both ends included. */
  days: number;
  ticks: ImageryTick[];
  /** Month labels: `NOV` at the start, then the first of each month on the track. */
  months: { label: string; dayIndex: number }[];
}

const DAY_MS = 86_400_000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The UTC calendar day of an ISO instant; `null` when it isn't one. */
export function dayOf(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

export function buildImageryAxis(
  stops: readonly TimelineStop[],
  band: ImageryUrlBand,
): ImageryAxis {
  const byDay = new Map<string, number[]>();
  for (const [i, stop] of stops.entries()) {
    const day = dayOf(stop.frame.capturedAt);
    if (day === null) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
  }
  const days = [...byDay.keys()].sort();
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    return { start: null, days: 0, ticks: [], months: [] };
  }
  const origin = dayNumber(first);
  const ticks: ImageryTick[] = [];
  for (const day of days) {
    const indices = byDay.get(day) ?? [];
    const usable = indices.filter((i) => stops[i]?.landable);
    const tall = usable.length > 0;
    // Radar never draws a short tick, whatever the stop says: a radar pass isn't hidden by weather.
    if (!tall && band === 'vh') continue;
    ticks.push({
      day,
      dayIndex: dayNumber(day) - origin,
      tall,
      stopIndex: tall ? (usable[usable.length - 1] as number) : (indices[0] as number),
    });
  }
  const span = dayNumber(last) - origin + 1;
  const months: { label: string; dayIndex: number }[] = [];
  const startDate = new Date(`${first}T00:00:00Z`);
  for (let d = 0; d < span; d++) {
    const date = new Date(startDate.getTime() + d * DAY_MS);
    const label = MONTHS[date.getUTCMonth()] as string;
    if (d === 0) {
      // The start gets its month only if the next month's label won't crowd it.
      if (date.getUTCDate() <= 25 || span < 8) months.push({ label, dayIndex: 0 });
    } else if (date.getUTCDate() === 1) {
      months.push({ label, dayIndex: d });
    }
  }
  return { start: first, days: span, ticks, months };
}

/**
 * The stop the view opens on: the URL's `?frame=` day when a usable pass sits on it, else the usable
 * pass nearest that day, else the latest usable pass. `null` when nothing is usable.
 */
export function selectedStopFor(
  stops: readonly TimelineStop[],
  frame: string | undefined,
): number | null {
  if (frame !== undefined) {
    let onDay: number | null = null;
    for (const [i, stop] of stops.entries()) {
      if (stop.landable && dayOf(stop.frame.capturedAt) === frame) onDay = i;
    }
    if (onDay !== null) return onDay;
    const near = nearestLandableStopToDate(stops, `${frame}T12:00:00Z`);
    if (near !== null) return near;
  }
  return nearestLandableStop(stops, stops.length - 1, -1);
}

/**
 * The stop a day stands for — its latest usable pass, the one `selectedStopFor` lands on for that
 * day. `null` when the day has nothing usable.
 */
function dayStop(stops: readonly TimelineStop[], day: string | null): number | null {
  let found: number | null = null;
  for (const [i, stop] of stops.entries()) {
    if (stop.landable && dayOf(stop.frame.capturedAt) === day) found = i;
  }
  return found;
}

/**
 * The next usable **day** in a direction from `current`, as the stop that day stands for; `current`
 * itself at either end. Steps by day, not by pass: the URL keeps only the day (`?frame=`), so a
 * second pass on the same day would land back on the day's latest and Left would never leave it.
 */
export function stepUsable(
  stops: readonly TimelineStop[],
  current: number,
  direction: 1 | -1,
): number {
  const here = dayOf(stops[current]?.frame.capturedAt ?? '');
  for (let i = current + direction; i >= 0 && i < stops.length; i += direction) {
    const stop = stops[i];
    if (!stop?.landable) continue;
    const day = dayOf(stop.frame.capturedAt);
    // `i` is usable and on `day`, so the day has a stop.
    if (day !== here) return dayStop(stops, day) as number;
  }
  return current;
}

/** The first and last usable days (Home / End), as the stop each day stands for. */
export function edgeUsable(stops: readonly TimelineStop[], edge: 'first' | 'last'): number | null {
  const at =
    edge === 'first'
      ? nearestLandableStop(stops, 0, 1)
      : nearestLandableStop(stops, stops.length - 1, -1);
  if (at === null) return null;
  return dayStop(stops, dayOf(stops[at]?.frame.capturedAt ?? '')) as number;
}

/** A tick's tooltip: the date, and for a hidden day why it can't be shown. */
export function tickTip(stop: TimelineStop): string {
  const date = frameDateLabel(stop.frame.capturedAt).replace(/,? \d{4}$/, '');
  if (stop.landable) return date;
  const caveat = stopCaveat(stop);
  const why =
    stop.blockedBy === 'coverage' ? 'Too little of the lake to show' : 'Too cloudy to show';
  return caveat ? `${date} · ${why}: ${caveat}` : `${date} · ${why}`;
}
