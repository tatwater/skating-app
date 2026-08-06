import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  belongsInCorpus,
  HARD_MIN_SURFACE_AREA_SQM,
  isWetlandClass,
  MIN_SURFACE_AREA_SQM,
  meetsAreaFloor,
  UNNAMED_WETLAND_MIN_ACRES,
  UNNAMED_WETLAND_MIN_SQM,
} from './osm';

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

  it('1. refuses everything under an acre', () => {
    for (const type of ['lake', 'marsh'] as const) {
      expect(belongsInCorpus({ type, name: 'Named', surfaceAreaSqM: tiny })).toBe(false);
      expect(belongsInCorpus({ type, name: '', surfaceAreaSqM: tiny })).toBe(false);
    }
    // N7b's includedByRequest is the only way in below an acre.
    expect(
      belongsInCorpus({ type: 'marsh', name: '', surfaceAreaSqM: tiny, includedByRequest: true }),
    ).toBe(true);
  });

  it('2. admits 1-5 acres only when named AND not wetland', () => {
    expect(belongsInCorpus({ type: 'pond', name: 'Keiser Pond', surfaceAreaSqM: mid })).toBe(true);
    expect(belongsInCorpus({ type: 'pond', name: '', surfaceAreaSqM: mid })).toBe(false);
    // A named 3-acre marsh is out where a named 3-acre pond is in.
    expect(belongsInCorpus({ type: 'marsh', name: 'Little Bog', surfaceAreaSqM: mid })).toBe(false);
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

  it('5. holds unnamed wetland to fifty acres, not five', () => {
    // Measured over the whole corpus: 3,659 unnamed wetlands above five acres, of which 415 clear
    // fifty. A 30-acre bar would have kept 733; the founder took the stricter one and N7b as the
    // backstop for anything it cuts wrongly.
    const marsh = { type: 'marsh' as const, name: '' };
    expect(belongsInCorpus({ ...marsh, surfaceAreaSqM: UNNAMED_WETLAND_MIN_SQM })).toBe(true);
    expect(belongsInCorpus({ ...marsh, surfaceAreaSqM: UNNAMED_WETLAND_MIN_SQM - 1 })).toBe(false);
    // …and five acres, which admits every other class, is nowhere near enough for this one.
    expect(belongsInCorpus({ ...marsh, surfaceAreaSqM: MIN_SURFACE_AREA_SQM })).toBe(false);
  });

  it('needs no derived statistic — every rule reads name, area and type alone', () => {
    // This replaced a long-axis exemption, which was the only rule gated on a computed shape stat.
    // That forced lazy stats in the transform AND split the correct behaviour in two: an import must
    // refuse an unprovable body, a prune must keep it. Two readings of one rule is how a silent
    // deletion happens. Area needs no such branch — assert the property, not just the behaviour.
    expect(UNNAMED_WETLAND_MIN_ACRES).toBe(50);
    expect(UNNAMED_WETLAND_MIN_SQM).toBeGreaterThan(MIN_SURFACE_AREA_SQM);
  });

  it('treats a caller with no type as non-wetland, so existing callers are unaffected', () => {
    expect(belongsInCorpus({ name: '', surfaceAreaSqM: big })).toBe(true);
    expect(belongsInCorpus({ name: 'X', surfaceAreaSqM: mid })).toBe(true);
  });

  it('lets a request override every rule', () => {
    expect(
      belongsInCorpus({ type: 'marsh', name: '', surfaceAreaSqM: mid, includedByRequest: true }),
    ).toBe(true);
  });

  it('leaves meetsAreaFloor answering the size question alone', () => {
    expect(meetsAreaFloor({ name: 'Little Bog', surfaceAreaSqM: mid })).toBe(true);
    expect(belongsInCorpus({ type: 'marsh', name: 'Little Bog', surfaceAreaSqM: mid })).toBe(false);
  });
});

describe('belongsInCorpus across the enum rename (N7/D109)', () => {
  const acres = (n: number) => n * 4046.8564224;

  // The rename's one dangerous branch. `type === 'marsh'` against a body carrying `'wetland'` returns
  // false, the gate never fires, and every unnamed bog above five acres is silently admitted.
  it('applies the wetland rules to BOTH spellings', () => {
    for (const type of ['marsh', 'wetland'] as const) {
      expect(belongsInCorpus({ name: '', surfaceAreaSqM: acres(20), type })).toBe(false);
      expect(belongsInCorpus({ name: '', surfaceAreaSqM: acres(60), type })).toBe(true);
      expect(belongsInCorpus({ name: 'Kingdom Bog', surfaceAreaSqM: acres(3), type })).toBe(false);
    }
    expect(isWetlandClass('marsh')).toBe(true);
    expect(isWetlandClass('wetland')).toBe(true);
  });

  // Founder call 2026-08-04: the class carries the safety meaning, the admission bar does not.
  it('gives `river` the ordinary still-water rules', () => {
    expect(belongsInCorpus({ name: '', surfaceAreaSqM: acres(20), type: 'river' })).toBe(true);
    expect(
      belongsInCorpus({ name: 'Nesowadnehunk Deadwater', surfaceAreaSqM: acres(3), type: 'river' }),
    ).toBe(true);
    expect(isWetlandClass('river')).toBe(false);
  });

  it('treats `unclassified` permissively — absence of evidence is not evidence to delete', () => {
    expect(belongsInCorpus({ name: '', surfaceAreaSqM: acres(20), type: 'unclassified' })).toBe(
      true,
    );
    expect(isWetlandClass('unclassified')).toBe(false);
  });

  it('leaves lakePond, reservoir and bay on the non-wetland path', () => {
    for (const type of ['lakePond', 'reservoir', 'bay'] as const) {
      expect(isWetlandClass(type)).toBe(false);
      expect(belongsInCorpus({ name: '', surfaceAreaSqM: acres(20), type })).toBe(true);
    }
  });
});
