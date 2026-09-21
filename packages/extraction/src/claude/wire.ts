/**
 * What Claude is asked to return, and how it becomes the contract.
 *
 * The wire shape differs from the contract on purpose, in three places the model is bad at and the
 * wrapper is good at:
 *
 * - **Quotes, not offsets.** A model asked for character offsets guesses; asked for the exact quote
 *   it copies. The wrapper locates the quote (whitespace-folded, case-insensitive) and stamps the
 *   offsets, flagging `located: false` when the quote is not in the text.
 * - **Inches and local clock times, not centimeters and epoch ms.** The corpus writes "3–4 inches"
 *   and "got off around 4"; the model transcribes those and the wrapper converts (D25), resolving a
 *   local time against the body's zone and the day the text was written.
 * - **Free strings for enum-shaped values, validated here.** A structured-output schema with a
 *   strict enum makes one unknown value fail the whole parse. Taking a string and checking it
 *   against the vocabulary keeps the rest of the result and turns the unknown into a `miss` of kind
 *   `enum_value` — which is exactly the coverage signal D200 wants.
 */

import { inchesToCm, type SkateEndPrecision, zonedInstant, zonedParts } from '@skating/core';
import { z } from 'zod';
import {
  type Evidence,
  EXTRACTED_FIELD_KEYS,
  type ExtractedFieldKey,
  type ExtractedFields,
  type ExtractedReport,
  type ExtractionInput,
  type ExtractionResult,
  ExtractionResultSchema,
  MISS_KINDS,
  type Miss,
  type Vocabulary,
} from '../contract';

export const WireWhereSchema = z.object({
  extent: z.string().optional(),
  subAreaId: z.string().optional(),
  sector: z.string().optional(),
  placeName: z.string().optional(),
});

/**
 * One extracted value, flat. Every field uses this one shape — a structured-output grammar is
 * compiled per request and a schema with fourteen differently-typed lists was "too large"
 * (Anthropic 400, 2026-09-21); one object type reused across a list compiles small. `field` says
 * which contract field it is; `value` is the enum key, the thickness method, or the local clock
 * time; the optional numbers ride alongside for thickness and snow depth.
 */
export const WireValueSchema = z.object({
  /** A contract field key: quality, suitability, observedFrom, sighting, endTime, iceTypes, surfaceTags, snowCoverage, snowImpediment, snowDrifts, snowDepthInches, thickness, hazards, accessConditions. */
  field: z.string(),
  /** The enum key (black_ice, dont_go, …); for thickness the method; for endTime the local time; for snowDepthInches "depth". */
  value: z.string(),
  confidence: z.number().min(0).max(1),
  quote: z.string(),
  quoteField: z.enum(['title', 'text']),
  where: WireWhereSchema.optional(),
  /** Inches: a single number (thickness valueInches, or the snow depth). */
  inches: z.number().optional(),
  minInches: z.number().optional(),
  maxInches: z.number().optional(),
  pokeCount: z.number().int().optional(),
  supportable: z.boolean().optional(),
  /** endTime only: minute | half_hour. */
  precision: z.string().optional(),
  note: z.string().optional(),
});
export type WireValue = z.infer<typeof WireValueSchema>;

export const WireReportSchema = z.object({
  bodyRef: z.string().nullable(),
  bodyName: z.string().optional(),
  visit: z.number().int().min(0).default(0),
  note: z.string().optional(),
  values: z.array(WireValueSchema).default([]),
});

export const WireMissSchema = z.object({
  kind: z.string(),
  text: z.string(),
  wouldNeed: z.string(),
});

export const WireResultSchema = z.object({
  reports: z.array(WireReportSchema),
  misses: z.array(WireMissSchema).default([]),
});
export type WireResult = z.infer<typeof WireResultSchema>;
export type WireReport = z.infer<typeof WireReportSchema>;

// ── Locating quotes ─────────────────────────────────────────────────────────────────────────────

/** Fold whitespace and case so a quote survives a line break and a capital the model normalized. */
function fold(s: string): { folded: string; map: number[] } {
  const map: number[] = [];
  let folded = '';
  let inSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (/\s/.test(ch)) {
      if (!inSpace) {
        folded += ' ';
        map.push(i);
        inSpace = true;
      }
      continue;
    }
    inSpace = false;
    folded += ch.toLowerCase();
    map.push(i);
  }
  return { folded, map };
}

