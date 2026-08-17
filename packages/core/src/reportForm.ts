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
import { cmToInches, cToF, fToC, inchesToCm, kphToMph, mphToKph, roundTo } from './units';

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

/**
 * A stored report, as much of it as the form needs to be seeded from (N6f).
 *
 * Structural rather than `Doc<'reports'>`, so `@skating/core` stays free of the Convex data model
 * and both clients can pass the row they already hold.
 */
export interface StoredReportForForm {
  skateEndTime: number;
  skateStartTime?: number;
  iceTypes?: IceType[];
  surfaceTags?: SurfaceTag[];
  skateQuality?: SkateQuality;
  iceThickness?: { readings: ThicknessReadingLike[] };
  snowCoverCm?: number;
  conditions?: {
    airTempC?: number;
    windSpeedKph?: number;
    windDir?: string;
    sky?: SkyCondition;
    precip?: PrecipType;
  };
  notes?: string;
}

interface ThicknessReadingLike {
  valueCm?: number;
  minCm?: number;
  maxCm?: number;
  method: ThicknessMethod;
}

/**
 * Round-trip a metric number into the imperial string the form edits.
 *
 * **Rounded, and that is a real decision.** 12 cm is 4.724409448818898 inches, and seeding an edit
 * box with that would make every report look like it had been measured to the micron — and worse,
 * re-submitting it unchanged would store 11.99999… cm, so a no-op edit would silently perturb the
 * number. One decimal is finer than anyone reads ice to and stable across a round trip.
 */
function toInchesString(cm: number | undefined, decimals = 1): string {
  return cm === undefined ? '' : String(roundTo(cmToInches(cm), decimals));
}

/** One stored reading → the form's imperial pair, choosing the mode the reading was actually made in. */
function toFormReading(reading: ThicknessReadingLike): ThicknessFormReading {
  // `valueCm` present ⇒ a single measurement; otherwise it was entered as a range, even if only one
  // end of it was filled in. `buildReportInput` produces exactly one of these two shapes.
  if (reading.valueCm !== undefined) {
    return {
      mode: 'single',
      value: toInchesString(reading.valueCm),
      min: '',
      max: '',
      method: reading.method,
    };
  }
  return {
    mode: 'range',
    value: '',
    min: toInchesString(reading.minCm),
    max: toInchesString(reading.maxCm),
    method: reading.method,
  };
}

/**
 * The two lossy conditions fields, each as the pair of conversions the form puts them through:
 * `display` is the whole imperial unit the input shows, `toMetric` is what `buildReportInput` sends
 * back. Keyed by field so the server can replay the exact same arithmetic — see `isFormRoundTripOf`.
 * Both halves read this map, so what the form renders and what the server predicts cannot drift.
 */
const CONDITION_FIELD = {
  airTempC: { display: (metric: number) => roundTo(cToF(metric), 0), toMetric: fToC },
  windSpeedKph: { display: (metric: number) => roundTo(kphToMph(metric), 0), toMetric: mphToKph },
} as const;

/**
 * Is `next` **exactly** what the edit form would have re-emitted for a stored `stored`, i.e. did the
 * author leave this field alone? (N6f)
 *
 * The conditions fields are whole degrees F and whole mph, and the stored numbers are neither: a
 * report's weather is usually written by `conditions.autofillConditions` from Open-Meteo in precise
 * metric. So −3.4 °C renders as `26`, and `buildReportInput` converts that back to −3.33 °C — a
 * different number, from an author who typed nothing. An exact `stored === next` therefore reads
 * every edit as a weather edit, which is wrong twice over: it perturbs a measurement nobody touched,
 * and it relabels a model's figure as a human's observation.
 *
 * ⚠ **This predicts the round trip rather than allowing a tolerance**, and the difference is not
 * academic. Both inputs accept decimals, so "did these two round to the same whole unit?" would call
 * 26.4 °F typed over a modelled 26 °F *unchanged* and silently restore the model's number — throwing
 * away an edit to protect provenance, which is a worse trade than the bug it fixes. Reconstructing
 * `toMetric(display(stored))` and comparing exactly has no such window: the arithmetic is the same
 * ops in the same order as the form's, so an untouched field matches bit for bit, and anything the
 * author actually typed — by a whole unit or a tenth of one — does not.
 *
 * The one case it *does* absorb is an author retyping the number already on screen. Keeping the
 * stored value there is right anyway: they entered exactly what was displayed, so there is nothing
 * to record but a loss of precision.
 */
export function isFormRoundTripOf(
  field: keyof typeof CONDITION_FIELD,
  stored: number | undefined,
  next: number | undefined,
): boolean {
  if (stored === next) return true; // covers both-absent, and a value that needed no rounding
  if (stored === undefined || next === undefined) return false; // one side cleared or added
  const { display, toMetric } = CONDITION_FIELD[field];
  return toMetric(display(stored)) === next;
}

/**
 * Seed the form from a stored report — the inverse of `buildReportInput`, for the edit path (N6f).
 *
 * `reports.update` is **last-write-wins over the whole content block**, not a patch: an omitted
 * optional field is cleared. So an edit form that started empty would silently delete every field the
 * author didn't retype, which is why this exists and why it has to be faithful in both directions —
 * `buildReportInput(reportFormFromReport(r))` must reproduce `r`.
 *
 * **What it deliberately does not carry**: `conditions.source`. The form has no slot for provenance
 * and no way to render it, so round-tripping it here would mean inventing a hidden field. The server
 * keeps the stored source when the values come back unchanged (see `reports.update`), which is the
 * same decision made in the one place that can actually compare old and new.
 *
 * ⚠ **The weather pair is the one lossy step**, because the fields are whole °F / whole mph and the
 * stored numbers are precise metric from Open-Meteo. `buildReportInput(reportFormFromReport(r))`
 * reproduces every other field exactly; those two come back within a rounding step, which is why the
 * server asks `isFormRoundTripOf` rather than `===`. The imperial fields above it are lossless in
 * practice — a user typed them in inches to begin with, so they round-trip to themselves.
 */
export function reportFormFromReport(report: StoredReportForForm): ReportFormState {
  return {
    skateEndTime: report.skateEndTime,
    ...(report.skateStartTime !== undefined ? { skateStartTime: report.skateStartTime } : {}),
    iceTypes: [...(report.iceTypes ?? [])],
    surfaceTags: [...(report.surfaceTags ?? [])],
    skateQuality: report.skateQuality ?? '',
    thickness: (report.iceThickness?.readings ?? []).map(toFormReading),
    snowCover: toInchesString(report.snowCoverCm),
    conditions: {
      airTempF:
        report.conditions?.airTempC === undefined
          ? ''
          : String(CONDITION_FIELD.airTempC.display(report.conditions.airTempC)),
      windMph:
        report.conditions?.windSpeedKph === undefined
          ? ''
          : String(CONDITION_FIELD.windSpeedKph.display(report.conditions.windSpeedKph)),
      windDir: report.conditions?.windDir ?? '',
      sky: report.conditions?.sky ?? '',
      precip: report.conditions?.precip ?? '',
    },
    notes: report.notes ?? '',
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
