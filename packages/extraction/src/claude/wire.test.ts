import { describe, expect, it } from 'vitest';
import { defaultVocabulary, type ExtractionInput } from '../contract';
import {
  evidenceFor,
  localTimeToMs,
  locateQuote,
  mapWireResult,
  WireFieldsSchema,
  type WireResult,
} from './wire';

const TEXT =
  'Skated Morey this afternoon.  Black ice at the north end,\nabout 3-4 inches by the auger. Got off around 4.';

function input(over: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    title: 'Morey 1/10',
    text: TEXT,
    bodyCandidates: [{ ref: 'morey', name: 'Lake Morey', aliases: [], subAreas: [] }],
    vocabulary: defaultVocabulary(),
    writtenAtMs: Date.UTC(2026, 0, 10, 22, 0),
    timeZone: 'America/New_York',
    ...over,
  };
}

describe('locateQuote', () => {
  it('finds a quote across a line break and a case change, returning original offsets', () => {
    const found = locateQuote(TEXT, 'North End, about 3-4 inches');
    expect(found).not.toBeNull();
    expect(TEXT.slice(found?.start, found?.end)).toBe('north end,\nabout 3-4 inches');
  });
  it('folds runs of whitespace', () => {
    const found = locateQuote(TEXT, 'this afternoon. Black');
    expect(TEXT.slice(found?.start, found?.end)).toBe('this afternoon.  Black');
  });
  it('returns null for an absent or empty quote', () => {
    expect(locateQuote(TEXT, 'sunapee')).toBeNull();
    expect(locateQuote(TEXT, '   ')).toBeNull();
  });
  it('evidenceFor flags a quote that is not in the text, and reads the title', () => {
    expect(evidenceFor(input(), 'not here', 'text')).toMatchObject({
      located: false,
      start: 0,
      end: 0,
    });
    expect(evidenceFor(input(), 'Morey', 'title')).toMatchObject({
      field: 'title',
      located: true,
      start: 0,
      end: 5,
    });
  });
});

describe('localTimeToMs', () => {
  it('resolves a full local timestamp and a bare clock time on the written day', () => {
    const full = localTimeToMs('2026-01-10T16:00', input());
    expect(full).toBe(Date.UTC(2026, 0, 10, 21, 0)); // 4 pm EST
    expect(localTimeToMs('16:00', input())).toBe(full);
  });
  it('is null when unparseable, or bare with no written day', () => {
    expect(localTimeToMs('around four', input())).toBeNull();
    expect(localTimeToMs('16:00', { timeZone: 'America/New_York' })).toBeNull();
  });
});

