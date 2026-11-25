import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLAIM_SOURCES } from './confidence';
import {
  aliasesFor,
  bodyAliasesFor,
  bodySearchTextFor,
  composeNameClaims,
  distinctNameClaims,
  NAME_SOURCE_RANK,
  type NameClaim,
  searchTextFor,
} from './nameClaims';

const claim = (source: NameClaim['source'], value: string): NameClaim => ({ source, value });

describe('distinctNameClaims', () => {
  it('keeps one claim per distinct string, first source wins', () => {
    expect(
      distinctNameClaims([
        claim('nhd', 'The Basin'),
        claim('3dhp', 'The Basin'),
        claim('osm', 'Lake Auburn'),
      ]),
    ).toEqual([claim('nhd', 'The Basin'), claim('osm', 'Lake Auburn')]);
  });

  it('trims and drops blanks rather than storing them', () => {
    expect(distinctNameClaims([claim('osm', '  Long Pond '), claim('nhd', '   ')])).toEqual([
      claim('osm', 'Long Pond'),
    ]);
  });

  it('dedupes case-insensitively, keeping the first spelling seen', () => {
    expect(distinctNameClaims([claim('nhd', 'Mud Pond'), claim('osm', 'MUD POND')])).toEqual([
      claim('nhd', 'Mud Pond'),
    ]);
  });

  // The scorer's `sameName` folds apostrophes, possessive `s` and word order so two spellings count
  // as ONE claim — right for "do the publishers disagree?", wrong here. Convex's search tokenizer
  // does no folding, so these produce different tokens and dropping one is a missed search.
  it('does NOT fold spellings the way sameName does, because search does not either', () => {
    for (const pair of [
      ["Harvey's Lake", 'Harveys Lake'],
      ['Salem Lake', 'Lake Salem'],
      ['Clark Pond', 'Clarks Pond'],
    ] as const) {
      expect(distinctNameClaims([claim('nhd', pair[0]), claim('osm', pair[1])])).toHaveLength(2);
    }
  });
});

describe('composeNameClaims', () => {
  // The bug this exists for, and it fails quietly: a moderator preferring "Lake Auburn" creates a
  // `user` claim with OSM's value, so a single dedupe drops OSM's — and clearing the override then
  // restores "The Basin" with NO alias, destroying the very name the pick was made to keep.
  it('keeps the catalog claim the moderator pick mirrors', () => {
    const composed = composeNameClaims(
      [claim('user', 'Lake Auburn')],
      [claim('nhd', 'The Basin'), claim('osm', 'Lake Auburn')],
    );
    expect(composed).toEqual([
      claim('user', 'Lake Auburn'),
      claim('nhd', 'The Basin'),
      claim('osm', 'Lake Auburn'),
    ]);
    // …so clearing the override still has an alias to restore.
    const catalog = composed.filter((c) => c.source !== 'user');
    expect(aliasesFor(catalog, 'The Basin')).toEqual(['Lake Auburn']);
  });

  it('still dedupes within each side', () => {
    expect(composeNameClaims([], [claim('nhd', 'Long Pond'), claim('3dhp', 'Long Pond')])).toEqual([
      claim('nhd', 'Long Pond'),
    ]);
  });

  it('does not double the alias in searchText, because aliasesFor folds the repetition', () => {
    const composed = composeNameClaims(
      [claim('user', 'Lake Auburn')],
      [claim('nhd', 'The Basin'), claim('osm', 'Lake Auburn')],
    );
    expect(searchTextFor('Lake Auburn', aliasesFor(composed, 'Lake Auburn'))).toBe(
      'Lake Auburn The Basin',
    );
  });
});

describe('aliasesFor', () => {
  // Auburn's own water supply: NHD's gnis_name is "The Basin", OSM says "Lake Auburn", authority
  // ranking stores the former — and before this, a skater typing "Lake Auburn" found nothing.
  it('keeps the losing name so the lake is still findable under it', () => {
    expect(
      aliasesFor([claim('nhd', 'The Basin'), claim('osm', 'Lake Auburn')], 'The Basin'),
    ).toEqual(['Lake Auburn']);
  });

  it('excludes the displayed name case-insensitively, not by identity', () => {
    expect(
      aliasesFor([claim('nhd', 'the basin'), claim('osm', 'Lake Auburn')], 'The Basin'),
    ).toEqual(['Lake Auburn']);
  });

  it('is empty when every publisher agrees', () => {
    expect(aliasesFor([claim('nhd', 'Long Pond'), claim('osm', 'Long Pond')], 'Long Pond')).toEqual(
      [],
    );
  });

  it('is empty for a body nobody named', () => {
    expect(aliasesFor([], '')).toEqual([]);
  });
});