/** Find `quote` in `haystack`, tolerant of whitespace and case. Offsets into the original. */
export function locateQuote(
  haystack: string,
  quote: string,
): { start: number; end: number } | null {
  const q = fold(quote.trim()).folded;
  if (q.length === 0) return null;
  const h = fold(haystack);
  const at = h.folded.indexOf(q);
  if (at === -1) return null;
  const start = h.map[at] as number;
  const endIdx = h.map[at + q.length - 1] as number;
  return { start, end: endIdx + 1 };
}

export function evidenceFor(
  input: ExtractionInput,
  quote: string,
  quoteField: 'title' | 'text',
): Evidence {
  const haystack = quoteField === 'title' ? (input.title ?? '') : input.text;
  const found = locateQuote(haystack, quote);
  if (found)
    return { field: quoteField, start: found.start, end: found.end, text: quote, located: true };
  return { field: quoteField, start: 0, end: 0, text: quote, located: false };
}

// ── Mapping ─────────────────────────────────────────────────────────────────────────────────────

/** Resolve a local clock time on the day the text was written. `null` for an unparseable string. */
export function localTimeToMs(
  localTime: string,
  input: Pick<ExtractionInput, 'writtenAtMs' | 'timeZone'>,
): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localTime.trim());
  if (m) {
    const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
    return zonedInstant(y, mo, d, h * 60 + mi, input.timeZone);
  }
  const t = /^(\d{2}):(\d{2})$/.exec(localTime.trim());
  if (t && input.writtenAtMs !== undefined) {
    const p = zonedParts(input.writtenAtMs, input.timeZone);
    const [, h, mi] = t.map(Number) as [number, number, number];
    return zonedInstant(p.year, p.month, p.day, h * 60 + mi, input.timeZone);
  }
  return null;
}

