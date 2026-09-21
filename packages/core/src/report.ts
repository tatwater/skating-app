/**
 * Report input validation + normalization (D22–D25/D41, widened in A10 / D190–D195) — the single
 * client-and-server contract (re-enforced server-side per D37). The report sheet validates with
 * this before submit, and `reports.create` re-runs it at the trust boundary, so the rules live in
 * exactly one place.
 *
 * Observation-friendly (D3): nothing about ice *quality* is required here — a "don't skate here"
 * report carrying only `notes` is valid, and `update` keeps it that way for every report already
 * posted. What's required is just the anchor: a water body, when the skater **left the ice**
 * (`skateEndTime` — the freshest read; Phase 05). The A10 **minimum set** (D189) is a separate,
 * create-only check — `minimumSetGaps` below — so the floor is never retroactive. An optional
 * `skateStartTime` captures when they got on; duration is *derived* (`end − start`), never stored.
 * All reports are public (D13) — there is no visibility field. (Minors can't create reports at
 * all; that gate lives in `reports.create`, not here — D41.)
 *
 * ## Two input shapes, one stored shape
 *
 * The chips (`iceTypes`, `surfaceTags`) and snow each accept the **pre-A10 form** — a bare key, a
 * bare `snowCoverCm` — as well as the located / faceted objects, and normalize to the objects. A
 * phone that has not updated, a draft the offline queue held across the update, and the old web
 * form all keep working against the narrowed schema because normalization happens here, at the
 * contract, not in the schema.
 */

import { isValidCoord, type LatLng } from './geometry';
import {
  type ChipInput,
  chipKeys,
  type LocatedIceType,
  type LocatedSurfaceTag,
  type Snow,
  snowIsEmpty,
  toLocatedChip,
} from './reportFields';
import {
  CONDITION_SOURCES,
  type ConditionSource,
  ICE_TYPES,
  type IceType,
  OBSERVED_FROM,
  type ObservedFrom,
  PRECIP_TYPES,
  type PrecipType,
  SIGHTINGS,
  type Sighting,
  SKATE_END_PRECISIONS,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  type SkateEndPrecision,
  type SkateQuality,
  type SkyCondition,
  SNOW_COVERAGES,
  SNOW_DRIFTS,
  SNOW_IMPEDIMENTS,
  SUITABILITIES,
  SURFACE_TAGS,
  type Suitability,
  type SurfaceTag,
  THICKNESS_METHODS,
  THICKNESS_SCOPES,
  type ThicknessMethod,
  type ThicknessScope,
} from './types';
import { validateWhere, type Where } from './where';

/** A skate-end time more than this far past `now` is treated as implausibly future and rejected. */
export const SKATE_TIME_FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

export interface ThicknessReadingInput {
  valueCm?: number;
  minCm?: number;
  /** Absent with `minCm` present ⇒ a **lower bound** ("at least 4 inches") — D195. */
  maxCm?: number;
  method: ThicknessMethod;
  /** Pole-test count, `poke` readings only (D195). Person- and pole-relative; never converted to cm. */
  pokeCount?: number;
  /** The skater's word — "supportable" / "unsupportable" — never ours (D195, D3). */
  supportable?: boolean;
  where?: Where;
  coord?: LatLng;
  note?: string;
}

export interface ReportConditionsInput {
  airTempC?: number;
  windSpeedKph?: number;
  windDir?: string;
  sky?: SkyCondition;
  precip?: PrecipType;
  source?: ConditionSource;
}

export interface ReportInput {
  waterBodyId: string;
  /** When the skater **left the ice** — the primary sort key everywhere (D28; Phase 05 rename). */
  skateEndTime: number;
  /** Optional — when they got *on* the ice. Duration is derived (`end − start`), never stored. */
  skateStartTime?: number;
  /** How exact the end time is (D192). Stamped by the sheet; absent from older clients. */
  skateEndPrecision?: SkateEndPrecision;
  /** How the author saw it (D191). Absent means unstated — there is no backfill. */
  observedFrom?: ObservedFrom;
  /** What a shore observer saw (D189) — valid only off the ice. */
  sighting?: Sighting;
  iceTypes?: ChipInput<IceType>[];
  surfaceTags?: ChipInput<SurfaceTag>[];
  skateQuality?: SkateQuality;
  suitability?: Suitability;
  iceThickness?: { readings: ThicknessReadingInput[]; scope?: ThicknessScope };
  snow?: Snow;
  /** @deprecated The pre-A10 single number; normalized into `snow.depthCm`. Older clients only. */
  snowCoverCm?: number;
  conditions?: ReportConditionsInput;
  notes?: string;
  /** Optional put-in pin the skater dropped (access point); becomes `reports.point`. */
  point?: LatLng;
  /**
   * The per-report put-in opt-out (Phase 04 decision #7): `false` keeps the precise put-in off the map
   * and, for a report published from a track, clips the path's ends (D58). Omitted means shown — the
   * stored field is optional with that default, so the form only sends the opt-out. See
   * `putInPrivacy.ts` for the copy and the remembered default.
   */
  showPutIn?: boolean;
}

