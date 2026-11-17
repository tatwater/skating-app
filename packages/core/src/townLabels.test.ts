import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { namesakeKindOf, namesakeTells, townKindOf, townLabel, townName } from './townLabels';

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

describe('mid-load: a namesake whose full name has not loaded yet (B01-3p)', () => {
  it('a namesake’s kind: unknown without a full name, none when the full name gives none', () => {
    expect(namesakeKindOf('Plattsburgh', undefined)).toBeNull();
    expect(namesakeKindOf('Plattsburgh', 'Plattsburgh')).toBe('');
    expect(namesakeKindOf('Plattsburgh', 'Plattsburgh city')).toBe('city');
  });

  it('its kind is unknown, never a kind of its own: the town reads by its name alone', () => {
    // The city has loaded its full name; the town of the same name has not. Before, the town's
    // blank counted as a second kind, so the city read "(city)" while the town read bare.
    const midLoad = [
      { id: 'c', kind: 'city' },
      { id: 't', kind: null },
    ];
    expect(namesakeTells('c', 'city', midLoad)).toEqual({ kind: false, county: false });
    // A full name that gives no kind ('') is known: it still tells.
    expect(
      namesakeTells('c', 'city', [
        { id: 'c', kind: 'city' },
        { id: 't', kind: '' },
      ]),
    ).toEqual({ kind: true, county: false });
  });

  it('any namesake still loading holds every tell back, so no label claims what is not known', () => {
    const three = [
      { id: 'a', kind: 'city' },
      { id: 'b', kind: 'town' },
      { id: 'c', kind: null },
    ];
    for (const own of ['a', 'b']) {
      expect(namesakeTells(own, own === 'a' ? 'city' : 'town', three)).toEqual({
        kind: false,
        county: false,
      });
    }
    // Once it loads, the rule reads as before.
    expect(
      namesakeTells('a', 'city', [
        { id: 'a', kind: 'city' },
        { id: 'b', kind: 'town' },
        { id: 'c', kind: 'city' },
      ]),
    ).toEqual({ kind: true, county: true });
  });

  it('a town whose own full name has not loaded claims no county from a namesake with no kind', () => {
    // Its own kind is unknown (`null` in the list); asked as '' it would match the '' namesake.
    const ownUnknown = [
      { id: 't', kind: null },
      { id: 'u', kind: '' },
      { id: 'c', kind: 'city' },
    ];
    expect(namesakeTells('t', '', ownUnknown)).toEqual({ kind: false, county: false });
  });

  /** Whatever is loaded, a tell shown is one the loaded namesakes prove: never a wrong kind. */
  const loading = fc.array(
    fc.record({
      kind: fc.constantFrom('town', 'city', 'village', '', null),
    }),
    { minLength: 1, maxLength: 8 },
  );
  const sound = fc.property(loading, (set) => {
    const all = set.map((n, i) => ({ id: String(i), ...n }));
    for (const n of all) {
      if (n.kind === null) continue;
      const tells = namesakeTells(n.id, n.kind, all);
      const others = all.filter((o) => o.id !== n.id);
      if (tells.kind || tells.county) expect(all.every((o) => o.kind !== null)).toBe(true);
      if (tells.kind) expect(others.some((o) => o.kind !== n.kind)).toBe(true);
      if (tells.county) expect(others.some((o) => o.kind === n.kind)).toBe(true);
    }
  });

  it.each([5, 77, 2027])('a tell is only ever one the loaded namesakes prove (seed %i)', (seed) => {
    fc.assert(sound, { seed, numRuns: 300 });
  });

  it('a tell is only ever one the loaded namesakes prove (a random seed, logged)', () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`town label mid-load: seed ${seed}`);
    fc.assert(sound, { seed, numRuns: 300 });
  });
});

describe('every namesake loaded: exactly the labels before B01-3p', () => {
  /** The rule as it stood on main before B01-3p, for loaded namesakes. */
  const before = (id: string, kind: string, namesakes: readonly { id: string; kind: string }[]) => {
    const others = namesakes.filter((n) => n.id !== id);
    if (others.length === 0) return { kind: false, county: false };
    const kinds = new Set([kind, ...others.map((n) => n.kind)]);
    return { kind: kinds.size > 1, county: others.some((n) => n.kind === kind) };
  };
  const label = (
    name: string,
    n: { id: string; kind: string; county: string },
    all: readonly { id: string; kind: string; county: string }[],
  ) => {
    const tells = namesakeTells(n.id, n.kind, all);
    return townLabel({
      name,
      state: 'NY',
      ...(tells.kind && n.kind !== '' ? { kind: n.kind } : {}),
      ...(tells.county ? { inCounty: n.county } : {}),
    });
  };

  it('dev’s shapes: same-kind pairs and triples by county; a city beside its town by kind and county', () => {
    const triple = [
      { id: 'a', kind: 'town', county: 'Clinton County' },
      { id: 'b', kind: 'town', county: 'Dutchess County' },
      { id: 'c', kind: 'town', county: 'Oneida County' },
    ];
    expect(triple.map((n) => label('Clinton', n, triple))).toEqual([
      'Clinton (Clinton County), NY',
      'Clinton (Dutchess County), NY',
      'Clinton (Oneida County), NY',
    ]);
    // A city and a town of one name in one county, and a second town of that name elsewhere.
    const geneva = [
      { id: 'city', kind: 'city', county: 'Ontario County' },
      { id: 'town', kind: 'town', county: 'Ontario County' },
      { id: 'other', kind: 'town', county: 'Other County' },
    ];
    expect(geneva.map((n) => label('Geneva', n, geneva))).toEqual([
      'Geneva (city), NY',
      'Geneva (town, Ontario County), NY',
      'Geneva (town, Other County), NY',
    ]);
    const cities = [
      { id: 'c1', kind: 'city', county: 'Ontario County' },
      { id: 'c2', kind: 'city', county: 'Other County' },
      { id: 't', kind: 'town', county: 'Ontario County' },
    ];
    expect(label('Geneva', cities[0] as never, cities)).toBe('Geneva (city, Ontario County), NY');
  });

  const loaded = fc.array(fc.record({ kind: fc.constantFrom('town', 'city', 'village', '') }), {
    minLength: 1,
    maxLength: 8,
  });
  const unchanged = fc.property(loaded, (set) => {
    const all = set.map((n, i) => ({ id: String(i), ...n }));
    for (const n of all)
      expect(namesakeTells(n.id, n.kind, all)).toEqual(before(n.id, n.kind, all));
  });
  it.each([13, 4242])(
    'the rule is unchanged where every full name has loaded (seed %i)',
    (seed) => {
      fc.assert(unchanged, { seed, numRuns: 300 });
    },
  );
  it('the rule is unchanged where every full name has loaded (a random seed, logged)', () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`town label unchanged: seed ${seed}`);
    fc.assert(unchanged, { seed, numRuns: 300 });
  });
});
