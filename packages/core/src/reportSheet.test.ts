import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  confirmList,
  DEFAULT_PRECISION_FLOOR,
  emptySheet,
  FIELD_SECTION,
  hasExtracted,
  type ReportSheetState,
  SHEET_SECTIONS,
  type SheetAction,
  type SheetFieldKey,
  sectionFilled,
  sectionSummary,
  selectedChips,
  selectedValues,
  sheetGaps,
  sheetReducer,
  toReportInput,
} from './reportSheet';

const OPENED = Date.UTC(2026, 0, 10, 21, 12);
const TZ = 'America/New_York';

function run(actions: SheetAction[], start = emptySheet(OPENED, 'wb1')): ReportSheetState {
  return actions.reduce(sheetReducer, start);
}

const evidence = { start: 0, end: 5, text: 'black' };

describe('emptySheet', () => {
  it('has every field, observedFrom defaulted to on the ice, and no section collapsed', () => {
    const s = emptySheet(OPENED, 'wb1');
    expect(Object.keys(s.fields).sort()).toEqual(Object.keys(FIELD_SECTION).sort());
    expect(selectedValues(s, 'observedFrom')).toEqual(['on_ice']);
    expect(s.fields.observedFrom.touched).toBe(false);
    expect(Object.values(s.collapsed).every((c) => c === false)).toBe(true);
    expect(sectionFilled(s, 'observedFrom')).toBe(false); // a default is not a fill
    expect(emptySheet(OPENED).waterBodyId).toBeUndefined();
  });
});

describe('select / deselect', () => {
  it('a tapped value is solid; a single-select field keeps one', () => {
    const s = run([
      { type: 'select', field: 'quality', key: 'good', value: 'good' },
      { type: 'select', field: 'quality', key: 'great', value: 'great' },
    ]);
    expect(selectedValues(s, 'quality')).toEqual(['great']);
    expect(s.fields.quality.chips.map((c) => c.key)).toEqual(['great']); // the solid loser is gone
    expect(s.fields.quality.touched).toBe(true);
  });

  it('a multi field keeps every tap, and a deselected solid chip is gone', () => {
    const s = run([
      { type: 'select', field: 'iceTypes', key: 'black_ice', value: { type: 'black_ice' } },
      { type: 'select', field: 'iceTypes', key: 'shell_ice', value: { type: 'shell_ice' } },
      { type: 'deselect', field: 'iceTypes', key: 'black_ice' },
    ]);
    expect(selectedValues(s, 'iceTypes')).toEqual([{ type: 'shell_ice' }]);
  });

  it('a tap with a value on an existing key replaces the value (a retyped reading)', () => {
    const s = run([
      {
        type: 'select',
        field: 'thickness',
        key: 'reading:1',
        value: { method: 'measured', valueCm: 10 },
      },
      {
        type: 'select',
        field: 'thickness',
        key: 'reading:1',
        value: { method: 'measured', valueCm: 12 },
      },
      { type: 'select', field: 'thickness', key: 'reading:1' },
    ]);
    expect(selectedValues(s, 'thickness')).toEqual([{ method: 'measured', valueCm: 12 }]);
  });

  it('a ghost becomes solid on tap; selecting an unknown key with no value is a no-op', () => {
    const s = run([
      {
        type: 'suggest',
        field: 'surfaceTags',
        source: 'peer',
        values: [{ key: 'glass', value: { type: 'glass' } }],
      },
    ]);
    expect(selectedValues(s, 'surfaceTags')).toEqual([]);
    const tapped = sheetReducer(s, { type: 'select', field: 'surfaceTags', key: 'glass' });
    expect(selectedValues(tapped, 'surfaceTags')).toEqual([{ type: 'glass' }]);
    expect(sheetReducer(s, { type: 'select', field: 'surfaceTags', key: 'rough' })).toBe(s);
  });

  it('deselecting an extracted chip demotes it to a ghost that a later extraction cannot re-promote', () => {
    const extraction: SheetAction = {
      type: 'applyExtraction',
      seq: 1,
      floors: { iceTypes: 0.8 },
      fields: {
        iceTypes: [{ key: 'black_ice', value: { type: 'black_ice' }, confidence: 0.95, evidence }],
      },
    };
    const s = run([extraction, { type: 'deselect', field: 'iceTypes', key: 'black_ice' }]);
    expect(s.fields.iceTypes.chips[0]?.tier).toBe('ghost');
    expect(selectedValues(s, 'iceTypes')).toEqual([]);
    const again = sheetReducer(s, { ...extraction, seq: 2 });
    expect(again.fields.iceTypes.chips[0]?.tier).toBe('ghost');
  });

  it('a defaulted select is the sheet’s, not the author’s: solid, untouched, and an extraction may step it down', () => {
    const pinned = { ms: OPENED, precision: 'minute' as const };
    const s = run([
      { type: 'select', field: 'endTime', key: 'pinned', value: pinned, defaulted: true },
    ]);
    expect(selectedValues(s, 'endTime')).toEqual([pinned]);
    expect(s.fields.endTime.chips[0]?.defaulted).toBe(true);
    expect(s.fields.endTime.touched).toBe(false);
    // The author's own tap on the same key clears the mark and touches the field.
    const tapped = sheetReducer(s, { type: 'select', field: 'endTime', key: 'pinned' });
    expect(tapped.fields.endTime.chips[0]?.defaulted).toBeUndefined();
    expect(tapped.fields.endTime.touched).toBe(true);
    // Untouched, the default yields to a confident extraction the way the vantage default does.
    const read = sheetReducer(s, {
      type: 'applyExtraction',
      seq: 1,
      floors: { endTime: 0.5 },
      fields: {
        endTime: [
          {
            key: 'read',
            value: { ms: OPENED - 3_600_000, precision: 'half_hour' },
            confidence: 0.9,
            evidence,
          },
        ],
      },
    });
    expect(selectedValues(read, 'endTime')).toEqual([
      { ms: OPENED - 3_600_000, precision: 'half_hour' },
    ]);
    expect(read.fields.endTime.chips.find((c) => c.key === 'pinned')?.tier).toBe('ghost');
  });

  it('setWhere attaches, replaces and clears a where on a located chip', () => {
    const s = run([
      { type: 'select', field: 'iceTypes', key: 'black_ice', value: { type: 'black_ice' } },
      { type: 'setWhere', field: 'iceTypes', key: 'black_ice', where: { sector: 'N' } },
    ]);
    expect(selectedValues(s, 'iceTypes')).toEqual([{ type: 'black_ice', where: { sector: 'N' } }]);
    const cleared = sheetReducer(s, { type: 'setWhere', field: 'iceTypes', key: 'black_ice' });
    expect(selectedValues(cleared, 'iceTypes')).toEqual([{ type: 'black_ice' }]);
  });
});