export interface NormalizedThicknessReading {
  valueCm?: number;
  minCm?: number;
  maxCm?: number;
  method: ThicknessMethod;
  pokeCount?: number;
  supportable?: boolean;
  where?: Where;
  coord?: LatLng;
  note?: string;
}

/** Normalized conditions — `source` is always set (defaulted to `user`), matching the stored shape. */
export interface NormalizedConditions {
  airTempC?: number;
  windSpeedKph?: number;
  windDir?: string;
  sky?: SkyCondition;
  precip?: PrecipType;
  source: ConditionSource;
}

/** The clean, defaulted report ready for `reports.create` to server-stamp + insert. */
export interface NormalizedReport {
  waterBodyId: string;
  skateEndTime: number;
  skateStartTime?: number;
  skateEndPrecision?: SkateEndPrecision;
  observedFrom?: ObservedFrom;
  sighting?: Sighting;
  iceTypes: LocatedIceType[];
  surfaceTags: LocatedSurfaceTag[];
  skateQuality?: SkateQuality;
  suitability?: Suitability;
  iceThickness?: { readings: NormalizedThicknessReading[]; scope?: ThicknessScope };
  snow?: Snow;
  conditions?: NormalizedConditions;
  notes?: string;
  point?: LatLng;
}

export interface ReportValidationError {
  field: string;
  message: string;
}

export type ReportValidationResult =
  | { ok: true; normalized: NormalizedReport }
  | { ok: false; errors: ReportValidationError[] };

/**
 * The one validation message with a caller outside the form: both apps report a future-skate-time
 * rejection as an analytics signal (Phase 07-2), because that failure is almost always **device clock
 * skew costing someone a report**, not someone claiming a skate that hasn't happened — and a
 * persistent non-zero rate is the case for widening `SKATE_TIME_FUTURE_TOLERANCE_MS`. Shared as a
 * constant so the check and the copy can't drift into a silently-dead detector.
 */
export const FUTURE_SKATE_TIME_MESSAGE = 'cannot be in the future';

/** Did this validation fail on the future-skate-time rule? See `FUTURE_SKATE_TIME_MESSAGE`. */
export function hasFutureSkateTimeError(errors: readonly ReportValidationError[]): boolean {
  return errors.some((e) => e.field === 'skateEndTime' && e.message === FUTURE_SKATE_TIME_MESSAGE);
}

export interface ReportValidationContext {
  /** Current time (epoch ms) — injected, not read, so validation stays pure/testable. */
  now: number;
}

function isMember<T extends string>(arr: readonly T[], value: unknown): value is T {
  // `Array.includes` safely returns false for a non-string, so no separate typeof guard is needed.
  return (arr as readonly string[]).includes(value as string);
}

/** A finite number ≥ 0 — thickness/snow/wind can't be negative. Callers pass a defined number. */
function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Validate one thickness reading, pushing any problems (path-prefixed) into `errors`. Returns the
 * normalized reading, or `null` if it was invalid.
 *
 * Rule (D22, relaxed by D195): a reading is a single `valueCm` **XOR** a range — and a range may now
 * be `minCm` alone, the lower bound the corpus gives nearly as often as a number ("at least 4"),
 * with `minCm <= maxCm` when both are present. A `poke` reading is the exception to "a value or a
 * range": its count *is* the reading, and the cm figure beside it is the skater's own estimate,
 * optional. Every other method forbids `pokeCount`, so a count can never masquerade as a measurement.
 */
