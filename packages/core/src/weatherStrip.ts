/**
 * The "weather-since" strip copy + display gates (Phase 10 / §3 / D19). **Plain-text, verdict-free**
 * (founder call 2026-07-22): it states what the weather *did*, never what the ice *is* (D3) — no
 * "safe/unsafe," no arrows, no color-coded verdict. The degree-hour integrals the decay model uses stay
 * model-internal; the strip shows only the human subset, in **imperial** (D25).
 *
 * Two surfaces, two window rules (both feed off `summarizeWeatherSince`):
 *   - **report strip:** window = since the skate; shown only once it's `>~6h` old (a fresh report has no
 *     weather-since) and collapses to a plain age line past `~14d` (stale on its own terms — §3);
 *   - **hazard strip:** a rolling recent window (`~7d`, matching the decay cron) since last confirmed —
 *     "since first reported" is meaningless for a season-long ridge.
 */

import {
  cmToInches,
  formatTemperatureF,
  formatWindMph,
  kphToMph,
  mmToInches,
  roundTo,
} from './units';
import type { WeatherSinceSummary } from './weather';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The rolling recent-weather window (days) a hazard's strip and the decay cron both look back over —
 * single-sourced here so the two can't drift (the convex cron imports this same constant). "Recent
 * conditions are what erode confidence; a month-old thaw is irrelevant" (§4/§6).
 */
export const HAZARD_WEATHER_LOOKBACK_DAYS = 7;

/** Below this much rain/snow we don't mention precip (rounding noise, not weather worth reporting). */
const PRECIP_MENTION_MM = 0.2;
const PRECIP_MENTION_CM = 0.2;
/** Only call out gusts once they're brisk enough to matter to a skater. */
const GUST_MENTION_MPH = 15;

/**
 * The plain-text weather-since line (imperial), e.g.
 * `peak 41°F · low 22°F · 3 nights below freezing · 6h sun · 0.5″ rain · gusts to 30 mph`.
 * Returns `null` when there's nothing to say (no data). **Descriptive only** — never a verdict (D3).
 */
export function formatWeatherSinceStrip(s: WeatherSinceSummary): string | null {
  const parts: string[] = [];
  if (s.peakTempC !== null) parts.push(`peak ${formatTemperatureF(s.peakTempC)}`);
  if (s.minTempC !== null) parts.push(`low ${formatTemperatureF(s.minTempC)}`);
  if (s.nightsBelowFreezing !== null && s.nightsBelowFreezing > 0) {
    const n = s.nightsBelowFreezing;
    parts.push(`${n} ${n === 1 ? 'night' : 'nights'} below freezing`);
  }
  const sunHours = Math.round(s.hoursOfSun);
  if (sunHours >= 1) parts.push(`${sunHours}h sun`);

  // Precipitation — prefer the rain/snow split (opposite meanings), fall back to lumped precip.
  if (s.rainMm > PRECIP_MENTION_MM) parts.push(`${roundTo(mmToInches(s.rainMm), 2)}″ rain`);
  if (s.snowfallCm > PRECIP_MENTION_CM) parts.push(`${roundTo(cmToInches(s.snowfallCm), 1)}″ snow`);
  if (
    s.rainMm <= PRECIP_MENTION_MM &&
    s.snowfallCm <= PRECIP_MENTION_CM &&
    s.totalPrecipMm > PRECIP_MENTION_MM
  ) {
    parts.push(`${roundTo(mmToInches(s.totalPrecipMm), 2)}″ precip`);
  }

  if (s.maxWindGustKph !== null && kphToMph(s.maxWindGustKph) >= GUST_MENTION_MPH) {
    parts.push(`gusts to ${formatWindMph(s.maxWindGustKph)}`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface ReportStripOptions {
  /** Below this age a report has ~no weather-since — don't show the strip. Default 6h. */
  minAgeHours?: number;
  /** Past this age the report is stale on its own terms — collapse to an age line. Default 14 days. */
  maxAgeDays?: number;
}

export type ReportStripState =
  | { kind: 'hidden' } // too fresh — no meaningful weather-since yet
  | { kind: 'aged' } // too old — the UI shows a plain "reported N ago" age line instead
  | { kind: 'strip'; windowStartMs: number };

/**
 * Whether/how to show the weather-since strip on a **report** (§3). The UI fetches
 * `getWeatherSinceForBody({ startMs: windowStartMs })` only for `kind: 'strip'`.
 */
export function reportStripState(
  skateEndTime: number,
  now: number,
  opts: ReportStripOptions = {},
): ReportStripState {
  const minAgeMs = (opts.minAgeHours ?? 6) * HOUR_MS;
  const maxAgeMs = (opts.maxAgeDays ?? 14) * DAY_MS;
  const age = now - skateEndTime;
  if (age < minAgeMs) return { kind: 'hidden' };
  if (age > maxAgeMs) return { kind: 'aged' };
  return { kind: 'strip', windowStartMs: skateEndTime };
}

/**
 * The window start for a **hazard**'s recent-weather strip: `max(lastConfirmedAt, now − lookback)`. Same
 * window the decay cron uses (default 7 days) so the strip and the decay agree on one shared fetch (§3).
 */
export function hazardStripWindowStartMs(
  lastConfirmedAt: number,
  now: number,
  lookbackDays = HAZARD_WEATHER_LOOKBACK_DAYS,
): number {
  return Math.max(lastConfirmedAt, now - lookbackDays * DAY_MS);
}
