/**
 * Report input validation + normalization (D22–D25/D41) — the single client-and-server contract
 * (re-enforced server-side per D37). The report form validates with this before submit, and
 * `reports.create` re-runs it at the trust boundary, so the rules live in exactly one place.
 *
 * Observation-friendly (D3): nothing about ice *quality* is required — a "don't skate here" report
 * carrying only `notes` is valid. What's required is just the anchor: a water body, when it was
 * skated, and who can see it. Visibility is additionally capped at the author's
 * `maxVisibilityForProfile` ceiling (D41) so a minor author can never post `public`.
 */

import type { LatLng } from './geometry'
import {
  CONDITION_SOURCES,
  type ConditionSource,
  ICE_TYPES,
  type IceType,
  PRECIP_TYPES,
  type PrecipType,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  type SkateQuality,
  type SkyCondition,
  SURFACE_TAGS,
  type SurfaceTag,
  THICKNESS_METHODS,
  type ThicknessMethod,
  VISIBILITY_LEVELS,
  type Visibility,
} from './types'

/** A skate time more than this far past `now` is treated as implausibly future and rejected. */
export const SKATE_TIME_FUTURE_TOLERANCE_MS = 60 * 60 * 1000

export interface ThicknessReadingInput {
  valueCm?: number
  minCm?: number
  maxCm?: number
  method: ThicknessMethod
  coord?: LatLng
  note?: string
}

export interface ReportConditionsInput {
  airTempC?: number
  windSpeedKph?: number
  windDir?: string
  sky?: SkyCondition
  precip?: PrecipType
  source?: ConditionSource
}

export interface ReportInput {
  waterBodyId: string
  skateTime: number
  visibility: Visibility
  iceTypes?: IceType[]
  surfaceTags?: SurfaceTag[]
  skateQuality?: SkateQuality
  iceThickness?: { readings: ThicknessReadingInput[] }
  snowCoverCm?: number
  conditions?: ReportConditionsInput
  notes?: string
  /** Optional put-in pin the skater dropped (access point); becomes `reports.point`. */
  point?: LatLng
}

export interface NormalizedThicknessReading {
  valueCm?: number
  minCm?: number
  maxCm?: number
  method: ThicknessMethod
  coord?: LatLng
  note?: string
}

/** Normalized conditions — `source` is always set (defaulted to `user`), matching the stored shape. */
export interface NormalizedConditions {
  airTempC?: number
  windSpeedKph?: number
  windDir?: string
  sky?: SkyCondition
  precip?: PrecipType
  source: ConditionSource
}

/** The clean, defaulted report ready for `reports.create` to server-stamp + insert. */
export interface NormalizedReport {
  waterBodyId: string
  skateTime: number
  visibility: Visibility
  iceTypes: IceType[]
  surfaceTags: SurfaceTag[]
  skateQuality?: SkateQuality
  iceThickness?: { readings: NormalizedThicknessReading[] }
  snowCoverCm?: number
  conditions?: NormalizedConditions
  notes?: string
  point?: LatLng
}

export interface ReportValidationError {
  field: string
  message: string
}

export type ReportValidationResult =
  | { ok: true; normalized: NormalizedReport }
  | { ok: false; errors: ReportValidationError[] }

export interface ReportValidationContext {
  /** Current time (epoch ms) — injected, not read, so validation stays pure/testable. */
  now: number
  /** Widest visibility this author may post at — `maxVisibilityForProfile` (D41). */
  maxVisibility: Visibility
}

function isMember<T extends string>(arr: readonly T[], value: unknown): value is T {
  // `Array.includes` safely returns false for a non-string, so no separate typeof guard is needed.
  return (arr as readonly string[]).includes(value as string)
}

function isValidCoord(coord: LatLng): boolean {
  return (
    Number.isFinite(coord.lat) &&
    Number.isFinite(coord.lng) &&
    coord.lat >= -90 &&
    coord.lat <= 90 &&
    coord.lng >= -180 &&
    coord.lng <= 180
  )
}

