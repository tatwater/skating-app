import type { ModerationStatus } from '@skating/core';

import { countWords, dayMonth, dayTime } from './flagFormat';
import type { LiveTarget } from './flagTypes';
import { PHOTO_WORDS as P } from './photoWords';

/**
 * **Board 2.7, as data** — pure: what the stage may draw for this viewer, its caption and place on the
 * report, *On the same report*, and the photo's own state (up, hidden, removed with its deletion day,
 * withdrawn by its uploader, or deleted to a tombstone).
 *
 * **What the read serves decides everything here.** The item carries the **thumbnail** only; the full
 * image is fetched on *Show the photo* (`inbox.photoReveal`), so before the reveal its address is in
 * neither the page's markup nor its data. A viewer without `content.read` is served no address of any
 * size (`canReveal: false`), and the stage says so in words with no image at all. A purged photo
 * serves none to anyone. Nothing here derives a staff field the server didn't send.
 */

/** The photo subject as the server serves it (`inbox.item`'s photo flag). */
export type PhotoView = Extract<LiveTarget, { targetType: 'photo' }>['photo'];

/** Another photo on the same report — never the flagged one itself. */
export type PhotoSibling = PhotoView['siblings'][number];

export const photoViewOf = (target: Extract<LiveTarget, { targetType: 'photo' }>): PhotoView =>
  target.photo;

/**
 * What the stage draws:
 * - `stage` — the photo, pixelated from its thumbnail until revealed (the full image comes on Show);
 * - `noAccess` — the viewer can't see photos (the server served no address): words, no image;
 * - `noFile` — the viewer may see it, but no file was served (the blob is gone);
 * - `purged` — a removal's file deleted on the clock: what was removed, and when;
 * - `missing` — a takedown's rotation found its file gone (`bytesMissingAt`): it can't be restored.
 */
export type StageState =
  | { kind: 'stage'; thumb: string }
  | { kind: 'noAccess' }
  | { kind: 'noFile' }
  | { kind: 'purged'; purgedAt: number; removedAt: number | null }
  | { kind: 'missing'; at: number };

export function stageState(photo: PhotoView): StageState {
  // A tombstone outranks everything: there is nothing to show, to anyone.
  if (photo.purgedAt !== null) {
    return { kind: 'purged', purgedAt: photo.purgedAt, removedAt: photo.moderatedAt };
  }
  // The file is gone (found so by its rotation): nothing to show, and nothing to restore.
  if (photo.bytesMissingAt !== null) return { kind: 'missing', at: photo.bytesMissingAt };
  // Only the server's word lets the stage draw: an address served without it is never painted.
  if (!photo.canReveal) return { kind: 'noAccess' };
  if (photo.thumbUrl === null) return { kind: 'noFile' };
  return { kind: 'stage', thumb: photo.thumbUrl };
}

/** The photo's axis, as the server serves it. */
export const photoStatus = (photo: PhotoView): ModerationStatus => photo.moderationStatus;

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
  const total = Math.max(photo.photoCount ?? 0, photo.indexOnReport + 1);
  // The report's own list is counted whole (`photoCount`); a floor only when the read gave none.
  return P.ofReport(
    photo.indexOnReport + 1,
    countWords({ count: total, capped: photo.photoCount === null }),
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
  /** An open flag on another photo: its Inbox item's ref (`flag:<id>`). */
  flagRef: string | null;
  /**
   * Whether *Show the photo* reveals it too: the flagged photo itself, and a neighbor still up with no
   * flag of its own. One flagged on its own, or already hidden or removed, stays pixelated — it is
   * decided in its own item, which its link opens.
   */
  revealable: boolean;
};

/**
 * *On the same report*, in the report's order: the read's **other** photos (never the flagged one),
 * with the flagged photo placed at its own index — so each keeps its place on the report ("Photo 3"),
 * found by id, never by position in the list. Empty off a report, or when it holds only this photo.
 */
export function siblingViews(photo: PhotoView): SiblingView[] {
  if (photo.reportId === null || photo.siblings.length === 0) return [];
  const at = photo.indexOnReport ?? photo.siblings.length;
  const others = photo.siblings.map(
    (s, i): SiblingView => ({
      photoId: s.photoId,
      thumbUrl: s.thumbUrl,
      // The others are served in the report's order: those after the flagged one sit one place on.
      n: i < at ? i + 1 : i + 2,
      self: false,
      label:
        s.moderationStatus === 'hidden'
          ? P.hidden
          : s.moderationStatus === 'removed'
            ? P.removed
            : null,
      flagRef: s.openFlagId === null ? null : `flag:${s.openFlagId}`,
      revealable: s.moderationStatus === 'visible' && s.openFlagId === null,
    }),
  );
  const self: SiblingView = {
    photoId: photo.photoId,
    thumbUrl: photo.thumbUrl,
    n: at + 1,
    self: true,
    label: P.thisOne,
    flagRef: null,
    revealable: true,
  };
  return [...others, self].sort((a, b) => a.n - b.n);
}

/** "Showing 12 of 30 photos" under a strip the read cut; `null` while the strip is whole. */
export function siblingsCutLine(photo: PhotoView): string | null {
  if (!photo.siblingsCut) return null;
  const shown = siblingViews(photo).length;
  const total = Math.max(photo.photoCount ?? 0, shown + 1);
  return P.sameReportCut(shown, countWords({ count: total, capped: photo.photoCount === null }));
}

/** A removed photo's deletion line, while it waits on its 30 days. */
export function purgeLine(photo: PhotoView, timeZone?: string): string | null {
  if (photo.moderationStatus !== 'removed' || photo.purgeAt === null || photo.purgedAt !== null) {
    return null;
  }
  // A withdrawal can't be restored (the server refuses it): its deletion is not "unless restored".
  const day = dayMonth(photo.purgeAt, timeZone);
  return photo.withdrawnAt !== null ? P.purgeOnWithdrawn(day) : P.purgeOn(day);
}

/** Its uploader deleted it while it was held: kept, out of sight, and when. */
export function withdrawnLine(photo: PhotoView, timeZone?: string): string | null {
  if (photo.withdrawnAt === null || photo.purgedAt !== null) return null;
  return P.withdrawn(dayMonth(photo.withdrawnAt, timeZone));
}
