/**
 * Stage A — segmentation (D196, amended 2026-09-19): Claude splits the title + text into
 * observation **units** — which sentences belong to which body and which visit — and finds the
 * candidate spans the voting stage needs: numbers with units, poke counts, compass phrases, named
 * places, clock times. This is the multi-hop, free-string half; Jev is documented weak on
 * indirection and cannot return a string it was not offered, so a model that reads does this part.
 *
 * Stage A returns no field values. That is deliberate: its job is *what is this sentence about*,
 * and the enum votes belong to Stage B, where the probability is calibrated.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ExtractionInput, Miss } from '../contract';
import { type ClaudeModelKey, type ClaudeUsage, callStructured } from './client';
import { userPrompt } from './prompt';
import { evidenceFor, toMiss, WireAboutBodySchema, WireMissSchema } from './wire';

export const MeasurementSchema = z.object({
  quote: z.string(),
  /** What the number measures, as the author frames it. */
  kind: z.enum(['ice_thickness', 'snow_depth', 'other']),
  valueInches: z.number().optional(),
  minInches: z.number().optional(),
  maxInches: z.number().optional(),
  /** The author's own words on how it was got — "augered", "by the crack", "someone said". */
  how: z.string().optional(),
});

export const PokeCountSchema = z.object({ quote: z.string(), count: z.number().int().min(0) });
export const CompassPhraseSchema = z.object({
  quote: z.string(),
  /** The author's phrase normalized to a sector word when it clearly is one; else omitted. */
  sector: z.string().optional(),
  /** A named bay from the candidates, by id, when the phrase is inside one. */
  subAreaId: z.string().optional(),
});
export const PlaceSchema = z.object({ quote: z.string(), name: z.string() });
export const ClockTimeSchema = z.object({
  quote: z.string(),
  /** `YYYY-MM-DDTHH:MM` or `HH:MM`, as best resolved; what it marks. */
  localTime: z.string(),
  marks: z.enum(['got_off', 'got_on', 'other']),
});

export const UnitSchema = z.object({
  bodyRef: z.string().nullable(),
  bodyName: z.string().optional(),
  /** Any integer on the wire; `denseVisits` renumbers (see wire.ts). */
  visit: z.number().int().default(0),
  /** The author's own sentences about this body and visit, verbatim, in order. */
  sentences: z.array(z.string()),
  measurements: z.array(MeasurementSchema).default([]),
  pokeCounts: z.array(PokeCountSchema).default([]),
  compassPhrases: z.array(CompassPhraseSchema).default([]),
  places: z.array(PlaceSchema).default([]),
  clockTimes: z.array(ClockTimeSchema).default([]),
});
export type Unit = z.infer<typeof UnitSchema>;

export const SegmentationSchema = z.object({
  units: z.array(UnitSchema),
  /** Facts about a body rather than a visit (D211) — Stage A reads them; there is nothing to vote on. */
  aboutBody: z.array(WireAboutBodySchema).default([]),
  misses: z.array(WireMissSchema).default([]),
});
export type Segmentation = z.infer<typeof SegmentationSchema>;

export function segmentationSystemPrompt(): string {
  return `You split one skater's email or post about lake ice into observation units, without judging the ice. The community is Nordic (wild) ice skaters in Vermont, New Hampshire, New York, Maine and Quebec.

A unit is (one body of water, one visit): everything the author says they or someone else observed about that lake on that trip. An email about two lakes is two units; a morning skate and an evening re-check of the same lake are two units (visit 0, visit 1); a relayed observation from another day is its own unit ("a fisher said it was open water yesterday"). Number each body's visits 0, 1, 2… in time order, earliest first.

These are not observations and belong to no unit: a season summary, a retrospective or a list of lakes skated; an invitation, a plan or a meeting time; a forecast or a prediction (anything about a time after the text was written); a question; gear or safety advice; weather that is not about the ice; and anything in an earlier message the author quoted or forwarded (after "On … wrote:", a "From: … Sent: …" header, "-----Original Message-----"). A text that is mostly one of these may still hold one observation — keep that sentence as a unit. A text with no observation has no units; list what it says about ice, snow, access or the trip under misses.

For each unit:
- bodyRef: the matching candidate's ref, or null with bodyName as the author wrote it when the lake is not a candidate. Prefer the candidate whose place hint matches; if unsure, null.
- sentences: the author's own sentences for this unit, verbatim, in order. Never a signature, a forwarded message or a quoted reply.
- measurements: every number with a unit of length the author gives — kind ice_thickness, snow_depth or other; inches (convert "a foot" to 12, "half an inch" to 0.5; a range as min/max; "at least 4" / "4+" as min only); "how" quotes the words that say how it was got. A snow depth only when the author saw the snow on the ice, never snowfall from the weather.
- pokeCounts: every pole-test count ("5 pokes", "went in three pokes").
- compassPhrases: every phrase locating something on the body — "the north end", "the northeast corner", "the middle", "along the west shore", "the back of the bay". Set sector to one of N, NE, E, SE, S, SW, W, NW, middle, near_shore, head, mouth when the phrase clearly is one; subAreaId when the phrase is inside a candidate's named bay.
- places: named landmarks that are not candidates — islands, points, coves, camps, beaches, launches ("off Shelburne Point", "by Crow Island", "the boat access").
- clockTimes: clock times and clear anchors ("got off at 4", "left at sunset" → the word, not a guess): localTime as "HH:MM" (or "YYYY-MM-DDTHH:MM" when a date is given), marks got_off / got_on / other.

aboutBody: facts about a body itself rather than a visit — parking ("limited parking at the launch spot"), access (getting onto the ice), feature (something lasting that bears on the ice: inlets, springs, currents, depth, sun exposure, a shore notorious for thin ice), character (the lake's size or setting). One entry each: bodyRef (or null with bodyName), topic (parking, access, feature, character, other), and the author's exact words as quote with quoteField. From any text, a report or not.

Every quote is the author's exact words, at most 160 characters. Never invent a body, a number, a time or a place. Misses are anything about the ice, snow, access or the trip that a structured report of ice types, surface, snow, thickness, hazards, access conditions, quality, suitability, how it was seen, what was seen and when the author got off could not hold — be generous; kind is enum_value, field, where, report_kind or other, and wouldNeed says what would hold it.`;
}

export interface StageAResult {
  segmentation: Segmentation;
  usage: ClaudeUsage;
  latencyMs: number;
}

export async function runStageA(
  client: Anthropic,
  model: ClaudeModelKey,
  input: ExtractionInput,
): Promise<StageAResult> {
  const started = Date.now();
  const call = await callStructured(
    client,
    model,
    SegmentationSchema,
    segmentationSystemPrompt(),
    userPrompt(input),
  );
  return { segmentation: call.data, usage: call.usage, latencyMs: Date.now() - started };
}

/** The unit's own text — what Stage B votes over. */
export function unitText(unit: Unit): string {
  return unit.sentences.join(' ');
}

/** The evidence a unit-level vote carries: the unit's sentences, located in the author's text. */
export function unitEvidence(input: ExtractionInput, unit: Unit) {
  return evidenceFor(input, unit.sentences[0] ?? '', 'text');
}

/** Stage A's misses in the contract's shape. */
export function segmentationMisses(seg: Segmentation): Miss[] {
  return seg.misses.map(toMiss);
}
