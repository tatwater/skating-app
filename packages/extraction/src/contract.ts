/**
 * The extraction contract (A10 §1.1 / D196) — engine-independent, the one shape the eval harness,
 * the Convex action (§5.1), the corpus replay (D200) and the sheet reducer all speak.
 *
 * ```
 * { title?, text, bodyCandidates[], vocabulary } → { reports: [{ bodyRef, fields }], misses[] }
 * ```
 *
 * ## What the shape commits to
 *
 * - **Per body, per visit.** A multi-lake day or a before-and-after-work pair comes back as several
 *   reports, each with the body it is about and the sentences that are its own (`note`), which is
 *   how a Post becomes Reports (D186) and how a body page shows prose without the Post (§5.1).
 * - **Every value carries a confidence and an evidence span.** The confidence decides the D188 tier
 *   against the field's precision floor; the span is what the author sees on long-press and what
 *   the reviewer sees in the eval. A value with no span is a guess and is not returned.
 * - **Field keys are the sheet's field keys** (`SheetFieldKey`) where the two overlap, so the sheet
 *   applies a result with no mapping — plus `hazards`, `snowDepthCm` and the `note`, which are not
 *   chip fields. `endTime` is in the sheet's `EndTimeValue` shape.
 * - **A miss is a first-class output** (D200): anything the author said that the contract has no
 *   slot for — a texture, a landmark, a kind of report the sheet has no door for — so the corpus
 *   replay's miss list is produced by the same call that produces the reports.
 * - **Nothing here is a claim by us** (D3): every value is the author's, transcribed, for the author
 *   to confirm. The engine never invents a body; an unmatched name is returned as `bodyName` with a
 *   `null` ref for the sheet to resolve or the replay to count.
 *
 * Zod schemas sit beside the types because the Claude engine uses them as structured-output
 * schemas and the harness validates every engine's result against them.
 */

import {
  ACCESS_CONDITION_REASONS,
  HAZARD_TYPES,
  ICE_TYPES,
  OBSERVED_FROM,
  SECTORS,
  SIGHTINGS,
  SKATE_END_PRECISIONS,
  SKATE_QUALITIES,
  SNOW_COVERAGES,
  SNOW_DRIFTS,
  SNOW_IMPEDIMENTS,
  SUITABILITIES,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  WHERE_EXTENTS,
} from '@skating/core';
import { z } from 'zod';

// ── Input ───────────────────────────────────────────────────────────────────────────────────────

export const SubAreaCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});

export const BodyCandidateSchema = z.object({
  /** An opaque ref the caller resolves — a Convex id on the sheet, a corpus key in the eval. */
  ref: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  /** Named bays (A09) the `where` may name by id. */
  subAreas: z.array(SubAreaCandidateSchema).default([]),
  /** A hint for the engine — "Enfield, NH" — never returned. */
  place: z.string().optional(),
});
export type BodyCandidate = z.infer<typeof BodyCandidateSchema>;

/** The enums the engine may return, as the caller offers them. Built from core by `defaultVocabulary`. */
export const VocabularySchema = z.object({
  iceTypes: z.array(z.string()),
  surfaceTags: z.array(z.string()),
  hazardTypes: z.array(z.string()),
  qualities: z.array(z.string()),
  suitabilities: z.array(z.string()),
  observedFrom: z.array(z.string()),
  sightings: z.array(z.string()),
  snowCoverages: z.array(z.string()),
  snowImpediments: z.array(z.string()),
  snowDrifts: z.array(z.string()),
  sectors: z.array(z.string()),
  whereExtents: z.array(z.string()),
  accessConditions: z.array(z.string()),
  thicknessMethods: z.array(z.string()),
});
export type Vocabulary = z.infer<typeof VocabularySchema>;

export function defaultVocabulary(): Vocabulary {
  return {
    iceTypes: [...ICE_TYPES],
    surfaceTags: [...SURFACE_TAGS],
    hazardTypes: [...HAZARD_TYPES],
    qualities: [...SKATE_QUALITIES],
    suitabilities: [...SUITABILITIES],
    observedFrom: [...OBSERVED_FROM],
    sightings: [...SIGHTINGS],
    snowCoverages: [...SNOW_COVERAGES],
    snowImpediments: [...SNOW_IMPEDIMENTS],
    snowDrifts: [...SNOW_DRIFTS],
    sectors: [...SECTORS],
    whereExtents: [...WHERE_EXTENTS],
    accessConditions: [...ACCESS_CONDITION_REASONS],
    thicknessMethods: [...THICKNESS_METHODS],
  };
}

export const ExtractionInputSchema = z.object({
  title: z.string().optional(),
  text: z.string(),
  bodyCandidates: z.array(BodyCandidateSchema),
  vocabulary: VocabularySchema,
  /** When the text was written — relative dates ("yesterday") resolve against it. Epoch ms. */
  writtenAtMs: z.number().optional(),
  timeZone: z.string().default('America/New_York'),
});
export type ExtractionInput = z.infer<typeof ExtractionInputSchema>;

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

