import { describe, expect, it } from 'vitest';

import {
  aliasesFor,
  composeNameClaims,
  distinctNameClaims,
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
  it('keeps the catalogue claim the moderator pick mirrors', () => {
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
    const catalogue = composed.filter((c) => c.source !== 'user');
    expect(aliasesFor(catalogue, 'The Basin')).toEqual(['Lake Auburn']);
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