describe('suggestions (D188)', () => {
  it('arrive as ghosts, never selected, and never duplicate a known key', () => {
    const s = run([
      { type: 'select', field: 'iceTypes', key: 'black_ice', value: { type: 'black_ice' } },
      {
        type: 'suggest',
        field: 'iceTypes',
        source: 'peer',
        values: [
          { key: 'black_ice', value: { type: 'black_ice' } },
          { key: 'shell_ice', value: { type: 'shell_ice' } },
        ],
      },
    ]);
    expect(s.fields.iceTypes.chips.map((c) => [c.key, c.tier, c.source])).toEqual([
      ['black_ice', 'solid', undefined],
      ['shell_ice', 'ghost', 'peer'],
    ]);
    expect(toReportInput(s).iceTypes).toEqual([{ type: 'black_ice' }]);
  });
});

describe('applyExtraction (D188, D196)', () => {
  const floors = { iceTypes: 0.8, quality: 0.9, suitability: 0.9 };

  it('at or above the floor is extracted and pre-selected; below is a ghost', () => {
    const s = run([
      {
        type: 'applyExtraction',
        seq: 1,
        floors,
        fields: {
          iceTypes: [
            { key: 'black_ice', value: { type: 'black_ice' }, confidence: 0.95, evidence },
            { key: 'shell_ice', value: { type: 'shell_ice' }, confidence: 0.5, evidence },
          ],
        },
      },
    ]);
    expect(s.fields.iceTypes.chips.map((c) => [c.key, c.tier])).toEqual([
      ['black_ice', 'extracted'],
      ['shell_ice', 'ghost'],
    ]);
    expect(selectedValues(s, 'iceTypes')).toEqual([{ type: 'black_ice' }]);
    expect(hasExtracted(s)).toBe(true);
  });

  it('with no floor configured everything is a ghost', () => {
    const s = run([
      {
        type: 'applyExtraction',
        seq: 1,
        floors: {},
        fields: { quality: [{ key: 'great', value: 'great', confidence: 1, evidence }] },
      },
    ]);
    expect(DEFAULT_PRECISION_FLOOR).toBeGreaterThan(1);
    expect(s.fields.quality.chips[0]?.tier).toBe('ghost');
  });

  it('never overwrites a touched field or a solid chip; new values land as ghosts there', () => {
    const s = run([
      { type: 'select', field: 'quality', key: 'good', value: 'good' },
      {
        type: 'applyExtraction',
        seq: 1,
        floors,
        fields: { quality: [{ key: 'great', value: 'great', confidence: 0.99, evidence }] },
      },
    ]);
    expect(selectedValues(s, 'quality')).toEqual(['good']);
    expect(s.fields.quality.chips.find((c) => c.key === 'great')?.tier).toBe('ghost');
  });

  it('the untouched observedFrom default yields to an extraction that read "from the shore"', () => {
    const s = run([
      {
        type: 'applyExtraction',
        seq: 1,
        floors: { observedFrom: 0.8 },
        fields: { observedFrom: [{ key: 'shore', value: 'shore', confidence: 0.9, evidence }] },
      },
    ]);
    expect(selectedValues(s, 'observedFrom')).toEqual(['shore']);
    expect(s.fields.observedFrom.chips.map((c) => [c.key, c.tier])).toEqual([
      ['on_ice', 'ghost'],
      ['shore', 'extracted'],
    ]);
    // The section is filled by the extraction, untouched though it is — the default alone is not.
    expect(sectionFilled(s, 'observedFrom')).toBe(true);
    expect(sectionSummary(s, 'observedFrom', TZ)).toBe('Shore');
    expect(sectionFilled(emptySheet(OPENED, 'wb1'), 'observedFrom')).toBe(false);
  });

  it('a single-select field keeps the most confident extraction; ties go to the earlier one', () => {
    const s = run([
      {
        type: 'applyExtraction',
        seq: 1,
        floors,
        fields: {
          suitability: [
            { key: 'experienced_only', value: 'experienced_only', confidence: 0.92, evidence },
            { key: 'dont_go', value: 'dont_go', confidence: 0.97, evidence },
          ],
        },
      },
    ]);
    expect(selectedValues(s, 'suitability')).toEqual(['dont_go']);
  });

  it('a late result never overrides a newer one', () => {
    const newer: SheetAction = {
      type: 'applyExtraction',
      seq: 2,
      floors,
      fields: {
        iceTypes: [{ key: 'black_ice', value: { type: 'black_ice' }, confidence: 0.9, evidence }],
      },
    };
    const late: SheetAction = {
      type: 'applyExtraction',
      seq: 1,
      floors,
      fields: {
        iceTypes: [{ key: 'shell_ice', value: { type: 'shell_ice' }, confidence: 0.9, evidence }],
      },
    };
    const s = run([newer, late]);
    expect(s.fields.iceTypes.chips.map((c) => c.key)).toEqual(['black_ice']);
    expect(s.extractionSeq).toBe(2);
  });

  it('refreshes the evidence and tier of an untouched extracted chip on a newer pass', () => {
    const first: SheetAction = {
      type: 'applyExtraction',
      seq: 1,
      floors,
      fields: {
        iceTypes: [{ key: 'black_ice', value: { type: 'black_ice' }, confidence: 0.9, evidence }],
      },
    };
    const second: SheetAction = {
      type: 'applyExtraction',
      seq: 2,
      floors,
      fields: {
        iceTypes: [
          {
            key: 'black_ice',
            value: { type: 'black_ice', where: { sector: 'N' } },
            confidence: 0.5,
            evidence: { start: 10, end: 30, text: 'black ice at the north end' },
          },
        ],
      },
    };
    const s = run([first, second]);
    const chip = s.fields.iceTypes.chips[0];
    expect(chip?.tier).toBe('ghost'); // dropped below the floor on the fuller read
    expect(chip?.value).toEqual({ type: 'black_ice', where: { sector: 'N' } });
    expect(chip?.evidence?.text).toBe('black ice at the north end');
  });

  it('never selects a ghost and never serializes one (property)', () => {
    const fieldKeys = Object.keys(FIELD_SECTION) as SheetFieldKey[];
    const scalarFields: SheetFieldKey[] = ['quality', 'suitability', 'snowCoverage'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            field: fc.constantFrom(...scalarFields),
            key: fc.constantFrom('a', 'b', 'c'),
            confidence: fc.double({ min: 0, max: 1, noNaN: true }),
            touch: fc.boolean(),
          }),
          { maxLength: 12 },
        ),
        (steps) => {
          let s = emptySheet(OPENED, 'wb1');
          let seq = 0;
          for (const step of steps) {
            if (step.touch) {
              s = sheetReducer(s, {
                type: 'select',
                field: step.field,
                key: step.key,
                value: step.key,
              });
            } else {
              s = sheetReducer(s, {
                type: 'applyExtraction',
                seq: ++seq,
                floors: { [step.field]: 0.7 },
                fields: {
                  [step.field]: [
                    { key: step.key, value: step.key, confidence: step.confidence, evidence },
                  ],
                },
              } as SheetAction);
            }
          }
          for (const key of fieldKeys) {
            const chips = s.fields[key].chips;
            // A single-select field never has two selections.
            if (!s.fields[key].multi) expect(selectedChips(s, key).length).toBeLessThanOrEqual(1);
            // A touched field's selection is solid or absent — never an extraction's.
            if (s.fields[key].touched) {
              expect(selectedChips(s, key).every((c) => c.tier === 'solid')).toBe(true);
            }
            // Ghosts never serialize: the serialized value of the field is a selected one or absent.
            const input = toReportInput(s);
            const serializedValue =
              key === 'quality'
                ? input.skateQuality
                : key === 'suitability'
                  ? input.suitability
                  : key === 'snowCoverage'
                    ? input.snow?.coverage
                    : undefined;
            const ghosts = chips.filter((c) => c.tier === 'ghost').map((c) => c.value);
            if (serializedValue !== undefined) {
              expect(selectedValues(s, key)).toContain(serializedValue);
              if (!selectedValues(s, key).includes(serializedValue)) {
                expect(ghosts).not.toContain(serializedValue);
              }
            }
          }
        },
      ),
    );
  });
});