function validateReading(
  reading: ThicknessReadingInput,
  path: string,
  errors: ReportValidationError[],
): NormalizedThicknessReading | null {
  const before = errors.length;
  const { valueCm, minCm, maxCm, pokeCount } = reading;

  const methodKnown = isMember(THICKNESS_METHODS, reading.method);
  if (!methodKnown) {
    errors.push({ field: `${path}.method`, message: 'must be measured, estimated or poke' });
  }
  const isPoke = methodKnown && reading.method === 'poke';

  if (isPoke) {
    if (pokeCount === undefined || !Number.isInteger(pokeCount) || pokeCount < 0) {
      errors.push({
        field: `${path}.pokeCount`,
        message: 'a poke reading needs a whole-number count',
      });
    }
  } else if (pokeCount !== undefined) {
    errors.push({ field: `${path}.pokeCount`, message: 'only a poke reading carries a count' });
  }

  const hasCm = valueCm !== undefined || minCm !== undefined || maxCm !== undefined;
  if (valueCm !== undefined && (minCm !== undefined || maxCm !== undefined)) {
    errors.push({ field: path, message: 'give a single value OR a min/max range, not both' });
  } else if (valueCm !== undefined) {
    if (!isNonNegativeFinite(valueCm)) {
      errors.push({ field: `${path}.valueCm`, message: 'must be a number ≥ 0' });
    }
  } else if (minCm !== undefined || maxCm !== undefined) {
    if (minCm === undefined) {
      // An upper bound alone ("under 2") is spelled `minCm: 0, maxCm: 5`; a bare max hides the zero.
      errors.push({ field: path, message: 'a range needs minCm (maxCm alone is not a range)' });
    } else if (
      !isNonNegativeFinite(minCm) ||
      (maxCm !== undefined && !isNonNegativeFinite(maxCm))
    ) {
      errors.push({ field: path, message: 'minCm and maxCm must be numbers ≥ 0' });
    } else if (maxCm !== undefined && minCm > maxCm) {
      errors.push({ field: path, message: 'minCm must be ≤ maxCm' });
    }
  } else if (!isPoke) {
    errors.push({ field: path, message: 'give a value or a min/max range' });
  }

  if (reading.supportable !== undefined && typeof reading.supportable !== 'boolean') {
    errors.push({ field: `${path}.supportable`, message: 'must be true or false' });
  }

  let where: Where | undefined;
  if (reading.where !== undefined) {
    where = validateWhere(reading.where, `${path}.where`, errors) ?? undefined;
  }

  if (reading.coord !== undefined && !isValidCoord(reading.coord)) {
    errors.push({ field: `${path}.coord`, message: 'is not a valid coordinate' });
  }

  if (errors.length > before) return null;

  const normalized: NormalizedThicknessReading = { method: reading.method };
  if (valueCm !== undefined) normalized.valueCm = valueCm;
  else if (hasCm) {
    normalized.minCm = minCm;
    if (maxCm !== undefined) normalized.maxCm = maxCm;
  }
  if (isPoke) normalized.pokeCount = pokeCount;
  if (reading.supportable !== undefined) normalized.supportable = reading.supportable;
  if (where !== undefined) normalized.where = where;
  if (reading.coord !== undefined) normalized.coord = reading.coord;
  const note = reading.note?.trim();
  if (note) normalized.note = note;
  return normalized;
}

/**
 * Would `validateReportInput` accept this reading? The same rule as `validateReading`, exposed for
 * a caller that *builds* readings from somewhere other than the form — the extraction mappers — so
 * a reading the sheet could never post (a poke with no count, an estimate with no number) is
 * dropped at the source instead of failing the whole report at *Post*. One rule, one place.
 */
export function isValidThicknessReading(reading: ThicknessReadingInput): boolean {
  return validateReading(reading, 'reading', []) !== null;
}

/**
 * May a report from this vantage carry a `sighting` (D189)? "Still open" is what someone on the
 * bank reports; from the ice it would be a surface chip, and with no vantage stated it is nobody's.
 * The validator, both extraction engines and the sheet all ask this one function.
 */
export function sightingAllowedFrom(observedFrom: ObservedFrom | undefined): boolean {
  return observedFrom !== undefined && observedFrom !== 'on_ice';
}

