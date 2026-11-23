/**
 * When the mobile feed may draw its sections (D292). The heads of the recency sections are decided
 * by the up-front favorites read, the matched lakes and the recommended strip: drawn before all
 * three answer, a favorite would land at the top of a section a moment later. While they load, the
 * offline cache stands in when there is one, so a weak connection never trades saved cards for a
 * spinner; the cache lifts nothing, so it waits for none of them. The wait is bounded
 * (`LATEST_HEADS_WAIT_MS`): past it the live list draws with what has answered.
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
  /** `LATEST_HEADS_WAIT_MS` passed since the first live page: draw with what has answered. */
  waitedOut: boolean;
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
  // A slow or lost read never hides loaded Posts for long: past the wait the live list draws.
  const liveReady = liveHeads || (live && input.waitedOut);
  const showCached = input.cachedCount > 0 && (!live || (input.resultsCount > 0 && !liveReady));
  return { showCached, headsKnown: showCached || liveReady };
}
