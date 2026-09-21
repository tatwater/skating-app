/**
 * Pure form-state ⇆ domain logic for the report create form (§5, D22–D25/D41), shared by **both**
 * apps (D7/D40). Each surface's form holds the imperial strings the skater types; these helpers turn
 * that into the metric `ReportInput` the shared validator + `reports.create` consume (D25 — store
 * metric, enter/display imperial). Kept pure so the conversions and the thickness value-XOR-range
 * assembly are unit-tested without a DOM. (Reports have no visibility — all public, D13.)
 *
 * `skateEndTime` ("when the skater left the ice", Phase 05) is carried as **epoch ms** (canonical,
 * platform-neutral). Each surface adapts at its own input boundary: web's
 * `<input type="datetime-local">` round-trip lives in `apps/web`, mobile's date picker yields ms
 * directly. An optional `skateStartTime` captures when they got on; the UI may collect it as a start
 * time *or* a duration (`resolveSkateWindow` back-computes the start), but only the two timestamps
 * are ever stored — duration is derived (`end − start`).
 */

import type { LatLng } from './geometry';
import type { ReportInput, ThicknessReadingInput } from './report';
import {
  type ChipInput,
  iceTypeKeys,
  type LocatedIceType,
  type LocatedSurfaceTag,
  type Snow,
  surfaceTagKeys,
  toLocatedChip,
} from './reportFields';
import type {
  IceType,
  ObservedFrom,
  PrecipType,
  Sighting,
  SkateEndPrecision,
  SkateQuality,
  SkyCondition,
  Suitability,
  SurfaceTag,
  ThicknessMethod,
  ThicknessScope,
} from './types';
import { cmToInches, cToF, fToC, inchesToCm, kphToMph, mphToKph, roundTo } from './units';
import type { Where } from './where';

/**
 * The methods this form can complete (A10 / D195). `poke` is in `THICKNESS_METHODS` for the sheet,
 * whose reading has a count field; this form has none, and a poke reading without a count is one
 * the validator refuses — so offering it here is offering a reading that can never be posted. A
 * stored poke reading still round-trips through an edit, via `ThicknessFormReading.carried`.
 */
export const FORM_THICKNESS_METHODS = [
  'measured',
  'estimated',
] as const satisfies readonly ThicknessMethod[];

/**
 * The parts of a stored reading this form has no control for (D195): a poke's count, the skater's
 * word, a place, a coordinate, a note. Seeded by `reportFormFromReport` and re-emitted by
 * `buildReportInput` so an edit through this form is not a deletion — `reports.update` is
 * last-write-wins over the whole content block (see `reportFormFromReport`). Kept on the reading
 * rather than beside the list so a reading removed or reordered in the form takes its own facets
 * with it.
 */
export interface ThicknessReadingCarried {
  pokeCount?: number;
  supportable?: boolean;
  where?: Where;
  coord?: LatLng;
  note?: string;
}

/** One thickness reading as the form holds it: imperial strings + a single/range mode toggle. */
export interface ThicknessFormReading {
  mode: 'single' | 'range';
  value: string; // inches (mode = single)
  min: string; // inches (mode = range)
  max: string; // inches (mode = range)
  method: ThicknessMethod;
  carried?: ThicknessReadingCarried;
}

/**
 * What a stored report says that this form has no control for (A10) — carried through an edit
 * untouched and re-emitted by `buildReportInput`. The form edits chips as bare keys, snow as a
 * depth, thickness as a value or a range; everything the sheet adds beside those — a chip's
 * `where` and `note`, the snow facets, a vantage, a sighting, a suitability, the end time's
 * precision — would otherwise go back to `reports.update` as absent, and absent there means
 * *cleared*. Absent on a form that is creating a report.
 */
export interface CarriedReportFields {
  /** The end time `skateEndPrecision` describes: the precision goes back only while that time stands. */
  skateEndTime: number;
  skateEndPrecision?: SkateEndPrecision;
  observedFrom?: ObservedFrom;
  sighting?: Sighting;
  suitability?: Suitability;
  /** Every stored chip, located or not, keyed by its type in `buildReportInput` — a key still selected gets its chips back. */
  iceTypes: LocatedIceType[];
  surfaceTags: LocatedSurfaceTag[];
  thicknessScope?: ThicknessScope;
  /** The D194 facets beside the depth this form edits. */
  snow?: Omit<Snow, 'depthCm'>;
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
  carried?: CarriedReportFields;
  /**
   * Whether this report's precise put-in may be shown (Phase 04 decision #7). Seeded from the
   * profile's remembered default (`resolveShowPutInDefault`); an edit seeds from the stored report.
   */
  showPutIn: boolean;
}

/** A fresh, empty reading (single measured) for the "add reading" affordance. */
export function emptyThicknessReading(): ThicknessFormReading {
  return { mode: 'single', value: '', min: '', max: '', method: 'measured' };
}

