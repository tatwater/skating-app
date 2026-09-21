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

import {
  inchesToCm,
  isValidThicknessReading,
  type ObservedFrom,
  SKATE_END_PRECISIONS,
  SKATE_TIME_FUTURE_TOLERANCE_MS,
  type SkateEndPrecision,
  sightingAllowedFrom,
  type ThicknessMethod,
  type ThicknessReadingInput,
  zonedInstant,
  zonedInstantOnDayOf,
} from '@skating/core';
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

/**
 * The body a report is about, held to the contract: `bodyRef` names one of the offered candidates
 * or is `null`. A model can and does return a ref it was never given — a name, a slug it made up —
 * and copying that through would make a hallucination a valid extraction, scored as a hit or a
 * miss on a body that was never on the list. Here, while the list is in hand, such a ref becomes
 * `null` with the string kept as `bodyName` (the model's best word for the body; never our
 * invention) when the model gave none. Both engines map through this.
 */
export function bodyOf(
  wire: { bodyRef: string | null; bodyName?: string },
  input: Pick<ExtractionInput, 'bodyCandidates'>,
): { bodyRef: string | null; bodyName?: string } {
  const bodyName = wire.bodyName?.trim() || undefined;
  if (wire.bodyRef === null) return { bodyRef: null, ...(bodyName ? { bodyName } : {}) };
  if (input.bodyCandidates.some((c) => c.ref === wire.bodyRef)) {
    return { bodyRef: wire.bodyRef, ...(bodyName ? { bodyName } : {}) };
  }
  return { bodyRef: null, bodyName: bodyName ?? wire.bodyRef };
}

/**
 * Resolve a local clock time. A full `YYYY-MM-DDTHH:MM` is taken as written; a bare `HH:MM` is
 * read on the day the text was written — or the day before, when that clock time has not yet come
 * round at the moment of writing: "got off at 4" in an email sent at 2 am is yesterday's four, and
 * today's would be an end time in the future, which the validator refuses. `null` for an
 * unparseable string, or a bare time with no written day to hang it on.
 */
export function localTimeToMs(
  localTime: string,
  input: Pick<ExtractionInput, 'writtenAtMs' | 'timeZone'>,
): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localTime.trim());
  if (m) {
    const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
    if (!isCalendarDate(y, mo, d) || !isClockTime(h, mi)) return null;
    return zonedInstant(y, mo, d, h * 60 + mi, input.timeZone);
  }
  const t = /^(\d{2}):(\d{2})$/.exec(localTime.trim());
  if (t && input.writtenAtMs !== undefined) {
    const [, h, mi] = t.map(Number) as [number, number, number];
    if (!isClockTime(h, mi)) return null;
    const today = zonedInstantOnDayOf(input.writtenAtMs, h * 60 + mi, input.timeZone);
    if (today <= input.writtenAtMs + SKATE_TIME_FUTURE_TOLERANCE_MS) return today;
    return zonedInstantOnDayOf(input.writtenAtMs, h * 60 + mi, input.timeZone, -1);
  }
  return null;
}

/**
 * A date that exists. The digits alone are not enough: `Date.UTC` normalizes February 30th into
 * March 2nd and 25:99 into the next day, so a model's slip would come back as a real instant on
 * the wrong day instead of a miss. The round trip through `Date.UTC` is the calendar check —
 * a day that overflows its month reads back as a different one.
 */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function isClockTime(hour: number, minute: number): boolean {
  return hour <= 23 && minute <= 59;
}

/** A miss in the contract's shape: an engine's free-string `kind` outside `MISS_KINDS` is `other`. */
export function toMiss(m: { kind: string; text: string; wouldNeed: string }): Miss {
  const kind = (MISS_KINDS as readonly string[]).includes(m.kind)
    ? (m.kind as Miss['kind'])
    : 'other';
  return { kind, text: m.text, wouldNeed: m.wouldNeed };
}

/** cm from a wire inches figure — `undefined` for an absent, negative or non-finite one. */
export function wireInchesToCm(inches: number | undefined): number | undefined {
  return inches !== undefined && Number.isFinite(inches) && inches >= 0
    ? inchesToCm(inches)
    : undefined;
}

/** The number part of a thickness reading as the wire carries it: inches, a count, the skater's word. */
export interface WireThicknessParts {
  method: ThicknessMethod;
  inches?: number;
  minInches?: number;
  maxInches?: number;
  pokeCount?: number;
  supportable?: boolean;
}