describe('toReportInput / sheetGaps (D189)', () => {
  it('serializes solid and extracted values, ghosts never, and reports the gaps', () => {
    let s = emptySheet(OPENED, 'wb1');
    expect(sheetGaps(s)).toEqual(['endTime', 'howWasIt', 'observation']);
    s = run(
      [
        {
          type: 'select',
          field: 'endTime',
          key: 'pinned',
          value: { ms: OPENED, precision: 'minute' },
        },
        { type: 'select', field: 'quality', key: 'great', value: 'great' },
        {
          type: 'applyExtraction',
          seq: 1,
          floors: { surfaceTags: 0.8, snowCoverage: 0.8 },
          fields: {
            surfaceTags: [{ key: 'glass', value: { type: 'glass' }, confidence: 0.9, evidence }],
            snowCoverage: [{ key: 'lanes', value: 'lanes', confidence: 0.3, evidence }],
          },
        },
        { type: 'setScalar', key: 'notes', value: '  north end was the best  ' },
        { type: 'setScalar', key: 'snowDepthCm', value: 2 },
      ],
      s,
    );
    expect(sheetGaps(s)).toEqual([]);
    expect(toReportInput(s)).toEqual({
      waterBodyId: 'wb1',
      skateEndTime: OPENED,
      skateEndPrecision: 'minute',
      observedFrom: 'on_ice',
      iceTypes: [],
      surfaceTags: [{ type: 'glass' }],
      skateQuality: 'great',
      snow: { depthCm: 2 },
      notes: 'north end was the best',
    });
  });

  it('a hazard satisfies the observation term; prose alone never posts', () => {
    const base = run([
      { type: 'select', field: 'endTime', key: 'p', value: { ms: OPENED, precision: 'minute' } },
      { type: 'select', field: 'suitability', key: 'dont_go', value: 'dont_go' },
      { type: 'setScalar', key: 'notes', value: 'open lead across the whole north end, do not go' },
    ]);
    expect(sheetGaps(base)).toEqual(['observation']);
    const withHazard = sheetReducer(base, { type: 'setScalar', key: 'hazardIds', value: ['h1'] });
    expect(sheetGaps(withHazard)).toEqual([]);
  });

  it('thickness readings and the scope serialize together', () => {
    const s = run([
      { type: 'select', field: 'thickness', key: 'r1', value: { method: 'poke', pokeCount: 4 } },
      { type: 'setScalar', key: 'thicknessScope', value: 'everywhere_tested' },
    ]);
    expect(toReportInput(s).iceThickness).toEqual({
      readings: [{ method: 'poke', pokeCount: 4 }],
      scope: 'everywhere_tested',
    });
  });
});

