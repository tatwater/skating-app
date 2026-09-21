import { describe, expect, it } from 'vitest';
import type { Unit } from '../claude/stageA';
import { defaultVocabulary, type ExtractionInput, type Miss } from '../contract';
import type { JevAnswer } from './client';
import { CHOICE_DROP_BELOW, NOUL_DROP_BELOW, questionsForUnit, reportFromAnswers } from './stageB';

const TEXT =
  'Skated Morey. Black ice at the north end, 3-4 inches by the auger, 5 pokes for me. Got off at 4:15. A dusting of snow.';
const input: ExtractionInput = {
  text: TEXT,
  bodyCandidates: [],
  vocabulary: defaultVocabulary(),
  writtenAtMs: Date.UTC(2026, 0, 10, 22),
  timeZone: 'America/New_York',
};

const unit: Unit = {
  bodyRef: 'morey',
  visit: 0,
  sentences: [
    'Skated Morey.',
    'Black ice at the north end, 3-4 inches by the auger, 5 pokes for me.',
  ],
  measurements: [
    {
      quote: '3-4 inches by the auger',
      kind: 'ice_thickness',
      minInches: 3,
      maxInches: 4,
      how: 'by the auger',
    },
    { quote: 'A dusting of snow', kind: 'snow_depth', valueInches: 0.2 },
    { quote: 'x', kind: 'other', valueInches: 9 },
  ],
  pokeCounts: [{ quote: '5 pokes for me', count: 5 }],
  compassPhrases: [{ quote: 'the north end', sector: 'N' }],
  places: [],
  clockTimes: [{ quote: 'Got off at 4:15', localTime: '16:15', marks: 'got_off' }],
};

describe('questionsForUnit', () => {
  it('asks one choice per single field with a none hatch, one noul per multi value, and the candidates', () => {
    const q = questionsForUnit(unit, input.vocabulary);
    expect(q.quality).toMatchObject({ type: 'choice' });
    expect(Object.keys((q.quality as { criteria: Record<string, string> }).criteria)).toEqual([
      'none',
      'great',
      'good',
      'fair',
      'poor',
    ]);
    expect(q['iceTypes.black_ice']).toMatchObject({ type: 'noul' });
    expect(q['hazards.open_water']).toMatchObject({ type: 'noul' });
    expect(q['m0.method']).toMatchObject({ type: 'choice' });
    expect(q['m1.method']).toBeUndefined(); // snow depth is not a thickness
    expect(q['iceTypes.black_ice.where']).toMatchObject({ type: 'choice' });
    expect(
      (q['iceTypes.black_ice.where'] as { criteria: Record<string, string> }).criteria,
    ).toEqual({
      none: 'Not located, or located nowhere in particular',
      p0: 'Located by "the north end"',
    });
    expect(q['accessConditions.icy_lot.where']).toBeUndefined();
    // Every value Jev may return was offered: no question, no value.
    const nouls = Object.keys(q).filter((k) => q[k]?.type === 'noul');
    expect(nouls).toHaveLength(
      input.vocabulary.iceTypes.length +
        input.vocabulary.surfaceTags.length +
        input.vocabulary.hazardTypes.length +
        input.vocabulary.accessConditions.length,
    );
  });

  it('asks no where questions without a compass phrase', () => {
    const q = questionsForUnit({ ...unit, compassPhrases: [] }, input.vocabulary);
    expect(Object.keys(q).some((k) => k.endsWith('.where'))).toBe(false);
  });
});