/**
 * A thickness reading in the validator's shape from the wire numbers, or `null` when the sheet
 * could never post it — a `poke` with no count, an estimate with no number, a value beside a range.
 * The rule is the validator's own (`isValidThicknessReading`), so the engines cannot hand the sheet
 * a pre-selected chip that fails at *Post*. One repair, in the validator's documented spelling: an
 * upper bound alone ("under 2 inches") becomes `minCm: 0, maxCm`.
 */
export function thicknessReadingFrom(
  parts: WireThicknessParts,
): Omit<ThicknessReadingInput, 'where' | 'coord' | 'note'> | null {
  const valueCm = wireInchesToCm(parts.inches);
  let minCm = wireInchesToCm(parts.minInches);
  const maxCm = wireInchesToCm(parts.maxInches);
  if (valueCm === undefined && minCm === undefined && maxCm !== undefined) minCm = 0;
  const reading: Omit<ThicknessReadingInput, 'where' | 'coord' | 'note'> = {
    method: parts.method,
    ...(valueCm !== undefined ? { valueCm } : {}),
    ...(minCm !== undefined ? { minCm } : {}),
    ...(maxCm !== undefined ? { maxCm } : {}),
    ...(parts.pokeCount !== undefined ? { pokeCount: parts.pokeCount } : {}),
    ...(parts.supportable !== undefined ? { supportable: parts.supportable } : {}),
  };
  return isValidThicknessReading(reading) ? reading : null;
}

/** What a dropped reading would have needed — the miss's `wouldNeed`. */
export function thicknessMissReason(method: ThicknessMethod): string {
  return method === 'poke'
    ? 'a poke count on the poke reading'
    : 'a number on the thickness reading';
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

  for (const v of wire.values) {
    const evidence = evidenceFor(input, v.quote, v.quoteField);
    const push = (key: ExtractedFieldKey, value: unknown) =>
      (fields[key] as unknown[]).push({ value, confidence: v.confidence, evidence });
    const miss = (wouldNeed: string, kind: Miss['kind'] = 'enum_value') =>
      misses.push({ kind, text: v.quote, wouldNeed });

    // `hasOwn`, not `in`: the field name is the model's free string, and `'constructor' in {}` is
    // true — a prototype key would reach `vocab[undefined]` and throw out of the whole mapping.
    if (Object.hasOwn(ENUM_VOCAB, v.field)) {
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
        const depth = wireInchesToCm(v.inches ?? v.maxInches ?? v.minInches);
        if (depth !== undefined) push('snowDepthCm', depth);
        break;
      }
      case 'thickness': {
        if (!inVocab(vocab.thicknessMethods, v.value)) {
          miss(`thickness method: ${v.value}`);
          break;
        }
        const method = v.value as ThicknessMethod;
        const reading = thicknessReadingFrom({
          method,
          inches: v.inches,
          minInches: v.minInches,
          maxInches: v.maxInches,
          pokeCount: v.pokeCount,
          supportable: v.supportable,
        });
        if (reading === null) {
          miss(thicknessMissReason(method), 'other');
          break;
        }
        const where = mapWhere(v.where, vocab, misses);
        push('thickness', {
          ...reading,
          ...(where ? { where } : {}),
          ...(v.note ? { note: v.note } : {}),
        });
        break;
      }
      case 'endTime': {
        const ms = localTimeToMs(v.value, input);
        const precision = (v.precision ?? 'half_hour') as SkateEndPrecision;
        if (ms === null || !(SKATE_END_PRECISIONS as readonly string[]).includes(precision)) break;
        push('endTime', { ms, precision });
        break;
      }
      default:
        miss(`a field named ${v.field}`, 'field');
    }
  }

  // A sighting is what someone *off* the ice saw (D189). The prompt says so; the model does not
  // always listen, and the validator would refuse the pair — so the validator's own rule is asked.
  const vantage = fields.observedFrom?.[0] as { value: ObservedFrom } | undefined;
  if (!sightingAllowedFrom(vantage?.value)) fields.sighting = [];

  return {
    ...bodyOf(wire, input),
    visit: wire.visit,
    ...(wire.note ? { note: wire.note } : {}),
    fields: fields as unknown as ExtractedFields,
  };
}

/** Map a whole wire result and validate it against the contract — the last line of defense. */
export function mapWireResult(wire: WireResult, input: ExtractionInput): ExtractionResult {
  const misses: Miss[] = [];
  const reports = wire.reports.map((r) => mapWireReport(r, input, misses));
  for (const m of wire.misses) misses.push(toMiss(m));
  return ExtractionResultSchema.parse({ reports, misses });
}

export type { ExtractedFieldKey };
