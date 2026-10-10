/**
 * The season watch's settings and the one evaluation every reader shares (A06i §1, D213).
 *
 * `ingestGate` holds the rules; this holds the *knobs* and the order they are applied in, so the
 * daily cron and `/admin/seasons`' preview cannot disagree about what a setting means. The preview
 * replays past seasons through {@link evaluateSeason} with edited values, and the cron decides the
 * live season through the same function with the saved ones — one rule, one answer.
 *
 * ## ⚠ Air temperature, never ice (D3)
 *
 * Every threshold here is an overnight **air** low at a coordinate. A sentinel "firing" means a
 * summit had a cold night; it says nothing about whether any lake holds ice, and nothing built on it
 * may say otherwise. The watch is a monitoring window — it decides when we start *looking* (D149).
 */

import { archiveSeasonLabel } from './imageryArchive';
import {
  addDaysIso,
  type DailyLow,
  DEFAULT_CORPUS_FRACTION,
  DEFAULT_FREEZE_C,
  DEFAULT_SENTINEL_NIGHTS,
  DEFAULT_THAW_C,
  DEFAULT_THAW_RUN_DAYS,
  DEFAULT_WINTER_FRACTION,
  type GateWindow,
  ingestWindow,
  type SiteLow,
  type SiteSeries,
} from './ingestGate';

/** Every knob the watch has. Temperatures are °C — the UI shows °F first and converts. */
export interface SeasonWatchSettings {
  /** `MM-DD`, July–December: the earliest night in a season that may count for anything. */
  startMonthDay: string;
  /** An overnight low at or below this is "freezing" for every rule. */
  freezeC: number;
  /** Consecutive freezing nights at one sentinel before it opens the watch. */
  sentinelNights: number;
  /** Fraction of ordinary sites freezing on one night that opens the watch without a sentinel. */
  corpusFraction: number;
  /** Fraction of ordinary sites freezing on one night that counts as winter region-wide. */
  winterFraction: number;
  /** The sentinel low that sends the "time to start satellite imagery" email. */
  imageryNudgeC: number;
  /** A night above this counts as thawed at an ordinary site. */
  thawC: number;
  /** Consecutive all-thawed nights that end the watch. */
  thawRunDays: number;
  /** How many ordinary lakes the cron samples beside the sentinels and the pinned sites. */
  sampleSize: number;
}

export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

/** The founder's imagery line (2026-10-06): the first 20 °F night at a sentinel. */
export const IMAGERY_NUDGE_F = 20;

/** The founder's October floor (2026-08-25) — see `imageryIngest.ts`. */
export const DEFAULT_START_MONTH_DAY = '10-01';

/**
 * Ordinary lakes sampled beside the roster. Enough that `corpusFraction`'s 10% means "a few sites
 * agreed" rather than "one site is noisy", and small enough to stay one Open-Meteo request.
 */
export const DEFAULT_SAMPLE_SITES = 24;

/** The most ordinary lakes the sample may hold. */
export const MAX_SAMPLE_SITES = 60;

/** The most sentinels, and the most pinned sites, a roster may name. */
export const MAX_ROSTER_SITES = 10;

/** The settings D149 shipped with, so nothing moves until someone saves an edit. */
export const DEFAULT_SEASON_WATCH_SETTINGS: SeasonWatchSettings = {
  startMonthDay: DEFAULT_START_MONTH_DAY,
  freezeC: DEFAULT_FREEZE_C,
  sentinelNights: DEFAULT_SENTINEL_NIGHTS,
  corpusFraction: DEFAULT_CORPUS_FRACTION,
  winterFraction: DEFAULT_WINTER_FRACTION,
  imageryNudgeC: fahrenheitToCelsius(IMAGERY_NUDGE_F),
  thawC: DEFAULT_THAW_C,
  thawRunDays: DEFAULT_THAW_RUN_DAYS,
  sampleSize: DEFAULT_SAMPLE_SITES,
};

/**
 * The earliest floor the editor accepts: the history fill (`seasonWatch.fillSeason`) keeps lows from
 * this day on, so a floor before it would preview a season missing nights the live cron counts.
 */
export const EARLIEST_START_MONTH_DAY = '09-01';