describe('confirmList (D188)', () => {
  it('lists every extracted chip, safety-flavored first', () => {
    const s = run([
      {
        type: 'applyExtraction',
        seq: 1,
        floors: { iceTypes: 0.5, suitability: 0.5, thickness: 0.5 },
        fields: {
          iceTypes: [{ key: 'black_ice', value: { type: 'black_ice' }, confidence: 0.9, evidence }],
          suitability: [{ key: 'dont_go', value: 'dont_go', confidence: 0.9, evidence }],
          thickness: [
            { key: 'r1', value: { method: 'estimated', minCm: 5 }, confidence: 0.9, evidence },
          ],
        },
      },
    ]);
    expect(confirmList(s).map((i) => [i.field, i.safety])).toEqual([
      ['suitability', true],
      ['thickness', true],
      ['iceTypes', false],
    ]);
    expect(hasExtracted(emptySheet(OPENED))).toBe(false);
  });
});

describe('sections', () => {
  it('order is fixed with How was it? first', () => {
    expect(SHEET_SECTIONS[0]).toBe('howWasIt');
    expect(SHEET_SECTIONS).toHaveLength(10);
  });

  it('collapse is explicit state', () => {
    const s = run([{ type: 'setCollapsed', section: 'snow', collapsed: true }]);
    expect(s.collapsed.snow).toBe(true);
    expect(s.collapsed.howWasIt).toBe(false);
  });

  it('summaries repeat the author’s chips and nothing more', () => {
    const s = run([
      { type: 'select', field: 'quality', key: 'great', value: 'great' },
      {
        type: 'select',
        field: 'suitability',
        key: 'not_for_beginners',
        value: 'not_for_beginners',
      },
      { type: 'select', field: 'observedFrom', key: 'shore', value: 'shore' },
      { type: 'select', field: 'sighting', key: 'open', value: 'open' },
      { type: 'select', field: 'endTime', key: 'p', value: { ms: OPENED, precision: 'half_hour' } },
      {
        type: 'select',
        field: 'iceTypes',
        key: 'black_ice',
        value: { type: 'black_ice', where: { sector: 'N', extent: 'patches' } },
      },
      {
        type: 'select',
        field: 'surfaceTags',
        key: 'glass',
        value: { type: 'glass', where: { sector: 'middle' } },
      },
      { type: 'select', field: 'snowCoverage', key: 'lanes', value: 'lanes' },
      { type: 'select', field: 'snowImpediment', key: 'didnt_matter', value: 'didnt_matter' },
      { type: 'select', field: 'snowDrifts', key: 'avoidable', value: 'avoidable' },
      { type: 'setScalar', key: 'plowedPath', value: true },
      {
        type: 'select',
        field: 'thickness',
        key: 'r1',
        value: { method: 'measured', valueCm: 10.16 },
      },
      { type: 'setScalar', key: 'hazardIds', value: ['h1'] },
      { type: 'answerPassed', hazardId: 'h2', verdict: 'still_there' },
      { type: 'answerPassed', hazardId: 'h3', verdict: 'didnt_look' },
      { type: 'setScalar', key: 'putInId', value: 'pi1' },
      { type: 'select', field: 'accessConditions', key: 'plank_needed', value: 'plank_needed' },
      { type: 'setScalar', key: 'photoIds', value: ['a'] },
      {
        type: 'setScalar',
        key: 'notes',
        value: 'one two three four five six seven eight nine ten',
      },
    ]);
    expect(sectionSummary(s, 'howWasIt', TZ)).toBe('Great · Not for beginners');
    expect(sectionSummary(s, 'observedFrom', TZ)).toBe('Shore · Open');
    expect(sectionSummary(s, 'endTime', TZ)).toBe('about 4:12 PM');
    expect(sectionSummary(s, 'iceAndSurface', TZ)).toBe(
      'Black ice, patches north end · Glass, middle',
    );
    expect(sectionSummary(s, 'snow', TZ)).toBe(
      'Snow: lanes · didnt matter · drifts avoidable · plowed path',
    );
    expect(sectionSummary(s, 'thickness', TZ)).toBe('4″ (measured)');
    expect(sectionSummary(s, 'hazards', TZ)).toBe('1 marked · 1 confirmed');
    expect(sectionSummary(s, 'access', TZ)).toBe('Put-in chosen · Plank needed');
    expect(sectionSummary(s, 'photos', TZ)).toBe('1 photo');
    expect(sectionSummary(s, 'writing', TZ)).toBe('one two three four five six seven eight');
    for (const section of SHEET_SECTIONS) expect(sectionFilled(s, section)).toBe(true);
    expect(sectionSummary(emptySheet(OPENED), 'snow', TZ)).toBe('');
  });

  it('a minute-precision end time reads plainly; every unfilled section is empty', () => {
    const s = run([
      { type: 'select', field: 'endTime', key: 'p', value: { ms: OPENED, precision: 'minute' } },
    ]);
    expect(sectionSummary(s, 'endTime', TZ)).toBe('4:12 PM');
    for (const section of SHEET_SECTIONS) {
      if (section !== 'endTime') expect(sectionFilled(s, section)).toBe(false);
    }
  });
});

