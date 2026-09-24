/**
 * The report sheet's state (A10 §3.1 / D187, D188, D189) — one pure reducer for the three doors,
 * the review screen and the edit screen, shared by mobile and web.
 *
 * ## Sections, in an order that never changes
 *
 * `SHEET_SECTIONS` is the fixed order (D187): *How was it?* pinned at the top, then how it was seen,
 * when, the ice, snow, thickness, hazards, access, photos, and the writing. A skater who wants to
 * put the thickness first scrolls to thickness; nothing reorders around a suggestion, an
 * extraction, or a fill. Each section reports whether it is filled and a one-line summary, and the
 * sheet collapses filled sections to that line.
 *
 * ## Three chip tiers (D188)
 *
 * Every chip-shaped field holds chips in one of three tiers, and the tier is decided by **whose
 * words the value came from**:
 *
 * - `ghost` — someone else implied it: another skater's report, the weather, the track, a prior
 *   visit, or an extraction below its field's precision floor. Rendered outlined; **never
 *   serializes**; only a tap makes it solid.
 * - `extracted` — a model read it out of the author's own title and prose, at or above the floor.
 *   Arrives **pre-selected**, marked *from your writing* with its evidence span, and persists on
 *   Post unless the author deselects it. The author said it once; asking them to tap it again is
 *   how reports end up half-complete.
 * - `solid` — the author tapped it, or typed it. Persists.
 *
 * `toReportInput` serializes the solid and extracted tiers and nothing else; `confirmList` is the
 * *Confirm & Post* screen's input, safety-flavored values first.
 *
 * ## The author is never overwritten
 *
 * A field the author has touched — tapped a chip, deselected one, typed — is `touched`, and a later
 * extraction may add ghosts to it but never changes a selection. Extractions also carry a sequence
 * number: a late result from an earlier paragraph never overrides a newer one.
 *
 * Nothing here is a safety claim (D3). The minimum set is `minimumSetGaps` in `report.ts`; the sheet
 * only asks it.
 */

import type { AccessConditionReason } from './accessAlert';
import type { LatLng } from './geometry';
import type { HazardVerdict } from './hazardLifecycle';
import {
  type MinimumSetTerm,
  minimumSetGaps,
  type ReportConditionsInput,
  type ReportInput,
  type ThicknessReadingInput,
} from './report';
import {
  type ChipInput,
  type LocatedChip,
  type LocatedIceType,
  type LocatedSurfaceTag,
  type Snow,
  toLocatedChip,
} from './reportFields';
import { formatThicknessReading, humanizeEnum } from './reportView';
import type {
  IceType,
  ObservedFrom,
  Sighting,
  SkateEndPrecision,
  SkateQuality,
  SnowCoverage,
  SnowDrift,
  SnowImpediment,
  Suitability,
  SurfaceTag,
  ThicknessScope,
} from './types';
import { cmToInches, inchesToCm } from './units';
import { describeLocatedChip, type Where } from './where';

// ── Sections ────────────────────────────────────────────────────────────────────────────────────

/** The fixed section order (D187). *How was it?* is pinned; nothing ever moves. */
export const SHEET_SECTIONS = [
  'howWasIt',
  'observedFrom',
  'endTime',
  'iceAndSurface',
  'snow',
  'thickness',
  'hazards',
  'access',
  'photos',
  'writing',
] as const;
export type SheetSection = (typeof SHEET_SECTIONS)[number];

// ── Chips ───────────────────────────────────────────────────────────────────────────────────────

export type ChipTier = 'ghost' | 'extracted' | 'solid';

/** Where a ghost came from — what the collapsed suggestion line names. */
export type SuggestionSource = 'peer' | 'weather' | 'track' | 'prior' | 'extraction';

/** A span of the author's own writing that an extracted value came from. */
export interface EvidenceSpan {
  start: number;
  end: number;
  text: string;
}

export interface SheetChip<V> {
  /** Identity within the field — one chip per key. For a located chip, the type; for a reading, an id. */
  key: string;
  value: V;
  tier: ChipTier;
  /** Ghosts only: who implied it. */
  source?: SuggestionSource;
  /** Extracted (and demoted-extraction ghosts): the model's confidence and the span it read. */
  confidence?: number;
  evidence?: EvidenceSpan;
  /**
   * A solid chip the *sheet* set rather than the author (`observedFrom: on_ice`, D191). Serializes
   * like any solid chip, but an extraction in the same untouched field may step it down to a ghost —
   * a default is what stands until someone says otherwise, and the author's prose counts.
   */
  defaulted?: boolean;
}

export interface ChipField<V> {
  chips: SheetChip<V>[];
  /** One selection at most (a quality) or many (ice types)? */
  multi: boolean;
  /** Has the author tapped, deselected or typed here? Once true, no extraction changes a selection. */
  touched: boolean;
}

export interface EndTimeValue {
  ms: number;
  precision: SkateEndPrecision;
}

