import type { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatDistanceMiles, type LatLng } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
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
  stale = false,
  onShow,
  onSamePlace,
}: {
  lookalikes: Lookalikes;
  /** A write in flight, or the row locked by a colleague's decision: *Same place* waits, open or not. */
  busy?: boolean;
  /**
   * The row's landmark is no longer the one on the map (`landmarkDrifted`): a new *Same place* waits
   * for *Show both* — but one already open answers the landmark it named, which is what was checked.
   */
  stale?: boolean;
  /**
   * Draw the spot with this lookalike. Which one, not where: the caller freezes the pair from the row
   * at the click (`pickReview`), and says so if a colleague decides or moves it since (`watchReview`).
   */
  onShow: (lookalike: Exclude<ReviewShow, 'spot'>) => void;
  /** Answer the proposal with this landmark — confirmed first, with an optional note the skaters read. */
  onSamePlace: (landmarkId: Id<'bodyLandmarks'>, note: string) => Promise<unknown>;
}) {
  const { similarLandmark: live, similarProposal: proposal } = lookalikes;
  /**
   * The landmark a *Same place* dialog is about, frozen when it opens (Greptile P1 on #88). The row's
   * lookalike can change under an open dialog — a nearer landmark added — and the dialog must neither
   * re-word itself nor answer with a landmark the moderator never read or checked.
   */
  const [confirming, setConfirming] = useState<NonNullable<Lookalikes['similarLandmark']> | null>(
    null,
  );
  const landmark = confirming ?? live;
  /**
   * The very landmark the open dialog names, moved or renamed since it opened: the answer goes by id,
   * so it would name a place the dialog no longer describes. It waits; the next dialog reads it anew.
   */
  const changed =
    confirming !== null &&
    live?.landmarkId === confirming.landmarkId &&
    (live.name !== confirming.name ||
      live.point.lat !== confirming.point.lat ||
      live.point.lng !== confirming.point.lng);
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
            // One dialog per landmark: a note drafted for one never rides into the answer for
            // another (skaters read it). Stable while open — `landmark` is frozen then.
            key={landmark.landmarkId}
            trigger={
              <Button variant="ghost" size="xs" disabled={busy || stale}>
                Same place
              </Button>
            }
            title={`Answer with “${landmark.name}”?`}
            description={`The skaters who named this spot read that it is the landmark “${landmark.name}”, ${formatDistanceMiles(landmark.meters)} away. Show both first if you have not looked.`}
            confirmLabel="Answer with this landmark"
            confirmVariant="default"
            requireReason={false}
            reasonPlaceholder="Optional note the skaters will read"
            extraFields={
              changed ? (
                <p className="text-destructive text-sm">
                  This landmark was moved or renamed since you opened this. Cancel and look again.
                </p>
              ) : undefined
            }
            onOpenChange={(open) => setConfirming(open ? (live ?? null) : null)}
            confirmDisabled={busy || changed}
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