/** A span of the author's own text (title or body), by character offset into the field named. */
export const EvidenceSchema = z.object({
  field: z.enum(['title', 'text']).default('text'),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string(),
  /**
   * Was the quote found in the author's text? An engine quotes; the wrapper locates. A quote that
   * is not in the text is a sign the engine paraphrased or invented — the value is kept (recall)
   * but the reviewer and the sheet see the flag, and the eval counts it.
   */
  located: z.boolean().default(true),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** `confidence` is the engine's; the floor (§1.4) reads it. Calibration is what the eval measures. */
function field<V extends z.ZodTypeAny>(value: V) {
  return z.object({ value, confidence: z.number().min(0).max(1), evidence: EvidenceSchema });
}

export const WhereSchema = z.object({
  extent: z.enum(WHERE_EXTENTS).optional(),
  subAreaId: z.string().optional(),
  sector: z.enum(SECTORS).optional(),
  /** A named place the union has no id for yet ("off Shelburne Point") — the landmarks ETL's input. */
  placeName: z.string().optional(),
});
export type ExtractedWhere = z.infer<typeof WhereSchema>;

export const LocatedChipSchema = z.object({
  type: z.string(),
  where: WhereSchema.optional(),
  note: z.string().optional(),
});

export const ThicknessReadingSchema = z.object({
  method: z.enum(THICKNESS_METHODS),
  valueCm: z.number().optional(),
  minCm: z.number().optional(),
  maxCm: z.number().optional(),
  pokeCount: z.number().int().optional(),
  supportable: z.boolean().optional(),
  where: WhereSchema.optional(),
  note: z.string().optional(),
});

export const EndTimeSchema = z.object({
  ms: z.number(),
  precision: z.enum(SKATE_END_PRECISIONS),
});

export const HazardMentionSchema = z.object({
  type: z.enum(HAZARD_TYPES),
  where: WhereSchema.optional(),
  note: z.string().optional(),
});

export const ExtractedFieldsSchema = z.object({
  quality: z.array(field(z.enum(SKATE_QUALITIES))).default([]),
  suitability: z.array(field(z.enum(SUITABILITIES))).default([]),
  observedFrom: z.array(field(z.enum(OBSERVED_FROM))).default([]),
  sighting: z.array(field(z.enum(SIGHTINGS))).default([]),
  endTime: z.array(field(EndTimeSchema)).default([]),
  iceTypes: z.array(field(LocatedChipSchema)).default([]),
  surfaceTags: z.array(field(LocatedChipSchema)).default([]),
  snowCoverage: z.array(field(z.enum(SNOW_COVERAGES))).default([]),
  snowImpediment: z.array(field(z.enum(SNOW_IMPEDIMENTS))).default([]),
  snowDrifts: z.array(field(z.enum(SNOW_DRIFTS))).default([]),
  snowDepthCm: z.array(field(z.number())).default([]),
  thickness: z.array(field(ThicknessReadingSchema)).default([]),
  hazards: z.array(field(HazardMentionSchema)).default([]),
  accessConditions: z.array(field(z.enum(ACCESS_CONDITION_REASONS))).default([]),
});
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;
export type ExtractedFieldKey = keyof ExtractedFields;
export const EXTRACTED_FIELD_KEYS = Object.keys(ExtractedFieldsSchema.shape) as ExtractedFieldKey[];

export const ExtractedReportSchema = z.object({
  /** A `bodyCandidates[].ref`, or `null` when the text names a body that was not offered. */
  bodyRef: z.string().nullable(),
  /** The name as written, when `bodyRef` is null — never invented. */
  bodyName: z.string().optional(),
  /** Which visit on this body, when the text describes more than one (morning / after work): 0, 1, … */
  visit: z.number().int().min(0).default(0),
  /** The sentences that are this body's own (§5.1) — the Report's `note`, author-editable. */
  note: z.string().optional(),
  fields: ExtractedFieldsSchema,
});
export type ExtractedReport = z.infer<typeof ExtractedReportSchema>;

/** Why something the author said has no slot (D200) — the coverage check's buckets. */
export const MISS_KINDS = ['enum_value', 'field', 'where', 'report_kind', 'other'] as const;

export const MissSchema = z.object({
  kind: z.enum(MISS_KINDS),
  /** The author's words. */
  text: z.string(),
  /** What would have held it — "a `crusty` snow texture", "a landmark: Shelburne Point". */
  wouldNeed: z.string(),
});
export type Miss = z.infer<typeof MissSchema>;

export const ExtractionResultSchema = z.object({
  reports: z.array(ExtractedReportSchema),
  misses: z.array(MissSchema).default([]),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/** What an engine reports about a run, beside the result — the eval's cost and latency columns. */
export interface ExtractionUsage {
  engine: string;
  latencyMs: number;
  /** USD, from the engine's own rate table. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Requests made, so a two-stage engine's fan-out is visible. */
  requests: number;
}

export interface ExtractionRun {
  result: ExtractionResult;
  usage: ExtractionUsage;
}

/** The one method every engine implements (D196). */
export interface Extractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractionRun>;
}