// ── A10-3: verdicts, the quick thickness row, seeding from a stored report ─────────────────────

import { isValidThicknessReading, validateReportInput } from './report';
import {
  confirmableVerdict,
  PASSED_VERDICTS,
  sheetFromReport,
  THICKNESS_BANDS,
  thicknessBandKey,
  thicknessBandOf,
  thicknessBandOfKey,
  thicknessBandReading,
} from './reportSheet';
import { ICE_TYPES, SKATE_QUALITIES, SURFACE_TAGS } from './types';

describe('passed-hazard verdicts (D52 + didn’t look)', () => {
  it('are the three confirmation verdicts plus didnt_look, and only didnt_look files nothing', () => {
    expect(PASSED_VERDICTS).toEqual([
      'still_there',
      'healing_unsafe',
      'fully_healed',
      'didnt_look',
    ]);
    expect(confirmableVerdict('didnt_look')).toBeNull();
    expect(confirmableVerdict('fully_healed')).toBe('fully_healed');
  });
});

describe('setBody', () => {
  it('drops the previous lake’s peer ghosts and nothing else', () => {
    const s = [
      {
        type: 'suggest' as const,
        field: 'iceTypes' as const,
        source: 'peer' as const,
        values: [{ key: 'glass', value: { type: 'glass' } }],
      },
      {
        type: 'suggest' as const,
        field: 'surfaceTags' as const,
        source: 'track' as const,
        values: [{ key: 'snow_covered', value: { type: 'snow_covered' } }],
      },
      {
        type: 'select' as const,
        field: 'iceTypes' as const,
        key: 'black_ice',
        value: { type: 'black_ice' },
      },
      { type: 'setBody' as const, waterBodyId: 'wb-2' },
    ].reduce(sheetReducer, emptySheet(OPENED, 'wb-1'));
    expect(s.waterBodyId).toBe('wb-2');
    expect(s.fields.iceTypes.chips.map((c) => c.key)).toEqual(['black_ice']);
    expect(s.fields.surfaceTags.chips.map((c) => c.key)).toEqual(['snow_covered']);
    // The same lake again is a no-op, ghosts included.
    const same = [
      {
        type: 'suggest' as const,
        field: 'quality' as const,
        source: 'peer' as const,
        values: [{ key: 'good', value: 'good' }],
      },
    ].reduce(sheetReducer, s);
    expect(sheetReducer(same, { type: 'setBody', waterBodyId: 'wb-2' })).toBe(same);
  });
});

