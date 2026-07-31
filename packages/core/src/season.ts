/**
 * Seasons (D63) — the vocabulary every seasonal read is derived from.
 *
 * **A season is July 1 → June 30, labelled by the two calendar years it spans: `'24/'25`.** July is the
 * deadest point of the year in the Northeast, so the boundary never cuts a live season and the reset
 * lands when nobody is looking at the map.
 *
 * **Derived, never stored.** There is no `season` column, no backfill, no cron to advance anything and
 * nothing to drift. The seasonal reset is not an event — it is `seasonOf(now)` returning a different
 * number, and every query following it. The mechanical payoff is real: `skateEndTime` is already the
 * range field of `by_water_body_moderation_and_skate_end_time`, `by_moderation_and_skate_end_time` and
 * `by_author_skate_end_time`, so a season lower bound makes those reads **cheaper** rather than more
 * expensive.
 *
 * **A season is represented as the calendar year it starts in** — `2024` *is* `'24/'25`. One number,
 * orderable, subtractable, and impossible to get half-right the way a `{start, end}` pair can be.
 *
 * **The boundary is UTC**, like every other calendar computation in this package (`age`, `dob`,
 * `metrics`). In the Northeast that puts it at 8pm ET on June 30 rather than midnight — four hours
 * astray, in the single deadest week of the skating year. Choosing a timezone would buy nothing and
 * would need a rule for a corpus that eventually spans more than one.
 *
 * What this module deliberately does **not** know: which reads are scoped. Put-ins, analytics rollups,
 * moderation queues, `bodyFeatures` and a profile's own history are all exempt for their own reasons —
 * see the phase doc. This file only answers "which season is this instant in".
 */

/**
 * A season, named by the calendar year it begins in: `2024` means the season running from
 * 1 July 2024 to 30 June 2025, displayed as `'24/'25`.
 */
export type Season = number;

/** The month a season starts in, 1-based like a human calendar reads it. July (D63). */
export const SEASON_START_MONTH = 7;

/** `Date.UTC`'s month argument is 0-based; this is the one place that conversion happens. */
const SEASON_START_MONTH_INDEX = SEASON_START_MONTH - 1;

/**
 * The season an instant falls in. Anything from July 1 onward belongs to the season named by that
 * calendar year; anything before it belongs to the one that started the previous July.
 *
 * Total over every finite input — there is no "not in a season" — which is what lets callers treat it
 * as a plain projection rather than something that can fail.
 */
export function seasonOf(ms: number): Season {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= SEASON_START_MONTH_INDEX ? year : year - 1;
}

/** The season we are in right now — the one every unscoped read defaults to. */
export function currentSeason(now: number): Season {
  return seasonOf(now);
}

/**
 * The earliest season anyone may ask for. Nordic skating predates it by centuries; what this bounds is
 * the *argument*, and no report in this app can be older than the app.
 */
export const EARLIEST_BROWSABLE_SEASON = 1900;

/**
 * Is this a season a client is allowed to name?
 *
 * Every seasonal read takes `season` as a bare optional number off the wire, which means it can arrive
 * as `NaN`, a fraction, or `1e15`. None of those throw: they turn into index bounds that match nothing,
 * so the screen goes empty and says a lake had a quiet winter. Callers pair this with "absent ⇒ this
 * season" so a nonsense argument lands on the same honest default as no argument at all, rather than on
 * a silent lie about the lake.
 */
export function isBrowsableSeason(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= EARLIEST_BROWSABLE_SEASON &&
    value <= EARLIEST_BROWSABLE_SEASON + 500
  );
}

/**
 * The season a read should actually use: the one asked for if it is nameable, otherwise `fallback`.
 *
 * The single place the wire value is sanitized, so a new seasonal read gets the behaviour by calling
 * one function rather than by remembering the argument is unvalidated.
 */
export function resolveSeason(requested: number | undefined, fallback: Season): Season {
  return requested !== undefined && isBrowsableSeason(requested) ? requested : fallback;
}

/**
 * The first instant of a season (inclusive) — the lower bound handed to an index range.
 *
 * `seasonStartMs(seasonOf(t)) <= t` for every `t`, which is the property every scoped read leans on.
 */
export function seasonStartMs(season: Season): number {
  return Date.UTC(season, SEASON_START_MONTH_INDEX, 1);
}

/**
 * The first instant of the *next* season — an **exclusive** upper bound, so `[start, end)` tiles the
 * timeline with no gap and no overlap. Half-open on purpose: a closed bound needs an "end minus one
 * millisecond" somewhere, and that is the kind of thing that is wrong by exactly one millisecond for
 * years without anyone noticing.
 */
export function seasonEndMs(season: Season): number {
  return seasonStartMs(season + 1);
}

/** Is this instant inside this season? `[start, end)`, matching the bounds above. */
export function isInSeason(ms: number, season: Season): boolean {
  return ms >= seasonStartMs(season) && ms < seasonEndMs(season);
}

/** The season before this one. Trivial by construction — which is the point of the representation. */
export function previousSeason(season: Season): Season {
  return season - 1;
}

/**
 * `'24/'25` — the label, everywhere it appears. Two-digit years with the leading apostrophes a skater
 * writes them with, because a season spans New Year and "the 2024 season" is ambiguous to exactly the
 * people this app is for.
 */
export function formatSeason(season: Season): string {
  return `'${twoDigit(season)}/'${twoDigit(season + 1)}`;
}

/** Last two digits of a year, zero-padded — so 2000/2001 reads `'00/'01` rather than `'0/'1`. */
function twoDigit(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, '0');
}

/**
 * Every season from the one containing `fromMs` through the one containing `toMs`, **newest first** —
 * the season selector's option list.
 *
 * Built from two instants rather than two seasons because that is what the callers hold: the earliest
 * report on a water body (one row, read ascending off an index the lake page already uses) and `now`.
 * Returns a single entry when both land in the same season, and `[]` never — a lake with no reports at
 * all still offers the current season, because that's the one it's showing.
 */
export function seasonsBetween(fromMs: number, toMs: number): Season[] {
  const first = seasonOf(Math.min(fromMs, toMs));
  const last = seasonOf(Math.max(fromMs, toMs));
  const seasons: Season[] = [];
  for (let s = last; s >= first; s--) seasons.push(s);
  return seasons;
}

/**
 * How many whole days into its season a moment falls — 0 on July 1 (N5c / §C6).
 *
 * The unit the timing window is computed in, and it has to be *relative to the season* rather than a
 * calendar day-of-year: a window that straddles the new year is the normal case here, and day-of-year
 * would put late December at 360 and early January at 5, which no percentile can read as adjacent.
 */
export function dayOfSeason(ms: number, season: Season = seasonOf(ms)): number {
  return Math.floor((ms - seasonStartMs(season)) / 86_400_000);
}
