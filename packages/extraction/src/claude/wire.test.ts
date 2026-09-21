import { describe, expect, it } from 'vitest';
import { defaultVocabulary, type ExtractionInput } from '../contract';
import {
  evidenceFor,
  localTimeToMs,
  locateQuote,
  mapWireResult,
  thicknessReadingFrom,
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
  it('is null for a date or clock time that does not exist, rather than a normalized neighbor', () => {
    // `Date.UTC` would read each of these as a real instant on another day (Greptile P2, PR #71).
    expect(localTimeToMs('2026-02-30T16:00', input())).toBeNull();
    expect(localTimeToMs('2026-13-01T16:00', input())).toBeNull();
    expect(localTimeToMs('2026-01-00T16:00', input())).toBeNull();
    expect(localTimeToMs('2026-01-10T25:99', input())).toBeNull();
    expect(localTimeToMs('2026-01-10T16:60', input())).toBeNull();
    expect(localTimeToMs('24:00', input())).toBeNull();
    // The edges that do exist stay: a leap day, 23:59, midnight.
    expect(localTimeToMs('2024-02-29T23:59', input())).toBe(Date.UTC(2024, 1, 30, 4, 59));
    expect(localTimeToMs('00:00', input())).toBe(Date.UTC(2026, 0, 10, 5, 0));
  });
  it('reads a bare clock time that has not yet come round as yesterday’s', () => {
    // Written at 2 am EST on the 11th: "got off at 4" is the 10th's four, not a future one.
    const lateNight = input({ writtenAtMs: Date.UTC(2026, 0, 11, 7, 0) });
    expect(localTimeToMs('16:00', lateNight)).toBe(Date.UTC(2026, 0, 10, 21, 0));
    // A minute or two ahead of a fast clock stays today (the validator's own tolerance).
    const justAfter = input({ writtenAtMs: Date.UTC(2026, 0, 10, 20, 58) });
    expect(localTimeToMs('16:00', justAfter)).toBe(Date.UTC(2026, 0, 10, 21, 0));
    // A full timestamp is taken as written, future or not.
    expect(localTimeToMs('2026-01-11T16:00', lateNight)).toBe(Date.UTC(2026, 0, 11, 21, 0));
  });
});

describe('thicknessReadingFrom — the validator’s rule at the source', () => {
  it('keeps what the sheet can post, repairs an upper bound alone, drops the rest', () => {
    expect(thicknessReadingFrom({ method: 'measured', inches: 4 })).toEqual({
      method: 'measured',
      valueCm: 10.16,
    });
    expect(thicknessReadingFrom({ method: 'estimated', minInches: 4 })).toEqual({
      method: 'estimated',
      minCm: 10.16,
    });
    // "Under 2 inches" — an upper bound alone is spelled with the zero the validator wants.
    expect(thicknessReadingFrom({ method: 'estimated', maxInches: 2 })).toEqual({
      method: 'estimated',
      minCm: 0,
      maxCm: 5.08,
    });
    expect(
      thicknessReadingFrom({ method: 'poke', pokeCount: 5, minInches: 3, supportable: true }),
    ).toEqual({ method: 'poke', pokeCount: 5, minCm: 7.62, supportable: true });
    expect(thicknessReadingFrom({ method: 'poke', inches: 3 })).toBeNull(); // no count
    expect(thicknessReadingFrom({ method: 'estimated' })).toBeNull(); // no number
    expect(thicknessReadingFrom({ method: 'measured', inches: 4, minInches: 3 })).toBeNull();
    expect(thicknessReadingFrom({ method: 'measured', pokeCount: 2, inches: 4 })).toBeNull();
    expect(thicknessReadingFrom({ method: 'measured', inches: -1 })).toBeNull();
  });
});