/** The chip-shaped fields. Keys are stable strings so the extraction contract can address them. */
export interface SheetFields {
  quality: ChipField<SkateQuality>;
  suitability: ChipField<Suitability>;
  observedFrom: ChipField<ObservedFrom>;
  sighting: ChipField<Sighting>;
  endTime: ChipField<EndTimeValue>;
  iceTypes: ChipField<LocatedIceType>;
  surfaceTags: ChipField<LocatedSurfaceTag>;
  snowCoverage: ChipField<SnowCoverage>;
  snowImpediment: ChipField<SnowImpediment>;
  snowDrifts: ChipField<SnowDrift>;
  thickness: ChipField<ThicknessReadingInput>;
  accessConditions: ChipField<AccessConditionReason>;
}
export type SheetFieldKey = keyof SheetFields;
export type FieldValue<K extends SheetFieldKey> =
  SheetFields[K] extends ChipField<infer V> ? V : never;

const MULTI_FIELDS: ReadonlySet<SheetFieldKey> = new Set<SheetFieldKey>([
  'iceTypes',
  'surfaceTags',
  'thickness',
  'accessConditions',
]);

/** The section each field renders in. */
export const FIELD_SECTION: Record<SheetFieldKey, SheetSection> = {
  quality: 'howWasIt',
  suitability: 'howWasIt',
  observedFrom: 'observedFrom',
  sighting: 'observedFrom',
  endTime: 'endTime',
  iceTypes: 'iceAndSurface',
  surfaceTags: 'iceAndSurface',
  snowCoverage: 'snow',
  snowImpediment: 'snow',
  snowDrifts: 'snow',
  thickness: 'thickness',
  accessConditions: 'access',
};

/**
 * A hazard the track passed (§6.2) or the body carries (§6 (d)), with the author's answer —
 * `undefined` until they answer. The three D52 verdicts, as `hazardConfirmations.confirm` takes
 * them, plus *didn't look*: silence is never a vote, and neither is "I didn't go there". A tick-
 * through "gone" would be `fully_healed` under a softer label — the one vote D52 makes deliberately
 * hard — so the word stays the word (founder call, 2026-09-21).
 */
export type PassedVerdict = Exclude<HazardVerdict, 'never_existed'> | 'didnt_look';
export const PASSED_VERDICTS = [
  'still_there',
  'healing_unsafe',
  'fully_healed',
  'didnt_look',
] as const satisfies readonly PassedVerdict[];

/** The verdicts that file a confirmation (`via: 'report_flow'`); *didn't look* files nothing. */
export function confirmableVerdict(
  verdict: PassedVerdict,
): Exclude<PassedVerdict, 'didnt_look'> | null {
  return verdict === 'didnt_look' ? null : verdict;
}

export interface ReportSheetState {
  waterBodyId?: string;
  /** The minute the sheet was opened — the pinned end-time chip's instant, kept across a resume (D192). */
  openedAtMs: number;
  fields: SheetFields;
  /** Author-typed scalars. Each is `touched` the moment it is set. */
  scalars: {
    skateStartTime?: number;
    snowDepthCm?: number;
    plowedPath?: boolean;
    thicknessScope?: ThicknessScope;
    notes: string;
    point?: LatLng;
    putInId?: string;
    /** The lot the skater parked at (A06d), when they chose one — a target for lot-shaped conditions (D197). */
    parkingAreaId?: string;
    /** The one-line access note that rides the condition alerts (D197). */
    accessNote?: string;
    /** The per-report put-in opt-out (Phase 04 #7). `undefined` reads as shown, like the stored field. */
    showPutIn?: boolean;
    /**
     * The report's weather block. On a fresh sheet, absent — the server autofills from Open-Meteo
     * at create, as it does today — until the author corrects what the sheet shows for the hour
     * (founder call, 2026-09-21), which stores the block as `source: 'user'`. On an edit, seeded
     * whole from the stored row with its source, because `reports.update` is last-write-wins over
     * the block and an omitted block is a cleared one.
     */
    conditions?: ReportConditionsInput;
    photoIds: string[];
    /** Hazards drawn from the sheet or bundled (D55): ids the Report will carry. */
    hazardIds: string[];
    /** The tick-through (§6.2): passed hazard id → the author's verdict. Silence is never a vote. */
    passedVerdicts: Record<string, PassedVerdict>;
  };
  /** JSON-shaped (a draft persists this), never a `Set`. */
  touchedScalars: Partial<Record<keyof ReportSheetState['scalars'], true>>;
  collapsed: Record<SheetSection, boolean>;
  /** The newest extraction applied; an older sequence is ignored. */
  extractionSeq: number;
}

function emptyField<V>(multi: boolean): ChipField<V> {
  return { chips: [], multi, touched: false };
}