describe('searchTextFor', () => {
  it('joins the name and its aliases into the one indexed field', () => {
    expect(searchTextFor('The Basin', ['Lake Auburn'])).toBe('The Basin Lake Auburn');
  });

  it('handles a body with no aliases', () => {
    expect(searchTextFor('Long Pond', undefined)).toBe('Long Pond');
    expect(searchTextFor('Long Pond', [])).toBe('Long Pond');
  });

  it('drops blanks so a stray empty alias cannot double a separator', () => {
    expect(searchTextFor('Long Pond', ['', '  ', 'Big Pond'])).toBe('Long Pond Big Pond');
  });

  // An unnamed body still gets a row; its searchText is empty rather than whitespace.
  it('is empty for an unnamed body with nothing else to offer', () => {
    expect(searchTextFor('', [])).toBe('');
  });
});

describe('bodyAliasesFor (B01-3h: one rule for every search)', () => {
  it('the catalogs’ other names, then a moderator’s aliases — each once, case and space aside', () => {
    const body = {
      name: 'The Basin',
      nameClaims: [claim('nhd', 'The Basin'), claim('osm', 'Lake Auburn')],
      moderatorAliases: ['  the basin ', 'lake auburn', 'Auburn Reservoir', 'AUBURN RESERVOIR'],
    };
    expect(bodyAliasesFor(body)).toEqual(['Lake Auburn', 'Auburn Reservoir']);
    expect(bodySearchTextFor(body)).toBe('The Basin Lake Auburn Auburn Reservoir');
  });

  it('with no moderator aliases it is exactly the catalogs’ rule, so an unaliased body’s text never moves', () => {
    const value = fc.string({ maxLength: 12 });
    const source = fc.constantFrom<NameClaim['source']>('osm', 'nhd', 'gnis', '3dhp', 'user');
    fc.assert(
      fc.property(
        value,
        fc.array(fc.record({ source, value }), { maxLength: 6 }),
        (name, claims) => {
          const body = { name, nameClaims: claims };
          expect(bodyAliasesFor(body)).toEqual(aliasesFor(claims, name));
          expect(bodySearchTextFor({ ...body, moderatorAliases: [] })).toBe(
            searchTextFor(name, aliasesFor(claims, name)),
          );
        },
      ),
    );
  });

  it('every non-blank moderator alias is findable: its trimmed text is in the search text', () => {
    const word = fc.string({ minLength: 1, maxLength: 10 });
    fc.assert(
      fc.property(word, fc.array(word, { maxLength: 6 }), (name, aliases) => {
        const text = bodySearchTextFor({ name, moderatorAliases: aliases }).toLowerCase();
        for (const alias of aliases) {
          if (alias.trim()) expect(text).toContain(alias.trim().toLowerCase());
        }
        const out = bodyAliasesFor({ name, moderatorAliases: aliases });
        const keys = out.map((a) => a.trim().toLowerCase());
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).not.toContain(name.trim().toLowerCase());
      }),
    );
  });
});

