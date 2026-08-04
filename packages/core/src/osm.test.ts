import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  belongsInCorpus,
  HARD_MIN_SURFACE_AREA_SQM,
  isWaterBodyType,
  MIN_SURFACE_AREA_SQM,
  meetsAreaFloor,
  type OsmTags,
  WETLAND_MIN_LONG_AXIS_M,
  waterBodyTypeFromOsmTags,
} from './osm';
import { WATER_BODY_TYPES } from './types';

describe('waterBodyTypeFromOsmTags', () => {
  it('maps the recognized still-water types', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'lake' })).toBe('lake');
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'pond' })).toBe('pond');
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'reservoir' })).toBe('reservoir');
    // A bare `water=*` subtag (no `natural=water`) is still a water area.
    expect(waterBodyTypeFromOsmTags({ water: 'pond' })).toBe('pond');
  });

  it('maps reservoirs and bays tagged without a `water` subtag', () => {
    expect(waterBodyTypeFromOsmTags({ landuse: 'reservoir' })).toBe('reservoir');
    expect(waterBodyTypeFromOsmTags({ natural: 'bay' })).toBe('bay');
  });

  it('maps a marsh but skips other wetlands', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland', wetland: 'marsh' })).toBe('marsh');
    expect(waterBodyTypeFromOsmTags({ wetland: 'marsh' })).toBe('marsh');
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland', wetland: 'swamp' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland', wetland: 'bog' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland' })).toBeNull();
  });

  it('falls back to `other` for a water area of unrecognized/unspecified kind', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'water' })).toBe('other');
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'lagoon' })).toBe('other');
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'oxbow' })).toBe('other');
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'basin' })).toBe('other');
  });

  it('defers rivers and skips flowing/linear water (Phase 1 imports still water only)', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'river' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'stream' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'canal' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ waterway: 'river' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ waterway: 'stream' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ waterway: 'riverbank' })).toBeNull();
    // A `waterway` tag wins over a bare `natural=water` with no subtype — deferred.
    expect(waterBodyTypeFromOsmTags({ natural: 'water', waterway: 'canal' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ natural: 'water', waterway: 'river' })).toBeNull();
  });

  it('keeps an explicit still-water classification alongside a through-waterway tag (P1)', () => {
    // Legacy/relation tagging leaves waterway=* on some reservoir areas — don't drop them.
    expect(waterBodyTypeFromOsmTags({ landuse: 'reservoir', waterway: 'river' })).toBe('reservoir');
    expect(
      waterBodyTypeFromOsmTags({ natural: 'water', water: 'reservoir', waterway: 'river' }),
    ).toBe('reservoir');
    expect(waterBodyTypeFromOsmTags({ natural: 'bay', waterway: 'stream' })).toBe('bay');
  });

  it('returns null for non-water features and empty tags', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'wood' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ building: 'yes' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({ landuse: 'residential' })).toBeNull();
    expect(waterBodyTypeFromOsmTags({})).toBeNull();
  });

  it('returns a valid type or null with the right flowing-water precedence (property)', () => {
    const arbTags: fc.Arbitrary<OsmTags> = fc.record(
      {
        natural: fc.constantFrom('water', 'bay', 'wetland', 'wood', 'scrub'),
        water: fc.constantFrom('lake', 'pond', 'reservoir', 'river', 'stream', 'canal', 'lagoon'),
        waterway: fc.constantFrom('river', 'stream', 'canal', 'riverbank'),
        landuse: fc.constantFrom('reservoir', 'residential', 'basin'),
        wetland: fc.constantFrom('marsh', 'swamp', 'bog'),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(arbTags, (tags) => {
        const result = waterBodyTypeFromOsmTags(tags);
        // Result is always null or a member of our enum.
        expect(result === null || isWaterBodyType(result)).toBe(true);
        // A flowing `water=*` subtag is always deferred, whatever else is present.
        if (['river', 'stream', 'canal'].includes(tags.water ?? '')) {
          expect(result).toBeNull();
        }
        // A bare `waterway` with no positive still-water signal is deferred…
        const stillWaterSignal =
          tags.water !== undefined ||
          tags.natural === 'bay' ||
          tags.landuse === 'reservoir' ||
          tags.wetland === 'marsh';
        if (tags.waterway !== undefined && !stillWaterSignal) {
          expect(result).toBeNull();
        }
        // …but an explicit `landuse=reservoir` wins over a coincident `waterway` (P1).
        if (
          tags.waterway !== undefined &&
          tags.water === undefined &&
          tags.natural !== 'bay' &&
          tags.landuse === 'reservoir'
        ) {
          expect(result).toBe('reservoir');
        }
      }),
    );
  });
});

describe('isWaterBodyType', () => {
  it('accepts every enum member and rejects non-members', () => {
    for (const t of WATER_BODY_TYPES) expect(isWaterBodyType(t)).toBe(true);
    expect(isWaterBodyType('river')).toBe(true);
    expect(isWaterBodyType('ocean')).toBe(false);
    expect(isWaterBodyType('')).toBe(false);
  });
});