function validateConditions(
  conditions: ReportConditionsInput,
  errors: ReportValidationError[],
): NormalizedConditions {
  if (conditions.airTempC !== undefined && !Number.isFinite(conditions.airTempC)) {
    errors.push({ field: 'conditions.airTempC', message: 'must be a number' });
  }
  if (conditions.windSpeedKph !== undefined && !isNonNegativeFinite(conditions.windSpeedKph)) {
    errors.push({ field: 'conditions.windSpeedKph', message: 'must be a number ≥ 0' });
  }
  if (conditions.sky !== undefined && !isMember(SKY_CONDITIONS, conditions.sky)) {
    errors.push({ field: 'conditions.sky', message: 'is not a known sky condition' });
  }
  if (conditions.precip !== undefined && !isMember(PRECIP_TYPES, conditions.precip)) {
    errors.push({ field: 'conditions.precip', message: 'is not a known precipitation type' });
  }
  if (conditions.source !== undefined && !isMember(CONDITION_SOURCES, conditions.source)) {
    errors.push({ field: 'conditions.source', message: 'is not a known source' });
  }

  // Phase 02a conditions are manual entry (D19) — default the provenance to the user. Built even on
  // error (the caller discards it when `errors` is non-empty), so the return type stays concrete.
  const normalized: NormalizedConditions = { source: conditions.source ?? 'user' };
  if (conditions.airTempC !== undefined) normalized.airTempC = conditions.airTempC;
  if (conditions.windSpeedKph !== undefined) normalized.windSpeedKph = conditions.windSpeedKph;
  const windDir = conditions.windDir?.trim();
  if (windDir) normalized.windDir = windDir;
  if (conditions.sky !== undefined) normalized.sky = conditions.sky;
  if (conditions.precip !== undefined) normalized.precip = conditions.precip;
  return normalized;
}

/**
 * Validate a chip list in either shape and normalize every entry to the located object. A bare
 * string chip is the pre-A10 form (and the quick-tap form); a located chip validates its `where`.
 */
function validateChips<T extends string>(
  chips: readonly ChipInput<T>[],
  vocabulary: readonly T[],
  field: string,
  unknownMessage: string,
  errors: ReportValidationError[],
): { type: T; where?: Where; note?: string }[] {
  const out: { type: T; where?: Where; note?: string }[] = [];
  for (const [i, chip] of chips.entries()) {
    const path = `${field}[${i}]`;
    const before = errors.length;
    const located = toLocatedChip(chip);
    if (!isMember(vocabulary, located.type)) errors.push({ field: path, message: unknownMessage });
    let where: Where | undefined;
    if (located.where !== undefined) {
      where = validateWhere(located.where, `${path}.where`, errors) ?? undefined;
    }
    if (errors.length > before) continue;
    const normalized: { type: T; where?: Where; note?: string } = { type: located.type };
    if (where !== undefined) normalized.where = where;
    const note = located.note?.trim();
    if (note) normalized.note = note;
    out.push(normalized);
  }
  return out;
}

/**
 * Validate the snow section in either shape — the D194 object, or the pre-A10 `snowCoverCm` number,
 * which becomes `depthCm`. When both arrive the object wins and the number must agree, so a client
 * cannot send two depths. Returns `undefined` for a section that says nothing.
 */
function validateSnow(
  snow: Snow | undefined,
  snowCoverCm: number | undefined,
  errors: ReportValidationError[],
): Snow | undefined {
  const before = errors.length;
  const normalized: Snow = {};
  if (snow !== undefined) {
    if (snow.coverage !== undefined) {
      if (!isMember(SNOW_COVERAGES, snow.coverage)) {
        errors.push({ field: 'snow.coverage', message: 'is not a known coverage' });
      } else normalized.coverage = snow.coverage;
    }
    if (snow.impediment !== undefined) {
      if (!isMember(SNOW_IMPEDIMENTS, snow.impediment)) {
        errors.push({ field: 'snow.impediment', message: 'is not a known impediment' });
      } else normalized.impediment = snow.impediment;
    }
    if (snow.drifts !== undefined) {
      if (!isMember(SNOW_DRIFTS, snow.drifts)) {
        errors.push({ field: 'snow.drifts', message: 'is not a known drift value' });
      } else normalized.drifts = snow.drifts;
    }
    if (snow.depthCm !== undefined) {
      if (!isNonNegativeFinite(snow.depthCm)) {
        errors.push({ field: 'snow.depthCm', message: 'must be a number ≥ 0' });
      } else normalized.depthCm = snow.depthCm;
    }
    if (snow.plowedPath !== undefined) {
      if (typeof snow.plowedPath !== 'boolean') {
        errors.push({ field: 'snow.plowedPath', message: 'must be true or false' });
      } else normalized.plowedPath = snow.plowedPath;
    }
  }
  if (snowCoverCm !== undefined) {
    if (!isNonNegativeFinite(snowCoverCm)) {
      errors.push({ field: 'snowCoverCm', message: 'must be a number ≥ 0' });
    } else if (normalized.depthCm !== undefined && normalized.depthCm !== snowCoverCm) {
      errors.push({ field: 'snowCoverCm', message: 'disagrees with snow.depthCm' });
    } else if (normalized.depthCm === undefined) normalized.depthCm = snowCoverCm;
  }
  if (errors.length > before || snowIsEmpty(normalized)) return undefined;
  return normalized;
}

