/**
 * Stage B — voting (D196, amended 2026-09-19): per unit from Stage A, one Jev request fanning out
 * a `noul` over every value of every multi-valued enum (ice types, surface tags, hazards, access
 * conditions), a `choice` over each single-valued enum (quality, suitability, how it was seen, the
 * sighting, the three snow facets — each with a `none` hatch), and a `choice` over Stage A's
 * candidates for thickness (the method of each measurement) and for `where` (which compass phrase a
 * located value belongs to). Jev returns a calibrated probability per value; the D188 tier reads
 * straight off it, and a value Jev was never offered cannot appear.
 *
 * Pure question-building and answer-mapping here; the request itself is `JevClient.ask`.
 */

import {
  type ObservedFrom,
  SECTORS,
  sightingAllowedFrom,
  type ThicknessMethod,
} from '@skating/core';
import type { Unit } from '../claude/stageA';
import { unitEvidence, unitText } from '../claude/stageA';
import {
  evidenceFor,
  localTimeToMs,
  thicknessMissReason,
  thicknessReadingFrom,
  wireInchesToCm,
} from '../claude/wire';
import {
  type Evidence,
  EXTRACTED_FIELD_KEYS,
  type ExtractedFields,
  type ExtractedReport,
  type ExtractionInput,
  type Miss,
  type Vocabulary,
} from '../contract';
import type { JevAnswer, JevQuestion } from './client';

/** A noul at or below this is "the author did not say it"; the value is dropped, not ghosted. */
export const NOUL_DROP_BELOW = 0.2;
/** A choice whose winning probability is under this is dropped — the author did not say. */
export const CHOICE_DROP_BELOW = 0.35;

const SINGLE: { key: keyof ExtractedFields; vocab: keyof Vocabulary; ask: string }[] = [
  {
    key: 'quality',
    vocab: 'qualities',
    ask: 'The author’s overall word for how the skating was on this body during this visit',
  },
  {
    key: 'suitability',
    vocab: 'suitabilities',
    ask: 'Who the author says should (or should not) go skate this body',
  },
  {
    key: 'observedFrom',
    vocab: 'observedFrom',
    ask: 'How the author saw this ice: on it, from shore (a car, a window, a drone, a photo), or secondhand from someone else',
  },
  {
    key: 'sighting',
    vocab: 'sightings',
    ask: 'What a shore or secondhand observer saw the body doing: still open, a skim of ice, frozen over, snow covered',
  },
  {
    key: 'snowCoverage',
    vocab: 'snowCoverages',
    ask: 'How much of the ice the author says is covered by snow',
  },
  {
    key: 'snowImpediment',
    vocab: 'snowImpediments',
    ask: 'Whether the snow affected the author’s skating',
  },
  { key: 'snowDrifts', vocab: 'snowDrifts', ask: 'What the author says about snow drifts' },
];

const MULTI: {
  key: keyof ExtractedFields;
  vocab: keyof Vocabulary;
  frame: (v: string) => string;
}[] = [
  {
    key: 'iceTypes',
    vocab: 'iceTypes',
    frame: (v) => `The author observed ${v.replace(/_/g, ' ')} on this body during this visit`,
  },
  {
    key: 'surfaceTags',
    vocab: 'surfaceTags',
    frame: (v) => `The author describes the skating surface as ${v.replace(/_/g, ' ')}`,
  },
  {
    key: 'hazards',
    vocab: 'hazardTypes',
    frame: (v) => `The author reports a ${v.replace(/_/g, ' ')} hazard on this body`,
  },
  {
    key: 'accessConditions',
    vocab: 'accessConditions',
    frame: (v) =>
      `The author reports this access condition at the launch or parking: ${v.replace(/_/g, ' ')}`,
  },
];

/** The questions for one unit. Keys are `<field>.<value>` / `<field>` / `m<i>.method` so answers map back. */
export function questionsForUnit(unit: Unit, vocab: Vocabulary): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {};
  for (const s of SINGLE) {
    const criteria: Record<string, string> = { none: 'The author does not say' };
    for (const v of vocab[s.vocab]) criteria[v] = v.replace(/_/g, ' ');
    q[s.key] = { type: 'choice', instructions: s.ask, criteria };
  }
  for (const m of MULTI) {
    for (const v of vocab[m.vocab]) q[`${m.key}.${v}`] = { type: 'noul', instructions: m.frame(v) };
  }
  unit.measurements.forEach((m, i) => {
    if (m.kind !== 'ice_thickness') return;
    q[`m${i}.method`] = {
      type: 'choice',
      instructions: `How the author got the ice thickness "${m.quote}"`,
      criteria: {
        measured: 'The author drilled, augered, taped or otherwise measured it themselves',
        estimated:
          'The author eyeballed it, read it off a crack or a fishing hole, or is repeating a number',
        poke: 'It is a pole or spike test counted in pokes',
        none: 'It is not an ice thickness',
      },
    };
    q[`m${i}.supportable`] = {
      type: 'choice',
      instructions: `Whether the author says this ice held them ("supportable") or not`,
      criteria: {
        supportable: 'The author says it held / is supportable',
        unsupportable: 'The author says it did not hold / is unsupportable',
        none: 'The author does not say',
      },
    };
  });
  if (unit.compassPhrases.length > 0) {
    for (const m of MULTI) {
      if (m.key === 'accessConditions') continue;
      for (const v of vocab[m.vocab]) {
        const criteria: Record<string, string> = {
          none: 'Not located, or located nowhere in particular',
        };
        unit.compassPhrases.forEach((p, i) => {
          criteria[`p${i}`] = `Located by "${p.quote}"`;
        });
        q[`${m.key}.${v}.where`] = {
          type: 'choice',
          instructions: `If the author mentions ${v.replace(/_/g, ' ')}, which phrase says where on the body it is`,
          criteria,
        };
      }
    }
  }
  return q;
}

