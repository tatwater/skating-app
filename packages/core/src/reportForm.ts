/**
 * Pure form-state ⇆ domain logic for the report create form (§E, D22–D25/D41), shared by **both**
 * apps (D7/D40). Each surface's form holds the imperial strings the skater types; these helpers turn
 * that into the metric `ReportInput` the shared validator + `reports.create` consume (D25 — store
 * metric, enter/display imperial). Kept pure so the conversions and the thickness value-XOR-range
 * assembly are unit-tested without a DOM. (Reports have no visibility — all public, D13.)
 *
 * `skateEndTime` ("when the skater left the ice", Phase 5) is carried as **epoch ms** (canonical,
 * platform-neutral). Each surface adapts at its own input boundary: web's
 * `<input type="datetime-local">` round-trip lives in `apps/web`, mobile's date picker yields ms
 * directly. An optional `skateStartTime` captures when they got on; the UI may collect it as a start
 * time *or* a duration (`resolveSkateWindow` back-computes the start), but only the two timestamps
 * are ever stored — duration is derived (`end − start`).
 */

import type { ReportInput } from './report';
import type {
  IceType,
  PrecipType,
  SkateQuality,
  SkyCondition,
  SurfaceTag,
  ThicknessMethod,
} from './types';
import { fToC, inchesToCm, mphToKph } from './units';

/** One thickness reading as the form holds it: imperial strings + a single/range mode toggle. */
export interface ThicknessFormReading {
  mode: 'single' | 'range';
  value: string; // inches (mode = single)
  min: string; // inches (mode = range)
  max: string; // inches (mode = range)
  method: ThicknessMethod;
}

export interface ReportFormState {
  skateEndTime: number; // epoch ms — when they left the ice (each surface adapts its own picker)
  skateStartTime?: number; // epoch ms — optional; resolved from a start time OR a duration at the UI
  iceTypes: IceType[];
  surfaceTags: SurfaceTag[];
  skateQuality: SkateQuality | '';
  thickness: ThicknessFormReading[];
  snowCover: string; // inches
  conditions: {
    airTempF: string;
    windMph: string;
    windDir: string;
    sky: SkyCondition | '';
    precip: PrecipType | '';
  };
  notes: string;
}

/** A fresh, empty reading (single measured) for the "add reading" affordance. */
export function emptyThicknessReading(): ThicknessFormReading {
  return { mode: 'single', value: '', min: '', max: '', method: 'measured' };
}

/**
 * A blank form defaulted for `now`. Skate time defaults to now (editable to the past for offline
 * reports, D9); no ice fields are required (an observation-only report, D3). All reports are public
 * (D13), so there's no visibility to default.
 */
export function emptyReportForm(now: number): ReportFormState {
  return {
    skateEndTime: now,
    iceTypes: [],
    surfaceTags: [],
    skateQuality: '',
    thickness: [],
    snowCover: '',
    conditions: { airTempF: '', windMph: '', windDir: '', sky: '', precip: '' },
    notes: '',
  };
}

/** Parse a numeric input string; `undefined` when blank or not a finite number. */
function parseNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** One form reading → the metric `ThicknessReadingInput`, or `null` if it carries no measurement. */
function toThicknessReading(reading: ThicknessFormReading) {
  if (reading.mode === 'single') {
    const value = parseNumber(reading.value);
    if (value === undefined) return null;
    return { valueCm: inchesToCm(value), method: reading.method };
  }
  const min = parseNumber(reading.min);
  const max = parseNumber(reading.max);
  if (min === undefined && max === undefined) return null;
  return {
    ...(min !== undefined ? { minCm: inchesToCm(min) } : {}),
    ...(max !== undefined ? { maxCm: inchesToCm(max) } : {}),
    method: reading.method,
  };
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
  const readings = form.thickness.map(toThicknessReading).filter((r) => r !== null);
  const snowCoverInches = parseNumber(form.snowCover);
  const airTempF = parseNumber(form.conditions.airTempF);
  const windMph = parseNumber(form.conditions.windMph);
  const windDir = form.conditions.windDir.trim();
  const conditions = {
    ...(airTempF !== undefined ? { airTempC: fToC(airTempF) } : {}),
    ...(windMph !== undefined ? { windSpeedKph: mphToKph(windMph) } : {}),
    ...(windDir !== '' ? { windDir } : {}),
    ...(form.conditions.sky !== '' ? { sky: form.conditions.sky } : {}),
    ...(form.conditions.precip !== '' ? { precip: form.conditions.precip } : {}),
  };
  const hasConditions = Object.keys(conditions).length > 0;
  const notes = form.notes.trim();

  return {
    waterBodyId,
    skateEndTime: form.skateEndTime,
    ...(form.skateStartTime !== undefined ? { skateStartTime: form.skateStartTime } : {}),
    ...(form.iceTypes.length > 0 ? { iceTypes: form.iceTypes } : {}),
    ...(form.surfaceTags.length > 0 ? { surfaceTags: form.surfaceTags } : {}),
    ...(form.skateQuality !== '' ? { skateQuality: form.skateQuality } : {}),
    ...(readings.length > 0 ? { iceThickness: { readings } } : {}),
    ...(snowCoverInches !== undefined ? { snowCoverCm: inchesToCm(snowCoverInches) } : {}),
    ...(hasConditions ? { conditions: { ...conditions, source: 'user' as const } } : {}),
    ...(notes !== '' ? { notes } : {}),
    ...(point ? { point } : {}),
  };
}

/** What the skate-window helper is given at the form boundary: a required end, plus *optionally* an
 *  explicit start OR a duration (mutually exclusive in the UI; if both arrive, the explicit start
 *  wins). Times are epoch ms; duration is in minutes. */
export interface SkateWindowInput {
  end: number;
  start?: number;
  durationMinutes?: number;
}

/** The resolved window — only the two timestamps are ever persisted (duration is derived). */
export type SkateWindowResult =
  | { ok: true; skateEndTime: number; skateStartTime?: number }
  | { ok: false; error: string };

/**
 * Resolve the optional start/duration entry into the two stored timestamps (Phase 5). This is the
 * **input-boundary** helper: a duration back-computes `start = end − duration` here so the rest of
 * the system only ever sees `{ skateStartTime?, skateEndTime }` — duration is never a stored field.
 * Validates that the end is a real instant and that any resolved start falls at/​before it (an
 * inverted window is nonsensical). An explicit `start` takes precedence over `durationMinutes` if
 * both are somehow supplied. With neither, the window is just the end (no start).
 */
export function resolveSkateWindow(input: SkateWindowInput): SkateWindowResult {
  const { end, start, durationMinutes } = input;
  if (!Number.isFinite(end) || end <= 0) {
    return { ok: false, error: 'Enter a valid end time.' };
  }

  let skateStartTime: number | undefined;
  if (start !== undefined) {
    if (!Number.isFinite(start) || start <= 0)
      return { ok: false, error: 'Enter a valid start time.' };
    skateStartTime = start;
  } else if (durationMinutes !== undefined) {
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return { ok: false, error: 'Enter a duration greater than zero.' };
    }
    skateStartTime = end - durationMinutes * 60_000;
    if (skateStartTime <= 0) return { ok: false, error: 'That duration is longer than possible.' };
  }

  if (skateStartTime !== undefined && skateStartTime > end) {
    return { ok: false, error: 'The start must be before the end.' };
  }
  return skateStartTime !== undefined
    ? { ok: true, skateEndTime: end, skateStartTime }
    : { ok: true, skateEndTime: end };
}
