import type { Id } from '@skating/convex/dataModel';
import { formatDistanceMiles, type LatLng } from '@skating/core';
import { googleMapsUrl } from '../../lib/googleMaps';
import type { ReviewPoints } from '../../lib/reviewMarkers';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

/** A proposal's possible duplicates, as the server reports them (`landmarkLookalikesView`). */
export interface Lookalikes {
  similarLandmark?: {
    landmarkId: Id<'bodyLandmarks'>;
    name: string;
    point: LatLng;
    meters: number;
  };
  similarProposal?: {
    requestId: Id<'waterBodyRequests'>;
    name: string;
    coord: LatLng;
    meters: number;
  };
}

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
  ask,
  name,
  lookalikes,
  busy = false,
  onShow,
  onSamePlace,
}: {
  ask: LatLng;
  name: string;
  lookalikes: Lookalikes;
  busy?: boolean;
  onShow: (review: ReviewPoints) => void;
  onSamePlace: (landmarkId: Id<'bodyLandmarks'>) => void;
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
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onShow({
                ask,
                name,
                other: { point: landmark.point, kind: 'landmark', name: landmark.name },
              })
            }
          >
            Show both
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            title={`Answer this proposal with the landmark “${landmark.name}”`}
            onClick={() => onSamePlace(landmark.landmarkId)}
          >
            Same place
          </Button>
        </p>
      ) : null}
      {proposal ? (
        <p className="flex flex-wrap items-center gap-x-1">
          <span>
            Another “{proposal.name}” proposal is {formatDistanceMiles(proposal.meters)} away.
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onShow({
                ask,
                name,
                other: { point: proposal.coord, kind: 'proposal', name: proposal.name },
              })
            }
          >
            Show both
          </Button>
        </p>
      ) : null}
    </div>
  );
}