describe('the quick thickness row (D195)', () => {
  it('a band is one estimated reading with the band’s edges; 6+ is a lower bound, under 2 an upper', () => {
    expect(thicknessBandReading('under_2')).toEqual({ method: 'estimated', minCm: 0, maxCm: 5.08 });
    expect(thicknessBandReading('6_plus')).toEqual({ method: 'estimated', minCm: 15.24 });
    expect(thicknessBandReading('3_4', { sector: 'N' })).toEqual({
      method: 'estimated',
      minCm: 7.62,
      maxCm: 10.16,
      where: { sector: 'N' },
    });
    for (const band of THICKNESS_BANDS) {
      expect(thicknessBandOf(thicknessBandReading(band))).toBe(band);
      expect(thicknessBandOfKey(thicknessBandKey(band))).toBe(band);
      // Every band is a reading the validator takes — a bare `maxCm` is not (`minCm: 0` spells it).
      expect(isValidThicknessReading(thicknessBandReading(band))).toBe(true);
    }
    expect(thicknessBandOfKey('reading:1')).toBeNull();
    expect(thicknessBandOfKey('band:nope')).toBeNull();
    // A precise reading is never mistaken for a band, even at a band's edges.
    expect(thicknessBandOf({ method: 'measured', minCm: 7.62, maxCm: 10.16 })).toBeNull();
    expect(thicknessBandOf({ method: 'estimated', valueCm: 7.62 })).toBeNull();
    expect(
      thicknessBandOf({ method: 'estimated', minCm: 7.62, maxCm: 10.16, supportable: true }),
    ).toBeNull();
    expect(thicknessBandOf({ method: 'estimated', minCm: 8, maxCm: 10.16 })).toBeNull();
  });

  it('selecting a band replaces the previous band and leaves precise readings alone', () => {
    const s = run([
      {
        type: 'select',
        field: 'thickness',
        key: 'reading:1',
        value: { method: 'measured', valueCm: 10 },
      },
      { type: 'selectThicknessBand', band: '2_3' },
      { type: 'selectThicknessBand', band: '4_6' },
    ]);
    expect(s.fields.thickness.chips.map((c) => c.key)).toEqual(['reading:1', 'band:4_6']);
    expect(s.fields.thickness.touched).toBe(true);
    const cleared = sheetReducer(s, { type: 'selectThicknessBand', band: null });
    expect(cleared.fields.thickness.chips.map((c) => c.key)).toEqual(['reading:1']);
  });
});

