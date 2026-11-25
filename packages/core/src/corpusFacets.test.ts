import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLAIM_SOURCES } from './confidence';
import { facetOf, otherNameOf, splitOfNames } from './corpusFacets';
import { CORPUS_TASK_FACETS, CORPUS_TASK_LANES } from './corpusTasks';
import { WATER_BODY_CLASSES } from './types';

describe('splitOfNames — the board’s own rows', () => {
  it.each([
    ['East Grand Lake', 'Grand Lake', 'qualifier'],
    ['Little Lake Sunapee', 'Lake Sunapee', 'qualifier'],
    ['The Basin', 'Lake Auburn', 'different'],
    ['Stinson Lake', 'Stinson Pond', 'different'],
    ['Lake Elmore', 'Elmore Pond', 'different'],
    ['Mollys Falls Pond', 'Mollys Falls Reservoir', 'different'],
    ['Little Elligo Pond', 'Little Eligo Pond', 'oneLetter'],
    ['Thurman W. Dix Reservoir', 'Therman W. Dix Reservoir', 'oneLetter'],
    ['Lake Runnemede', 'Lake Runnenede', 'oneLetter'],
    ['Tuttle Pond', 'Turtle Pond', 'oneLetter'],
    ['Bear Pond', 'Bean Pond', 'oneLetter'],
  ] as const)('%s / %s is %s', (shown, other, split) => {
    expect(splitOfNames(shown, other)).toBe(split);
    expect(splitOfNames(other, shown)).toBe(split);
  });

  it('is two edits apart, not one, for a transposition', () => {
    expect(splitOfNames('Lake Ab', 'Lake Ba')).toBe('different');
  });

  it('folds case and accents before it compares', () => {
    expect(splitOfNames('LAC ÉCHO', 'Lac Echos')).toBe('oneLetter');
    expect(splitOfNames('Upper Lac Écho', 'lac echo')).toBe('qualifier');
  });
});

describe('otherNameOf', () => {
  it('is the most authoritative catalog name a reader would see as different', () => {
    expect(
      otherNameOf({
        name: 'The Basin',
        nameClaims: [
          { source: 'osm', value: 'Lake Auburn' },
          { source: 'nhd', value: 'The Basin' },
          { source: '3dhp', value: 'Auburn Lake' },
        ],
      }),
    ).toBe('Auburn Lake');
  });

  it('skips a moderator’s claim, a spelling of the shown name, and blanks', () => {
    expect(
      otherNameOf({
        name: 'Harveys Lake',
        nameClaims: [
          { source: 'user', value: 'Mine' },
          { source: 'gnis', value: "Harvey's Lake" },
          { source: 'nhd', value: '  ' },
        ],
      }),
    ).toBeNull();
    expect(otherNameOf({ name: 'Mud Pond' })).toBeNull();
  });

  it('keeps stored order on a rank tie, and ranks an unknown source last', () => {
    expect(
      otherNameOf({
        name: 'A Pond',
        nameClaims: [
          { source: 'mystery', value: 'C Pond' },
          { source: 'osm', value: 'B Lake' },
          { source: 'osm', value: 'D Lake' },
        ],
      }),
    ).toBe('B Lake');
  });
});

describe('facetOf — Name conflicts', () => {
  it('splits the shown name against the other catalog name', () => {
    const record = (other: string) => ({
      name: 'Grand Lake',
      type: 'lakePond' as const,
      nameClaims: [
        { source: 'gnis', value: 'Grand Lake' },
        { source: 'osm', value: other },
      ],
    });
    expect(facetOf('nameConflicts', record('East Grand Lake'))).toBe('qualifier');
    expect(facetOf('nameConflicts', record('Grand Lakes Pond'))).toBe('different');
    expect(facetOf('nameConflicts', record('Grant Lake'))).toBe('oneLetter');
  });

  it('is Different when no catalog name differs (claims not stored)', () => {
    expect(facetOf('nameConflicts', { name: 'Mud Pond', type: 'lakePond' })).toBe('different');
  });
});

describe('facetOf — Class conflicts', () => {
  const record = (...claims: [string, (typeof WATER_BODY_CLASSES)[number]][]) => ({
    name: 'Bog Pond',
    type: 'lakePond' as const,
    classClaims: claims.map(([source, value]) => ({ source, value })),
  });

  it('is Wetland or lake when a wetland meets open water', () => {
    expect(facetOf('classConflicts', record(['nhd', 'wetland'], ['osm', 'lakePond']))).toBe(
      'wetlandOrLake',
    );
    expect(facetOf('classConflicts', record(['nhd', 'wetland'], ['osm', 'reservoir']))).toBe(
      'wetlandOrLake',
    );
  });

  it('is Other pairs for the rest', () => {
    expect(facetOf('classConflicts', record(['nhd', 'wetland'], ['osm', 'river']))).toBe(
      'otherPairs',
    );
    expect(facetOf('classConflicts', record(['nhd', 'lakePond'], ['osm', 'bay']))).toBe(
      'otherPairs',
    );
    expect(facetOf('classConflicts', record(['nhd', 'lakePond']))).toBe('otherPairs');
  });

  it('is not recorded with no class claim stored, and ignores a user claim', () => {
    expect(facetOf('classConflicts', { name: 'X', type: 'wetland' })).toBe('notRecorded');
    expect(facetOf('classConflicts', record())).toBe('notRecorded');
    expect(facetOf('classConflicts', record(['user', 'wetland']))).toBe('notRecorded');
  });
});

describe('facetOf — properties', () => {
  const claim = fc.record({
    source: fc.constantFrom(...CLAIM_SOURCES),
    value: fc.constantFrom('Grand Lake', 'East Grand Lake', 'Grant Lake', 'Mud Pond', ''),
  });
  const classClaim = fc.record({
    source: fc.constantFrom(...CLAIM_SOURCES),
    value: fc.constantFrom(...WATER_BODY_CLASSES),
  });

  it('is always one of the lane’s own facets, never All', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CORPUS_TASK_LANES),
        fc.string({ maxLength: 30 }),
        fc.constantFrom(...WATER_BODY_CLASSES),
        fc.option(fc.array(claim, { maxLength: 5 }), { nil: undefined }),
        fc.option(fc.array(classClaim, { maxLength: 5 }), { nil: undefined }),
        (lane, name, type, nameClaims, classClaims) => {
          const facet = facetOf(lane, {
            name,
            type,
            ...(nameClaims ? { nameClaims } : {}),
            ...(classClaims ? { classClaims } : {}),
          });
          expect(CORPUS_TASK_FACETS[lane] as readonly string[]).toContain(facet);
          expect(facet).not.toBe('all');
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('splitOfNames is symmetric', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        expect(splitOfNames(a, b)).toBe(splitOfNames(b, a));
      }),
      { numRuns: 2_000 },
    );
  });
});
