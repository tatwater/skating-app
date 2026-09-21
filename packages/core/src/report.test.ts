import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isValidThicknessReading,
  locatedSubAreaIds,
  minimumSetGaps,
  type ReportInput,
  SKATE_TIME_FUTURE_TOLERANCE_MS,
  sightingAllowedFrom,
  type ThicknessReadingInput,
  validateReportInput,
} from './report';

const NOW = 1_700_000_000_000;
const CTX = { now: NOW };

/** A minimal valid report; override fields per test. */
function base(overrides: Partial<ReportInput> = {}): ReportInput {
  return { waterBodyId: 'wb1', skateEndTime: NOW - 1000, ...overrides };
}

/** Assert failure and return the set of error fields. */
function fieldsOf(input: ReportInput, ctx = CTX): string[] {
  const result = validateReportInput(input, ctx);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure');
  return result.errors.map((e) => e.field);
}

describe('validateReportInput — valid reports', () => {
  it('accepts a minimal notes-only observation (D3) and defaults the arrays', () => {
    const result = validateReportInput(base({ notes: '  do not skate — open leads  ' }), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.iceTypes).toEqual([]);
    expect(result.normalized.surfaceTags).toEqual([]);
    expect(result.normalized.iceThickness).toBeUndefined();
    expect(result.normalized.notes).toBe('do not skate — open leads');
    expect(result.normalized.skateQuality).toBeUndefined();
    expect(result.normalized.conditions).toBeUndefined();
    expect(result.normalized.point).toBeUndefined();
    expect(result.normalized.snow).toBeUndefined();
    expect(result.normalized.skateStartTime).toBeUndefined();
    expect(result.normalized.observedFrom).toBeUndefined();
    expect(result.normalized.suitability).toBeUndefined();
  });

  it('accepts and preserves an optional start time before the end (Phase 05)', () => {
    const result = validateReportInput(base({ skateStartTime: NOW - 60 * 60 * 1000 }), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.skateStartTime).toBe(NOW - 60 * 60 * 1000);
    expect(result.normalized.skateEndTime).toBe(NOW - 1000);
  });

  it('accepts a start equal to the end (zero-length window)', () => {
    const end = NOW - 1000;
    const result = validateReportInput(base({ skateEndTime: end, skateStartTime: end }), CTX);
    expect(result.ok).toBe(true);
  });

  it('normalizes a full report (readings, conditions, point, trimming)', () => {
    const result = validateReportInput(
      base({
        iceTypes: ['black_ice'],
        surfaceTags: ['glass', 'orange_peel'],
        skateQuality: 'good',
        iceThickness: {
          readings: [
            { valueCm: 10, method: 'measured' },
            {
              minCm: 5,
              maxCm: 8,
              method: 'estimated',
              coord: { lat: 44, lng: -73 },
              note: ' NE bay ',
            },
          ],
        },
        snowCoverCm: 0,
        conditions: {
          airTempC: -5,
          windSpeedKph: 12,
          windDir: '  NW  ',
          sky: 'clear',
          precip: 'none',
          source: 'user',
        },
        point: { lat: 44.2, lng: -72.5 },
      }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const n = result.normalized;
    expect(n.iceThickness?.readings).toEqual([
      { method: 'measured', valueCm: 10 },
      { method: 'estimated', minCm: 5, maxCm: 8, coord: { lat: 44, lng: -73 }, note: 'NE bay' },
    ]);
    expect(n.conditions).toEqual({
      source: 'user',
      airTempC: -5,
      windSpeedKph: 12,
      windDir: 'NW',
      sky: 'clear',
      precip: 'none',
    });
    expect(n.point).toEqual({ lat: 44.2, lng: -72.5 });
    // The pre-A10 number lands as the D194 depth, and the bare chips are lifted to located objects.
    expect(n.snow).toEqual({ depthCm: 0 });
    expect(n.iceTypes).toEqual([{ type: 'black_ice' }]);
    expect(n.surfaceTags).toEqual([{ type: 'glass' }, { type: 'orange_peel' }]);
  });

  it('defaults conditions.source to user (manual entry, D19) and drops absent fields', () => {
    const result = validateReportInput(base({ conditions: { airTempC: -2 } }), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.conditions).toEqual({ source: 'user', airTempC: -2 });
  });

  it('allows a skate time within the clock-skew tolerance', () => {
    const soon = base({ skateEndTime: NOW + SKATE_TIME_FUTURE_TOLERANCE_MS - 1 });
    expect(validateReportInput(soon, CTX).ok).toBe(true);
  });

  it('drops an empty thickness section', () => {
    const result = validateReportInput(base({ iceThickness: { readings: [] } }), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.iceThickness).toBeUndefined();
  });

  it('drops whitespace-only notes', () => {
    const result = validateReportInput(base({ notes: '   ' }), CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.notes).toBeUndefined();
  });
});

describe('validateReportInput — required fields', () => {
  it('rejects a missing or whitespace water body', () => {
    expect(fieldsOf(base({ waterBodyId: '' }))).toContain('waterBodyId');
    expect(fieldsOf(base({ waterBodyId: '   ' }))).toContain('waterBodyId');
  });

  it('rejects a missing / non-positive skate-end time', () => {
    expect(fieldsOf(base({ skateEndTime: Number.NaN }))).toContain('skateEndTime');
    expect(fieldsOf(base({ skateEndTime: 0 }))).toContain('skateEndTime');
    expect(fieldsOf(base({ skateEndTime: -5 }))).toContain('skateEndTime');
  });

  it('rejects an implausibly-future skate-end time', () => {
    const future = base({ skateEndTime: NOW + SKATE_TIME_FUTURE_TOLERANCE_MS + 60_000 });
    const result = validateReportInput(future, CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      field: 'skateEndTime',
      message: 'cannot be in the future',
    });
  });

  it('rejects a start after the end, and a non-positive start (Phase 05)', () => {
    const end = NOW - 1000;
    expect(fieldsOf(base({ skateEndTime: end, skateStartTime: end + 1000 }))).toContain(
      'skateStartTime',
    );
    expect(fieldsOf(base({ skateStartTime: 0 }))).toContain('skateStartTime');
    expect(fieldsOf(base({ skateStartTime: Number.NaN }))).toContain('skateStartTime');
  });
});

describe('validateReportInput — enum membership', () => {
  it('rejects unknown ice types / surface tags / quality', () => {
    expect(fieldsOf(base({ iceTypes: ['lava' as never] }))).toContain('iceTypes[0]');
    expect(fieldsOf(base({ surfaceTags: ['sticky' as never] }))).toContain('surfaceTags[0]');
    expect(fieldsOf(base({ skateQuality: 'amazing' as never }))).toContain('skateQuality');
  });
});

describe('validateReportInput — thickness readings (D22)', () => {
  it('rejects a non-array readings list', () => {
    const bad = base({ iceThickness: { readings: 'nope' as unknown as ThicknessReadingInput[] } });
    expect(fieldsOf(bad)).toContain('iceThickness.readings');
  });

  it('rejects an unknown method', () => {
    const bad = base({ iceThickness: { readings: [{ valueCm: 5, method: 'guessed' as never }] } });
    expect(fieldsOf(bad)).toContain('iceThickness.readings[0].method');
  });

  it('rejects both a value and a range', () => {
    const bad = base({
      iceThickness: { readings: [{ valueCm: 5, minCm: 1, maxCm: 9, method: 'measured' }] },
    });
    expect(fieldsOf(bad)).toContain('iceThickness.readings[0]');
  });

  it('rejects a negative / non-finite single value', () => {
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ valueCm: -1, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0].valueCm');
    expect(
      fieldsOf(
        base({
          iceThickness: { readings: [{ valueCm: Number.POSITIVE_INFINITY, method: 'measured' }] },
        }),
      ),
    ).toContain('iceThickness.readings[0].valueCm');
  });

  it('rejects a max-only range, a negative range, and an inverted range', () => {
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ maxCm: 3, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0]');
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ minCm: -1, maxCm: 5, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0]');
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ minCm: 9, maxCm: 4, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0]');
  });

  it('rejects a reading with neither a value nor a range', () => {
    expect(fieldsOf(base({ iceThickness: { readings: [{ method: 'measured' }] } }))).toContain(
      'iceThickness.readings[0]',
    );
  });

  it('rejects an invalid reading coord', () => {
    const bad = base({
      iceThickness: { readings: [{ valueCm: 5, method: 'measured', coord: { lat: 200, lng: 0 } }] },
    });
    expect(fieldsOf(bad)).toContain('iceThickness.readings[0].coord');
  });

  it('value XOR range determines validity (property)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (hasValue, hasRange, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const reading: ThicknessReadingInput = { method: 'measured' };
          if (hasValue) reading.valueCm = a;
          if (hasRange) {
            reading.minCm = lo;
            reading.maxCm = hi;
          }
          const result = validateReportInput(base({ iceThickness: { readings: [reading] } }), CTX);
          // Valid iff exactly one of {single value, min/max range} is present (a non-poke method).
          expect(result.ok).toBe(hasValue !== hasRange);
        },
      ),
    );
  });
});