describe('reportFromAnswers', () => {
  const choice = (c: string, p: number): JevAnswer => ({
    type: 'choice',
    choice: c,
    confidence: p,
    probabilities: { [c]: p, none: 1 - p },
  });
  const noul = (n: number): JevAnswer => ({ type: 'noul', noul: n });

  it('reads the tier straight off the probability, drops the hatches and the weak, and maps candidates', () => {
    const answers: Record<string, JevAnswer> = {
      quality: choice('great', 0.8),
      suitability: choice('none', 0.9),
      observedFrom: choice('on_ice', CHOICE_DROP_BELOW - 0.01),
      'iceTypes.black_ice': noul(0.97),
      'iceTypes.black_ice.where': choice('p0', 0.9),
      'iceTypes.shell_ice': noul(NOUL_DROP_BELOW),
      'surfaceTags.glass': noul(0.6),
      'surfaceTags.glass.where': choice('none', 0.8),
      'hazards.open_water': noul(0.3),
      'accessConditions.plank_needed': noul(0.5),
      'm0.method': choice('measured', 0.93),
      'm0.supportable': choice('supportable', 0.7),
    };
    const r = reportFromAnswers(unit, answers, input);
    expect(r.bodyRef).toBe('morey');
    expect(r.note).toBe(unit.sentences.join(' '));
    expect(r.fields.quality).toEqual([
      {
        value: 'great',
        confidence: 0.8,
        evidence: { field: 'text', start: 0, end: 13, text: 'Skated Morey.', located: true },
      },
    ]);
    expect(r.fields.suitability).toEqual([]);
    expect(r.fields.observedFrom).toEqual([]);
    expect(r.fields.iceTypes.map((v) => [v.value, v.confidence])).toEqual([
      [{ type: 'black_ice', where: { sector: 'N' } }, 0.97],
    ]);
    expect(r.fields.surfaceTags.map((v) => v.value)).toEqual([{ type: 'glass' }]);
    expect(r.fields.hazards.map((v) => v.value)).toEqual([{ type: 'open_water' }]);
    expect(r.fields.accessConditions.map((v) => v.value)).toEqual(['plank_needed']);
    expect(r.fields.thickness.map((v) => v.value)).toEqual([
      { method: 'measured', minCm: 7.62, maxCm: 10.16, supportable: true },
      { method: 'poke', pokeCount: 5 },
    ]);
    expect(r.fields.thickness[0]?.evidence.text).toBe('3-4 inches by the auger');
    expect(r.fields.snowDepthCm.map((v) => v.value)).toEqual([0.508]);
    expect(r.fields.endTime).toEqual([
      {
        value: { ms: Date.UTC(2026, 0, 10, 21, 15), precision: 'minute' },
        confidence: 0.85,
        evidence: expect.objectContaining({ text: 'Got off at 4:15', located: true }),
      },
    ]);
  });

  it('a sighting survives only off the ice', () => {
    const shore = reportFromAnswers(
      unit,
      { observedFrom: choice('shore', 0.9), sighting: choice('open', 0.8) },
      input,
    );
    expect(shore.fields.sighting.map((v) => v.value)).toEqual(['open']);
    const onIce = reportFromAnswers(
      unit,
      { observedFrom: choice('on_ice', 0.9), sighting: choice('frozen', 0.9) },
      input,
    );
    expect(onIce.fields.sighting).toEqual([]);
    const unstated = reportFromAnswers(unit, { sighting: choice('frozen', 0.9) }, input);
    expect(unstated.fields.sighting).toEqual([]);
  });

  it('a measurement voted "none" or weakly is not a reading; an unlocated phrase becomes a place name', () => {
    const placed: Unit = {
      ...unit,
      compassPhrases: [{ quote: 'by the boathouse', sector: 'NNE' }], // not a vocabulary sector
    };
    const r = reportFromAnswers(
      placed,
      {
        'm0.method': choice('none', 0.9),
        'iceTypes.black_ice': noul(0.9),
        'iceTypes.black_ice.where': choice('p0', 0.8),
        'surfaceTags.glass': noul(0.9),
        'surfaceTags.glass.where': choice('p7', 0.8), // a phrase index that does not exist
      },
      input,
    );
    expect(r.fields.thickness.map((v) => v.value)).toEqual([{ method: 'poke', pokeCount: 5 }]);
    expect(r.fields.iceTypes[0]?.value).toEqual({
      type: 'black_ice',
      where: { placeName: 'by the boathouse' },
    });
    expect(r.fields.surfaceTags[0]?.value).toEqual({ type: 'glass' });
  });

  it('a method vote the validator would refuse drops the reading and counts a miss', () => {
    // Jev calls the auger range a poke: with no count beside it the sheet could not post it, so
    // it is dropped; the "5 pokes" count reading stands on its own, and the miss says why.
    const misses: Miss[] = [];
    const r = reportFromAnswers(unit, { 'm0.method': choice('poke', 0.9) }, input, misses);
    expect(r.fields.thickness.map((v) => v.value)).toEqual([{ method: 'poke', pokeCount: 5 }]);
    expect(misses).toEqual([
      {
        kind: 'other',
        text: '3-4 inches by the auger',
        wouldNeed: 'a poke count on the poke reading',
      },
    ]);
    // A method outside the offered vocabulary is not a reading either.
    const off = reportFromAnswers(unit, { 'm0.method': choice('augered', 0.9) }, input);
    expect(off.fields.thickness.map((v) => v.value)).toEqual([{ method: 'poke', pokeCount: 5 }]);
  });

  it('a half-hour clock time is half_hour precision; a bad one is skipped', () => {
    const halfHour: Unit = {
      ...unit,
      clockTimes: [
        { quote: 'around 4', localTime: '16:00', marks: 'got_off' },
        { quote: 'dusk', localTime: 'dusk', marks: 'got_off' },
        { quote: 'on at 10', localTime: '10:00', marks: 'got_on' },
      ],
    };
    const r = reportFromAnswers(halfHour, {}, input);
    expect(r.fields.endTime.map((v) => v.value.precision)).toEqual(['half_hour']);
  });
});
