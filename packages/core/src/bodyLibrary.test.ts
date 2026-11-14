import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CountFootprint,
  clampPageSize,
  completeOption,
  countAddress,
  countDeltas,
  countKeysOf,
  facetOptionsOf,
  LIBRARY_FACET_IDS,
  LIBRARY_FACETS,
  LIBRARY_LANES,
  LIBRARY_MAX_START,
  LIBRARY_PAGE_SIZE,
  type LibraryFacetFacts,
  laneOf,
  libraryScopes,
  librarySearchText,
  libraryStandingOf,
  matchedAlias,
  matchesFacets,
  nameSortKey,
  parseCountAddress,
  SCOPE_ALL,
  servedCounts,
  sizeOption,
  tallyCounts,
  textMatches,
  UNKNOWN_LAST_ASC,
  UNKNOWN_LAST_DESC,
  unknownLastKeys,
} from './bodyLibrary';
import { WATER_BODY_CLASSES } from './types';

const ACRE = 4046.8564224;

const FACTS: LibraryFacetFacts = {
  bodyClass: 'lakePond',
  areaSqM: 500 * ACRE,
  outline: 'catalog',
  hasPutIns: true,
  reports: 3,
  everReported: true,
  completeHave: 9,
  completeOf: 10,
  curated: true,
  asks: 2,
  intake: false,
  awaitingEnrichment: false,
};

describe('standing and lanes', () => {
  const base = { dedupStatus: 'clean' as const };
  it('files every standing, and a merged body nowhere', () => {
    expect(libraryStandingOf(base)).toBe('active');
    expect(libraryStandingOf({ ...base, dedupStatus: 'merged' })).toBeNull();
    expect(libraryStandingOf({ ...base, reviewStatus: 'rejected' })).toBe('rejected');
    expect(libraryStandingOf({ ...base, removedAt: 1 })).toBe('removed');
    expect(libraryStandingOf({ ...base, publicAccess: { verdict: 'none', decidedAt: 1 } })).toBe(
      'no_public_access',
    );
    expect(libraryStandingOf({ ...base, dormant: { since: 1, reason: 'moderator' } })).toBe(
      'moderator',
    );
  });
  it('files rejected under removed, every other standing under its own lane', () => {
    expect(laneOf('rejected')).toBe('removed');
    for (const lane of LIBRARY_LANES) expect(laneOf(lane)).toBe(lane);
  });
});

describe('scopes', () => {
  it('lists a body under * and each state once, dropping a malformed code', () => {
    expect(libraryScopes(['vt', 'NY', 'VT', 'Vermont', ''])).toEqual([SCOPE_ALL, 'NY', 'VT']);
    expect(libraryScopes(undefined)).toEqual([SCOPE_ALL]);
  });
});

describe('facet options', () => {
  it('buckets area by acres, and an unknown area under no size', () => {
    expect(sizeOption(9.99 * ACRE)).toBe('under-10');
    expect(sizeOption(10 * ACRE)).toBe('10-100');
    expect(sizeOption(999 * ACRE)).toBe('100-1000');
    expect(sizeOption(1000 * ACRE)).toBe('1000-up');
    expect(sizeOption(undefined)).toBeNull();
    expect(sizeOption(0)).toBeNull();
    expect(sizeOption(Number.NaN)).toBeNull();
  });
  it('files completeness as all, eight or more, or under eight', () => {
    expect(completeOption(10, 10)).toBe('all');
    expect(completeOption(8, 10)).toBe('most');
    expect(completeOption(7, 10)).toBe('under-8');
  });
  it('reads each facet from the facts', () => {
    expect(facetOptionsOf(FACTS)).toEqual({
      class: ['lakePond'],
      size: ['100-1000'],
      outline: ['catalog'],
      putins: ['some'],
      reports: ['season'],
      complete: ['most'],
      curation: ['curated', 'asks'],
    });
    const quiet = {
      ...FACTS,
      areaSqM: null,
      hasPutIns: false,
      reports: 0,
      everReported: false,
      curated: false,
      asks: 0,
      intake: true,
      awaitingEnrichment: true,
    };
    expect(facetOptionsOf(quiet)).toMatchObject({
      size: [],
      putins: ['none'],
      reports: ['never'],
      curation: ['intake', 'enrichment'],
    });
  });
  it('keys the total and every option the row falls under', () => {
    expect(countKeysOf(FACTS)).toEqual([
      'total',
      'class:lakePond',
      'size:100-1000',
      'outline:catalog',
      'putins:some',
      'reports:season',
      'complete:most',
      'curation:curated',
      'curation:asks',
    ]);
  });
  it('widens within a facet and narrows across facets', () => {
    expect(matchesFacets(FACTS, {})).toBe(true);
    expect(matchesFacets(FACTS, { class: ['bay', 'lakePond'] })).toBe(true);
    expect(matchesFacets(FACTS, { class: ['lakePond'], size: ['1000-up'] })).toBe(false);
    expect(matchesFacets(FACTS, { size: [] })).toBe(true);
    expect(matchesFacets({ ...FACTS, areaSqM: null }, { size: ['under-10'] })).toBe(false);
  });
  it('offers the page ids', () => {
    expect(LIBRARY_FACETS.class).toEqual(WATER_BODY_CLASSES);
    expect(LIBRARY_FACET_IDS).toEqual([
      'class',
      'size',
      'outline',
      'putins',
      'reports',
      'complete',
      'curation',
    ]);
  });
});