const MONTH_DAY = /^(09|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Everything wrong with a settings object, as sentences an admin can act on. Empty means valid.
 *
 * The bounds are sanity, not policy: they refuse values that would make a rule meaningless (a
 * fraction above one, a run of zero nights) and leave every judgment call to the person editing.
 */
export function validateSeasonWatchSettings(settings: SeasonWatchSettings): string[] {
  const errors: string[] = [];
  const within = (value: number, min: number, max: number, message: string) => {
    if (!Number.isFinite(value) || value < min || value > max) errors.push(message);
  };
  const whole = (value: number, min: number, max: number, message: string) => {
    if (!Number.isInteger(value) || value < min || value > max) errors.push(message);
  };

  const monthDay = MONTH_DAY.exec(settings.startMonthDay);
  if (!monthDay) {
    errors.push('The earliest date must be MM-DD between September and December.');
  } else {
    const [month, day] = [Number(monthDay[1]), Number(monthDay[2])];
    // A real calendar day — 31 September and 31 November do not exist in any year.
    const probe = new Date(Date.UTC(2001, month - 1, day));
    if (probe.getUTCMonth() !== month - 1) errors.push('The earliest date is not a real day.');
  }
  within(settings.freezeC, -20, 5, 'The freezing line must be between −4 °F and 41 °F.');
  whole(settings.sentinelNights, 1, 14, 'Sentinel nights must be a whole number from 1 to 14.');
  within(settings.corpusFraction, 0.01, 1, 'The ordinary-lake opening share must be 1–100%.');
  within(settings.winterFraction, 0.01, 1, 'The winter share must be 1–100%.');
  within(settings.imageryNudgeC, -40, 5, 'The imagery line must be between −40 °F and 41 °F.');
  within(settings.thawC, -10, 10, 'The thaw line must be between 14 °F and 50 °F.');
  whole(settings.thawRunDays, 1, 60, 'Thawed nights must be a whole number from 1 to 60.');
  whole(
    settings.sampleSize,
    1,
    MAX_SAMPLE_SITES,
    `The sample must be a whole number from 1 to ${MAX_SAMPLE_SITES} lakes.`,
  );
  return errors;
}

/** `winter-2026-27` → `2026`. Throws on anything else, because a wrong year files a season wrongly. */
export function seasonStartYear(label: string): number {
  const match = /^winter-(\d{4})-(\d{2})$/.exec(label);
  if (!match || archiveSeasonLabel(Number(match[1])) !== label) {
    throw new Error(`not a season label: ${label}`);
  }
  return Number(match[1]);
}

/** The first date a season's observations may count from — its start year plus `startMonthDay`. */
export function seasonFloorDate(label: string, startMonthDay: string): string {
  return `${seasonStartYear(label)}-${startMonthDay}`;
}

/**
 * Drop every observation before `floor`, and every site left with none.
 *
 * ⚠ **The floor bounds the observations, not just the tick** — the reason this lives here rather
 * than in the cron. `past_days` reaches back 92 days, so the first October tick carries the summit's
 * August nights, and `ingestWindow` returns the earliest freeze in whatever it is handed.
 */
export function clipToFloor(series: readonly SiteSeries[], floor: string): SiteSeries[] {
  return series
    .map((s) => ({ ...s, days: s.days.filter((d) => d.date >= floor) }))
    .filter((s) => s.days.length > 0);
}

/** The first night on or after `from` at which `site` was at or below `thresholdC`. */
export function firstNightAtOrBelow(
  site: SiteSeries,
  thresholdC: number,
  from = '',
): DailyLow | null {
  let first: DailyLow | null = null;
  for (const day of site.days) {
    if (day.date >= from && day.minTempC <= thresholdC && (!first || day.date < first.date)) {
      first = day;
    }
  }
  return first;
}

/**
 * The first night on or after `from` at which **any sentinel** was at or below `thresholdC`, and
 * every sentinel that was, coldest first — the imagery email's trigger and its table.
 */
export function firstSentinelNightAtOrBelow(
  series: readonly SiteSeries[],
  thresholdC: number,
  from = '',
): { date: string; sites: SiteLow[] } | null {
  const hits = series
    .filter((s) => s.sentinel)
    .map((s) => ({ siteId: s.siteId, night: firstNightAtOrBelow(s, thresholdC, from) }))
    .filter((h): h is { siteId: string; night: DailyLow } => h.night !== null);
  if (hits.length === 0) return null;
  const date = hits.map((h) => h.night.date).sort()[0] as string;
  const sites = hits
    .filter((h) => h.night.date === date)
    .map((h) => ({ siteId: h.siteId, lowC: h.night.minTempC }))
    .sort((a, b) => (a.lowC === b.lowC ? a.siteId.localeCompare(b.siteId) : a.lowC - b.lowC));
  return { date, sites };
}

export interface SeasonEvaluation extends GateWindow {
  /** The first date observations counted from. */
  floor: string;
  /** The first sentinel night at or below the imagery line, on or after the watch opened. */
  imageryNudge: { date: string; sites: SiteLow[] } | null;
}

/**
 * One season, under one set of settings — the function the cron and the preview share.
 *
 * The imagery nudge is looked for only once the watch has opened: with `sentinelNights` above one, a
 * summit can dip to 20 °F on a night that does not yet open anything, and "start the imagery" before
 * "the watch has begun" is an email in the wrong order.
 */
export function evaluateSeason(
  series: readonly SiteSeries[],
  settings: SeasonWatchSettings,
  season: string,
): SeasonEvaluation {
  const floor = seasonFloorDate(season, settings.startMonthDay);
  const clipped = clipToFloor(series, floor);
  const window = ingestWindow(clipped, {
    freezeC: settings.freezeC,
    sentinelNights: settings.sentinelNights,
    corpusFraction: settings.corpusFraction,
    winterFraction: settings.winterFraction,
    thawC: settings.thawC,
    thawRunDays: settings.thawRunDays,
  });
  const imageryNudge = window.opensOn
    ? firstSentinelNightAtOrBelow(clipped, settings.imageryNudgeC, window.opensOn)
    : null;
  return { ...window, floor, imageryNudge };
}

/**
 * A site's lows stored compactly: the first date and one value per following day, `null` for a gap.
 * One document per site per season holds ~270 numbers this way, where a document per night would be
 * ~7,000 rows a season for the page to read.
 */
export interface CompactLows {
  firstDate: string;
  lows: (number | null)[];
}

export function expandLows(compact: CompactLows): DailyLow[] {
  const out: DailyLow[] = [];
  compact.lows.forEach((minTempC, i) => {
    if (minTempC !== null) out.push({ date: addDaysIso(compact.firstDate, i), minTempC });
  });
  return out;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Fold freshly fetched nights into what is stored. A fetched night **replaces** a stored one: the
 * forecast endpoint's past days are revised as observations arrive, and the latest is the best.
 * Nights never fetched again are kept, which is the point of storing them at all.
 */
export function mergeLows(existing: CompactLows | null, days: readonly DailyLow[]): CompactLows {
  const byDate = new Map<string, number | null>();
  if (existing) {
    existing.lows.forEach((low, i) => {
      byDate.set(addDaysIso(existing.firstDate, i), low);
    });
  }
  for (const day of days) byDate.set(day.date, day.minTempC);
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return { firstDate: existing?.firstDate ?? '', lows: [] };
  const firstDate = dates[0] as string;
  const span = daysBetween(firstDate, dates[dates.length - 1] as string) + 1;
  const lows: (number | null)[] = Array.from({ length: span }, (_, i) => {
    const value = byDate.get(addDaysIso(firstDate, i));
    return value === undefined ? null : value;
  });
  return { firstDate, lows };
}

/** `31.3°F (−0.4°C)` — °F first, the founder's units (2026-10-06), with a true minus sign. */
export function formatLow(lowC: number): string {
  const minus = (n: number, digits: number) => {
    const text = n.toFixed(digits);
    // `-0.0` is a rounding artifact, not a reading below zero.
    return Number(text) === 0 ? (0).toFixed(digits) : text.replace('-', '−');
  };
  return `${minus(celsiusToFahrenheit(lowC), 1)}°F (${minus(lowC, 1)}°C)`;
}