describe('validateReportInput — A10 thickness (D195)', () => {
  it('accepts a lower bound: minCm without maxCm', () => {
    const result = validateReportInput(
      base({ iceThickness: { readings: [{ minCm: 10, method: 'estimated' }] } }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.iceThickness?.readings).toEqual([{ method: 'estimated', minCm: 10 }]);
  });

  it('a poke reading needs a whole-number count and may carry no cm at all', () => {
    const ok = validateReportInput(
      base({ iceThickness: { readings: [{ method: 'poke', pokeCount: 5 }] } }),
      CTX,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(ok.normalized.iceThickness?.readings).toEqual([{ method: 'poke', pokeCount: 5 }]);

    const withEstimate = validateReportInput(
      base({ iceThickness: { readings: [{ method: 'poke', pokeCount: 3, minCm: 7, maxCm: 10 }] } }),
      CTX,
    );
    expect(withEstimate.ok).toBe(true);

    expect(fieldsOf(base({ iceThickness: { readings: [{ method: 'poke' }] } }))).toContain(
      'iceThickness.readings[0].pokeCount',
    );
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ method: 'poke', pokeCount: 2.5 }] } })),
    ).toContain('iceThickness.readings[0].pokeCount');
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ method: 'poke', pokeCount: -1 }] } })),
    ).toContain('iceThickness.readings[0].pokeCount');
  });

  it('only a poke reading carries a count', () => {
    expect(
      fieldsOf(
        base({ iceThickness: { readings: [{ method: 'measured', valueCm: 5, pokeCount: 3 }] } }),
      ),
    ).toContain('iceThickness.readings[0].pokeCount');
  });

  it('keeps supportable as the skater said it and rejects a non-boolean', () => {
    const result = validateReportInput(
      base({
        iceThickness: { readings: [{ method: 'measured', valueCm: 5, supportable: false }] },
      }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized.iceThickness?.readings[0]?.supportable).toBe(false);
    expect(
      fieldsOf(
        base({
          iceThickness: {
            readings: [{ method: 'measured', valueCm: 5, supportable: 'yes' as never }],
          },
        }),
      ),
    ).toContain('iceThickness.readings[0].supportable');
  });

  it('validates a where on a reading, and the thickness scope', () => {
    const result = validateReportInput(
      base({
        iceThickness: {
          scope: 'at_spot',
          readings: [{ method: 'measured', valueCm: 5, where: { sector: 'N' } }],
        },
      }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.iceThickness?.scope).toBe('at_spot');
      expect(result.normalized.iceThickness?.readings[0]?.where).toEqual({ sector: 'N' });
    }
    expect(
      fieldsOf(
        base({
          iceThickness: {
            readings: [{ method: 'measured', valueCm: 5, where: { sector: 'up' as never } }],
          },
        }),
      ),
    ).toContain('iceThickness.readings[0].where.sector');
    expect(
      fieldsOf(
        base({
          iceThickness: {
            scope: 'somewhere' as never,
            readings: [{ method: 'measured', valueCm: 5 }],
          },
        }),
      ),
    ).toContain('iceThickness.scope');
  });
});