function inVocab(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

function mapWhere(
  where: z.infer<typeof WireWhereSchema> | undefined,
  vocab: Vocabulary,
  misses: Miss[],
): ExtractedFields['iceTypes'][number]['value']['where'] {
  if (!where) return undefined;
  const out: NonNullable<ExtractedFields['iceTypes'][number]['value']['where']> = {};
  if (where.extent !== undefined) {
    if (inVocab(vocab.whereExtents, where.extent)) {
      out.extent = where.extent as NonNullable<typeof out.extent>;
    } else misses.push({ kind: 'where', text: where.extent, wouldNeed: 'an extent value' });
  }
  if (where.sector !== undefined) {
    if (inVocab(vocab.sectors, where.sector))
      out.sector = where.sector as NonNullable<typeof out.sector>;
    else misses.push({ kind: 'where', text: where.sector, wouldNeed: 'a sector value' });
  }
  if (where.subAreaId !== undefined) out.subAreaId = where.subAreaId;
  if (where.placeName !== undefined) out.placeName = where.placeName;
  return Object.keys(out).length > 0 ? out : undefined;
}

type EnumKey =
  | 'quality'
  | 'suitability'
  | 'observedFrom'
  | 'sighting'
  | 'snowCoverage'
  | 'snowImpediment'
  | 'snowDrifts'
  | 'accessConditions';
const ENUM_VOCAB: Record<EnumKey, keyof Vocabulary> = {
  quality: 'qualities',
  suitability: 'suitabilities',
  observedFrom: 'observedFrom',
  sighting: 'sightings',
  snowCoverage: 'snowCoverages',
  snowImpediment: 'snowImpediments',
  snowDrifts: 'snowDrifts',
  accessConditions: 'accessConditions',
};

/** Map one wire report to the contract, validating every enum-shaped value against the vocabulary. */
export function mapWireReport(
  wire: WireReport,
  input: ExtractionInput,
  misses: Miss[],
): ExtractedReport {
  const vocab = input.vocabulary;
  const fields: Record<string, unknown[]> = Object.fromEntries(
    EXTRACTED_FIELD_KEYS.map((k) => [k, []]),
  );
  const cm = (x: number | undefined) =>
    x !== undefined && Number.isFinite(x) && x >= 0 ? inchesToCm(x) : undefined;

  for (const v of wire.values) {
    const evidence = evidenceFor(input, v.quote, v.quoteField);
    const push = (key: ExtractedFieldKey, value: unknown) =>
      (fields[key] as unknown[]).push({ value, confidence: v.confidence, evidence });
    const miss = (wouldNeed: string, kind: Miss['kind'] = 'enum_value') =>
      misses.push({ kind, text: v.quote, wouldNeed });

    if (v.field in ENUM_VOCAB) {
      const key = v.field as EnumKey;
      if (inVocab(vocab[ENUM_VOCAB[key]], v.value)) push(key, v.value);
      else miss(`${key}: ${v.value}`);
      continue;
    }
    switch (v.field) {
      case 'iceTypes':
      case 'surfaceTags': {
        const list = v.field === 'iceTypes' ? vocab.iceTypes : vocab.surfaceTags;
        if (!inVocab(list, v.value)) {
          miss(`${v.field}: ${v.value}`);
          break;
        }
        const where = mapWhere(v.where, vocab, misses);
        push(v.field, {
          type: v.value,
          ...(where ? { where } : {}),
          ...(v.note ? { note: v.note } : {}),
        });
        break;
      }
      case 'hazards': {
        if (!inVocab(vocab.hazardTypes, v.value)) {
          miss(`hazards: ${v.value}`);
          break;
        }
        const where = mapWhere(v.where, vocab, misses);
        push('hazards', {
          type: v.value,
          ...(where ? { where } : {}),
          ...(v.note ? { note: v.note } : {}),
        });
        break;
      }
      case 'snowDepthInches': {
        const depth = cm(v.inches ?? v.maxInches ?? v.minInches);
        if (depth !== undefined) push('snowDepthCm', depth);
        break;
      }
      case 'thickness': {
        if (!inVocab(vocab.thicknessMethods, v.value)) {
          miss(`thickness method: ${v.value}`);
          break;
        }
        const where = mapWhere(v.where, vocab, misses);
        push('thickness', {
          method: v.value,
          ...(cm(v.inches) !== undefined ? { valueCm: cm(v.inches) } : {}),
          ...(cm(v.minInches) !== undefined ? { minCm: cm(v.minInches) } : {}),
          ...(cm(v.maxInches) !== undefined ? { maxCm: cm(v.maxInches) } : {}),
          ...(v.pokeCount !== undefined ? { pokeCount: v.pokeCount } : {}),
          ...(v.supportable !== undefined ? { supportable: v.supportable } : {}),
          ...(where ? { where } : {}),
          ...(v.note ? { note: v.note } : {}),
        });
        break;
      }
      case 'endTime': {
        const ms = localTimeToMs(v.value, input);
        const precision = (v.precision ?? 'half_hour') as SkateEndPrecision;
        if (ms === null || !['gps', 'minute', 'half_hour'].includes(precision)) break;
        push('endTime', { ms, precision });
        break;
      }
      default:
        miss(`a field named ${v.field}`, 'field');
    }
  }

  // A sighting is what someone *off* the ice saw (D189). The prompt says so; the model does not
  // always listen, and the validator would refuse the pair — so the same rule is applied here.
  const vantage = fields.observedFrom?.[0] as { value: string } | undefined;
  if (vantage === undefined || vantage.value === 'on_ice') fields.sighting = [];

  return {
    bodyRef: wire.bodyRef,
    ...(wire.bodyName ? { bodyName: wire.bodyName } : {}),
    visit: wire.visit,
    ...(wire.note ? { note: wire.note } : {}),
    fields: fields as unknown as ExtractedFields,
  };
}

/** Map a whole wire result and validate it against the contract — the last line of defense. */
export function mapWireResult(wire: WireResult, input: ExtractionInput): ExtractionResult {
  const misses: Miss[] = [];
  const reports = wire.reports.map((r) => mapWireReport(r, input, misses));
  for (const m of wire.misses) {
    const kind = (MISS_KINDS as readonly string[]).includes(m.kind)
      ? (m.kind as Miss['kind'])
      : 'other';
    misses.push({ kind, text: m.text, wouldNeed: m.wouldNeed });
  }
  return ExtractionResultSchema.parse({ reports, misses });
}

export type { ExtractedFieldKey };
