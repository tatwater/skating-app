import { describe, expect, it } from 'vitest';
import { type FeedHeadsInput, feedHeads } from './feedHeads';

const ready: FeedHeadsInput = {
  resultsCount: 20,
  status: 'CanLoadMore',
  cachedCount: 0,
  favoritesLoaded: true,
  bodiesWanted: false,
  bodiesLoaded: false,
  recommendedLoaded: true,
  waitedOut: false,
};

describe('feedHeads (D292)', () => {
  it('draws the live list once the favorites, the lakes it asked for and the strip answer', () => {
    expect(feedHeads(ready)).toEqual({ showCached: false, headsKnown: true, lift: true });
    expect(feedHeads({ ...ready, bodiesWanted: true, bodiesLoaded: true })).toEqual({
      showCached: false,
      headsKnown: true,
      lift: true,
    });
  });

  it('waits for each of them: any one can move a section’s head', () => {
    for (const missing of [
      { favoritesLoaded: false },
      { bodiesWanted: true, bodiesLoaded: false },
      { recommendedLoaded: false },
    ]) {
      expect(feedHeads({ ...ready, ...missing }).headsKnown).toBe(false);
    }
  });

  it('keeps the offline cache up while the live list waits, so saved cards never become a spinner', () => {
    expect(feedHeads({ ...ready, cachedCount: 5, favoritesLoaded: false })).toEqual({
      showCached: true,
      headsKnown: true,
      lift: false,
    });
    // Before the first live page, as it always did.
    expect(
      feedHeads({ ...ready, resultsCount: 0, status: 'LoadingFirstPage', cachedCount: 5 }),
    ).toEqual({ showCached: true, headsKnown: true, lift: false });
  });

  it('shows the live list, not the cache, once it can draw — or once it is truly empty', () => {
    expect(feedHeads({ ...ready, cachedCount: 5 }).showCached).toBe(false);
    expect(
      feedHeads({ ...ready, resultsCount: 0, status: 'Exhausted', cachedCount: 5 }).showCached,
    ).toBe(false);
  });

  it('draws the live list once the wait runs out, whatever is still loading', () => {
    expect(feedHeads({ ...ready, favoritesLoaded: false, waitedOut: true })).toEqual({
      showCached: false,
      headsKnown: true,
      lift: false,
    });
    // And a late answer doesn't turn the lift back on: those sections already drew.
    expect(feedHeads({ ...ready, waitedOut: true }).lift).toBe(false);
    expect(
      feedHeads({ ...ready, cachedCount: 5, recommendedLoaded: false, waitedOut: true }).showCached,
    ).toBe(false);
    // Before the first live page there is nothing live to draw.
    expect(
      feedHeads({
        ...ready,
        resultsCount: 0,
        status: 'LoadingFirstPage',
        favoritesLoaded: false,
        waitedOut: true,
      }).headsKnown,
    ).toBe(false);
  });

  it('with no cache, waits with nothing drawn', () => {
    expect(feedHeads({ ...ready, favoritesLoaded: false })).toEqual({
      showCached: false,
      headsKnown: false,
      lift: true,
    });
  });
});
