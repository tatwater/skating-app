/**
 * Pure presentation helpers for rendering a report (Phase 2 §D, D22–D25). Turns the metric,
 * enum-coded report the server stores into the **imperial**, human-readable strings the web UI
 * shows (D25) — kept out of the React components so the formatting is unit-testable without a DOM
 * (the web analog of `waterMap.ts`). Mobile owns its own copy of these presentational bits.
 *
 * The community ice/surface vocabulary (D23) is coded as `snake_case` enums in `@skating/core`;
 * `humanizeEnum` renders them ("black_ice" → "Black ice") so a vocab change never desyncs a label
 * map. Only the visibility labels get an explicit map (their wording isn't a mechanical de-casing).
 */

import type {
  ConditionSource,
  PrecipType,
  SkateQuality,
  SkyCondition,
  ThicknessMethod,
  Visibility,
} from '@skating/core'
import {
  cmToInches,
  formatTemperatureF,
  formatThicknessInches,
  formatWindMph,
  roundTo,
} from '@skating/core'

/** `snake_case` enum token → sentence-case label ("orange_peel" → "Orange peel"). */
export function humanizeEnum(token: string): string {
  const spaced = token.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Per-report visibility, worded for the reader (not a mechanical de-casing of the enum). */
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  just_me: 'Only me',
  friends: 'Friends',
  followers: 'Followers',
  public: 'Public',
}

/** Thickness reading measurement trust (D22) — `estimated` is lower-trust than `measured`. */
export const THICKNESS_METHOD_LABELS: Record<ThicknessMethod, string> = {
  measured: 'measured',
  estimated: 'estimated',
}

/** One thickness reading as stored: a single value XOR a min/max range (validated in core). */
export interface ThicknessReading {
  valueCm?: number
  minCm?: number
  maxCm?: number
  method: ThicknessMethod
  note?: string
}

/**
 * Format a thickness reading in inches with its measurement method, e.g. `4″ (measured)` or
 * `2–4″ (estimated)`. Returns `null` for a reading that carries neither a value nor a full range
 * (the core validator forbids that, but the display layer never assumes clean input).
 */
export function formatThicknessReading(reading: ThicknessReading, decimals = 1): string | null {
  const method = ` (${THICKNESS_METHOD_LABELS[reading.method]})`
  if (reading.valueCm !== undefined) {
    return `${formatThicknessInches(reading.valueCm, decimals)}${method}`
  }
  if (reading.minCm !== undefined && reading.maxCm !== undefined) {
    // A range shares one ″ glyph ("2–4″"), so it formats the endpoints inline rather than via
    // formatThicknessInches (which would double the glyph).
    const min = roundTo(cmToInches(reading.minCm), decimals)
    const max = roundTo(cmToInches(reading.maxCm), decimals)
    return `${min}–${max}″${method}`
  }
  return null
}

/** Snow cover depth in inches, e.g. `1.5″` — same imperial format as an ice-thickness value. */
export function formatSnowCoverInches(cm: number, decimals = 1): string {
  return formatThicknessInches(cm, decimals)
}

/** Coarse skating quality (D23) — never a safety verdict (D3). */
export const SKATE_QUALITY_LABELS: Record<SkateQuality, string> = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
}

export const SKY_LABELS: Record<SkyCondition, string> = {
  clear: 'Clear',
  partly_cloudy: 'Partly cloudy',
  overcast: 'Overcast',
  precip: 'Precipitation',
}

export const PRECIP_LABELS: Record<PrecipType, string> = {
  none: 'None',
  rain: 'Rain',
  snow: 'Snow',
  sleet: 'Sleet',
}

/** Manual conditions AT skate time (D19); Open-Meteo auto-fill is Phase 10. */
export interface ReportConditions {
  airTempC?: number
  windSpeedKph?: number
  windDir?: string
  sky?: SkyCondition
  precip?: PrecipType
  source: ConditionSource
}

/**
 * Conditions → a list of `{ label, value }` rows for the detail panel, imperial + humanized,
 * skipping any field the reporter left blank. Wind direction (already a compass label like `NW`)
 * rides alongside the speed when present.
 */
export function formatConditions(conditions: ReportConditions): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  if (conditions.airTempC !== undefined) {
    rows.push({ label: 'Air temp', value: formatTemperatureF(conditions.airTempC) })
  }
  if (conditions.windSpeedKph !== undefined) {
    const speed = formatWindMph(conditions.windSpeedKph)
    rows.push({
      label: 'Wind',
      value: conditions.windDir ? `${speed} ${conditions.windDir}` : speed,
    })
  }
  if (conditions.sky !== undefined) rows.push({ label: 'Sky', value: SKY_LABELS[conditions.sky] })
  if (conditions.precip !== undefined) {
    rows.push({ label: 'Precip', value: PRECIP_LABELS[conditions.precip] })
  }
  return rows
}

/**
 * Skate time (the primary sort key everywhere, D28) as a readable local timestamp, e.g.
 * `Jan 5, 2026, 2:30 PM`. `timeZone` is injectable so the format is testable deterministically;
 * the UI omits it to render in the viewer's local zone.
 */
export function formatSkateTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(ms))
}
