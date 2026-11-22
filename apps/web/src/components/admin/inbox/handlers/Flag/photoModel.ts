import type { ModerationStatus } from '@skating/core';

import { countWords, dayMonth, dayTime } from './flagFormat';
import type { LiveTarget } from './flagTypes';
import { PHOTO_WORDS as P } from './photoWords';

/**
 * **Board 2.7, as data** — pure: what the stage may draw for this viewer, its caption and place on the
 * report, *On the same report*, and the photo's own state (up, hidden, removed with its deletion day,
 * or deleted to a tombstone).
 *
 * **What the read serves decides everything here.** The image is drawable only when the server says
 * this viewer may see it (`canReveal`) *and* served an address; a viewer without `content.read` is
 * served neither, and the stage says so in words with no image at all. Nothing here derives a staff
 * field the server didn't send.
 */

export type PhotoSubjectData = Extract<LiveTarget, { targetType: 'photo' }>['photo'];

/**
 * **What the photo subject's read is owed** (B01-5e's seam: `PhotoSubjectView` gains them; S5a serves
 * them). Optional here so the handler builds before the read lands; an absent one is read as the
 * conservative answer — no reveal, no state the server didn't state.
 */
export type PhotoStaffFields = {
  /** The photo's own axis (`visible` | `hidden` | `removed`). */
  moderationStatus?: ModerationStatus | null;
  /** The viewer holds `content.read`: the server served the addresses, and the stage may reveal. */
  canReveal?: boolean;
  /** When it was last hidden or removed. */
  moderatedAt?: number | null;
  /** A removal's deletion day (30 days on), cleared by a restore. */
  purgeAt?: number | null;
  /** The file was deleted on the purge clock: the row is a tombstone. */
  purgedAt?: number | null;
  /** The read cut *On the same report* short of the report's photos (bounded by the report's list). */
  siblingsCut?: boolean;
};

/** A photo on the same report; its own axis when the read serves it. */
export type PhotoSibling = PhotoSubjectData['siblings'][number] & {
  moderationStatus?: ModerationStatus | null;
};

export type PhotoView = Omit<PhotoSubjectData, 'siblings'> &
  PhotoStaffFields & { siblings: PhotoSibling[] };

/** The photo subject as the handler reads it (the seam's fields typed in, none derived). */
export const photoViewOf = (target: Extract<LiveTarget, { targetType: 'photo' }>): PhotoView =>
  target.photo as PhotoView;

/**
 * What the stage draws:
 * - `stage` — the photo, pixelated from its thumbnail until revealed (`full` is its address then);
 * - `noAccess` — the viewer can't see photos (the server served no address): words, no image;
 * - `noFile` — the viewer may see it, but no file was served (the blob is gone);
 * - `purged` — a removal's file deleted on the clock: what was removed, and when.
 */
export type StageState =
  | { kind: 'stage'; thumb: string | null; full: string | null }
  | { kind: 'noAccess' }
  | { kind: 'noFile' }
  | { kind: 'purged'; purgedAt: number; removedAt: number | null };

export function stageState(photo: PhotoView): StageState {
  // A tombstone outranks everything: there is nothing to show, to anyone.
  if (photo.purgedAt != null) {
    return { kind: 'purged', purgedAt: photo.purgedAt, removedAt: photo.moderatedAt ?? null };
  }
  // Only the server's word lets the stage draw: an address served without it is never painted.
  if (photo.canReveal !== true) return { kind: 'noAccess' };
  if (photo.url === null && photo.thumbUrl === null) return { kind: 'noFile' };
  return { kind: 'stage', thumb: photo.thumbUrl, full: photo.url };
}

/** The photo's axis: the subject's own, else the target's (the generic summary carries it too). */
export function photoStatus(
  photo: PhotoView,
  target: Pick<LiveTarget, 'moderationStatus'>,
): ModerationStatus {
  return photo.moderationStatus ?? target.moderationStatus ?? 'visible';
}

/** The stage's caption: when it was taken (else uploaded), and the body it was reported at. */
export function captionLine(photo: PhotoView, timeZone?: string): string {
  return [dayTime(photo.takenAt ?? photo.createdAt, timeZone), photo.body?.name ?? null]
    .filter((x): x is string => x !== null && x !== '')
    .join(' · ');
}

/** "1 of 4 on the report" — its place among the report's photos; `null` off a report. */
export function placeOnReport(photo: PhotoView): string | null {
  if (photo.reportId === null || photo.indexOnReport === null || photo.indexOnReport < 0) {
    return null;
  }
  const total = Math.max(photo.siblings.length, photo.indexOnReport + 1);
  return P.ofReport(
    photo.indexOnReport + 1,
    countWords({ count: total, capped: photo.siblingsCut === true }),
  );
}

/** One thumbnail of *On the same report*. */
export type SiblingView = {
  photoId: string;
  thumbUrl: string | null;
  /** Its place on the report, 1-based. */
  n: number;
  /** The flagged photo itself — matched by id, never by position. */
  self: boolean;
  /** Its label: *Flagged* for this one, its axis for a moderated sibling, else none. */
  label: string | null;
};

/**
 * *On the same report*, in the report's order, **the flagged photo found by its id** (it is not
 * always the first). Empty off a report, or when the report holds only this photo.
 */
export function siblingViews(photo: PhotoView): SiblingView[] {
  if (photo.reportId === null) return [];
  const views = photo.siblings.map((s, i) => {
    const self = s.photoId === photo.photoId;
    const status = s.moderationStatus ?? null;
    return {
      photoId: s.photoId,
      thumbUrl: s.thumbUrl,
      n: i + 1,
      self,
      label: self
        ? P.thisOne
        : status === 'hidden'
          ? P.hidden
          : status === 'removed'
            ? P.removed
            : null,
    };
  });
  return views.length <= 1 && views.every((v) => v.self) ? [] : views;
}

/** "Showing 12 of 20+ photos" under a cut list; `null` while the list is whole. */
export function siblingsCutLine(photo: PhotoView): string | null {
  if (photo.siblingsCut !== true) return null;
  const total = Math.max(photo.siblings.length, (photo.indexOnReport ?? -1) + 1);
  return P.sameReportCut(photo.siblings.length, countWords({ count: total, capped: true }));
}

/** A removed photo's deletion line, while it waits on its 30 days. */
export function purgeLine(photo: PhotoView, status: ModerationStatus, timeZone?: string) {
  if (status !== 'removed' || photo.purgeAt == null || photo.purgedAt != null) return null;
  return P.purgeOn(dayMonth(photo.purgeAt, timeZone));
}
