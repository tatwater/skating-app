/**
 * Deciding whether a photo is an orphan (N3).
 *
 * Extracted rather than copied, for the reason N2 recorded when it lifted the cell walk out of
 * `waterBodies`: two destructive callers — the orphan-GC cron and account deletion — must agree
 * exactly on what "unreferenced" means, and a copy would drift. Deleting a *referenced* photo puts a
 * permanent hole in a public report, so this is the one place that answer is derived.
 *
 * **The soundness argument is about who can attach a photo, not about when.**
 *
 * The obvious implementation gathers references from reports and hazards created near the photo's own
 * creation time — which is what the Phase 7b `photo_orphans` metric does, and is fine for a metric that
 * only has to be approximately right. It is **not** sound for a delete, because `reports.update` can
 * change `photoIds`: an old report edited today can newly reference a photo, and a creation-time window
 * would never see it.
 *
 * What closes that hole cheaply is `assertOwnedPhotos` — a report or hazard may only carry photos its
 * own author uploaded. So **the only rows that can ever reference a photo are its uploader's own
 * reports and hazards**, whenever they were written. Scanning by author is therefore both sound and
 * bounded by one person's contribution count rather than by the corpus.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a photo must have existed before the sweep will consider it abandoned.
 *
 * Generous on purpose. A photo uploaded minutes ago is mid-submission, not abandoned — the form
 * uploads before `reports.create` — and an offline draft (F2/D30) can flush a day or more later. The
 * cost of waiting is a few kilobytes; the cost of being early is deleting someone's photo out from
 * under the report they were still writing.
 */
export const PHOTO_ORPHAN_GRACE_MS = 30 * DAY_MS;

/**
 * Ceiling on the per-uploader reference scan. Far above any real contributor; its job is to make a
 * runaway impossible rather than to be reached. Hitting it returns `null` — see below.
 */
export const REFERENCE_SCAN_CAP = 4000;

/**
 * Every photo id referenced by one uploader's own reports and hazards.
 *
 * Returns **`null`** when the scan hit its cap, meaning "couldn't determine" rather than "nothing is
 * referenced". Callers must treat that as *keep the photo*: the two ways of being wrong here are not
 * symmetric, and an orphan that survives another sweep costs storage while a deleted reference costs a
 * public report its evidence.
 */
export async function referencedPhotoIds(
  ctx: QueryCtx | MutationCtx,
  uploaderId: Id<'profiles'>,
): Promise<Set<string> | null> {
  const reports = await ctx.db
    .query('reports')
    .withIndex('by_author', (q) => q.eq('authorId', uploaderId))
    .take(REFERENCE_SCAN_CAP);
  if (reports.length >= REFERENCE_SCAN_CAP) return null;

  const hazards = await ctx.db
    .query('hazards')
    .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', uploaderId))
    .take(REFERENCE_SCAN_CAP);
  if (hazards.length >= REFERENCE_SCAN_CAP) return null;

  const referenced = new Set<string>();
  for (const r of reports) for (const id of r.photoIds) referenced.add(id);
  for (const h of hazards) for (const id of h.photoIds) referenced.add(id);
  return referenced;
}

/**
 * Delete a photo row and both of its stored blobs.
 *
 * Blob failures are swallowed, and the row is deleted regardless — the same call order
 * `photos.remove` already uses. A throw here would strand the row *and* leave the blobs, which is
 * strictly worse than the blob leak the next sweep can't even see.
 */
export async function deletePhotoAndBlobs(ctx: MutationCtx, photo: Doc<'photos'>): Promise<void> {
  await ctx.storage.delete(photo.storageId as Id<'_storage'>).catch(() => {});
  await ctx.storage.delete(photo.thumbStorageId as Id<'_storage'>).catch(() => {});
  await ctx.db.delete(photo._id);
}