/** A fresh sheet on a body (door one), or with no body yet (door two). `observedFrom` defaults to on the ice, untouched. */
export function emptySheet(
  openedAtMs: number,
  waterBodyId?: string,
  opts: { showPutIn?: boolean } = {},
): ReportSheetState {
  const fields = {} as SheetFields;
  for (const key of Object.keys(FIELD_SECTION) as SheetFieldKey[]) {
    (fields as Record<SheetFieldKey, ChipField<unknown>>)[key] = emptyField(MULTI_FIELDS.has(key));
  }
  // D191: on the ice is the default, and it is a *default* — solid so it serializes, untouched so
  // an extraction that reads "from the shore" may still move it.
  fields.observedFrom.chips = [{ key: 'on_ice', value: 'on_ice', tier: 'solid', defaulted: true }];
  return {
    ...(waterBodyId !== undefined ? { waterBodyId } : {}),
    openedAtMs,
    fields,
    scalars: {
      notes: '',
      photoIds: [],
      hazardIds: [],
      passedVerdicts: {},
      ...(opts.showPutIn !== undefined ? { showPutIn: opts.showPutIn } : {}),
    },
    touchedScalars: {},
    collapsed: Object.fromEntries(SHEET_SECTIONS.map((s) => [s, false])) as Record<
      SheetSection,
      boolean
    >,
    extractionSeq: 0,
  };
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────

/** One extracted value for a field, as the extraction contract returns it (§1.1). */
export interface ExtractedValue<V> {
  key: string;
  value: V;
  confidence: number;
  evidence: EvidenceSpan;
}

export type SheetAction =
  | { type: 'setBody'; waterBodyId: string }
  /**
   * The author taps a chip: a ghost or extracted chip becomes solid; a new value is added solid; a
   * value with an existing key replaces it. `defaulted` is the *sheet* selecting on the author's
   * behalf (the pinned end-time preselect, D192, the way `observedFrom: on_ice` is set at open):
   * the chip is solid but `defaulted`, and the field is not `touched` — a default stands until
   * someone says otherwise, and the author's prose counts (D191).
   */
  | { type: 'select'; field: SheetFieldKey; key: string; value?: unknown; defaulted?: true }
  /** The author deselects: solid → gone, extracted → ghost (still offered, never re-promoted). */
  | { type: 'deselect'; field: SheetFieldKey; key: string }
  /** Attach or change a `where` on a located chip (ice, surface) or a reading. */
  | {
      type: 'setWhere';
      field: 'iceTypes' | 'surfaceTags' | 'thickness';
      key: string;
      where?: Where;
    }
  | { type: 'setScalar'; key: keyof ReportSheetState['scalars']; value: unknown }
  /** Suggestions from anyone but the author (D188): added as ghosts, never selected. */
  | {
      type: 'suggest';
      field: SheetFieldKey;
      source: SuggestionSource;
      values: { key: string; value: unknown }[];
    }
  /** An extraction result: at/above the floor ⇒ extracted (pre-selected), below ⇒ ghost. */
  | {
      type: 'applyExtraction';
      seq: number;
      floors: Partial<Record<SheetFieldKey, number>>;
      fields: Partial<{ [K in SheetFieldKey]: ExtractedValue<FieldValue<K>>[] }>;
    }
  | { type: 'answerPassed'; hazardId: string; verdict: PassedVerdict }
  /** The quick thickness row (D195): one band at most; `null` is *didn't check*. Precise readings are untouched. */
  | { type: 'selectThicknessBand'; band: ThicknessBand | null; where?: Where }
  | { type: 'setCollapsed'; section: SheetSection; collapsed: boolean };

/** The floor for a field when none was configured: everything is a ghost until the eval sets one (§1.4). */
export const DEFAULT_PRECISION_FLOOR = 1.01;

function isSelected(chip: SheetChip<unknown>): boolean {
  return chip.tier !== 'ghost';
}

function withField<K extends SheetFieldKey>(
  state: ReportSheetState,
  key: K,
  update: (field: SheetFields[K]) => SheetFields[K],
): ReportSheetState {
  const next = update(state.fields[key]);
  if (next === state.fields[key]) return state;
  return { ...state, fields: { ...state.fields, [key]: next } };
}

/** A solid chip the author owns — not the sheet's own default. */
function authorSolid(chip: SheetChip<unknown>): boolean {
  return chip.tier === 'solid' && chip.defaulted !== true;
}

export function sheetReducer(state: ReportSheetState, action: SheetAction): ReportSheetState {
  switch (action.type) {
    case 'setBody': {
      if (action.waterBodyId === state.waterBodyId) return state;
      // A peer's ghost was about the lake it came from (§4.4): on another lake it is nobody's
      // suggestion, so it goes; the author's own chips, and a ghost from their track or their
      // writing, are about their skate and stay.
      const fields = { ...state.fields };
      for (const key of Object.keys(fields) as SheetFieldKey[]) {
        const field = fields[key] as ChipField<unknown>;
        if (!field.chips.some((c) => c.tier === 'ghost' && c.source === 'peer')) continue;
        (fields as Record<SheetFieldKey, ChipField<unknown>>)[key] = {
          ...field,
          chips: field.chips.filter((c) => !(c.tier === 'ghost' && c.source === 'peer')),
        };
      }
      return { ...state, waterBodyId: action.waterBodyId, fields };
    }

    case 'select':
      return withField(state, action.field, (field) => {
        const chips = field.chips as SheetChip<unknown>[];
        const existing = chips.find((c) => c.key === action.key);
        const defaulted = action.defaulted === true ? true : undefined;
        let next: SheetChip<unknown>[];
        if (existing) {
          // A value with the tap replaces the chip's (a reading the author retyped); without one
          // the tap only promotes the tier.
          next = chips.map((c) =>
            c.key === action.key
              ? {
                  ...c,
                  ...(action.value !== undefined ? { value: action.value } : {}),
                  tier: 'solid' as const,
                  defaulted,
                }
              : c,
          );
        } else {
          if (action.value === undefined) return field; // nothing to add
          next = [
            ...chips,
            {
              key: action.key,
              value: action.value,
              tier: 'solid',
              ...(defaulted ? { defaulted } : {}),
            },
          ];
        }
        // A single-select field: the other selections step down — extracted to ghost, solid gone.
        if (!field.multi) {
          next = next.flatMap((c) => {
            if (c.key === action.key || !isSelected(c)) return [c];
            return c.tier === 'extracted' ? [{ ...c, tier: 'ghost' as const }] : [];
          });
        }
        // A default is the sheet's doing, not the author's: the field stays untouched.
        return { ...field, chips: next, touched: defaulted ? field.touched : true } as typeof field;
      });

    case 'deselect':
      return withField(state, action.field, (field) => {
        const chips = field.chips as SheetChip<unknown>[];
        const next = chips.flatMap((c) => {
          if (c.key !== action.key) return [c];
          if (c.tier === 'extracted') return [{ ...c, tier: 'ghost' as const }];
          if (c.tier === 'solid') return [];
          return [c];
        });
        return { ...field, chips: next, touched: true } as typeof field;
      });

    case 'setWhere':
      return withField(state, action.field, (field) => {
        const chips = field.chips as SheetChip<{ where?: Where }>[];
        const next = chips.map((c) => {
          if (c.key !== action.key) return c;
          const { where: _dropped, ...rest } = c.value;
          return { ...c, value: action.where ? { ...rest, where: action.where } : rest };
        });
        return { ...field, chips: next, touched: true } as typeof field;
      });

    case 'setScalar':
      return {
        ...state,
        scalars: { ...state.scalars, [action.key]: action.value },
        touchedScalars: { ...state.touchedScalars, [action.key]: true },
      };

    case 'suggest':
      return withField(state, action.field, (field) => {
        const chips = field.chips as SheetChip<unknown>[];
        const known = new Set(chips.map((c) => c.key));
        const added = action.values
          .filter((v) => !known.has(v.key))
          .map((v) => ({
            key: v.key,
            value: v.value,
            tier: 'ghost' as const,
            source: action.source,
          }));
        return { ...field, chips: [...chips, ...added] } as typeof field;
      });

    case 'applyExtraction': {
      // A late result from an earlier paragraph never overrides a newer one.
      if (action.seq <= state.extractionSeq) return state;
      let next: ReportSheetState = { ...state, extractionSeq: action.seq };
      for (const [fieldKey, values] of Object.entries(action.fields) as [
        SheetFieldKey,
        ExtractedValue<unknown>[] | undefined,
      ][]) {
        if (!values) continue;
        const floor = action.floors[fieldKey] ?? DEFAULT_PRECISION_FLOOR;
        next = withField(next, fieldKey, (field) => {
          let chips = field.chips as SheetChip<unknown>[];
          for (const v of values) {
            const tier: ChipTier = v.confidence >= floor ? 'extracted' : 'ghost';
            const existing = chips.find((c) => c.key === v.key);
            if (existing) {
              // Never change a selection the author made or unmade; refresh evidence on the rest.
              if (field.touched || authorSolid(existing)) continue;
              chips = chips.map((c) =>
                c.key === v.key
                  ? {
                      ...c,
                      value: v.value,
                      tier,
                      confidence: v.confidence,
                      evidence: v.evidence,
                      source: 'extraction',
                    }
                  : c,
              );
              continue;
            }
            // A touched field takes new values as ghosts only — the author is done deciding here.
            const arriving: ChipTier = field.touched ? 'ghost' : tier;
            chips = [
              ...chips,
              {
                key: v.key,
                value: v.value,
                tier: arriving,
                confidence: v.confidence,
                evidence: v.evidence,
                source: 'extraction',
              },
            ];
          }
          // A single-select field keeps at most one extracted selection — the most confident — and
          // an extracted selection steps the sheet's own default down to a ghost.
          if (!field.multi) {
            const extracted = chips.filter((c) => c.tier === 'extracted');
            const hasSolid = chips.some(authorSolid);
            const keep = hasSolid
              ? undefined
              : extracted.reduce<SheetChip<unknown> | undefined>(
                  (a, b) => (a === undefined || (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a),
                  undefined,
                );
            chips = chips.map((c) => {
              if (c.tier === 'extracted' && c !== keep) return { ...c, tier: 'ghost' };
              if (c.tier === 'solid' && c.defaulted && keep !== undefined) {
                return { ...c, tier: 'ghost', defaulted: undefined };
              }
              return c;
            });
          }
          return { ...field, chips } as typeof field;
        });
      }
      return next;
    }

    case 'answerPassed':
      return {
        ...state,
        scalars: {
          ...state.scalars,
          passedVerdicts: { ...state.scalars.passedVerdicts, [action.hazardId]: action.verdict },
        },
      };

    case 'selectThicknessBand':
      return withField(state, 'thickness', (field) => {
        const kept = field.chips.filter((c) => thicknessBandOfKey(c.key) === null);
        const chips =
          action.band === null
            ? kept
            : [
                ...kept,
                {
                  key: thicknessBandKey(action.band),
                  value: thicknessBandReading(action.band, action.where),
                  tier: 'solid' as const,
                },
              ];
        return { ...field, chips, touched: true };
      });

    case 'setCollapsed':
      return { ...state, collapsed: { ...state.collapsed, [action.section]: action.collapsed } };
  }
}

// ── The quick thickness path (D195) ─────────────────────────────────────────────────────────────

/**
 * The chip row *under 2 / 2–3 / 3–4 / 4–6 / 6+* — a band is stored as one `estimated` reading with
 * the band's edges in cm (a lower bound only for *6+*; *under 2* is `0–2`, because the validator
 * spells an upper bound alone as `minCm: 0` — a bare `maxCm` is refused as no range), so every
 * downstream reader sees a reading, not a new shape. `didn't check` is the absence of a band.
 */
export const THICKNESS_BANDS = ['under_2', '2_3', '3_4', '4_6', '6_plus'] as const;
export type ThicknessBand = (typeof THICKNESS_BANDS)[number];

export const THICKNESS_BAND_LABELS: Record<ThicknessBand, string> = {
  under_2: 'Under 2"',
  '2_3': '2–3"',
  '3_4': '3–4"',
  '4_6': '4–6"',
  '6_plus': '6"+',
};

const BAND_INCHES: Record<ThicknessBand, { min?: number; max?: number }> = {
  under_2: { min: 0, max: 2 },
  '2_3': { min: 2, max: 3 },
  '3_4': { min: 3, max: 4 },
  '4_6': { min: 4, max: 6 },
  '6_plus': { min: 6 },
};

const BAND_KEY_PREFIX = 'band:';

export function thicknessBandKey(band: ThicknessBand): string {
  return `${BAND_KEY_PREFIX}${band}`;
}

/** The band a chip key names, or `null` for a precise reading's key. */
export function thicknessBandOfKey(key: string): ThicknessBand | null {
  if (!key.startsWith(BAND_KEY_PREFIX)) return null;
  const band = key.slice(BAND_KEY_PREFIX.length);
  return (THICKNESS_BANDS as readonly string[]).includes(band) ? (band as ThicknessBand) : null;
}

/** The reading a band stands for. */
export function thicknessBandReading(band: ThicknessBand, where?: Where): ThicknessReadingInput {
  const { min, max } = BAND_INCHES[band];
  return {
    method: 'estimated',
    ...(min !== undefined ? { minCm: inchesToCm(min) } : {}),
    ...(max !== undefined ? { maxCm: inchesToCm(max) } : {}),
    ...(where !== undefined ? { where } : {}),
  };
}

/**
 * The band a stored reading came from, or `null` when it is a precise reading — so an edit shows
 * the quick row the way the author left it. Exact on the edges in inches (a tenth is finer than any
 * band edge), `estimated`, no count, no word.
 */
export function thicknessBandOf(reading: ThicknessReadingInput): ThicknessBand | null {
  if (reading.method !== 'estimated' || reading.valueCm !== undefined) return null;
  if (reading.pokeCount !== undefined || reading.supportable !== undefined) return null;
  const min =
    reading.minCm === undefined ? undefined : Math.round(cmToInches(reading.minCm) * 10) / 10;
  const max =
    reading.maxCm === undefined ? undefined : Math.round(cmToInches(reading.maxCm) * 10) / 10;
  for (const band of THICKNESS_BANDS) {
    const edges = BAND_INCHES[band];
    if (edges.min === min && edges.max === max) return band;
  }
  return null;
}

// ── Seeding from what was stored ────────────────────────────────────────────────────────────────

/**
 * A stored report, as much of it as a sheet is seeded from: the edit door (A06f folded in, §4.1)
 * and a draft the pre-sheet form saved. Structural rather than `Doc<'reports'>` so core stays free
 * of the data model; both clients pass the row they hold, or `buildReportInput`'s output.
 */
export interface SheetSeed {
  waterBodyId?: string;
  skateEndTime: number;
  skateStartTime?: number;
  skateEndPrecision?: SkateEndPrecision;
  observedFrom?: ObservedFrom;
  sighting?: Sighting;
  iceTypes?: readonly ChipInput<IceType>[];
  surfaceTags?: readonly ChipInput<SurfaceTag>[];
  skateQuality?: SkateQuality;
  suitability?: Suitability;
  iceThickness?: { readings: readonly ThicknessReadingInput[]; scope?: ThicknessScope };
  snow?: Snow;
  conditions?: ReportConditionsInput;
  notes?: string;
  point?: LatLng;
  putInId?: string;
  showPutIn?: boolean;
  photoIds?: readonly string[];
  /** The hazards the report already carries (drawn or bundled) — an edit never re-offers them. */
  hazardIds?: readonly string[];
}

function solid<V>(key: string, value: V): SheetChip<V> {
  return { key, value, tier: 'solid' };
}

/**
 * The chips of a located field, one per stored chip: keyed by type, and a second chip of the same
 * type — "black ice, north end" and "black ice, south bay" — keyed `type#2` so neither is lost on
 * the round trip (`reports.update` is last-write-wins over the block).
 */
function locatedChips<T extends string>(
  stored: readonly ChipInput<T>[],
): SheetChip<LocatedChip<T>>[] {
  const seen = new Map<string, number>();
  return stored.map((chip) => {
    const located = toLocatedChip(chip);
    const n = (seen.get(located.type) ?? 0) + 1;
    seen.set(located.type, n);
    return solid(n === 1 ? located.type : `${located.type}#${n}`, located);
  });
}

/**
 * Seed a sheet from a stored report — every value solid and the author's (never `defaulted`), so a
 * later extraction (A10-4) can add ghosts beside them but never move one. `openedAtMs` is the
 * sheet's own open time (the pinned chip); the stored end time is the selected chip regardless.
 */
export function sheetFromReport(seed: SheetSeed, openedAtMs: number): ReportSheetState {
  const state = emptySheet(openedAtMs, seed.waterBodyId, {
    ...(seed.showPutIn !== undefined ? { showPutIn: seed.showPutIn } : {}),
  });
  const f = state.fields;
  if (seed.skateQuality !== undefined)
    f.quality.chips = [solid(seed.skateQuality, seed.skateQuality)];
  if (seed.suitability !== undefined)
    f.suitability.chips = [solid(seed.suitability, seed.suitability)];
  if (seed.observedFrom !== undefined)
    f.observedFrom.chips = [solid(seed.observedFrom, seed.observedFrom)];
  if (seed.sighting !== undefined) f.sighting.chips = [solid(seed.sighting, seed.sighting)];
  f.endTime.chips = [
    solid('stored', { ms: seed.skateEndTime, precision: seed.skateEndPrecision ?? 'half_hour' }),
  ];
  f.iceTypes.chips = locatedChips(seed.iceTypes ?? []);
  f.surfaceTags.chips = locatedChips(seed.surfaceTags ?? []);
  const snow = seed.snow;
  if (snow?.coverage !== undefined) f.snowCoverage.chips = [solid(snow.coverage, snow.coverage)];
  if (snow?.impediment !== undefined)
    f.snowImpediment.chips = [solid(snow.impediment, snow.impediment)];
  if (snow?.drifts !== undefined) f.snowDrifts.chips = [solid(snow.drifts, snow.drifts)];
  f.thickness.chips = (seed.iceThickness?.readings ?? []).map((reading, i) => {
    const band = thicknessBandOf(reading);
    return solid(band === null ? `reading:${i + 1}` : thicknessBandKey(band), reading);
  });

  const scalars: ReportSheetState['scalars'] = {
    ...state.scalars,
    notes: seed.notes ?? '',
    photoIds: [...(seed.photoIds ?? [])],
    hazardIds: [...(seed.hazardIds ?? [])],
    ...(seed.skateStartTime !== undefined ? { skateStartTime: seed.skateStartTime } : {}),
    ...(snow?.depthCm !== undefined ? { snowDepthCm: snow.depthCm } : {}),
    ...(snow?.plowedPath !== undefined ? { plowedPath: snow.plowedPath } : {}),
    ...(seed.iceThickness?.scope !== undefined ? { thicknessScope: seed.iceThickness.scope } : {}),
    ...(seed.point !== undefined ? { point: seed.point } : {}),
    ...(seed.putInId !== undefined ? { putInId: seed.putInId } : {}),
    ...(seed.conditions !== undefined ? { conditions: seed.conditions } : {}),
  };
  const touchedScalars: ReportSheetState['touchedScalars'] = {};
  for (const key of Object.keys(scalars) as (keyof typeof scalars)[]) {
    const v = scalars[key];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (key === 'passedVerdicts') continue;
    touchedScalars[key] = true;
  }
  return { ...state, scalars, touchedScalars };
}

// ── Selectors ───────────────────────────────────────────────────────────────────────────────────

/** The selected (solid + extracted) values of a field, in chip order. Ghosts never appear. */
export function selectedValues<K extends SheetFieldKey>(
  state: ReportSheetState,
  key: K,
): FieldValue<K>[] {
  return (state.fields[key].chips as SheetChip<FieldValue<K>>[])
    .filter(isSelected)
    .map((c) => c.value);
}

/** The selected chips of a field — for the *Confirm & Post* list, which needs the tier and evidence. */
export function selectedChips<K extends SheetFieldKey>(
  state: ReportSheetState,
  key: K,
): SheetChip<FieldValue<K>>[] {
  return (state.fields[key].chips as SheetChip<FieldValue<K>>[]).filter(isSelected);
}

/** Serialize the sheet to the validator's input. Solid and extracted chips only; ghosts never. */
export function toReportInput(state: ReportSheetState): ReportInput {
  const s = state.scalars;
  const [quality] = selectedValues(state, 'quality');
  const [suitability] = selectedValues(state, 'suitability');
  const [observedFrom] = selectedValues(state, 'observedFrom');
  const [sighting] = selectedValues(state, 'sighting');
  const [endTime] = selectedValues(state, 'endTime');
  const [snowCoverage] = selectedValues(state, 'snowCoverage');
  const [snowImpediment] = selectedValues(state, 'snowImpediment');
  const [snowDrifts] = selectedValues(state, 'snowDrifts');
  const readings = selectedValues(state, 'thickness');
  const snow = {
    ...(snowCoverage !== undefined ? { coverage: snowCoverage } : {}),
    ...(snowImpediment !== undefined ? { impediment: snowImpediment } : {}),
    ...(snowDrifts !== undefined ? { drifts: snowDrifts } : {}),
    ...(s.snowDepthCm !== undefined ? { depthCm: s.snowDepthCm } : {}),
    ...(s.plowedPath !== undefined ? { plowedPath: s.plowedPath } : {}),
  };
  const notes = s.notes.trim();
  return {
    waterBodyId: state.waterBodyId ?? '',
    skateEndTime: endTime?.ms ?? Number.NaN,
    ...(endTime !== undefined ? { skateEndPrecision: endTime.precision } : {}),
    ...(s.skateStartTime !== undefined ? { skateStartTime: s.skateStartTime } : {}),
    ...(observedFrom !== undefined ? { observedFrom } : {}),
    ...(sighting !== undefined ? { sighting } : {}),
    iceTypes: selectedValues(state, 'iceTypes'),
    surfaceTags: selectedValues(state, 'surfaceTags'),
    ...(quality !== undefined ? { skateQuality: quality } : {}),
    ...(suitability !== undefined ? { suitability } : {}),
    ...(readings.length > 0
      ? { iceThickness: { readings, ...(s.thicknessScope ? { scope: s.thicknessScope } : {}) } }
      : {}),
    ...(Object.keys(snow).length > 0 ? { snow } : {}),
    ...(notes ? { notes } : {}),
    ...(s.point !== undefined ? { point: s.point } : {}),
    ...(s.putInId !== undefined ? { putInId: s.putInId } : {}),
    // Only the opt-out travels — the stored field is optional-defaults-to-shown.
    ...(s.showPutIn === false ? { showPutIn: false } : {}),
    ...(s.conditions !== undefined && conditionsHasValue(s.conditions)
      ? { conditions: { ...s.conditions, source: s.conditions.source ?? ('user' as const) } }
      : {}),
  };
}

function conditionsHasValue(c: ReportConditionsInput): boolean {
  return (
    c.airTempC !== undefined ||
    c.windSpeedKph !== undefined ||
    (c.windDir !== undefined && c.windDir !== '') ||
    c.sky !== undefined ||
    c.precip !== undefined
  );
}

/** The D189 gaps for this sheet — what still stands between it and *Post*. */
export function sheetGaps(state: ReportSheetState): MinimumSetTerm[] {
  return minimumSetGaps(toReportInput(state), state.scalars.hazardIds.length);
}

/** Is any extracted chip selected? Then the button reads *Confirm & Post* (D188). */
export function hasExtracted(state: ReportSheetState): boolean {
  return (Object.keys(FIELD_SECTION) as SheetFieldKey[]).some((key) =>
    state.fields[key].chips.some((c) => c.tier === 'extracted'),
  );
}

export interface ConfirmItem {
  field: SheetFieldKey;
  chip: SheetChip<unknown>;
  /** Safety-flavored values lead the list (D188): don't go, suitability, thickness, sighting. */
  safety: boolean;
}

const SAFETY_FIELDS: ReadonlySet<SheetFieldKey> = new Set<SheetFieldKey>([
  'suitability',
  'thickness',
  'sighting',
]);

/** The *Confirm & Post* list: every extracted chip, safety-flavored first, in section order. */
export function confirmList(state: ReportSheetState): ConfirmItem[] {
  const items: ConfirmItem[] = [];
  for (const key of Object.keys(FIELD_SECTION) as SheetFieldKey[]) {
    for (const chip of state.fields[key].chips) {
      if (chip.tier !== 'extracted') continue;
      items.push({ field: key, chip: chip as SheetChip<unknown>, safety: SAFETY_FIELDS.has(key) });
    }
  }
  return items.sort((a, b) => Number(b.safety) - Number(a.safety));
}

/** Is the section filled — something selected or typed in it? */
export function sectionFilled(state: ReportSheetState, section: SheetSection): boolean {
  const s = state.scalars;
  const anySelected = (Object.keys(FIELD_SECTION) as SheetFieldKey[])
    .filter((k) => FIELD_SECTION[k] === section)
    .some((k) => selectedValues(state, k).length > 0);
  switch (section) {
    case 'observedFrom':
      // The default is a default, not a fill — but a tap or an extraction that moved it is one.
      return (
        selectedChips(state, 'observedFrom').some((c) => c.defaulted !== true) ||
        selectedValues(state, 'sighting').length > 0
      );
    case 'snow':
      return anySelected || s.snowDepthCm !== undefined || s.plowedPath !== undefined;
    case 'hazards':
      return s.hazardIds.length > 0 || Object.keys(s.passedVerdicts).length > 0;
    case 'access':
      return anySelected || s.putInId !== undefined || s.point !== undefined;
    case 'photos':
      return s.photoIds.length > 0;
    case 'writing':
      return s.notes.trim().length > 0;
    default:
      return anySelected;
  }
}

/** Format an end-time chip for a summary line — local time in the given zone. */
function formatEndTime(value: EndTimeValue, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(value.ms);
  return value.precision === 'half_hour' ? `about ${time}` : time;
}

/**
 * The one-line summary a filled section collapses to. Never a safety verdict (D3): it repeats the
 * author's own chips and nothing more. Empty string for an unfilled section.
 */
export function sectionSummary(
  state: ReportSheetState,
  section: SheetSection,
  timeZone: string,
): string {
  if (!sectionFilled(state, section)) return '';
  const s = state.scalars;
  switch (section) {
    case 'howWasIt': {
      const [q] = selectedValues(state, 'quality');
      const [suit] = selectedValues(state, 'suitability');
      return [q && humanizeEnum(q), suit && humanizeEnum(suit)].filter(Boolean).join(' · ');
    }
    case 'observedFrom': {
      const [from] = selectedValues(state, 'observedFrom');
      const [sighting] = selectedValues(state, 'sighting');
      return [from && humanizeEnum(from), sighting && humanizeEnum(sighting)]
        .filter(Boolean)
        .join(' · ');
    }
    case 'endTime': {
      const [t] = selectedValues(state, 'endTime');
      return t ? formatEndTime(t, timeZone) : '';
    }
    case 'iceAndSurface':
      return [...selectedValues(state, 'iceTypes'), ...selectedValues(state, 'surfaceTags')]
        .map((chip) => describeLocatedChip(chip))
        .join(' · ');
    case 'snow': {
      const [c] = selectedValues(state, 'snowCoverage');
      const [i] = selectedValues(state, 'snowImpediment');
      const [d] = selectedValues(state, 'snowDrifts');
      return [
        c && `Snow: ${humanizeEnum(c).toLowerCase()}`,
        i && humanizeEnum(i).toLowerCase(),
        d && d !== 'none' && `drifts ${humanizeEnum(d).toLowerCase()}`,
        s.plowedPath && 'plowed path',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'thickness':
      return selectedValues(state, 'thickness')
        .map((r) => formatThicknessReading(r))
        .filter((x): x is string => x !== null)
        .join(' · ');
    case 'hazards': {
      const answered = Object.values(s.passedVerdicts).filter((v) => v !== 'didnt_look').length;
      const parts = [
        s.hazardIds.length > 0 && `${s.hazardIds.length} marked`,
        answered > 0 && `${answered} confirmed`,
      ].filter(Boolean);
      return parts.join(' · ');
    }
    case 'access':
      return [
        s.putInId !== undefined && 'Put-in chosen',
        ...selectedValues(state, 'accessConditions').map(humanizeEnum),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'photos':
      return `${s.photoIds.length} ${s.photoIds.length === 1 ? 'photo' : 'photos'}`;
    case 'writing':
      return s.notes.trim().split(/\s+/).slice(0, 8).join(' ');
  }
}
