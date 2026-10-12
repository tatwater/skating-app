import type { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatDistanceMiles, type LatLng } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import { googleMapsUrl } from '../../lib/googleMaps';
import type { ReviewShow } from '../../lib/reviewMarkers';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ReasonDialog } from './ReasonDialog';

/**
 * A proposal's possible duplicates, as the server reports them (`landmarkProposalView`) — read off
 * the query's own type, so the badge and the server cannot drift apart.
 */
export type Lookalikes = Pick<
  FunctionReturnType<typeof api.corpusRequests.openLandmarkRequestsForBody>['proposals'][number],
  'similarLandmark' | 'similarProposal'
>;

/** A spot's second look: the coordinate, linked out to Google Maps with a pin on it. */
export function GoogleMapsLink({ coord }: { coord: LatLng }) {
  return (
    <a
      href={googleMapsUrl(coord)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-primary text-xs underline-offset-2 hover:underline"
      title="Open this spot in Google Maps"
    >
      {coord.lat.toFixed(4)}, {coord.lng.toFixed(4)} ↗
    </a>
  );
}

/**
 * The possible-duplicate badge on a landmark proposal (D202): a landmark, or another proposal, that
 * shares its name somewhere else on the lake. Never a verdict — the same-place rule did not join
 * them, and the moderator decides on the map: *Show both* frames the pair; *Same place* answers the
 * proposal with the landmark that is already there. "Different place" is the row's own *Add*.
 */
export function PossibleDuplicate({
  lookalikes,
  busy = false,
  onShow,
  onSamePlace,
}: {
  lookalikes: Lookalikes;
  busy?: boolean;
  /**
   * Draw the spot with this lookalike. Which one, not where: the caller draws it from the row as it
   * stands (`useRowReview`), so a lookalike decided or moved since the click shows as it is now.
   */
  onShow: (lookalike: Exclude<ReviewShow, 'spot'>) => void;
  /** Answer the proposal with this landmark — confirmed first, with an optional note the skaters read. */
  onSamePlace: (landmarkId: Id<'bodyLandmarks'>, note: string) => Promise<unknown>;
}) {
  const { similarLandmark: landmark, similarProposal: proposal } = lookalikes;
  if (!landmark && !proposal) return null;
  return (
    <div className="flex w-full flex-col gap-1 text-foreground-muted text-xs">
      <Badge variant="outline">Possible duplicate</Badge>
      {landmark ? (
        <p className="flex flex-wrap items-center gap-x-1">
          <span>
            “{landmark.name}” is already a landmark, {formatDistanceMiles(landmark.meters)} from
            this spot.
          </span>
          <Button variant="ghost" size="xs" onClick={() => onShow('landmark')}>
            Show both
          </Button>
          {/* Confirmed, like the queue's Approve: it can answer a proposal with a landmark miles
              away, the skaters read the answer, and nothing undoes it. */}
          <ReasonDialog
            trigger={
              <Button variant="ghost" size="xs" disabled={busy}>
                Same place
              </Button>
            }
            title={`Answer with “${landmark.name}”?`}
            description={`The skaters who named this spot read that it is the landmark “${landmark.name}”, ${formatDistanceMiles(landmark.meters)} away. Show both first if you have not looked.`}
            confirmLabel="Answer with this landmark"
            confirmVariant="default"
            requireReason={false}
            reasonPlaceholder="Optional note the skaters will read"
            onConfirm={(note) => onSamePlace(landmark.landmarkId, note)}
          />
        </p>
      ) : null}
      {proposal ? (
        <p className="flex flex-wrap items-center gap-x-1">
          <span>
            Another “{proposal.name}” proposal is {formatDistanceMiles(proposal.meters)} away.
          </span>
          <Button variant="ghost" size="xs" onClick={() => onShow('proposal')}>
            Show both
          </Button>
        </p>
      ) : null}
    </div>
  );
}