describe('validateReportInput — located chips (D193)', () => {
  it('accepts both shapes and normalizes to located objects, trimming the note', () => {
    const result = validateReportInput(
      base({
        iceTypes: [
          'black_ice',
          { type: 'shell_ice', where: { sector: 'NE' }, note: ' near the inlet ' },
        ],
        surfaceTags: [{ type: 'glass', where: { extent: 'mostly' } }],
      }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.iceTypes).toEqual([
      { type: 'black_ice' },
      { type: 'shell_ice', where: { sector: 'NE' }, note: 'near the inlet' },
    ]);
    expect(result.normalized.surfaceTags).toEqual([{ type: 'glass', where: { extent: 'mostly' } }]);
  });

  it('rejects an unknown type inside a located chip, and a bad where', () => {
    expect(fieldsOf(base({ iceTypes: [{ type: 'lava' as never }] }))).toContain('iceTypes[0]');
    expect(fieldsOf(base({ surfaceTags: [{ type: 'glass', where: {} }] }))).toContain(
      'surfaceTags[0].where',
    );
    expect(
      fieldsOf(base({ iceTypes: [{ type: 'black_ice', where: { sector: 'head' } }] })),
    ).toContain('iceTypes[0].where.sector');
  });
});

describe('validateReportInput — How was it? and provenance (D190, D191)', () => {
  it('accepts suitability and observedFrom, rejects unknown values', () => {
    const result = validateReportInput(
      base({ suitability: 'dont_go', observedFrom: 'shore', skateEndPrecision: 'half_hour' }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.suitability).toBe('dont_go');
      expect(result.normalized.observedFrom).toBe('shore');
      expect(result.normalized.skateEndPrecision).toBe('half_hour');
    }
    expect(fieldsOf(base({ suitability: 'safe' as never }))).toContain('suitability');
    expect(fieldsOf(base({ observedFrom: 'drone' as never }))).toContain('observedFrom');
    expect(fieldsOf(base({ skateEndPrecision: 'afternoon' as never }))).toContain(
      'skateEndPrecision',
    );
  });

  it('a sighting is only for a report from shore or secondhand', () => {
    const shore = validateReportInput(base({ observedFrom: 'shore', sighting: 'open' }), CTX);
    expect(shore.ok).toBe(true);
    if (shore.ok) expect(shore.normalized.sighting).toBe('open');
    const relayed = validateReportInput(
      base({ observedFrom: 'secondhand', sighting: 'skim' }),
      CTX,
    );
    expect(relayed.ok).toBe(true);
    expect(fieldsOf(base({ sighting: 'frozen' }))).toContain('sighting');
    expect(fieldsOf(base({ observedFrom: 'on_ice', sighting: 'frozen' }))).toContain('sighting');
    expect(fieldsOf(base({ observedFrom: 'shore', sighting: 'melted' as never }))).toContain(
      'sighting',
    );
  });
});

describe('validateReportInput — snow (D194)', () => {
  it('rejects negative snow cover', () => {
    expect(fieldsOf(base({ snowCoverCm: -1 }))).toContain('snowCoverCm');
  });

  it('accepts the facets and drops an empty object', () => {
    const result = validateReportInput(
      base({
        snow: {
          coverage: 'lanes',
          impediment: 'didnt_matter',
          drifts: 'avoidable',
          plowedPath: true,
        },
      }),
      CTX,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.snow).toEqual({
        coverage: 'lanes',
        impediment: 'didnt_matter',
        drifts: 'avoidable',
        plowedPath: true,
      });
    }
    const empty = validateReportInput(base({ snow: {} }), CTX);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.normalized.snow).toBeUndefined();
  });

  it('rejects unknown facet values, a bad depth, and a non-boolean plowedPath', () => {
    expect(fieldsOf(base({ snow: { coverage: 'some' as never } }))).toContain('snow.coverage');
    expect(fieldsOf(base({ snow: { impediment: 'ruined' as never } }))).toContain(
      'snow.impediment',
    );
    expect(fieldsOf(base({ snow: { drifts: 'huge' as never } }))).toContain('snow.drifts');
    expect(fieldsOf(base({ snow: { depthCm: -2 } }))).toContain('snow.depthCm');
    expect(fieldsOf(base({ snow: { plowedPath: 'yes' as never } }))).toContain('snow.plowedPath');
  });

  it('the old number and the new depth must agree when both arrive; the object wins otherwise', () => {
    const agree = validateReportInput(base({ snow: { depthCm: 4 }, snowCoverCm: 4 }), CTX);
    expect(agree.ok).toBe(true);
    if (agree.ok) expect(agree.normalized.snow).toEqual({ depthCm: 4 });
    expect(fieldsOf(base({ snow: { depthCm: 4 }, snowCoverCm: 5 }))).toContain('snowCoverCm');
    const facetsPlusNumber = validateReportInput(
      base({ snow: { coverage: 'patches' }, snowCoverCm: 2 }),
      CTX,
    );
    expect(facetsPlusNumber.ok).toBe(true);
    if (facetsPlusNumber.ok) {
      expect(facetsPlusNumber.normalized.snow).toEqual({ coverage: 'patches', depthCm: 2 });
    }
  });
});