/**
 * The corpus-admission floor (D91). It lives here rather than in the ETL that applies it because
 * `waterBodies.pruneBelowAreaFloor` enforces the same rule over rows already stored — these tests
 * pin the shared contract both depend on.
 */
describe('meetsAreaFloor', () => {
  const ACRE = 4046.8564224;

  it('admits anything at or above five acres, named or not', () => {
    expect(meetsAreaFloor({ name: '', surfaceAreaSqM: MIN_SURFACE_AREA_SQM })).toBe(true);
    expect(meetsAreaFloor({ name: '', surfaceAreaSqM: 40 * ACRE })).toBe(true);
    expect(meetsAreaFloor({ name: 'Lake Morey', surfaceAreaSqM: 552 * ACRE })).toBe(true);
  });

  it('refuses an unnamed body below five acres — the backyard pond the floor exists for', () => {
    expect(meetsAreaFloor({ name: '', surfaceAreaSqM: MIN_SURFACE_AREA_SQM - 1 })).toBe(false);
    expect(meetsAreaFloor({ name: '', surfaceAreaSqM: 4 * ACRE })).toBe(false);
    expect(meetsAreaFloor({ name: '', surfaceAreaSqM: 0.2 * ACRE })).toBe(false);
  });

  it('admits a NAMED body down to one acre', () => {
    expect(meetsAreaFloor({ name: 'Keiser Pond', surfaceAreaSqM: HARD_MIN_SURFACE_AREA_SQM })).toBe(
      true,
    );
    expect(meetsAreaFloor({ name: 'Someones Pond', surfaceAreaSqM: 2 * ACRE })).toBe(true);
  });

  it('has NO bathymetry escape hatch — a surveyed but unnamed small lake is dropped', () => {
    // Deliberate, and it knowingly costs 5 bodies (D91). An "or an agency surveyed it" tier was
    // built and removed: agency coverage is *downstream* of this rule, because
    // `waterBodies.matchBathymetryLakes` resolves a surveyed lake against listed bodies in our
    // corpus. A lake this floor excludes can never be matched, so the clause could only protect
    // what an earlier, looser corpus had already found — and is a no-op for any new region.
    expect(meetsAreaFloor({ name: '', surfaceAreaSqM: 4 * ACRE })).toBe(false);
  });

  it('refuses a named body under one acre — a name stops asserting anything down there', () => {
    // 98% of sub-acre bodies are unnamed. Of the 1,586 that are named, one has an agency survey and
    // one has a long axis over 300 m; an acre is 64 m across.
    expect(
      meetsAreaFloor({ name: 'Quarry Pond', surfaceAreaSqM: HARD_MIN_SURFACE_AREA_SQM - 1 }),
    ).toBe(false);
    expect(meetsAreaFloor({ name: 'Named Puddle', surfaceAreaSqM: 0.1 * ACRE })).toBe(false);
  });

  it('is monotonic in area: growing a body never drops it out of the corpus', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100 * ACRE, noNaN: true }),
        fc.double({ min: 0, max: 100 * ACRE, noNaN: true }),
        fc.boolean(),
        (a, b, named) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          const name = named ? 'Some Pond' : '';
          if (meetsAreaFloor({ name, surfaceAreaSqM: small })) {
            expect(meetsAreaFloor({ name, surfaceAreaSqM: large })).toBe(true);
          }
        },
      ),
    );
  });

  it('lets no name cross the hard floor', () => {
    // The name tier only ever *widens* the floor between one and five acres — nothing it accepts is
    // below an acre, which is the whole content of the hard floor.
    fc.assert(
      fc.property(fc.double({ min: 0, max: ACRE, noNaN: true }), fc.boolean(), (area, named) => {
        expect(meetsAreaFloor({ name: named ? 'Anything At All' : '', surfaceAreaSqM: area })).toBe(
          area >= HARD_MIN_SURFACE_AREA_SQM && named,
        );
      }),
    );
  });
});

describe('belongsInCorpus', () => {
  // Expressed against the named thresholds rather than a magic acre constant, so the test still
  // means what it says if D91's numbers ever move.
  const tiny = { name: '', surfaceAreaSqM: HARD_MIN_SURFACE_AREA_SQM / 2 };
  const big = { name: '', surfaceAreaSqM: MIN_SURFACE_AREA_SQM * 8 };

  it('agrees with the floor when nothing was requested', () => {
    expect(belongsInCorpus(tiny)).toBe(false);
    expect(belongsInCorpus(big)).toBe(true);
  });

  it('admits a body a skater asked for, however small', () => {
    // The whole point of N7b: someone long-pressed a pond the floor deleted. Sub-acre is exactly
    // where D91 says nothing survives on any other evidence, which is why the flag has to be
    // independent of size rather than a lower threshold.
    expect(belongsInCorpus({ ...tiny, includedByRequest: true })).toBe(true);
  });

  it('treats an explicit false the same as absent, so the flag can be cleared', () => {
    // Un-requesting is a moderator reversing a decision; it must not become sticky.
    expect(belongsInCorpus({ ...tiny, includedByRequest: false })).toBe(false);
  });

  it('never demotes a body the floor already admits', () => {
    // The flag only ever adds. A big lake nobody requested is still in the corpus.
    expect(belongsInCorpus({ ...big, includedByRequest: false })).toBe(true);
  });

  it('is a membership question, not a size one — the two must not be conflated', () => {
    // meetsAreaFloor asks "is it big enough"; belongsInCorpus asks "does it belong". Four passes
    // were each answering the first when they meant the second, and one of them differently.
    expect(meetsAreaFloor({ ...tiny, name: '' })).toBe(false);
    expect(belongsInCorpus({ ...tiny, includedByRequest: true })).toBe(true);
  });
});