/**
 * A blank form defaulted for `now`. Skate time defaults to now (editable to the past for offline
 * reports, D9); no ice fields are required (an observation-only report, D3). All reports are public
 * (D13), so there's no visibility to default. `opts.showPutIn` is the profile's remembered put-in
 * switch (`resolveShowPutInDefault`); omitted, the switch starts shown, the stored field's default.
 */
export function emptyReportForm(now: number, opts: { showPutIn?: boolean } = {}): ReportFormState {
  return {
    skateEndTime: now,
    iceTypes: [],
    surfaceTags: [],
    skateQuality: '',
    thickness: [],
    snowCover: '',
    conditions: { airTempF: '', windMph: '', windDir: '', sky: '', precip: '' },
    notes: '',
    showPutIn: opts.showPutIn ?? true,
  };
}

/** Parse a numeric input string; `undefined` when blank or not a finite number. */
function parseNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * One form reading → the metric `ThicknessReadingInput`, or `null` if it carries no measurement.
 *
 * The carried facets ride along unchanged, with one exception: a poke's count belongs to the `poke`
 * method (the validator refuses it on any other), so switching the method in the form drops it.
 * A poke reading is the one shape that stands with no cm figure at all — the count is the reading
 * (D195) — so a carried count keeps the reading alive when the inch box is blank.
 */
function toThicknessReading(reading: ThicknessFormReading): ThicknessReadingInput | null {
  const { pokeCount, ...facets } = reading.carried ?? {};
  const carried = { ...facets, ...(reading.method === 'poke' ? { pokeCount } : {}) };
  const cm = (() => {
    if (reading.mode === 'single') {
      const value = parseNumber(reading.value);
      return value === undefined ? null : { valueCm: inchesToCm(value) };
    }
    const min = parseNumber(reading.min);
    const max = parseNumber(reading.max);
    if (min === undefined && max === undefined) return null;
    return {
      ...(min !== undefined ? { minCm: inchesToCm(min) } : {}),
      ...(max !== undefined ? { maxCm: inchesToCm(max) } : {}),
    };
  })();
  if (cm === null && carried.pokeCount === undefined) return null;
  return { ...cm, method: reading.method, ...definedOnly(carried) };
}

/** The object without its `undefined` entries, so a carried block never emits a key it has no value for. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The stored chips for a key the form still has selected — or the bare key, when nothing was stored. */
function chipsForKey<T extends string>(
  key: T,
  stored: readonly { type: T; where?: Where; note?: string }[],
): ChipInput<T>[] {
  const own = stored.filter((chip) => chip.type === key);
  return own.length > 0 ? own : [key];
}

/**
 * Assemble the metric `ReportInput` from the form (for both the pre-submit `validateReportInput`
 * check and the `reports.create` args). Imperial inputs convert to metric (D25); empty optional
 * fields drop out entirely so a bare notes-only report stays valid (D3). `point` is the optional
 * put-in pin (else the server defaults it to the body centroid).
 *
 * The `carried` block (an edit) is re-emitted here: a chip key still selected goes back as the
 * stored chips under that key, with their `where` and `note`; the snow depth typed here joins the
 * stored facets; the vantage, sighting and suitability go back as they were; and the end time's
 * precision goes back only while the end time it described is unchanged — a re-dated report has an
 * end time this form knows nothing about the exactness of.
 */
export function buildReportInput(
  form: ReportFormState,
  waterBodyId: string,
  point?: { lat: number; lng: number },
): ReportInput {
  const carried = form.carried;
  const readings = form.thickness.map(toThicknessReading).filter((r) => r !== null);
  const iceTypes = form.iceTypes.flatMap((key) => chipsForKey(key, carried?.iceTypes ?? []));
  const surfaceTags = form.surfaceTags.flatMap((key) =>
    chipsForKey(key, carried?.surfaceTags ?? []),
  );
  const snowCoverInches = parseNumber(form.snowCover);
  const snow = definedOnly({
    ...carried?.snow,
    depthCm: snowCoverInches !== undefined ? inchesToCm(snowCoverInches) : undefined,
  });
  const scope = carried?.thicknessScope;
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
    ...(carried?.skateEndPrecision !== undefined && carried.skateEndTime === form.skateEndTime
      ? { skateEndPrecision: carried.skateEndPrecision }
      : {}),
    ...(carried?.observedFrom !== undefined ? { observedFrom: carried.observedFrom } : {}),
    ...(carried?.sighting !== undefined ? { sighting: carried.sighting } : {}),
    ...(iceTypes.length > 0 ? { iceTypes } : {}),
    ...(surfaceTags.length > 0 ? { surfaceTags } : {}),
    ...(form.skateQuality !== '' ? { skateQuality: form.skateQuality } : {}),
    ...(carried?.suitability !== undefined ? { suitability: carried.suitability } : {}),
    ...(readings.length > 0
      ? { iceThickness: { readings, ...(scope !== undefined ? { scope } : {}) } }
      : {}),
    ...(Object.keys(snow).length > 0 ? { snow } : {}),
    ...(hasConditions ? { conditions: { ...conditions, source: 'user' as const } } : {}),
    ...(notes !== '' ? { notes } : {}),
    ...(point ? { point } : {}),
    // Only the opt-out travels: the stored field is optional-defaults-to-shown, and a draft saved
    // before the toggle existed (no `showPutIn` at all) must keep reading as shown.
    ...(form.showPutIn === false ? { showPutIn: false } : {}),
  };
}

