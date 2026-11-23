/**
 * **An author removing their own held photo withdraws it** (D248; B01-5e, ruled after the web review)
 * — by `photos.remove`, or by leaving it out of an edit. One rule, so the two can't disagree: a held
 * photo that is still up goes down at once (removed, on the 30-day purge clock, an `author_delete`
 * row naming them, its bytes rotated), and stays attached to its report as evidence, hidden from
 * every non-staff read. One already hidden or removed is left as it is.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { writeAudit } from './audit';
import { AUTHOR_DELETE_REASON } from './authorDeletion';
import { PHOTO_PURGE_DELAY_MS, photoHeld, photoVisible, photoWithdrawnAt } from './photoAccess';
import { scheduleRotation } from './photoRotation';

/**
 * Withdraw a held photo for its uploader (see {@link remove}). Idempotent: a photo already withdrawn
 * writes nothing. Leaves its flags open and its verdict standing — a moderator still decides.
 */
export async function withdrawHeldPhoto(
  ctx: MutationCtx,
  uploader: Doc<'profiles'>,
  photo: Doc<'photos'>,
  now: number,
): Promise<void> {
  if ((await photoWithdrawnAt(ctx, photo._id)) !== null) return;
  // Always removed: the purge clock stands only on a removed photo (a hidden one's would read as
  // stale, and its bytes would never go). A moderator's verdict on it stands as it was.
  const priorStatus = photo.moderationStatus;
  const newStatus = 'removed' as const;
  await ctx.db.patch(photo._id, {
    moderationStatus: newStatus,
    ...(newStatus !== priorStatus ? { moderatedAt: now } : {}),
    purgeAt: Math.min(photo.purgeAt ?? Number.POSITIVE_INFINITY, now + PHOTO_PURGE_DELAY_MS),
  });
  await writeAudit(ctx, {
    actorId: uploader._id,
    action: 'author_delete',
    targetType: 'photo',
    targetId: photo._id,
    reason: AUTHOR_DELETE_REASON,
    metadata: { priorStatus, newStatus, subjectUserId: uploader._id },
    createdAt: now,
  });
  // A withdrawal that takes the photo down moves its bytes, as a takedown does (`rotateBlobs`).
  if (priorStatus === 'visible') {
    await scheduleRotation(ctx, photo);
  }
}

/**
 * **An author's edit of a report's photo list** (D248): the photos sent, then — after them, in their
 * old order — every photo of `before` the edit leaves out that is held (moderated, flagged, under a
 * decision, or mid-rotation): kept attached as evidence, and, if it is still up, withdrawn
 * ({@link withdrawHeldPhoto}) — the same as deleting it. A photo that is gone, or not held, drops as
 * the edit asked. The same rule on every path that re-sends a report's list (`reports.update` is the
 * only one: a Post's album is derived from its members, `lib/postSync`).
 */
export async function keepAndWithdrawHeld(
  ctx: MutationCtx,
  author: Doc<'profiles'>,
  sent: readonly Id<'photos'>[],
  before: readonly Id<'photos'>[],
  now: number,
): Promise<Id<'photos'>[]> {
  const kept = new Set<string>(sent);
  const out = [...sent];
  for (const photoId of before) {
    if (kept.has(photoId)) continue;
    const photo = await ctx.db.get(photoId);
    if (!photo || !(await photoHeld(ctx, photo))) continue;
    out.push(photoId);
    kept.add(photoId);
    if (photoVisible(photo) && photo.uploaderId === author._id) {
      await withdrawHeldPhoto(ctx, author, photo, now);
    }
  }
  return out;
}
