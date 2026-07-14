/**
 * Pure form-state ⇆ domain logic for the report create form (§E, D22–D25/D41). The React form
 * (`ReportForm`) holds imperial strings the skater types; these helpers turn that into the metric
 * `ReportInput` the shared `@skating/core` validator + `reports.create` consume (D25 — store metric,
 * enter/display imperial). Kept pure so the conversions, the thickness value-XOR-range assembly,
 * and the D41 visibility clamp are unit-tested without a DOM.
 */

import {
  fToC,
  type IceType,
  inchesToCm,
  mphToKph,
  type PrecipType,
  type ReportInput,
  type SkateQuality,
  type SkyCondition,
  type SurfaceTag,
  type ThicknessMethod,
  VISIBILITY_LEVELS,
  type Visibility,
} from '@skating/core'

/** One thickness reading as the form holds it: imperial strings + a single/range mode toggle. */
export interface ThicknessFormReading {
  mode: 'single' | 'range'
  value: string // inches (mode = single)
  min: string // inches (mode = range)
  max: string // inches (mode = range)
  method: ThicknessMethod
}

export interface ReportFormState {
  skateTime: string // <input type="datetime-local"> value (local time)
  visibility: Visibility
  iceTypes: IceType[]
  surfaceTags: SurfaceTag[]
  skateQuality: SkateQuality | ''
  thickness: ThicknessFormReading[]
  snowCover: string // inches
  conditions: {
    airTempF: string
    windMph: string
    windDir: string
    sky: SkyCondition | ''
    precip: PrecipType | ''
  }
  notes: string
}

/** A fresh, empty reading (single measured) for the "add reading" affordance. */
export function emptyThicknessReading(): ThicknessFormReading {
  return { mode: 'single', value: '', min: '', max: '', method: 'measured' }
}

/** `<input type="datetime-local">` value for a timestamp, in the viewer's local zone. */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Parse a `datetime-local` value back to epoch ms (local zone); `NaN` if blank/invalid. */
export function datetimeLocalToMs(value: string): number {
  return new Date(value).getTime()
}

/**
 * A blank form defaulted for `now` at the author's derived default visibility — the caller passes
 * the default so the D41 policy stays in `@skating/core`. Skate time defaults to now (editable to
 * the past for offline reports, D9); no ice fields are required (an observation-only report, D3).
 */
export function emptyReportForm(now: number, defaultVisibility: Visibility): ReportFormState {
  return {
    skateTime: toDatetimeLocal(now),
    visibility: defaultVisibility,
    iceTypes: [],
    surfaceTags: [],
    skateQuality: '',
    thickness: [],
    snowCover: '',
    conditions: { airTempF: '', windMph: '', windDir: '', sky: '', precip: '' },
    notes: '',
  }
}

/**
 * The visibility levels this author may pick, clamped to their ceiling (D41) — a locked/minor author
 * (`maxVisibility` below `public`) is never offered `public`. Ordered narrowest → widest.
 */
export function visibilityOptions(maxVisibility: Visibility): Visibility[] {
  const ceiling = VISIBILITY_LEVELS.indexOf(maxVisibility)
  return VISIBILITY_LEVELS.filter((_, i) => i <= ceiling)
}

/** Parse a numeric input string; `undefined` when blank or not a finite number. */
function parseNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** One form reading → the metric `ThicknessReadingInput`, or `null` if it carries no measurement. */
function toThicknessReading(reading: ThicknessFormReading) {
  if (reading.mode === 'single') {
    const value = parseNumber(reading.value)
    if (value === undefined) return null
    return { valueCm: inchesToCm(value), method: reading.method }
  }
  const min = parseNumber(reading.min)
  const max = parseNumber(reading.max)
  if (min === undefined && max === undefined) return null
  return {
    ...(min !== undefined ? { minCm: inchesToCm(min) } : {}),
    ...(max !== undefined ? { maxCm: inchesToCm(max) } : {}),
    method: reading.method,
  }
}

/**
 * Assemble the metric `ReportInput` from the form (for both the pre-submit `validateReportInput`
 * check and the `reports.create` args). Imperial inputs convert to metric (D25); empty optional
 * fields drop out entirely so a bare notes-only report stays valid (D3). `point` is the optional
 * put-in pin (else the server defaults it to the body centroid).
 */
export function buildReportInput(
  form: ReportFormState,
  waterBodyId: string,
  point?: { lat: number; lng: number },
): ReportInput {
  const readings = form.thickness.map(toThicknessReading).filter((r) => r !== null)
  const snowCoverInches = parseNumber(form.snowCover)
  const airTempF = parseNumber(form.conditions.airTempF)
  const windMph = parseNumber(form.conditions.windMph)
  const windDir = form.conditions.windDir.trim()
  const conditions = {
    ...(airTempF !== undefined ? { airTempC: fToC(airTempF) } : {}),
    ...(windMph !== undefined ? { windSpeedKph: mphToKph(windMph) } : {}),
    ...(windDir !== '' ? { windDir } : {}),
    ...(form.conditions.sky !== '' ? { sky: form.conditions.sky } : {}),
    ...(form.conditions.precip !== '' ? { precip: form.conditions.precip } : {}),
  }
  const hasConditions = Object.keys(conditions).length > 0
  const notes = form.notes.trim()

  return {
    waterBodyId,
    skateTime: datetimeLocalToMs(form.skateTime),
    visibility: form.visibility,
    ...(form.iceTypes.length > 0 ? { iceTypes: form.iceTypes } : {}),
    ...(form.surfaceTags.length > 0 ? { surfaceTags: form.surfaceTags } : {}),
    ...(form.skateQuality !== '' ? { skateQuality: form.skateQuality } : {}),
    ...(readings.length > 0 ? { iceThickness: { readings } } : {}),
    ...(snowCoverInches !== undefined ? { snowCoverCm: inchesToCm(snowCoverInches) } : {}),
    ...(hasConditions ? { conditions: { ...conditions, source: 'user' as const } } : {}),
    ...(notes !== '' ? { notes } : {}),
    ...(point ? { point } : {}),
  }
}
