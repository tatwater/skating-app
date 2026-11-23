/**
 * When the mobile feed may draw its sections (D292). The heads of the recency sections are decided
 * by the up-front favorites read, the matched lakes and the recommended strip: drawn before all
 * three answer, a favorite would land at the top of a section a moment later. While they load, the
 * offline cache stands in when there is one, so a weak connection never trades saved cards for a
 * spinner; the cache lifts nothing, so it waits for none of them.
 */
export interface FeedHeadsInput {
  /** Posts the live feed has loaded. */
  resultsCount: number;
  status: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted';
  /** Cards in the offline read-cache. */
  cachedCount: number;
  favoritesLoaded: boolean;
  /** A weather filter is on and asks for lakes. */
  bodiesWanted: boolean;
  bodiesLoaded: boolean;
  recommendedLoaded: boolean;
}

export interface FeedHeads {
  /** Draw the offline cache instead of the live list. */
  showCached: boolean;
  /** The list may draw its sections. */
  headsKnown: boolean;
}

export function feedHeads(input: FeedHeadsInput): FeedHeads {
  const liveHeads =
    input.favoritesLoaded && (!input.bodiesWanted || input.bodiesLoaded) && input.recommendedLoaded;
  const live = input.resultsCount > 0 || input.status !== 'LoadingFirstPage';
  const showCached = input.cachedCount > 0 && (!live || (input.resultsCount > 0 && !liveHeads));
  return { showCached, headsKnown: showCached || liveHeads };
}
