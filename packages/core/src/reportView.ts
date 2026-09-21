/**
 * Pure presentation helpers for rendering a report (Phase 02a §4, D22–D25). Turns the metric,
 * enum-coded report the server stores into the **imperial**, human-readable strings the UI shows
 * (D25) — kept framework-free in `@skating/core` so **both** the web and mobile apps draw from one
 * source (D7/D40) and the formatting is unit-testable without a DOM.
 *
 * The community ice/surface vocabulary (D23) is coded as `snake_case` enums in `./types`;
 * `humanizeEnum` renders them ("black_ice" → "Black ice") so a vocab change never desyncs a label
 * map.
 */

import type {
  ConditionSource,
  PrecipType,
  SkateQuality,
  SkyCondition,
  ThicknessMethod,
} from './types';
import {
  cmToInches,
  formatTemperatureF,
  formatThicknessInches,
  formatWindMph,
  roundTo,
} from './units';

/** `snake_case` enum token → sentence-case label ("orange_peel" → "Orange peel"). */
export function humanizeEnum(token: string): string {
  const spaced = token.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Thickness reading measurement trust (D22, D195) — `estimated` is lower-trust than `measured`, and
 * a `poke` is the skater's pole test, labeled as such so it never reads as a drilled number.
 */
export const THICKNESS_METHOD_LABELS: Record<ThicknessMethod, string> = {
  measured: 'measured',
  estimated: 'estimated',
  poke: 'poke test',
};

/** One thickness reading as stored: a single value XOR a range (min-only = lower bound), validated in core. */
export interface ThicknessReading {
  valueCm?: number;
  minCm?: number;
  maxCm?: number;
  method: ThicknessMethod;
  pokeCount?: number;
  supportable?: boolean;
  note?: string;
}

/** The cm part of a reading in inches — `4″`, `2–4″`, or `4″+` for a lower bound; `null` when there is none. */
function formatThicknessCm(reading: ThicknessReading, decimals: number): string | null {
  if (reading.valueCm !== undefined) return formatThicknessInches(reading.valueCm, decimals);
  if (reading.minCm !== undefined) {
    // A range shares one ″ glyph ("2–4″"), so it formats the endpoints inline rather than via
    // formatThicknessInches (which would double the glyph).
    const min = roundTo(cmToInches(reading.minCm), decimals);
    if (reading.maxCm === undefined) return `${min}″+`;
    const max = roundTo(cmToInches(reading.maxCm), decimals);
    return `${min}–${max}″`;
  }
  return null;
}

/**
 * Format a thickness reading in inches with its measurement method, e.g. `4″ (measured)`,
 * `2–4″ (estimated)`, `4″+ (estimated)` for a lower bound, or `5 pokes, 3–4″ (poke test)` — a poke
 * reading leads with its count, because the count is the reading and the inches are the skater's
 * guess beside it (D195). "Supportable" / "unsupportable" is appended as the skater's word, never
 * ours (D3). Returns `null` for a reading that carries nothing (the core validator forbids that,
 * but the display layer never assumes clean input).
 */
export function formatThicknessReading(reading: ThicknessReading, decimals = 1): string | null {
  const cm = formatThicknessCm(reading, decimals);
  const parts: string[] = [];
  if (reading.method === 'poke' && reading.pokeCount !== undefined) {
    parts.push(`${reading.pokeCount} ${reading.pokeCount === 1 ? 'poke' : 'pokes'}`);
  }
  if (cm !== null) parts.push(cm);
  if (parts.length === 0) return null;
  const method = ` (${THICKNESS_METHOD_LABELS[reading.method]})`;
  const supportable =
    reading.supportable === undefined
      ? ''
      : reading.supportable
        ? ', supportable'
        : ', unsupportable';
  return `${parts.join(', ')}${method}${supportable}`;
}

/** Snow cover depth in inches, e.g. `1.5″` — same imperial format as an ice-thickness value. */
export function formatSnowCoverInches(cm: number, decimals = 1): string {
  return formatThicknessInches(cm, decimals);
}

/** Coarse skating quality (D23) — never a safety verdict (D3). */
export const SKATE_QUALITY_LABELS: Record<SkateQuality, string> = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

export const SKY_LABELS: Record<SkyCondition, string> = {
  clear: 'Clear',
  partly_cloudy: 'Partly cloudy',
  overcast: 'Overcast',
  precip: 'Precipitation',
};

export const PRECIP_LABELS: Record<PrecipType, string> = {
  none: 'None',
  rain: 'Rain',
  snow: 'Snow',
  sleet: 'Sleet',
};

/** Manual conditions AT skate time (D19); Open-Meteo auto-fill is Phase 10. */
export interface ReportConditions {
  airTempC?: number;
  windSpeedKph?: number;
  windDir?: string;
  sky?: SkyCondition;
  precip?: PrecipType;
  source: ConditionSource;
}

/**
 * Conditions → a list of `{ label, value }` rows for the detail panel, imperial + humanized,
 * skipping any field the reporter left blank. Wind direction (already a compass label like `NW`)
 * rides alongside the speed when present.
 */
export function formatConditions(conditions: ReportConditions): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (conditions.airTempC !== undefined) {
    rows.push({ label: 'Air temp', value: formatTemperatureF(conditions.airTempC) });
  }
  if (conditions.windSpeedKph !== undefined) {
    const speed = formatWindMph(conditions.windSpeedKph);
    rows.push({
      label: 'Wind',
      value: conditions.windDir ? `${speed} ${conditions.windDir}` : speed,
    });
  }
  if (conditions.sky !== undefined) rows.push({ label: 'Sky', value: SKY_LABELS[conditions.sky] });
  if (conditions.precip !== undefined) {
    rows.push({ label: 'Precip', value: PRECIP_LABELS[conditions.precip] });
  }
  return rows;
}

/**
 * Skate-end time (the primary sort key everywhere, D28; Phase 05 rename) as a readable local
 * timestamp, e.g. `Jan 5, 2026, 2:30 PM`. `timeZone` is injectable so the format is testable
 * deterministically; the UI omits it to render in the viewer's local zone.
 */
export function formatSkateTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(ms));
}

/** A duration in minutes as a compact label: `45m` · `1h` · `1h 30m`. Rounds to the nearest minute. */
export function formatDurationLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Format the skate window's *duration* for display (Phase 05) — the derived `end − start`, never a
 * stored field. Returns `null` when there's no start (an end-only report), so the UI can omit the
 * duration chip. A zero/negative span (should not occur post-validation) also yields `null`.
 */
export function formatSkateWindow(end: number, start?: number): string | null {
  if (start === undefined) return null;
  const minutes = (end - start) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return formatDurationLabel(minutes);
}
