import type { LatLng } from '@skating/core';
import { type ReviewPoints, type ReviewRow, type ReviewShow, rowReview } from './reviewMarkers';

/**
 * A review a moderator picked (D202), **frozen at the click**: what the map draws, and the requests
 * and landmark it is about. The map never morphs under them — a colleague deciding one end says so
 * (`watchReview`) and locks the rows, and the moderator goes *Back* when they have read it.
 */
export interface PickedReview {
  /** The request the moderator picked. */
  id: string;
  review: ReviewPoints;
  /** The other proposal of a proposal pair. */
  otherRequestId?: string;
  /** The landmark of a landmark pair. */
  landmarkId?: string;
}

/** A row as a pick reads it: its spot and name, and the ids of the lookalikes it reports. */
export interface PickableRow extends ReviewRow {
  similarLandmark?: { landmarkId: string; point: LatLng; name: string } | undefined;
  similarProposal?: { requestId: string; coord: LatLng; name: string } | undefined;
}

/** A click on *Show on map* or *Show both*, frozen: the drawing, and what it is about. */
export function pickReview(id: string, row: PickableRow, show: ReviewShow): PickedReview {
  const review = rowReview(row, show);
  return {
    id,
    review,
    ...(review.other?.kind === 'proposal' && row.similarProposal
      ? { otherRequestId: row.similarProposal.requestId }
      : {}),
    ...(review.other?.kind === 'landmark' && row.similarLandmark
      ? { landmarkId: row.similarLandmark.landmarkId }
      : {}),
  };
}

/** The server's word on a pick (`corpusRequests.reviewState`). */
export interface ReviewState {
  requests: readonly {
    requestId: string;
    status: 'open' | 'gone' | 'approved' | 'declined';
    name?: string;
    by?: string;
    byMe?: boolean;
    answeredWith?: string;
  }[];
  landmark?: { removed: boolean; name?: string; point?: LatLng; by?: string; byMe: boolean };
}

/**
 * What a pick is now: `live` while nothing it is about has changed; `mine` when the moderator changed
 * it themselves (the surface clears quietly — they know); `closed` with the sentence that says what
 * changed and who changed it, while the rows lock until they go *Back*.
 */
export type ReviewWatch = { kind: 'live' } | { kind: 'mine' } | { kind: 'closed'; text: string };

const someone = (by: string | undefined) => by ?? 'another moderator';

export function watchReview(picked: PickedReview, state: ReviewState | undefined): ReviewWatch {
  if (!state) return { kind: 'live' };
  const lines: string[] = [];
  for (const r of state.requests) {
    if (r.status === 'open') continue;
    if (r.byMe) return { kind: 'mine' };
    const isPicked = r.requestId === picked.id;
    const name = r.name || (isPicked ? picked.review.name : picked.review.other?.name);
    // Most of the queue's kinds carry no name (a lake to activate, admit, restore): the request then.
    const subject = name ? `“${name}”` : 'This request';
    if (r.status === 'gone') {
      lines.push(`${subject} is no longer in the queue.`);
    } else if (!isPicked) {
      const other = name ? `The other “${name}” proposal` : 'The other proposal';
      lines.push(`${other} was ${r.status} by ${someone(r.by)}. This pair is closed.`);
    } else if (r.status === 'approved' && r.answeredWith) {
      lines.push(`${subject} was answered by ${someone(r.by)}: the landmark “${r.answeredWith}”.`);
    } else {
      lines.push(`${subject} was ${r.status} by ${someone(r.by)}.`);
    }
  }
  const landmark = state.landmark;
  const drawn = picked.review.other?.kind === 'landmark' ? picked.review.other : undefined;
  if (picked.landmarkId !== undefined && landmark) {
    const name = landmark.name ?? drawn?.name ?? 'The landmark';
    const by = landmark.by ? ` by ${landmark.by}` : '';
    const moved =
      !landmark.removed &&
      landmark.point !== undefined &&
      drawn !== undefined &&
      (landmark.point.lat !== drawn.point.lat || landmark.point.lng !== drawn.point.lng);
    if ((landmark.removed || moved) && landmark.byMe) return { kind: 'mine' };
    if (landmark.removed) lines.push(`The landmark “${name}” was taken off the map${by}.`);
    else if (moved) lines.push(`The landmark “${name}” was moved${by}.`);
  }
  return lines.length > 0 ? { kind: 'closed', text: lines.join(' ') } : { kind: 'live' };
}

/** A row a closed review is about — its actions wait until the moderator goes back. */
export function locksRow(picked: PickedReview | null, watch: ReviewWatch, id: string): boolean {
  return (
    watch.kind === 'closed' && picked !== null && (id === picked.id || id === picked.otherRequestId)
  );
}

/**
 * The picked row's *Same place* would answer with a landmark other than the one its frozen pair draws
 * — a nearer one arrived since the click. The map keeps the pair, so the answer waits: the skaters
 * read it and nothing undoes it, and *Show both* again draws the landmark it would name.
 */
export function landmarkDrifted(
  picked: PickedReview | null,
  id: string,
  row: Pick<PickableRow, 'similarLandmark'>,
): boolean {
  return (
    picked !== null &&
    picked.id === id &&
    picked.landmarkId !== undefined &&
    row.similarLandmark?.landmarkId !== picked.landmarkId
  );
}