/** A finite number ≥ 0 — thickness/snow/wind can't be negative. Callers pass a defined number. */
function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/**
 * Validate one thickness reading, pushing any problems (path-prefixed) into `errors`. Returns the
 * normalized reading, or `null` if it was invalid. Rule (D22): a reading is a single `valueCm`
 * **XOR** a (`minCm`, `maxCm`) range — never both, never neither — with `minCm <= maxCm`.
 */
function validateReading(
  reading: ThicknessReadingInput,
  path: string,
  errors: ReportValidationError[],
): NormalizedThicknessReading | null {
  const before = errors.length
  const { valueCm, minCm, maxCm } = reading

  if (!isMember(THICKNESS_METHODS, reading.method)) {
    errors.push({ field: `${path}.method`, message: 'must be measured or estimated' })
  }

  if (valueCm !== undefined && (minCm !== undefined || maxCm !== undefined)) {
    errors.push({ field: path, message: 'give a single value OR a min/max range, not both' })
  } else if (valueCm !== undefined) {
    if (!isNonNegativeFinite(valueCm)) {
      errors.push({ field: `${path}.valueCm`, message: 'must be a number ≥ 0' })
    }
  } else if (minCm !== undefined || maxCm !== undefined) {
    if (minCm === undefined || maxCm === undefined) {
      errors.push({ field: path, message: 'a range needs both minCm and maxCm' })
    } else if (!isNonNegativeFinite(minCm) || !isNonNegativeFinite(maxCm)) {
      errors.push({ field: path, message: 'minCm and maxCm must be numbers ≥ 0' })
    } else if (minCm > maxCm) {
      errors.push({ field: path, message: 'minCm must be ≤ maxCm' })
    }
  } else {
    errors.push({ field: path, message: 'give a value or a min/max range' })
  }

  if (reading.coord !== undefined && !isValidCoord(reading.coord)) {
    errors.push({ field: `${path}.coord`, message: 'is not a valid coordinate' })
  }

  if (errors.length > before) return null

  const normalized: NormalizedThicknessReading = { method: reading.method }
  if (valueCm !== undefined) normalized.valueCm = valueCm
  else {
    normalized.minCm = minCm
    normalized.maxCm = maxCm
  }
  if (reading.coord !== undefined) normalized.coord = reading.coord
  const note = reading.note?.trim()
  if (note) normalized.note = note
  return normalized
}

function validateConditions(
  conditions: ReportConditionsInput,
  errors: ReportValidationError[],
): NormalizedConditions {
  if (conditions.airTempC !== undefined && !Number.isFinite(conditions.airTempC)) {
    errors.push({ field: 'conditions.airTempC', message: 'must be a number' })
  }
  if (conditions.windSpeedKph !== undefined && !isNonNegativeFinite(conditions.windSpeedKph)) {
    errors.push({ field: 'conditions.windSpeedKph', message: 'must be a number ≥ 0' })
  }
  if (conditions.sky !== undefined && !isMember(SKY_CONDITIONS, conditions.sky)) {
    errors.push({ field: 'conditions.sky', message: 'is not a known sky condition' })
  }
  if (conditions.precip !== undefined && !isMember(PRECIP_TYPES, conditions.precip)) {
    errors.push({ field: 'conditions.precip', message: 'is not a known precipitation type' })
  }
  if (conditions.source !== undefined && !isMember(CONDITION_SOURCES, conditions.source)) {
    errors.push({ field: 'conditions.source', message: 'is not a known source' })
  }

  // Phase 2 conditions are manual entry (D19) — default the provenance to the user. Built even on
  // error (the caller discards it when `errors` is non-empty), so the return type stays concrete.
  const normalized: NormalizedConditions = { source: conditions.source ?? 'user' }
  if (conditions.airTempC !== undefined) normalized.airTempC = conditions.airTempC
  if (conditions.windSpeedKph !== undefined) normalized.windSpeedKph = conditions.windSpeedKph
  const windDir = conditions.windDir?.trim()
  if (windDir) normalized.windDir = windDir
  if (conditions.sky !== undefined) normalized.sky = conditions.sky
  if (conditions.precip !== undefined) normalized.precip = conditions.precip
  return normalized
}

