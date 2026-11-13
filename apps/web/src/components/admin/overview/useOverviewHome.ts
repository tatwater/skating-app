import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';

import type { OverviewHomeData } from './OverviewHome';
import {
  type CorpusExtras,
  corpusFromReviewCounts,
  feedFromActions,
  inboxFromOverview,
  peopleFromOverview,
} from './overviewData';

/** How many feed rows Home reads: more than a tall screen shows, well under the server's cap. */
export const FEED_LIMIT = 50;

/**
 * Home's reads that exist today: the Inbox and People counts (`console.overview`), the Corpus
 * intake reasons (`waterBodies.reviewQueueCounts`) and the audit trail (`moderation.listActions`).
 * Each block is `undefined` until its read lands. What no read carries yet comes in as `extras`
 * (the Corpus rows outside the intake reasons) or straight from the route as props.
 */
export function useOverviewHome(
  extras: Partial<CorpusExtras> = {},
): Pick<OverviewHomeData, 'inbox' | 'corpus' | 'people' | 'feed'> {
  const overview = useQuery(api.console.overview, {});
  const reviewCounts = useQuery(api.waterBodies.reviewQueueCounts, {});
  const actions = useQuery(api.moderation.listActions, { limit: FEED_LIMIT });
  const { chordRefits, placeNames, preIcePass, enrichment, campaignAt } = extras;
  return useMemo(
    () => ({
      inbox: overview ? inboxFromOverview(overview.inbox) : undefined,
      people: overview ? peopleFromOverview(overview.people) : undefined,
      corpus: reviewCounts
        ? corpusFromReviewCounts(reviewCounts, {
            ...(chordRefits !== undefined && { chordRefits }),
            ...(placeNames !== undefined && { placeNames }),
            ...(preIcePass !== undefined && { preIcePass }),
            ...(enrichment !== undefined && { enrichment }),
            ...(campaignAt !== undefined && { campaignAt }),
          })
        : undefined,
      feed: actions ? feedFromActions(actions) : undefined,
    }),
    [overview, reviewCounts, actions, chordRefits, placeNames, preIcePass, enrichment, campaignAt],
  );
}