describe('the five admission rules (D91 + D96)', () => {
  const big = MIN_SURFACE_AREA_SQM * 8;
  const mid = MIN_SURFACE_AREA_SQM / 2; // between one and five acres
  const tiny = HARD_MIN_SURFACE_AREA_SQM / 2;
  const LONG = WETLAND_MIN_LONG_AXIS_M + 1;
  const SHORT = WETLAND_MIN_LONG_AXIS_M - 1;

  it('1. refuses everything under an acre', () => {
    for (const type of ['lake', 'marsh'] as const) {
      expect(belongsInCorpus({ type, name: 'Named', surfaceAreaSqM: tiny })).toBe(false);
      expect(belongsInCorpus({ type, name: '', surfaceAreaSqM: tiny, longAxisM: LONG })).toBe(
        false,
      );
    }
    // Even a 2 km channel: a 2 km x 3 m ditch is under an acre, and D91 is absolute here. N7b's
    // includedByRequest is the only way in.
    expect(
      belongsInCorpus({
        type: 'marsh',
        name: '',
        surfaceAreaSqM: tiny,
        longAxisM: LONG,
        includedByRequest: true,
      }),
    ).toBe(true);
  });

  it('2. admits 1-5 acres only when named AND not wetland', () => {
    expect(belongsInCorpus({ type: 'pond', name: 'Keiser Pond', surfaceAreaSqM: mid })).toBe(true);
    expect(belongsInCorpus({ type: 'pond', name: '', surfaceAreaSqM: mid })).toBe(false);
    // The clause that changed: a named 3-acre marsh is out where a named 3-acre pond is in.
    expect(belongsInCorpus({ type: 'marsh', name: 'Little Bog', surfaceAreaSqM: mid })).toBe(false);
    expect(belongsInCorpus({ type: 'marsh', name: '', surfaceAreaSqM: mid, longAxisM: LONG })).toBe(
      false,
    );
  });

  it('3. admits every NAMED body over five acres, wetland included', () => {
    for (const type of ['lake', 'pond', 'reservoir', 'bay', 'other', 'marsh'] as const) {
      expect(belongsInCorpus({ type, name: 'Ninemile Swamp', surfaceAreaSqM: big })).toBe(true);
    }
  });

  it('4. admits unnamed NON-wetland over five acres', () => {
    for (const type of ['lake', 'pond', 'reservoir', 'bay', 'other'] as const) {
      expect(belongsInCorpus({ type, name: '', surfaceAreaSqM: big })).toBe(true);
    }
  });

  it('5. admits unnamed wetland over five acres only past the long-axis bar', () => {
    const marsh = { type: 'marsh' as const, name: '', surfaceAreaSqM: big };
    expect(belongsInCorpus({ ...marsh, longAxisM: LONG })).toBe(true);
    expect(belongsInCorpus({ ...marsh, longAxisM: SHORT })).toBe(false);
    expect(belongsInCorpus({ ...marsh, longAxisM: WETLAND_MIN_LONG_AXIS_M })).toBe(true); // inclusive
  });

  it('5. refuses unnamed wetland whose axis is unknown — an import must not admit the unprovable', () => {
    // The deleter takes the opposite view: pruneBelowAreaFloor keeps a row it cannot evaluate rather
    // than removing it on absence of evidence. Strict predicate, conservative deleter.
    expect(belongsInCorpus({ type: 'marsh', name: '', surfaceAreaSqM: big })).toBe(false);
  });

  it('treats a caller with no type as non-wetland, so existing callers are unaffected', () => {
    // The wetland clauses can only ever narrow, so the permissive default is the safe one.
    expect(belongsInCorpus({ name: '', surfaceAreaSqM: big })).toBe(true);
    expect(belongsInCorpus({ name: 'X', surfaceAreaSqM: mid })).toBe(true);
  });

  it('lets a request override every rule', () => {
    expect(
      belongsInCorpus({ type: 'marsh', name: '', surfaceAreaSqM: mid, includedByRequest: true }),
    ).toBe(true);
  });

  it('leaves meetsAreaFloor answering the size question alone', () => {
    // The two must not be conflated: meetsAreaFloor is "is it big enough", belongsInCorpus is
    // "does it belong". A named 3-acre marsh passes the first and fails the second.
    expect(meetsAreaFloor({ name: 'Little Bog', surfaceAreaSqM: mid })).toBe(true);
    expect(belongsInCorpus({ type: 'marsh', name: 'Little Bog', surfaceAreaSqM: mid })).toBe(false);
  });
});
