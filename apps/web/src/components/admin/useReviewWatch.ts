import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';
import { type PickedReview, type ReviewWatch, watchReview } from '../../lib/reviewWatch';

/** What became of a pick, live from the server (`corpusRequests.reviewState`) — `live` with none. */
export function useReviewWatch(picked: PickedReview | null): ReviewWatch {
  const state = useQuery(
    api.corpusRequests.reviewState,
    picked
      ? {
          requestIds: [
            picked.id as Id<'waterBodyRequests'>,
            ...(picked.otherRequestId ? [picked.otherRequestId as Id<'waterBodyRequests'>] : []),
          ],
          ...(picked.landmarkId ? { landmarkId: picked.landmarkId as Id<'bodyLandmarks'> } : {}),
        }
      : 'skip',
  );
  return picked ? watchReview(picked, state) : { kind: 'live' };
}
