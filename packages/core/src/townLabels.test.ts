import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { namesakeTells, townKindOf, townLabel, townName } from './townLabels';

describe('town labels (B01-3l)', () => {
  it('the kind is TIGER’s full name past the name — read, never guessed', () => {
    expect(townKindOf('Plattsburgh', 'Plattsburgh city')).toBe('city');
    expect(townKindOf('Plattsburgh', 'Plattsburgh town')).toBe('town');
    expect(townKindOf('Newport', 'Newport  city ')).toBe('city');
    expect(townKindOf('Plattsburgh', undefined)).toBeUndefined();
    expect(townKindOf('Plattsburgh', 'Plattsburgh')).toBeUndefined();
    // A full name that doesn't extend the name says nothing about the kind.
    expect(townKindOf('Plattsburgh', 'City of Plattsburgh')).toBeUndefined();
  });

  it('a kind shows only when carried; every other town reads as before', () => {
    expect(townName({ name: 'Plattsburgh', kind: 'city' })).toBe('Plattsburgh (city)');
    expect(townLabel({ name: 'Plattsburgh', state: 'NY', kind: 'town' })).toBe(
      'Plattsburgh (town), NY',
    );
    expect(townLabel({ name: 'Burlington', state: 'VT' })).toBe('Burlington, VT');
    expect(townLabel({ name: 'Burlington', state: null })).toBe('Burlington');
  });
});

describe('namesakes of one kind are told apart by their county (B01-3m)', () => {
  it('two Clinton towns read with their counties; a namesake of another kind needs only the kind', () => {
    const clintons = [
      { id: 'a', kind: 'town', county: 'Clinton County' },
      { id: 'b', kind: 'town', county: 'Dutchess County' },
    ];
    expect(namesakeTells('a', 'town', clintons)).toEqual({ kind: false, county: true });
    expect(townLabel({ name: 'Clinton', state: 'NY', inCounty: 'Clinton County' })).toBe(
      'Clinton (Clinton County), NY',
    );
    const plattsburghs = [
      { id: 'c', kind: 'city', county: 'Clinton County' },
      { id: 't', kind: 'town', county: 'Clinton County' },
    ];
    expect(namesakeTells('c', 'city', plattsburghs)).toEqual({ kind: true, county: false });
    // A name no other subdivision of the state shares needs nothing.
    expect(namesakeTells('a', 'town', [clintons[0] as never])).toEqual({
      kind: false,
      county: false,
    });
    expect(
      townLabel({ name: 'Plattsburgh', state: 'NY', kind: 'city', inCounty: 'Clinton County' }),
    ).toBe('Plattsburgh (city, Clinton County), NY');
  });

  /**
   * Over generated namesake sets in one state — distinct boundaries, each of one of a few kinds and
   * counties, never two of one kind in one county (TIGER's subdivisions are unique there) — no two
   * read the same label.
   */
  const namesakes = fc.uniqueArray(
    fc.record({
      kind: fc.constantFrom('town', 'city', 'village', ''),
      county: fc.constantFrom('Clinton County', 'Dutchess County', 'Oneida County'),
    }),
    { minLength: 1, maxLength: 8, selector: (n) => `${n.kind}|${n.county}` },
  );
  const property = fc.property(namesakes, (set) => {
    const all = set.map((n, i) => ({ id: String(i), ...n }));
    const labels = all.map((n) => {
      const tells = namesakeTells(n.id, n.kind, all);
      return townLabel({
        name: 'Clinton',
        state: 'NY',
        ...(tells.kind && n.kind !== '' && { kind: n.kind }),
        ...(tells.county && { inCounty: n.county }),
      });
    });
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each([3, 31, 2026])(
    'no two boundaries in one state share a label (pinned seed %i)',
    (seed) => {
      fc.assert(property, { seed, numRuns: 200 });
    },
  );

  it('no two boundaries in one state share a label (a random seed, logged)', () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`town label namesakes: seed ${seed}`);
    fc.assert(property, { seed, numRuns: 200 });
  });
});