/**
 * Validate + normalize a report submission. Collects *all* problems (so the form can show them at
 * once) rather than failing on the first. On success, returns a `NormalizedReport` with arrays
 * defaulted, strings trimmed, and empty/optional sections dropped — ready for the server to stamp
 * `authorId`/`reportTime`/`point`-fallback and insert.
 */
export function validateReportInput(
  input: ReportInput,
  ctx: ReportValidationContext,
): ReportValidationResult {
  const errors: ReportValidationError[] = []

  if (!input.waterBodyId || input.waterBodyId.trim() === '') {
    errors.push({ field: 'waterBodyId', message: 'is required' })
  }

  if (!Number.isFinite(input.skateTime) || input.skateTime <= 0) {
    errors.push({ field: 'skateTime', message: 'is required' })
  } else if (input.skateTime > ctx.now + SKATE_TIME_FUTURE_TOLERANCE_MS) {
    errors.push({ field: 'skateTime', message: 'cannot be in the future' })
  }

  if (!isMember(VISIBILITY_LEVELS, input.visibility)) {
    errors.push({ field: 'visibility', message: 'is required' })
  } else if (
    VISIBILITY_LEVELS.indexOf(input.visibility) > VISIBILITY_LEVELS.indexOf(ctx.maxVisibility)
  ) {
    errors.push({
      field: 'visibility',
      message: `cannot exceed ${ctx.maxVisibility} for this account`,
    })
  }

  const iceTypes = input.iceTypes ?? []
  for (const [i, t] of iceTypes.entries()) {
    if (!isMember(ICE_TYPES, t))
      errors.push({ field: `iceTypes[${i}]`, message: 'is not a known ice type' })
  }

  const surfaceTags = input.surfaceTags ?? []
  for (const [i, t] of surfaceTags.entries()) {
    if (!isMember(SURFACE_TAGS, t)) {
      errors.push({ field: `surfaceTags[${i}]`, message: 'is not a known surface tag' })
    }
  }

  if (input.skateQuality !== undefined && !isMember(SKATE_QUALITIES, input.skateQuality)) {
    errors.push({ field: 'skateQuality', message: 'is not a known quality' })
  }

  const normalizedReadings: NormalizedThicknessReading[] = []
  if (input.iceThickness !== undefined) {
    const readings = input.iceThickness.readings
    if (!Array.isArray(readings)) {
      errors.push({ field: 'iceThickness.readings', message: 'must be a list of readings' })
    } else {
      for (const [i, reading] of readings.entries()) {
        const normalized = validateReading(reading, `iceThickness.readings[${i}]`, errors)
        if (normalized) normalizedReadings.push(normalized)
      }
    }
  }

  if (input.snowCoverCm !== undefined && !isNonNegativeFinite(input.snowCoverCm)) {
    errors.push({ field: 'snowCoverCm', message: 'must be a number ≥ 0' })
  }

  let normalizedConditions: NormalizedConditions | undefined
  if (input.conditions !== undefined) {
    normalizedConditions = validateConditions(input.conditions, errors)
  }

  if (input.point !== undefined && !isValidCoord(input.point)) {
    errors.push({ field: 'point', message: 'is not a valid coordinate' })
  }

  if (errors.length > 0) return { ok: false, errors }

  const normalized: NormalizedReport = {
    waterBodyId: input.waterBodyId,
    skateTime: input.skateTime,
    visibility: input.visibility,
    iceTypes,
    surfaceTags,
  }
  if (input.skateQuality !== undefined) normalized.skateQuality = input.skateQuality
  // Drop an empty thickness section — an `iceThickness: { readings: [] }` carries no information.
  if (normalizedReadings.length > 0) normalized.iceThickness = { readings: normalizedReadings }
  if (input.snowCoverCm !== undefined) normalized.snowCoverCm = input.snowCoverCm
  if (normalizedConditions !== undefined) normalized.conditions = normalizedConditions
  const notes = input.notes?.trim()
  if (notes) normalized.notes = notes
  if (input.point !== undefined) normalized.point = input.point

  return { ok: true, normalized }
}