describe('validateReportInput — snow + conditions', () => {
  it('rejects bad condition fields', () => {
    expect(fieldsOf(base({ conditions: { airTempC: Number.NaN } }))).toContain(
      'conditions.airTempC',
    );
    expect(fieldsOf(base({ conditions: { windSpeedKph: -3 } }))).toContain(
      'conditions.windSpeedKph',
    );
    expect(fieldsOf(base({ conditions: { sky: 'foggy' as never } }))).toContain('conditions.sky');
    expect(fieldsOf(base({ conditions: { precip: 'hail' as never } }))).toContain(
      'conditions.precip',
    );
    expect(fieldsOf(base({ conditions: { source: 'noaa' as never } }))).toContain(
      'conditions.source',
    );
  });
});

describe('validateReportInput — put-in pin coordinate bounds', () => {
  const invalid = [
    { lat: Number.NaN, lng: 0 },
    { lat: 0, lng: Number.NaN },
    { lat: -91, lng: 0 },
    { lat: 91, lng: 0 },
    { lat: 0, lng: -181 },
    { lat: 0, lng: 181 },
  ];
  it.each(invalid)('rejects out-of-range coord %o', (point) => {
    expect(fieldsOf(base({ point }))).toContain('point');
  });
});

describe('validateReportInput — error collection', () => {
  it('reports every problem at once, not just the first', () => {
    const result = validateReportInput(
      base({ waterBodyId: '', skateQuality: 'amazing' as never, snowCoverCm: -1 }),
      CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('minimumSetGaps (D189)', () => {
  const full = {
    waterBodyId: 'wb1',
    skateEndTime: NOW,
    skateQuality: 'good' as const,
    iceTypes: [{ type: 'black_ice' as const }],
    surfaceTags: [],
  };

  it('is empty for a complete report, whichever term satisfies each slot', () => {
    expect(minimumSetGaps(full, 0)).toEqual([]);
    expect(
      minimumSetGaps({ ...full, skateQuality: undefined, suitability: 'dont_go', iceTypes: [] }, 1),
    ).toEqual([]);
    expect(
      minimumSetGaps(
        { ...full, iceTypes: [], iceThickness: { readings: [{ method: 'poke', pokeCount: 4 }] } },
        0,
      ),
    ).toEqual([]);
    expect(minimumSetGaps({ ...full, iceTypes: [], surfaceTags: [{ type: 'glass' }] }, 0)).toEqual(
      [],
    );
    expect(minimumSetGaps({ ...full, iceTypes: [], sighting: 'open' }, 0)).toEqual([]);
  });

  it('names every missing term, in sheet order', () => {
    expect(
      minimumSetGaps({ waterBodyId: '', skateEndTime: 0, iceTypes: [], surfaceTags: [] }, 0),
    ).toEqual(['body', 'endTime', 'howWasIt', 'observation']);
    expect(minimumSetGaps({ ...full, iceTypes: [] }, 0)).toEqual(['observation']);
    expect(minimumSetGaps({ ...full, skateQuality: undefined }, 0)).toEqual(['howWasIt']);
  });

  it('prose alone never posts', () => {
    expect(minimumSetGaps({ ...full, skateQuality: undefined, iceTypes: [] }, 0)).toEqual([
      'howWasIt',
      'observation',
    ]);
  });
});

describe('isValidThicknessReading — the one rule, for a caller that builds readings', () => {
  it('agrees with validateReportInput on every shape the mappers can produce', () => {
    const cases: [ThicknessReadingInput, boolean][] = [
      [{ method: 'measured', valueCm: 10 }, true],
      [{ method: 'estimated', minCm: 5 }, true],
      [{ method: 'estimated', minCm: 0, maxCm: 5 }, true],
      [{ method: 'poke', pokeCount: 5 }, true],
      [{ method: 'poke', pokeCount: 5, minCm: 7, supportable: true }, true],
      [{ method: 'poke', minCm: 7 }, false], // a poke with no count
      [{ method: 'estimated' }, false], // an estimate with no number
      [{ method: 'measured', maxCm: 5 }, false], // an upper bound alone hides the zero
      [{ method: 'measured', valueCm: 10, minCm: 5 }, false],
      [{ method: 'measured', valueCm: 10, pokeCount: 2 }, false],
      [{ method: 'guessed' as 'measured', valueCm: 10 }, false],
    ];
    for (const [reading, valid] of cases) {
      expect(isValidThicknessReading(reading), JSON.stringify(reading)).toBe(valid);
      const whole = validateReportInput(base({ iceThickness: { readings: [reading] } }), CTX);
      expect(whole.ok, JSON.stringify(reading)).toBe(valid);
    }
  });
});

describe('sightingAllowedFrom (D189)', () => {
  it('is the validator’s rule: shore or secondhand only, never unstated', () => {
    expect(sightingAllowedFrom('shore')).toBe(true);
    expect(sightingAllowedFrom('secondhand')).toBe(true);
    expect(sightingAllowedFrom('on_ice')).toBe(false);
    expect(sightingAllowedFrom(undefined)).toBe(false);
  });
});

describe('locatedSubAreaIds', () => {
  it('collects every bay a chip or reading names, once each, in order of first mention', () => {
    expect(
      locatedSubAreaIds({
        iceTypes: [
          { type: 'black_ice', where: { subAreaId: 'bay1', sector: 'N' } },
          { type: 'shell_ice' },
        ],
        surfaceTags: [{ type: 'glass', where: { subAreaId: 'bay2' } }],
        iceThickness: {
          readings: [
            { method: 'measured', valueCm: 10, where: { subAreaId: 'bay1' } },
            { method: 'estimated', minCm: 5, where: { extent: 'patches' } },
          ],
        },
      }),
    ).toEqual(['bay1', 'bay2']);
    expect(locatedSubAreaIds({ iceTypes: [], surfaceTags: [] })).toEqual([]);
  });
});
