import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { BodyRow } from './bodiesModel';
import {
  appliedCount,
  appliedOptions,
  type BodyFacts,
  chipWords,
  FACET_IDS,
  FACETS,
  type FacetSelection,
  facetById,
  matchesSelection,
  optionsOf,
  toggleOption,
} from './bodyFacets';

const ACRE = 4046.8564224;

const row = (over: Partial<BodyRow> = {}): BodyRow => ({
  id: 'x',
  name: 'Post Pond',
  bodyClass: 'lakePond',
  states: ['NH'],
  areaSqM: 127 * ACRE,
  complete: { have: 9, of: 10, missing: ['bathymetry'], unknown: [] },
  asks: 1,
  reports: 1,
  changedAt: null,
  standing: 'active',
  ...over,
});
const facts = (over: Partial<BodyFacts> = {}): BodyFacts => ({
  outline: 'catalog',
  putIns: 2,
  curated: false,
  intake: false,
  awaitingEnrichment: false,
  ...over,
});
const UNKNOWN: BodyFacts = {
  outline: null,
  putIns: null,
  curated: null,
  intake: null,
  awaitingEnrichment: null,
};

describe('the facets', () => {
  it('cover every facet id once, each with unique options', () => {
    expect(FACETS.map((f) => f.id)).toEqual([...FACET_IDS]);
    for (const f of FACETS) {
      expect(new Set(f.options.map((o) => o.id)).size).toBe(f.options.length);
      expect(facetById(f.id)).toBe(f);
    }
  });
  it('put the unit on a chip where the menu’s words leave it off', () => {
    const size = facetById('size');
    const big = size.options.find((o) => o.id === '1000-up');
    expect(big && chipWords(big)).toBe('1,000 ac and up');
    const under = size.options.find((o) => o.id === 'under-10');
    expect(under && chipWords(under)).toBe('Under 10 ac');
  });
});

describe('choosing', () => {
  it('toggles an option, keeps the facet’s order, and drops an emptied facet', () => {
    let s: FacetSelection = {};
    s = toggleOption(s, 'size', '1000-up');
    s = toggleOption(s, 'size', 'under-10');
    expect(s.size).toEqual(['under-10', '1000-up']);
    s = toggleOption(s, 'class', 'bay');
    expect(appliedCount(s)).toBe(3);
    expect(appliedOptions(s).map((a) => `${a.facet.id}:${a.option.id}`)).toEqual([
      'class:bay',
      'size:under-10',
      'size:1000-up',
    ]);
    s = toggleOption(toggleOption(s, 'size', 'under-10'), 'size', '1000-up');
    expect(s).toEqual({ class: ['bay'] });
  });
  it('ignores option ids it doesn’t know when counting', () => {
    expect(appliedCount({ size: ['huge'] })).toBe(0);
  });
});

describe('which options a body falls under', () => {
  it('reads each fact, and an unrecorded one answers nothing', () => {
    expect(optionsOf(row(), facts(), 'size')).toEqual(['100-1000']);
    expect(optionsOf(row({ areaSqM: 5 * ACRE }), facts(), 'size')).toEqual(['under-10']);
    expect(optionsOf(row({ areaSqM: 50 * ACRE }), facts(), 'size')).toEqual(['10-100']);
    expect(optionsOf(row({ areaSqM: 5000 * ACRE }), facts(), 'size')).toEqual(['1000-up']);
    expect(optionsOf(row({ areaSqM: null }), facts(), 'size')).toBeNull();
    expect(optionsOf(row(), facts({ putIns: 0 }), 'putins')).toEqual(['none']);
    expect(optionsOf(row(), facts(), 'putins')).toEqual(['some']);
    expect(optionsOf(row(), UNKNOWN, 'putins')).toBeNull();
    expect(optionsOf(row(), UNKNOWN, 'outline')).toBeNull();
    expect(optionsOf(row(), facts({ outline: 'drawn' }), 'outline')).toEqual(['drawn']);
    expect(optionsOf(row({ reports: 0 }), facts(), 'reports')).toEqual([]);
    expect(optionsOf(row({ reports: null }), facts(), 'reports')).toBeNull();
    expect(optionsOf(row(), facts(), 'complete')).toEqual(['most']);
    expect(
      optionsOf(
        row({ complete: { have: 10, of: 10, missing: [], unknown: [] } }),
        facts(),
        'complete',
      ),
    ).toEqual(['all']);
    expect(
      optionsOf(
        row({ complete: { have: 3, of: 10, missing: [], unknown: [] } }),
        facts(),
        'complete',
      ),
    ).toEqual(['under-8']);
    expect(optionsOf(row({ complete: null }), facts(), 'complete')).toBeNull();
    expect(
      optionsOf(
        row(),
        facts({ curated: true, intake: true, awaitingEnrichment: true }),
        'curation',
      ),
    ).toEqual(['curated', 'asks', 'intake', 'enrichment']);
    expect(optionsOf(row({ asks: null }), UNKNOWN, 'curation')).toBeNull();
  });
});

describe('matching a selection', () => {
  const arbRow = fc.record({
    bodyClass: fc.constantFrom('lakePond', 'reservoir', 'bay'),
    areaSqM: fc.option(fc.double({ min: 0, max: 1e9, noNaN: true }), { nil: null }),
    reports: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
  });
  const arbFacts = fc.record({
    outline: fc.constantFrom('catalog' as const, 'drawn' as const, null),
    putIns: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
    curated: fc.option(fc.boolean(), { nil: null }),
    intake: fc.option(fc.boolean(), { nil: null }),
    awaitingEnrichment: fc.option(fc.boolean(), { nil: null }),
  });
  const arbSelection = fc.dictionary(
    fc.constantFrom(...FACET_IDS),
    fc.subarray([
      'lakePond',
      'bay',
      'under-10',
      '1000-up',
      'catalog',
      'some',
      'none',
      'season',
      'curated',
    ]),
  ) as fc.Arbitrary<FacetSelection>;

  it('narrows nothing when nothing is chosen', () => {
    fc.assert(fc.property(arbRow, arbFacts, (r, f) => matchesSelection(row(r), f, {})));
  });
  it('widens with another option in a facet, and narrows with another facet', () => {
    fc.assert(
      fc.property(
        arbRow,
        arbFacts,
        arbSelection,
        fc.constantFrom(...FACET_IDS),
        (r, f, s, facet) => {
          const before = matchesSelection(row(r), f, s);
          const option = facetById(facet).options[0]?.id as string;
          const chosen = s[facet] ?? [];
          const widened = { ...s, [facet]: chosen.length > 0 ? [...chosen, option] : chosen };
          const narrowed = chosen.length === 0 ? { ...s, [facet]: [option] } : s;
          return (
            (!before || matchesSelection(row(r), f, widened)) &&
            (!matchesSelection(row(r), f, narrowed) || before)
          );
        },
      ),
    );
  });
  it('never lets an unrecorded fact pass a chosen facet', () => {
    expect(
      matchesSelection(row({ areaSqM: null }), facts(), { size: ['under-10', '10-100'] }),
    ).toBe(false);
    expect(matchesSelection(row(), UNKNOWN, { outline: ['catalog', 'drawn'] })).toBe(false);
  });
});
