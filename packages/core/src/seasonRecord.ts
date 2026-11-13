/**
 * The season's record window (B01, the founder's calls of 2026-11-13) — the one rule every
 * season-ranged console read and the Overview's charts share.
 *
 * Two dates, two jobs. **The season's identity flips on 1 July** with the data season (D63,
 * `seasonOf`): from that day the console shows the new season. **Its record opens on 1 October**,
 * when the watch opens and long before ice usually comes: the charts, the totals and every
 * season-ranged count run from 1 October to today, or, for a past season, to its last day (30 June).
 * From 1 July to 30 September the window is empty — the new season is shown empty, never the last
 * one's data; a past season is reached only by choosing it.
 *
 * Days are metric days (UTC `YYYY-MM-DD`, `metricDay`), so a window is an index range over
 * `metricSnapshots.date`, and its instants are the same days' UTC bounds.
 */

import { metricDay, metricDayRange, metricDayStart } from './metrics';
import { type Season, seasonEndMs } from './season';

const DAY_MS = 86_400_000;

/** The record opens on 1 October: `Date.UTC`'s month is 0-based, so 9. */
const RECORD_OPENS_MONTH_INDEX = 9;

/** The first instant of a season's record: 1 October of the year the season began, UTC. */
export function seasonRecordOpensMs(season: Season): number {
  return Date.UTC(season, RECORD_OPENS_MONTH_INDEX, 1);
}

/** The UTC start of the day `ms` falls in. */
function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * A season's record window as `now` sees it: `opensOn` (always 1 October of the season) and the
 * metric days from it through today — or through the season's last day, for a past season. Empty
 * before 1 October, and for a season that hasn't begun.
 */
export function seasonRecordWindow(
  season: Season,
  now: number,
): { opensOn: string; days: string[] } {
  const opens = seasonRecordOpensMs(season);
  const lastDay = seasonEndMs(season) - DAY_MS;
  const end = Math.min(dayStart(now), lastDay);
  const opensOn = metricDay(opens);
  if (end < opens) return { opensOn, days: [] };
  const count = Math.round((end - opens) / DAY_MS) + 1;
  return { opensOn, days: metricDayRange(end, count) };
}

/**
 * The same window as instants, for a read over timestamped rows: `[from, to)` from 1 October to the
 * end of its last day, or `null` when the window is empty. Every row an index range over it returns
 * falls on one of `seasonRecordWindow`'s days.
 */
export function seasonRecordSpan(season: Season, now: number): { from: number; to: number } | null {
  const { days } = seasonRecordWindow(season, now);
  const last = days[days.length - 1];
  if (last === undefined) return null;
  return { from: seasonRecordOpensMs(season), to: metricDayStart(last) + DAY_MS };
}

/**
 * The last `count` metric days ending today — "this week" is `lastDays(now, 7)`. Not season-ranged:
 * the now and this-week figures read the same whichever season is shown.
 */
export function lastDays(now: number, count: number): { days: string[]; from: number; to: number } {
  const today = dayStart(now);
  return {
    days: metricDayRange(today, count),
    from: today - (count - 1) * DAY_MS,
    to: today + DAY_MS,
  };
}