describe('mapWireResult', () => {
  const t = 'text' as const;
  const wire: WireResult = {
    reports: [
      {
        bodyRef: 'morey',
        visit: 0,
        note: 'Skated Morey this afternoon.',
        values: [
          {
            field: 'quality',
            value: 'great',
            confidence: 0.9,
            quote: 'Skated Morey',
            quoteField: t,
          },
          {
            field: 'observedFrom',
            value: 'shore',
            confidence: 0.95,
            quote: 'Skated',
            quoteField: t,
          },
          {
            field: 'sighting',
            value: 'melting',
            confidence: 0.4,
            quote: 'afternoon',
            quoteField: t,
          },
          { field: 'sighting', value: 'open', confidence: 0.6, quote: 'afternoon', quoteField: t },
          {
            field: 'endTime',
            value: '16:00',
            precision: 'half_hour',
            confidence: 0.7,
            quote: 'around 4',
            quoteField: t,
          },
          {
            field: 'endTime',
            value: 'dusk',
            precision: 'half_hour',
            confidence: 0.7,
            quote: 'around 4',
            quoteField: t,
          },
          {
            field: 'iceTypes',
            value: 'black_ice',
            where: { sector: 'N' },
            confidence: 0.95,
            quote: 'Black ice at the north end',
            quoteField: t,
          },
          {
            field: 'iceTypes',
            value: 'glass_ice',
            confidence: 0.6,
            quote: 'Black ice',
            quoteField: t,
          },
          {
            field: 'iceTypes',
            value: 'shell_ice',
            where: { sector: 'upstream', extent: 'patches' },
            confidence: 0.5,
            quote: 'nowhere',
            quoteField: t,
          },
          {
            field: 'snowDepthInches',
            value: 'depth',
            inches: 0.2,
            confidence: 0.8,
            quote: 'dusting',
            quoteField: t,
          },
          {
            field: 'snowDepthInches',
            value: 'depth',
            inches: -1,
            confidence: 0.8,
            quote: 'x',
            quoteField: t,
          },
          {
            field: 'thickness',
            value: 'measured',
            minInches: 3,
            maxInches: 4,
            confidence: 0.92,
            quote: '3-4 inches by the auger',
            quoteField: t,
          },
          {
            field: 'thickness',
            value: 'guessed',
            inches: 2,
            confidence: 0.5,
            quote: 'x',
            quoteField: t,
          },
          // A poke with no count and an estimate with no number: the sheet could never post them.
          {
            field: 'thickness',
            value: 'poke',
            inches: 3,
            confidence: 0.9,
            quote: 'about 3-4 inches',
            quoteField: t,
          },
          {
            field: 'thickness',
            value: 'estimated',
            confidence: 0.6,
            quote: 'thick enough',
            quoteField: t,
          },
          // A prototype key as a field name must be a miss, not a crash.
          {
            field: 'constructor',
            value: 'great',
            confidence: 0.7,
            quote: 'Got off',
            quoteField: t,
          },
          {
            field: 'hazards',
            value: 'open_water',
            where: { placeName: 'the inlet' },
            confidence: 0.8,
            quote: 'Got off',
            quoteField: t,
          },
          { field: 'hazards', value: 'bear', confidence: 0.8, quote: 'Got off', quoteField: t },
          {
            field: 'accessConditions',
            value: 'plank_needed',
            confidence: 0.7,
            quote: 'Got off',
            quoteField: t,
          },
          { field: 'wind', value: 'strong', confidence: 0.7, quote: 'Got off', quoteField: t },
        ],
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
    expect(r?.fields.sighting.map((v) => v.value)).toEqual(['open']);
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
      { kind: 'enum_value', text: 'x', wouldNeed: 'thickness method: guessed' },
      { kind: 'other', text: 'about 3-4 inches', wouldNeed: 'a poke count on the poke reading' },
      { kind: 'other', text: 'thick enough', wouldNeed: 'a number on the thickness reading' },
      { kind: 'field', text: 'Got off', wouldNeed: 'a field named constructor' },
      { kind: 'enum_value', text: 'Got off', wouldNeed: 'hazards: bear' },
      { kind: 'field', text: 'Got off', wouldNeed: 'a field named wind' },
      { kind: 'field', text: 'windy', wouldNeed: 'a wind field' },
      { kind: 'other', text: 'x', wouldNeed: 'y' },
    ]);
  });

  it('drops a sighting from an author on the ice, or with no vantage (D189)', () => {
    const t = 'text' as const;
    const sighting = {
      field: 'sighting',
      value: 'open',
      confidence: 0.9,
      quote: 'Skated',
      quoteField: t,
    };
    const onIce = mapWireResult(
      {
        reports: [
          {
            bodyRef: 'morey',
            visit: 0,
            values: [
              {
                field: 'observedFrom',
                value: 'on_ice',
                confidence: 1,
                quote: 'Skated',
                quoteField: t,
              },
              sighting,
            ],
          },
        ],
        misses: [],
      },
      input(),
    );
    expect(onIce.reports[0]?.fields.sighting).toEqual([]);
    const unstated = mapWireResult(
      { reports: [{ bodyRef: 'morey', visit: 0, values: [sighting] }], misses: [] },
      input(),
    );
    expect(unstated.reports[0]?.fields.sighting).toEqual([]);
  });

  it('keeps a null body ref with the name as written', () => {
    const result = mapWireResult(
      { reports: [{ bodyRef: null, bodyName: 'Halfmile Pond', visit: 1, values: [] }], misses: [] },
      input(),
    );
    expect(result.reports[0]).toMatchObject({ bodyRef: null, bodyName: 'Halfmile Pond', visit: 1 });
  });

  it('nulls a body ref that was never a candidate, keeping the string as the name (Greptile P2, PR #71)', () => {
    const result = mapWireResult(
      {
        reports: [
          { bodyRef: 'morey', visit: 0, values: [] },
          { bodyRef: 'Lake Fairlee', visit: 0, values: [] },
          { bodyRef: 'fairlee', bodyName: 'Fairlee', visit: 0, values: [] },
        ],
        misses: [],
      },
      input(),
    );
    expect(result.reports.map((r) => [r.bodyRef, r.bodyName])).toEqual([
      ['morey', undefined],
      [null, 'Lake Fairlee'],
      [null, 'Fairlee'],
    ]);
  });
});
