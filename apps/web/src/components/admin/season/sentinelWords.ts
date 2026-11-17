/**
 * **The words of the Overview Home's *Overnight Lows at the Sentinels* row** (B01-2b), in one place
 * for the founder's copy pass. Taken verbatim from the Seasons board (7.1 Seasons | Winter 2026–27)
 * where it has them; the rest — marked *not on the board* — are the plainest form of the board's own,
 * and listed in the phase doc until reviewed.
 *
 * ⚠ Air temperature at three named sites (D3): nothing here may say a lake froze, that ice formed or
 * is safe, or that it will. A low is a reading; a line is the watch's own threshold, named for the
 * watch.
 */

import { dayLabel } from '@/components/admin/metrics/metricsModel';

/** The section's title (the board's). */
export const LOWS_TITLE = 'Overnight lows at the sentinels';

/** The unit at the rule's end, before the period (the board's "°F · 1–12 OCT"). */
export const LOWS_UNIT = '°F';

/**
 * The board's short names for the three sentinels (its legend and matrix: Clouds, Eagle, Kinsman),
 * keyed by the name the roster holds each by. Any other sentinel is called by its full name.
 */
export const SENTINEL_SHORT_NAMES: Readonly<Record<string, string>> = {
  'Upper Lake of the Clouds': 'Clouds',
  'Eagle Lake': 'Eagle',
  'Kinsman Pond': 'Kinsman',
};

export function sentinelShortName(name: string): string {
  return SENTINEL_SHORT_NAMES[name] ?? name;
}

/** "1–12 Oct", "28 Sep–3 Oct", or one night's "7 Oct": the nights drawn (the board's period). */
export function periodWords(first: string, last: string): string {
  if (first === last) return dayLabel(first);
  const [a, b] = [dayLabel(first), dayLabel(last)];
  const [aDay, aMonth] = a.split(' ');
  const [, bMonth] = b.split(' ');
  return aMonth === bMonth ? `${aDay}–${b}` : `${a}–${b}`;
}

/** The legend's two lines (the board's "the watch · 32 °F", "imagery · 20 °F"), at the stored lines. */
export const watchLineWords = (f: number) => `the watch · ${f} °F`;
export const imageryLineWords = (f: number) => `imagery · ${f} °F`;

/**
 * The watch's opening night (the board's "WATCH OPENED · 2 OF 3"). Opened by the region's bodies
 * with no sentinel firing, it says only that it opened — *not on the board*.
 */
export function watchOpenedWords(fired: number, of: number): string {
  return fired > 0 ? `Watch opened · ${fired} of ${of}` : 'Watch opened';
}

/**
 * The first imagery-line night (the board's "IMAGERY LINE · 19 °F"): the coldest of the sentinels the
 * record stored for it. With none stored, the line alone — *not on the board*.
 */
export function imageryNightWords(lowF: number | null): string {
  return lowF === null ? 'Imagery line' : `Imagery line · ${lowF} °F`;
}

/**
 * A sentinel's end label (the board's "KINSMAN 37"). When its last stored night is not the last night
 * drawn, the label says which night it was — *not on the board*: "Kinsman 37 · 10 Oct".
 */
export function endLabelWords(name: string, f: number, night: string | null): string {
  return night === null ? `${name} ${f}` : `${name} ${f} · ${dayLabel(night)}`;
}

/** What lands in the row while nothing is stored — the Metrics charts' form; *not on the board*. */
export const LOWS_LAND_HERE = 'The sentinels’ overnight lows land here';

/** Before the season's floor (the console's words for a season whose record hasn't begun). */
export const recordBeginsWords = (floor: string) => `Record begins ${dayLabel(floor)}`;

/** The window is open and nothing is stored (the console's words). */
export const LOWS_NOT_RECORDED = 'Not recorded yet';

/** The read failed: said in the row with Try again — *not on the board*. */
export const LOWS_FAILED = 'The sentinels’ overnight lows couldn’t be read';

/** The chart's and the matrix's names for a reader — *not on the board*. */
export const lowsChartLabel = (period: string) => `Overnight lows at the sentinels, ${period}, °F`;
export const lowsMatrixLabel = (period: string) =>
  `Overnight lows by sentinel and night, ${period}`;