/**
 * A stored report, as much of it as the form needs to be seeded from (A06f).
 *
 * Structural rather than `Doc<'reports'>`, so `@skating/core` stays free of the Convex data model
 * and both clients can pass the row they already hold.
 */
export interface StoredReportForForm {
  skateEndTime: number;
  skateStartTime?: number;
  skateEndPrecision?: SkateEndPrecision;
  observedFrom?: ObservedFrom;
  sighting?: Sighting;
  /**
   * Either shape (A10): this form edits the keys only, and carries each chip's `where` and `note`
   * through `ReportFormState.carried` so an edit that never touched them sends them back intact.
   */
  iceTypes?: readonly ChipInput<IceType>[];
  surfaceTags?: readonly ChipInput<SurfaceTag>[];
  skateQuality?: SkateQuality;
  suitability?: Suitability;
  iceThickness?: { readings: ThicknessReadingLike[]; scope?: ThicknessScope };
  /** The D194 object; this form shows and edits only its depth, and carries the facets. */
  snow?: Snow;
  conditions?: {
    airTempC?: number;
    windSpeedKph?: number;
    windDir?: string;
    sky?: SkyCondition;
    precip?: PrecipType;
  };
  notes?: string;
  showPutIn?: boolean;
}

interface ThicknessReadingLike extends ThicknessReadingCarried {
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
  const { valueCm, minCm, maxCm, method, ...facets } = reading;
  const carried = definedOnly(facets);
  const withCarried = Object.keys(carried).length > 0 ? { carried } : {};
  // `valueCm` present ⇒ a single measurement; otherwise it was entered as a range, even if only one
  // end of it was filled in — or, for a poke, neither. `buildReportInput` produces exactly these shapes.
  if (valueCm !== undefined) {
    return {
      mode: 'single',
      value: toInchesString(valueCm),
      min: '',
      max: '',
      method,
      ...withCarried,
    };
  }
  return {
    mode: 'range',
    value: '',
    min: toInchesString(minCm),
    max: toInchesString(maxCm),
    method,
    ...withCarried,
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
 * author leave this field alone? (A06f)
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
 * 26.4 °F typed over a modeled 26 °F *unchanged* and silently restore the model's number — throwing
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
 * Seed the form from a stored report — the inverse of `buildReportInput`, for the edit path (A06f).
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
 * **What it carries without a slot** (A10): the author's own claims this form predates — a chip's
 * `where` and `note`, the snow facets, the thickness scope and each reading's facets, the vantage,
 * the sighting, the suitability, the end time's precision. These are not provenance; they are what
 * the author said, and the server cannot tell "this client has no control for it" from "the author
 * cleared it". Only the client knows which it is, so the client says so, in `carried`.
 *
 * ⚠ **The weather pair is the one lossy step**, because the fields are whole °F / whole mph and the
 * stored numbers are precise metric from Open-Meteo. `buildReportInput(reportFormFromReport(r))`
 * reproduces every other field exactly; those two come back within a rounding step, which is why the
 * server asks `isFormRoundTripOf` rather than `===`. The imperial fields above it are lossless in
 * practice — a user typed them in inches to begin with, so they round-trip to themselves.
 */
export function reportFormFromReport(report: StoredReportForForm): ReportFormState {
  const { depthCm, ...snowFacets } = report.snow ?? {};
  const carried: CarriedReportFields = definedOnly({
    skateEndTime: report.skateEndTime,
    skateEndPrecision: report.skateEndPrecision,
    observedFrom: report.observedFrom,
    sighting: report.sighting,
    suitability: report.suitability,
    iceTypes: (report.iceTypes ?? []).map(toLocatedChip),
    surfaceTags: (report.surfaceTags ?? []).map(toLocatedChip),
    thicknessScope: report.iceThickness?.scope,
    snow: Object.keys(definedOnly(snowFacets)).length > 0 ? definedOnly(snowFacets) : undefined,
  }) as CarriedReportFields;
  return {
    skateEndTime: report.skateEndTime,
    ...(report.skateStartTime !== undefined ? { skateStartTime: report.skateStartTime } : {}),
    // Keys once each: a lake with "black ice, north end" and "black ice, south bay" is one chip
    // selected here, and both come back from `carried` while it stays selected.
    iceTypes: [...new Set(iceTypeKeys(report.iceTypes))],
    surfaceTags: [...new Set(surfaceTagKeys(report.surfaceTags))],
    skateQuality: report.skateQuality ?? '',
    thickness: (report.iceThickness?.readings ?? []).map(toFormReading),
    snowCover: toInchesString(depthCm),
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
    carried,
    showPutIn: report.showPutIn !== false,
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
 * Resolve the optional start/duration entry into the two stored timestamps (Phase 05). This is the
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