describe('servedCounts', () => {
  it('answers every facet and the total with nothing applied', () => {
    expect(servedCounts({})).toEqual({ facets: LIBRARY_FACET_IDS, total: true });
    expect(servedCounts({ size: ['nope'] })).toEqual({ facets: LIBRARY_FACET_IDS, total: true });
  });
  it('answers only the applied facet, and its total unless a body can hold two options', () => {
    expect(servedCounts({ size: ['1000-up'] })).toEqual({ facets: ['size'], total: true });
    expect(servedCounts({ curation: ['asks'] })).toEqual({ facets: ['curation'], total: false });
  });
  it('answers nothing with two applied', () => {
    expect(servedCounts({ size: ['1000-up'], class: ['bay'] })).toEqual({
      facets: [],
      total: false,
    });
  });
});

// ── The counts are the tally of the rows ─────────────────────────────────────────────────────

const footprint = fc.record({
  lane: fc.constantFrom(...LIBRARY_LANES),
  scopes: fc.subarray(['NY', 'VT', 'NH', 'ME', 'MA']).map((s) => [SCOPE_ALL, ...s]),
  keys: fc
    .subarray(['class:bay', 'size:10-100', 'putins:some', 'putins:none', 'curation:asks'])
    .map((k) => ['total', ...k]),
}) as fc.Arbitrary<CountFootprint>;

describe('countDeltas (property)', () => {
  it('any sequence of row writes keeps the counts equal to the tally of the rows', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.option(footprint)), {
          maxLength: 40,
        }),
        (writes) => {
          const rows = new Map<number, CountFootprint>();
          const counts = new Map<string, number>();
          for (const [body, next] of writes) {
            const before = rows.get(body) ?? null;
            for (const [a, d] of countDeltas(before, next)) {
              counts.set(a, (counts.get(a) ?? 0) + d);
            }
            if (next === null) rows.delete(body);
            else rows.set(body, next);
          }
          const tally = tallyCounts([...rows.values()]);
          for (const [a, n] of counts) expect(n).toBe(tally.get(a) ?? 0);
          for (const [a, n] of tally) expect(counts.get(a)).toBe(n);
          for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
  it('a row written unchanged moves nothing', () => {
    fc.assert(
      fc.property(footprint, (fp) => {
        expect(countDeltas(fp, fp).size).toBe(0);
      }),
    );
  });
  it('every body counts under its lane and under all', () => {
    const d = countDeltas(null, { lane: 'moderator', scopes: ['*'], keys: ['total'] });
    expect([...d.keys()].map(parseCountAddress)).toEqual([
      { lane: 'all', scope: '*', key: 'total' },
      { lane: 'moderator', scope: '*', key: 'total' },
    ]);
    expect(parseCountAddress(countAddress('a', 'b', 'c'))).toEqual({
      lane: 'a',
      scope: 'b',
      key: 'c',
    });
  });
});

// ── Unknown sorts last both ways ─────────────────────────────────────────────────────────────

describe('unknownLastKeys (property)', () => {
  const value = fc.option(fc.double({ min: 0, max: 1e12, noNaN: true }), { nil: null });
  it('an unknown follows every known value ascending and descending', () => {
    fc.assert(
      fc.property(value, value, (a, b) => {
        const ka = unknownLastKeys(a);
        const kb = unknownLastKeys(b);
        if (a === null && b !== null) {
          expect(ka.asc).toBeGreaterThan(kb.asc);
          expect(ka.desc).toBeLessThan(kb.desc);
        }
        if (a !== null && b !== null) {
          expect(Math.sign(ka.asc - kb.asc)).toBe(Math.sign(a - b));
          expect(Math.sign(ka.desc - kb.desc)).toBe(Math.sign(a - b));
        }
      }),
    );
  });
  it('treats a non-finite value as unknown', () => {
    expect(unknownLastKeys(Number.POSITIVE_INFINITY)).toEqual({
      asc: UNKNOWN_LAST_ASC,
      desc: UNKNOWN_LAST_DESC,
    });
    expect(unknownLastKeys(undefined).desc).toBe(UNKNOWN_LAST_DESC);
  });
});

describe('search', () => {
  it('matches word starts, case and accents aside', () => {
    expect(textMatches('Lac Élan', 'el')).toBe(true);
    expect(textMatches('Morgan Pond', 'morg po')).toBe(true);
    expect(textMatches('Morgan Pond', 'organ')).toBe(false);
    expect(textMatches('Morgan Pond', '  ')).toBe(false);
  });
  it('names the alias a search matched where the name did not', () => {
    expect(matchedAlias('The Basin', ['Lake Auburn'], 'auburn')).toBe('Lake Auburn');
    expect(matchedAlias('The Basin', ['Lake Auburn'], 'basin')).toBeUndefined();
    expect(matchedAlias('The Basin', ['Lake Auburn'], '')).toBeUndefined();
    expect(matchedAlias('The Basin', ['Lake Auburn'], 'way')).toBeUndefined();
  });
  it('joins name, aliases and ids, dropping blanks', () => {
    expect(librarySearchText('A', ['', 'B'], ['way/1'])).toBe('A\nB\nway/1');
  });
  it('sorts names lowercase and trimmed', () => {
    expect(nameSortKey('  Lake X ')).toBe('lake x');
  });
});

describe('page sizes', () => {
  it('holds a starting page to one row and the most', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(120.7)).toBe(120);
    expect(clampPageSize(10_000)).toBe(LIBRARY_MAX_START);
    expect(clampPageSize(Number.NaN)).toBe(LIBRARY_PAGE_SIZE);
  });
});