/**
 * Validate + normalize a report submission. Collects *all* problems (so the form can show them at
 * once) rather than failing on the first. On success, returns a `NormalizedReport` with arrays
 * defaulted, chips located, strings trimmed, and empty/optional sections dropped — ready for the
 * server to stamp `authorId`/`reportTime`/`point`-fallback and insert.
 */
export function validateReportInput(
  input: ReportInput,
  ctx: ReportValidationContext,
): ReportValidationResult {
  const errors: ReportValidationError[] = [];

  if (!input.waterBodyId || input.waterBodyId.trim() === '') {
    errors.push({ field: 'waterBodyId', message: 'is required' });
  }

  if (!Number.isFinite(input.skateEndTime) || input.skateEndTime <= 0) {
    errors.push({ field: 'skateEndTime', message: 'is required' });
  } else if (input.skateEndTime > ctx.now + SKATE_TIME_FUTURE_TOLERANCE_MS) {
    errors.push({ field: 'skateEndTime', message: FUTURE_SKATE_TIME_MESSAGE });
  }

  // Optional start (when they got on the ice). Must be a valid instant and not after the end —
  // duration is `end − start`, so an inverted window is nonsensical (Phase 05).
  if (input.skateStartTime !== undefined) {
    if (!Number.isFinite(input.skateStartTime) || input.skateStartTime <= 0) {
      errors.push({ field: 'skateStartTime', message: 'must be a valid time' });
    } else if (Number.isFinite(input.skateEndTime) && input.skateStartTime > input.skateEndTime) {
      errors.push({ field: 'skateStartTime', message: 'must be before the end time' });
    }
  }

  if (
    input.skateEndPrecision !== undefined &&
    !isMember(SKATE_END_PRECISIONS, input.skateEndPrecision)
  ) {
    errors.push({ field: 'skateEndPrecision', message: 'is not a known precision' });
  }

  if (input.observedFrom !== undefined && !isMember(OBSERVED_FROM, input.observedFrom)) {
    errors.push({ field: 'observedFrom', message: 'is not a known vantage' });
  }
  if (input.sighting !== undefined) {
    if (!isMember(SIGHTINGS, input.sighting)) {
      errors.push({ field: 'sighting', message: 'is not a known sighting' });
    } else if (!sightingAllowedFrom(input.observedFrom)) {
      errors.push({ field: 'sighting', message: 'is for a report from shore or secondhand' });
    }
  }

  const iceTypes = validateChips(
    input.iceTypes ?? [],
    ICE_TYPES,
    'iceTypes',
    'is not a known ice type',
    errors,
  );
  const surfaceTags = validateChips(
    input.surfaceTags ?? [],
    SURFACE_TAGS,
    'surfaceTags',
    'is not a known surface tag',
    errors,
  );

  if (input.skateQuality !== undefined && !isMember(SKATE_QUALITIES, input.skateQuality)) {
    errors.push({ field: 'skateQuality', message: 'is not a known quality' });
  }
  if (input.suitability !== undefined && !isMember(SUITABILITIES, input.suitability)) {
    errors.push({ field: 'suitability', message: 'is not a known suitability' });
  }

  const normalizedReadings: NormalizedThicknessReading[] = [];
  let thicknessScope: ThicknessScope | undefined;
  if (input.iceThickness !== undefined) {
    const readings = input.iceThickness.readings;
    if (!Array.isArray(readings)) {
      errors.push({ field: 'iceThickness.readings', message: 'must be a list of readings' });
    } else {
      for (const [i, reading] of readings.entries()) {
        const normalized = validateReading(reading, `iceThickness.readings[${i}]`, errors);
        if (normalized) normalizedReadings.push(normalized);
      }
    }
    if (input.iceThickness.scope !== undefined) {
      if (!isMember(THICKNESS_SCOPES, input.iceThickness.scope)) {
        errors.push({ field: 'iceThickness.scope', message: 'is not a known scope' });
      } else thicknessScope = input.iceThickness.scope;
    }
  }

  const snow = validateSnow(input.snow, input.snowCoverCm, errors);

  let normalizedConditions: NormalizedConditions | undefined;
  if (input.conditions !== undefined) {
    normalizedConditions = validateConditions(input.conditions, errors);
  }

  if (input.point !== undefined && !isValidCoord(input.point)) {
    errors.push({ field: 'point', message: 'is not a valid coordinate' });
  }

  if (errors.length > 0) return { ok: false, errors };

  const normalized: NormalizedReport = {
    waterBodyId: input.waterBodyId,
    skateEndTime: input.skateEndTime,
    iceTypes,
    surfaceTags,
  };
  if (input.skateStartTime !== undefined) normalized.skateStartTime = input.skateStartTime;
  if (input.skateEndPrecision !== undefined) normalized.skateEndPrecision = input.skateEndPrecision;
  if (input.observedFrom !== undefined) normalized.observedFrom = input.observedFrom;
  if (input.sighting !== undefined) normalized.sighting = input.sighting;
  if (input.skateQuality !== undefined) normalized.skateQuality = input.skateQuality;
  if (input.suitability !== undefined) normalized.suitability = input.suitability;
  // Drop an empty thickness section — an `iceThickness: { readings: [] }` carries no information.
  if (normalizedReadings.length > 0) {
    normalized.iceThickness = { readings: normalizedReadings };
    if (thicknessScope !== undefined) normalized.iceThickness.scope = thicknessScope;
  }
  if (snow !== undefined) normalized.snow = snow;
  if (normalizedConditions !== undefined) normalized.conditions = normalizedConditions;
  const notes = input.notes?.trim();
  if (notes) normalized.notes = notes;
  if (input.point !== undefined) normalized.point = input.point;

  return { ok: true, normalized };
}