describe('mapWireResult', () => {
  const wire: WireResult = {
    reports: [
      {
        bodyRef: 'morey',
        visit: 0,
        note: 'Skated Morey this afternoon.',
        fields: {
          quality: [{ value: 'great', confidence: 0.9, quote: 'Skated Morey', quoteField: 'text' }],
          suitability: [],
          observedFrom: [
            { value: 'on_ice', confidence: 0.95, quote: 'Skated', quoteField: 'text' },
          ],
          sighting: [{ value: 'melting', confidence: 0.4, quote: 'afternoon', quoteField: 'text' }],
          endTime: [
            {
              value: { localTime: '16:00', precision: 'half_hour' },
              confidence: 0.7,
              quote: 'around 4',
              quoteField: 'text',
            },
            {
              value: { localTime: 'dusk', precision: 'half_hour' },
              confidence: 0.7,
              quote: 'around 4',
              quoteField: 'text',
            },
          ],
          iceTypes: [
            {
              value: { type: 'black_ice', where: { sector: 'N' } },
              confidence: 0.95,
              quote: 'Black ice at the north end',
              quoteField: 'text',
            },
            {
              value: { type: 'glass_ice' },
              confidence: 0.6,
              quote: 'Black ice',
              quoteField: 'text',
            },
            {
              value: { type: 'shell_ice', where: { sector: 'upstream', extent: 'patches' } },
              confidence: 0.5,
              quote: 'nowhere',
              quoteField: 'text',
            },
          ],
          surfaceTags: [],
          snowCoverage: [],
          snowImpediment: [],
          snowDrifts: [],
          snowDepthInches: [
            { value: 0.2, confidence: 0.8, quote: 'dusting', quoteField: 'text' },
            { value: -1, confidence: 0.8, quote: 'x', quoteField: 'text' },
          ],
          thickness: [
            {
              value: { method: 'measured', minInches: 3, maxInches: 4 },
              confidence: 0.92,
              quote: '3-4 inches by the auger',
              quoteField: 'text',
            },
            {
              value: { method: 'guessed', valueInches: 2 },
              confidence: 0.5,
              quote: 'x',
              quoteField: 'text',
            },
          ],
          hazards: [
            {
              value: { type: 'open_water', where: { placeName: 'the inlet' } },
              confidence: 0.8,
              quote: 'Got off',
              quoteField: 'text',
            },
            { value: { type: 'bear' }, confidence: 0.8, quote: 'Got off', quoteField: 'text' },
          ],
          accessConditions: [
            { value: 'plank_needed', confidence: 0.7, quote: 'Got off', quoteField: 'text' },
          ],
        },
      },
    ],
    misses: [
      { kind: 'field', text: 'windy', wouldNeed: 'a wind field' },
      { kind: 'bogus', text: 'x', wouldNeed: 'y' },
    ],
  };

  it('maps values, converts units, locates quotes, and turns unknown enums into misses', () => {
    const result = mapWireResult(wire, input());
    const [r] = result.reports;
    expect(r?.bodyRef).toBe('morey');
    expect(r?.fields.quality).toEqual([
      {
        value: 'great',
        confidence: 0.9,
        evidence: { field: 'text', start: 0, end: 12, text: 'Skated Morey', located: true },
      },
    ]);
    expect(r?.fields.sighting).toEqual([]);
    expect(r?.fields.endTime).toHaveLength(1);
    expect(r?.fields.endTime[0]?.value).toEqual({
      ms: Date.UTC(2026, 0, 10, 21, 0),
      precision: 'half_hour',
    });
    expect(r?.fields.iceTypes.map((v) => v.value)).toEqual([
      { type: 'black_ice', where: { sector: 'N' } },
      { type: 'shell_ice', where: { extent: 'patches' } },
    ]);
    expect(r?.fields.iceTypes[1]?.evidence.located).toBe(false);
    expect(r?.fields.snowDepthCm.map((v) => v.value)).toEqual([0.508]);
    expect(r?.fields.thickness).toHaveLength(1);
    expect(r?.fields.thickness[0]?.value).toEqual({
      method: 'measured',
      minCm: 7.62,
      maxCm: 10.16,
    });
    expect(r?.fields.hazards.map((v) => v.value)).toEqual([
      { type: 'open_water', where: { placeName: 'the inlet' } },
    ]);
    expect(r?.fields.accessConditions.map((v) => v.value)).toEqual(['plank_needed']);
    expect(result.misses).toEqual([
      { kind: 'enum_value', text: 'afternoon', wouldNeed: 'sighting: melting' },
      { kind: 'enum_value', text: 'Black ice', wouldNeed: 'iceTypes: glass_ice' },
      { kind: 'where', text: 'upstream', wouldNeed: 'a sector value' },
      { kind: 'enum_value', text: 'Got off', wouldNeed: 'hazards: bear' },
      { kind: 'enum_value', text: 'x', wouldNeed: 'thickness method: guessed' },
      { kind: 'field', text: 'windy', wouldNeed: 'a wind field' },
      { kind: 'other', text: 'x', wouldNeed: 'y' },
    ]);
  });

  it('keeps a null body ref with the name as written', () => {
    const result = mapWireResult(
      {
        reports: [
          {
            bodyRef: null,
            bodyName: 'Halfmile Pond',
            visit: 1,
            fields: WireFieldsSchema.parse({}),
          },
        ],
        misses: [],
      },
      input(),
    );
    expect(result.reports[0]).toMatchObject({ bodyRef: null, bodyName: 'Halfmile Pond', visit: 1 });
  });
});
