/**
 * The timing window (N5c / §C6) — *"always between late December and February"*, which is the sentence
 * the founder ask named and the one most easily overclaimed.
 *
 * Two rules do all the work, and both widen rather than narrow:
 *
 * 1. **An interquartile range, not a min–max.** One anomalous November sighting must not stretch the
 *    window across the whole winter, and the 25th–75th percentile of members' day-of-season is the
 *    cheapest honest way to say "the middle of when this was reported".
 * 2. **Rendered in whole half-months, never in dates.** *"late December to February"*, never
 *    *"Dec 27 – Feb 8"*. A window quoted to the day implies the rest of the season is clear, and that
 *    is a claim nothing in the data supports — the members are sightings by people who happened to be
 *    on the ice, not a survey of when the feature exists.
 *
 * A minimum span follows from the same reasoning: however tightly three January sightings cluster,
 * saying "the second week of January" would be describing when somebody skated, not when the ridge is
 * there.
 */

/**
 * The narrowest window we will print, in half-months.
 *
 * Two half-months is about a month, comfortably past the "never narrower than about three weeks" line
 * §C6 draws. It is expressed in half-months rather than days because the *rendering* is in
 * half-months: a minimum in days would be snapped away by the widening step and would only look like a
 * guarantee.
 */
export const MIN_WINDOW_HALF_MONTHS = 2;

/** Month names indexed from July, which is where a season starts (D63). */
const SEASON_MONTHS = [
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
] as const;

/**
 * Day-of-season boundaries for each half-month, in a canonical non-leap season.
 *
 * Fixed rather than computed per season on purpose: the output is a half-month name, so a leap day
 * moves a boundary by one day inside a bucket fifteen days wide. Computing it per season would add a
 * season argument to every caller and change nothing anyone can see.
 */
const HALF_MONTH_LENGTHS = [
  [15, 16], // July
  [15, 16], // August
  [15, 15], // September
  [15, 16], // October
  [15, 15], // November
  [15, 16], // December
  [15, 16], // January
  [14, 14], // February
  [15, 16], // March
  [15, 15], // April
  [15, 16], // May
  [15, 15], // June
] as const;

/** Cumulative first-day-of-season for each of the 24 half-months. */
const HALF_MONTH_STARTS: number[] = (() => {
  const starts: number[] = [];
  let day = 0;
  for (const [first, second] of HALF_MONTH_LENGTHS) {
    starts.push(day);
    day += first;
    starts.push(day);
    day += second;
  }
  return starts;
})();

/** Days in a season, by the canonical calendar above. */
export const DAYS_IN_SEASON = HALF_MONTH_LENGTHS.reduce((sum, [a, b]) => sum + a + b, 0);

/** Which of the 24 half-months a day-of-season falls in. Clamped, so a stray value can't index off. */
export function halfMonthOf(dayOfSeason: number): number {
  const day = Math.max(0, Math.min(DAYS_IN_SEASON - 1, Math.floor(dayOfSeason)));
  let index = 0;
  for (let i = 0; i < HALF_MONTH_STARTS.length; i++) {
    if (day >= (HALF_MONTH_STARTS[i] as number)) index = i;
    else break;
  }
  return index;
}

/**
 * The `p`-th percentile of a set of day-of-season values, by nearest rank.
 *
 * Nearest rank rather than an interpolating percentile because the inputs are whole days and the
 * output is snapped to a half-month regardless — interpolating would compute a fractional day nobody
 * would ever see and would make the function harder to reason about at n = 2, which is the commonest
 * size a real cluster will be for years.
 */
export function percentileDay(days: readonly number[], p: number): number {
  if (days.length === 0) return 0;
  const sorted = [...days].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))));
  return sorted[rank] as number;
}

/**
 * A human phrase for the window between two days-of-season, widened to whole half-months.
 *
 * Returns `null` for an empty window, so a caller renders nothing rather than a sentence with a hole
 * in it — the timing clause is optional in the advisory and its absence says less than a bad guess.
 *
 * The label collapses a fully-covered month to its bare name, which is what makes the plan's own
 * example come out right: a window from the late half of December to the late half of February reads
 * *"late December to February"*, because February is covered end to end while December is not.
 */
export function timingWindowLabel(p25Day: number, p75Day: number): string | null {
  if (!Number.isFinite(p25Day) || !Number.isFinite(p75Day)) return null;
  let start = halfMonthOf(Math.min(p25Day, p75Day));
  let end = halfMonthOf(Math.max(p25Day, p75Day));

  // Widen to the minimum, symmetrically where there is room on both sides. A window pushed against
  // the start of the season grows forwards only, which is the honest direction — there is no ice in
  // June to widen back into.
  while (end - start + 1 < MIN_WINDOW_HALF_MONTHS) {
    if (end < HALF_MONTH_STARTS.length - 1) end += 1;
    else if (start > 0) start -= 1;
    else break;
  }

  const startMonth = Math.floor(start / 2);
  const endMonth = Math.floor(end / 2);
  const coversWholeStartMonth = start % 2 === 0 && (endMonth > startMonth || end % 2 === 1);
  const coversWholeEndMonth = end % 2 === 1 && (endMonth > startMonth || start % 2 === 0);

  if (startMonth === endMonth) {
    return coversWholeStartMonth
      ? (SEASON_MONTHS[startMonth] as string)
      : `${start % 2 === 0 ? 'early' : 'late'} ${SEASON_MONTHS[startMonth]}`;
  }
  const startLabel = coversWholeStartMonth
    ? (SEASON_MONTHS[startMonth] as string)
    : `${start % 2 === 0 ? 'early' : 'late'} ${SEASON_MONTHS[startMonth]}`;
  const endLabel = coversWholeEndMonth
    ? (SEASON_MONTHS[endMonth] as string)
    : `${end % 2 === 0 ? 'early' : 'late'} ${SEASON_MONTHS[endMonth]}`;
  return `${startLabel} to ${endLabel}`;
}
