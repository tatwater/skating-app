import { LIBRARY_FACET_IDS, LIBRARY_FACETS } from '@skating/core';
import { describe, expect, it } from 'vitest';

import {
  appliedCount,
  appliedOptions,
  chipWords,
  FACET_IDS,
  FACETS,
  type FacetSelection,
  facetById,
  toggleOption,
} from './bodyFacets';

describe('the facets', () => {
  it('are core’s facets and options, in core’s order — the ids the server files rows under', () => {
    expect([...FACET_IDS]).toEqual(LIBRARY_FACET_IDS);
    for (const f of FACETS) {
      expect(f.options.map((o) => o.id)).toEqual([...LIBRARY_FACETS[f.id]]);
    }
  });
  it('count all ten on the completeness facet', () => {
    expect(facetById('complete').options.map((o) => o.label)).toEqual(['All 10', '8–9', 'Under 8']);
  });
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