function whereFor(
  unit: Unit,
  answer: JevAnswer | undefined,
): ExtractedFields['iceTypes'][number]['value']['where'] {
  if (answer?.type !== 'choice' || answer.choice === 'none') return undefined;
  const idx = Number(answer.choice.slice(1));
  const phrase = unit.compassPhrases[idx];
  if (!phrase) return undefined;
  const out: NonNullable<ExtractedFields['iceTypes'][number]['value']['where']> = {};
  // Stage A's sector is a free string ("NNE", "north shore"); only a vocabulary value is a sector,
  // anything else is the phrase itself as a place name — never a failed parse.
  const sector =
    phrase.sector && (SECTORS as readonly string[]).includes(phrase.sector)
      ? (phrase.sector as (typeof SECTORS)[number])
      : undefined;
  if (sector) out.sector = sector;
  if (phrase.subAreaId) out.subAreaId = phrase.subAreaId;
  if (!sector && !phrase.subAreaId) out.placeName = phrase.quote;
  return out;
}

/**
 * Map one unit's answers to a contract report. A measurement whose method vote produces a reading
 * the validator would refuse — `poke` with no count beside it, a number-less estimate — is dropped
 * and counted in `misses` (the Stage A quote, what it would have needed), like the Claude engine.
 */
export function reportFromAnswers(
  unit: Unit,
  answers: Record<string, JevAnswer>,
  input: ExtractionInput,
  misses: Miss[] = [],
): ExtractedReport {
  const vocab = input.vocabulary;
  const ev = unitEvidence(input, unit);
  const fields = {} as Record<keyof ExtractedFields, unknown[]>;
  for (const key of EXTRACTED_FIELD_KEYS) fields[key] = [];

  for (const s of SINGLE) {
    const a = answers[s.key];
    if (a?.type !== 'choice' || a.choice === 'none') continue;
    const p = a.probabilities[a.choice] ?? 0;
    if (p < CHOICE_DROP_BELOW) continue;
    fields[s.key].push({ value: a.choice, confidence: p, evidence: ev });
  }
  // A sighting is what someone *off* the ice saw (D189): when the vantage vote says on the ice,
  // the sighting vote is answering a question that was not asked. The validator's own rule.
  const vantage = fields.observedFrom[0] as { value: ObservedFrom } | undefined;
  if (!sightingAllowedFrom(vantage?.value)) fields.sighting = [];

  for (const m of MULTI) {
    for (const v of vocab[m.vocab]) {
      const a = answers[`${m.key}.${v}`];
      if (a?.type !== 'noul' || a.noul <= NOUL_DROP_BELOW) continue;
      if (m.key === 'accessConditions') {
        fields[m.key].push({ value: v, confidence: a.noul, evidence: ev });
        continue;
      }
      const where = whereFor(unit, answers[`${m.key}.${v}.where`]);
      fields[m.key].push({
        value: { type: v, ...(where ? { where } : {}) },
        confidence: a.noul,
        evidence: ev,
      });
    }
  }

  unit.measurements.forEach((m, i) => {
    const evidence: Evidence = evidenceFor(input, m.quote, 'text');
    if (m.kind === 'snow_depth') {
      const depth = wireInchesToCm(m.valueInches ?? m.maxInches ?? m.minInches);
      if (depth !== undefined) fields.snowDepthCm.push({ value: depth, confidence: 0.9, evidence });
      return;
    }
    if (m.kind !== 'ice_thickness') return;
    const a = answers[`m${i}.method`];
    if (a?.type !== 'choice' || a.choice === 'none') return;
    if (!(vocab.thicknessMethods as readonly string[]).includes(a.choice)) return;
    const method = a.choice as ThicknessMethod;
    const p = a.probabilities[a.choice] ?? 0;
    if (p < CHOICE_DROP_BELOW) return;
    const sup = answers[`m${i}.supportable`];
    const supportable =
      sup &&
      sup.type === 'choice' &&
      sup.choice !== 'none' &&
      (sup.probabilities[sup.choice] ?? 0) >= CHOICE_DROP_BELOW
        ? sup.choice === 'supportable'
        : undefined;
    const reading = thicknessReadingFrom({
      method,
      inches: m.valueInches,
      minInches: m.minInches,
      maxInches: m.maxInches,
      ...(supportable !== undefined ? { supportable } : {}),
    });
    if (reading === null) {
      misses.push({ kind: 'other', text: m.quote, wouldNeed: thicknessMissReason(method) });
      return;
    }
    fields.thickness.push({ value: reading, confidence: p, evidence });
  });
  // When the author got off: Stage A's anchor, resolved on the body's clock (D192).
  for (const t of unit.clockTimes) {
    if (t.marks !== 'got_off') continue;
    const ms = localTimeToMs(t.localTime, input);
    if (ms === null) continue;
    fields.endTime.push({
      value: {
        ms,
        precision:
          /:\d\d$/.test(t.localTime) && !/:00$|:30$/.test(t.localTime) ? 'minute' : 'half_hour',
      },
      confidence: 0.85,
      evidence: evidenceFor(input, t.quote, 'text'),
    });
  }
  // A poke count with no inch figure is a reading in its own right (D195).
  for (const poke of unit.pokeCounts) {
    fields.thickness.push({
      value: { method: 'poke', pokeCount: poke.count },
      confidence: 0.9,
      evidence: evidenceFor(input, poke.quote, 'text'),
    });
  }

  return {
    bodyRef: unit.bodyRef,
    ...(unit.bodyName ? { bodyName: unit.bodyName } : {}),
    visit: unit.visit,
    note: unitText(unit),
    fields: fields as unknown as ExtractedFields,
  };
}