describe('sheetFromReport (the edit door, §4.1)', () => {
  const stored = {
    waterBodyId: 'wb1',
    skateEndTime: OPENED - 3_600_000,
    skateStartTime: OPENED - 7_200_000,
    skateEndPrecision: 'gps' as const,
    observedFrom: 'shore' as const,
    sighting: 'frozen' as const,
    iceTypes: [
      { type: 'black_ice' as const, where: { sector: 'N' as const } },
      { type: 'black_ice' as const, where: { sector: 'S' as const } },
      'shell_ice' as const,
    ],
    surfaceTags: ['glass' as const],
    skateQuality: 'good' as const,
    suitability: 'experienced_only' as const,
    iceThickness: {
      readings: [{ method: 'poke' as const, pokeCount: 3 }, thicknessBandReading('4_6')],
      scope: 'at_spot' as const,
    },
    snow: {
      coverage: 'patches' as const,
      impediment: 'didnt_matter' as const,
      drifts: 'none' as const,
      depthCm: 2,
      plowedPath: true,
    },
    conditions: {
      airTempC: -3,
      windSpeedKph: 10,
      windDir: 'NW',
      sky: 'clear' as const,
      precip: 'none' as const,
      source: 'openmeteo' as const,
    },
    notes: 'Fine.',
    point: { lat: 44, lng: -72 },
    putInId: 'pi-1',
    showPutIn: false,
    photoIds: ['ph1'],
    hazardIds: ['hz1'],
  };

  it('seeds every value solid and the author’s, keeps duplicate located chips, and round-trips', () => {
    const s = sheetFromReport(stored, OPENED);
    expect(s.openedAtMs).toBe(OPENED);
    expect(selectedValues(s, 'observedFrom')).toEqual(['shore']);
    expect(s.fields.observedFrom.chips[0]?.defaulted).toBeUndefined();
    expect(s.fields.iceTypes.chips.map((c) => c.key)).toEqual([
      'black_ice',
      'black_ice#2',
      'shell_ice',
    ]);
    expect(s.fields.thickness.chips.map((c) => c.key)).toEqual(['reading:1', 'band:4_6']);
    expect(s.scalars.showPutIn).toBe(false);
    expect(s.scalars.putInId).toBe('pi-1');
    expect(s.scalars.conditions?.source).toBe('openmeteo');
    expect(s.touchedScalars.notes).toBe(true);
    expect(s.touchedScalars.passedVerdicts).toBeUndefined();
    expect(sectionFilled(s, 'observedFrom')).toBe(true);
    expect(sectionFilled(s, 'access')).toBe(true);

    const out = toReportInput(s);
    expect(out).toEqual({
      waterBodyId: 'wb1',
      skateEndTime: stored.skateEndTime,
      skateEndPrecision: 'gps',
      skateStartTime: stored.skateStartTime,
      observedFrom: 'shore',
      sighting: 'frozen',
      iceTypes: [
        { type: 'black_ice', where: { sector: 'N' } },
        { type: 'black_ice', where: { sector: 'S' } },
        { type: 'shell_ice' },
      ],
      surfaceTags: [{ type: 'glass' }],
      skateQuality: 'good',
      suitability: 'experienced_only',
      iceThickness: { readings: stored.iceThickness.readings, scope: 'at_spot' },
      snow: stored.snow,
      notes: 'Fine.',
      point: { lat: 44, lng: -72 },
      putInId: 'pi-1',
      showPutIn: false,
      conditions: stored.conditions,
    });
    expect(validateReportInput(out, { now: OPENED }).ok).toBe(true);
  });

  it('a bare report seeds a sheet that reads as unfilled, with the default vantage', () => {
    const s = sheetFromReport({ skateEndTime: OPENED }, OPENED);
    expect(selectedValues(s, 'observedFrom')).toEqual(['on_ice']);
    expect(sectionFilled(s, 'observedFrom')).toBe(false);
    expect(selectedValues(s, 'endTime')).toEqual([{ ms: OPENED, precision: 'half_hour' }]);
    expect(toReportInput(s).conditions).toBeUndefined();
    expect(toReportInput(s).showPutIn).toBeUndefined();
  });

  it('round-trips any valid stored content (property)', () => {
    const chip = <T extends string>(types: readonly T[]) =>
      fc.record(
        {
          type: fc.constantFrom(...types),
          where: fc.option(
            fc.constantFrom({ sector: 'N' as const }, { extent: 'patches' as const }),
            { nil: undefined },
          ),
        },
        { requiredKeys: ['type'] },
      );
    fc.assert(
      fc.property(
        fc.record({
          iceTypes: fc.array(chip(ICE_TYPES), { maxLength: 4 }),
          surfaceTags: fc.array(chip(SURFACE_TAGS), { maxLength: 3 }),
          skateQuality: fc.option(fc.constantFrom(...SKATE_QUALITIES), { nil: undefined }),
          readings: fc.array(
            fc.constantFrom(
              { method: 'measured' as const, valueCm: 10 },
              { method: 'poke' as const, pokeCount: 2 },
              thicknessBandReading('2_3'),
            ),
            { maxLength: 3 },
          ),
        }),
        ({ iceTypes, surfaceTags, skateQuality, readings }) => {
          const input = {
            waterBodyId: 'wb1',
            skateEndTime: OPENED,
            iceTypes,
            surfaceTags,
            ...(skateQuality !== undefined ? { skateQuality } : {}),
            ...(readings.length > 0 ? { iceThickness: { readings } } : {}),
          };
          const out = toReportInput(sheetFromReport(input, OPENED));
          expect(out.iceTypes).toEqual(
            iceTypes.map((c) => ({ type: c.type, ...(c.where ? { where: c.where } : {}) })),
          );
          expect(out.surfaceTags).toEqual(
            surfaceTags.map((c) => ({ type: c.type, ...(c.where ? { where: c.where } : {}) })),
          );
          expect(out.skateQuality).toBe(skateQuality);
          expect(out.iceThickness?.readings ?? []).toEqual(readings);
        },
      ),
    );
  });
});

describe('the access and weather scalars serialize (A10-3)', () => {
  it('putInId and the put-in opt-out travel; a corrected weather block is stamped user', () => {
    const s = run([
      { type: 'setScalar', key: 'putInId', value: 'pi-1' },
      { type: 'setScalar', key: 'showPutIn', value: false },
      { type: 'setScalar', key: 'conditions', value: { airTempC: -4 } },
    ]);
    expect(toReportInput(s)).toMatchObject({
      putInId: 'pi-1',
      showPutIn: false,
      conditions: { airTempC: -4, source: 'user' },
    });
    expect(sectionFilled(s, 'access')).toBe(true);
    expect(sectionSummary(s, 'access', TZ)).toBe('Put-in chosen');
    const shown = run([
      { type: 'setScalar', key: 'showPutIn', value: true },
      { type: 'setScalar', key: 'conditions', value: { windDir: '' } },
    ]);
    expect(toReportInput(shown).showPutIn).toBeUndefined();
    expect(toReportInput(shown).conditions).toBeUndefined();
  });
});