// ── The minimum set (D189) ─────────────────────────────────────────────────────────────────────

/** The four terms of the minimum set, in the order the sheet asks for them. */
export const MINIMUM_SET_TERMS = ['body', 'endTime', 'howWasIt', 'observation'] as const;
export type MinimumSetTerm = (typeof MINIMUM_SET_TERMS)[number];

/**
 * What a report still needs before it may **post** (D189): a body, an end time, *How was it?*
 * (either axis — quality or suitability), and one observation — an ice or surface chip, a thickness
 * reading, a hazard, or, for a report from shore, a sighting. Engine-independent: prose alone never
 * posts, whoever or whatever filled the rest.
 *
 * Returns the missing terms (empty ⇒ may post). A pure check the sheet reducer runs on every
 * change and `posts.create` runs once, on create only — `update` never calls this, so a
 * pre-A10 notes-only report stays editable (D189 amendment, D199).
 */
export interface MinimumSetReport {
  waterBodyId: string;
  skateEndTime: number;
  skateQuality?: SkateQuality;
  suitability?: Suitability;
  iceTypes?: readonly ChipInput<IceType>[];
  surfaceTags?: readonly ChipInput<SurfaceTag>[];
  iceThickness?: { readings: readonly unknown[] };
  sighting?: Sighting;
}

/**
 * Every bay a report's `where`s name — on its chips and its readings — deduplicated, in order of
 * first mention. `validateWhere` checks the shape; that each id is a live bay *of this body* is the
 * server's check, made with the body's bays in hand (`reports.create` / `update`), and this is the
 * list it checks.
 */
export function locatedSubAreaIds(
  report: Pick<NormalizedReport, 'iceTypes' | 'surfaceTags' | 'iceThickness'>,
): string[] {
  const ids: string[] = [];
  const located: readonly { where?: Where }[] = [
    ...report.iceTypes,
    ...report.surfaceTags,
    ...(report.iceThickness?.readings ?? []),
  ];
  for (const item of located) {
    const id = item.where?.subAreaId;
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function minimumSetGaps(report: MinimumSetReport, hazardCount: number): MinimumSetTerm[] {
  const gaps: MinimumSetTerm[] = [];
  if (!report.waterBodyId) gaps.push('body');
  if (!Number.isFinite(report.skateEndTime) || report.skateEndTime <= 0) gaps.push('endTime');
  if (report.skateQuality === undefined && report.suitability === undefined) gaps.push('howWasIt');
  const observed =
    chipKeys(report.iceTypes).length > 0 ||
    chipKeys(report.surfaceTags).length > 0 ||
    (report.iceThickness?.readings.length ?? 0) > 0 ||
    hazardCount > 0 ||
    report.sighting !== undefined;
  if (!observed) gaps.push('observation');
  return gaps;
}