describe('every catalog behind a spelling (B01-7a)', () => {
  const recorded = (source: NameClaim['source'], value: string): NameClaim => ({
    source,
    value,
    sources: [source],
  });

  it('two catalogs with one spelling: one claim, the top-ranked its source, both in `sources`', () => {
    expect(
      distinctNameClaims([recorded('nhd', 'Long Pond'), recorded('3dhp', 'Long Pond')]),
    ).toEqual([{ source: 'nhd', value: 'Long Pond', sources: ['nhd', '3dhp'] }]);
  });

  it('three catalogs with one spelling, folded case-insensitively, in rank order after the first', () => {
    expect(
      distinctNameClaims([
        recorded('gnis', 'Little Basin Pond'),
        recorded('osm', 'little basin pond'),
        recorded('nhd', ' Little Basin Pond'),
        recorded('osm', 'Big Basin Pond'),
      ]),
    ).toEqual([
      { source: 'gnis', value: 'Little Basin Pond', sources: ['gnis', 'nhd', 'osm'] },
      { source: 'osm', value: 'Big Basin Pond', sources: ['osm'] },
    ]);
  });

  it('pools claims that already carry several catalogs, each catalog once', () => {
    expect(
      distinctNameClaims([
        { source: 'nhd', value: 'Mud Pond', sources: ['nhd', 'osm'] },
        { source: '3dhp', value: 'Mud Pond', sources: ['3dhp', 'osm'] },
      ]),
    ).toEqual([{ source: 'nhd', value: 'Mud Pond', sources: ['nhd', '3dhp', 'osm'] }]);
  });

  it('a spelling with any unrecorded claim stays unrecorded: nothing says the catalogs agree', () => {
    // A stored claim from before the campaign that records `sources`, beside one that has them (a
    // merge folding two bodies): the pooled list would leave the first claim's other catalogs out.
    expect(distinctNameClaims([claim('nhd', 'Mud Pond'), recorded('osm', 'Mud Pond')])).toEqual([
      claim('nhd', 'Mud Pond'),
    ]);
    expect(distinctNameClaims([recorded('nhd', 'Mud Pond'), claim('osm', 'Mud Pond')])).toEqual([
      claim('nhd', 'Mud Pond'),
    ]);
  });

  it('a moderator’s claim carries none, and composing a pick keeps each catalog claim’s', () => {
    const catalog = [
      { source: 'nhd' as const, value: 'The Basin', sources: ['nhd' as const, '3dhp' as const] },
      recorded('osm', 'Lake Auburn'),
    ];
    const composed = composeNameClaims([claim('user', 'Lake Auburn')], catalog);
    expect(composed).toEqual([claim('user', 'Lake Auburn'), ...catalog]);
    expect(composed[0]).not.toHaveProperty('sources');
  });

  it('the search text ignores `sources`: a body reads the same with them as without', () => {
    const bare = {
      name: 'The Basin',
      nameClaims: [claim('nhd', 'The Basin'), claim('osm', 'Lake Auburn')],
    };
    const withSources = {
      name: 'The Basin',
      nameClaims: [
        { source: 'nhd' as const, value: 'The Basin', sources: ['nhd' as const, '3dhp' as const] },
        recorded('osm', 'Lake Auburn'),
      ],
    };
    expect(bodySearchTextFor(withSources)).toBe(bodySearchTextFor(bare));
    expect(bodySearchTextFor(withSources)).toBe('The Basin Lake Auburn');
  });

  /** `distinctNameClaims` as it was before `sources` (A07a), kept here as the property's oracle. */
  function before(claims: readonly NameClaim[]): { source: string; value: string }[] {
    const seen = new Set<string>();
    const out: { source: string; value: string }[] = [];
    for (const c of claims) {
      const value = c.value.trim();
      if (value.length === 0) continue;
      const k = value.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ source: c.source, value });
    }
    return out;
  }

  const source = fc.constantFrom(...CLAIM_SOURCES);
  // Few spellings, varied in case and space, so they fold often.
  const value = fc.constantFrom(
    'Mud Pond',
    'mud pond',
    ' Mud Pond ',
    'Long Lake',
    'LONG LAKE',
    '',
    ' ',
  );
  const claims = fc.array(
    fc
      .record({
        source,
        value,
        sources: fc.option(fc.array(source, { maxLength: 4 }), { nil: undefined }),
      })
      .map(({ sources, ...c }): NameClaim => (sources === undefined ? c : { ...c, sources })),
    { maxLength: 8 },
  );

  it('`source` and `value` are exactly what they were before `sources` existed (property)', () => {
    fc.assert(
      fc.property(claims, (input) => {
        expect(
          distinctNameClaims(input).map(({ source: s, value: v }) => ({ source: s, value: v })),
        ).toEqual(before(input));
      }),
    );
  });

  it('`sources` is the claim’s own catalog first, then the rest in rank order, each once (property)', () => {
    fc.assert(
      fc.property(claims, (input) => {
        for (const out of distinctNameClaims(input)) {
          if (out.sources === undefined) continue;
          const [first, ...rest] = out.sources;
          expect(first).toBe(out.source);
          expect(new Set(out.sources).size).toBe(out.sources.length);
          const ranks = rest.map((s) => NAME_SOURCE_RANK[s]);
          expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
          // Every catalog any folded claim named is kept.
          const folded = input.filter(
            (c) => c.value.trim().toLowerCase() === out.value.toLowerCase(),
          );
          for (const c of folded)
            for (const s of [c.source, ...(c.sources ?? [])]) expect(out.sources).toContain(s);
        }
      }),
    );
  });
});

describe('NAME_SOURCE_RANK (moved from the ETL, B01-7a)', () => {
  it('ranks every claim source, by authority over US names, a moderator above every catalog', () => {
    expect(Object.keys(NAME_SOURCE_RANK).sort()).toEqual([...CLAIM_SOURCES].sort());
    const order = [...CLAIM_SOURCES].sort((a, b) => NAME_SOURCE_RANK[a] - NAME_SOURCE_RANK[b]);
    expect(order).toEqual(['user', 'gnis', 'nhd', '3dhp', 'osm', 'name']);
  });
});
