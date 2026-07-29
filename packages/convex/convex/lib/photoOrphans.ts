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
import { deleteStoredBlob } from './storageBlobs';

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
 * Every photo id referenced by one uploader's own reports and hazards — the **fast path**, answered in
 * a single transaction.
 *
 * Returns **`null`** when the scan hit its cap, meaning "couldn't determine" rather than "nothing is
 * referenced". Callers must treat that as *keep the photo*: the two ways of being wrong here are not
 * symmetric, and an orphan that survives another sweep costs storage while a deleted reference costs a
 * public report its evidence.
 *
 * **A `null` is not an answer to be retried, it's a method to be escalated from** (PR #30 review). The
 * cap is a property of the *uploader* — how many reports and hazards they have — not of the photo or
 * of the moment, so re-running this tomorrow returns `null` again, and every day after that. Treating
 * it as a transient failure is what made a prolific uploader's abandoned images permanent, including
 * after their account was deleted.
 *
 * So `storageHygiene.sweepOrphanPhotos` hands the uploader to `photoReconcile`, which answers the same
 * question completely by spreading it over as many transactions as it needs. This function stays the
 * cheap common case; that job is the one that always terminates.
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
 * The subset of an uploader's photos that are attached to a **hazard** (D66).
 *
 * The seam the seasonal photo expiry rests on: a picture of an open lead is worth more than any
 * sentence describing one, and it is exactly what the next skater on that shore needs — so a departed
 * skater's hazard photos are kept whole and everything else expires with its season. `null` means the
 * scan hit its cap, which is "couldn't determine" and never "nothing is attached": the caller keeps
 * the photo, because deleting an image on an unanswered question is the one mistake here that can't
 * be undone.
 *
 * Deliberately *not* expressed as a filter over {@link referencedPhotoIds}: that set unions reports
 * and hazards, and the whole point of this one is that those two answers are now different.
 */
export async function hazardPhotoIds(
  ctx: QueryCtx | MutationCtx,
  uploaderId: Id<'profiles'>,
): Promise<Set<string> | null> {
  const hazards = await ctx.db
    .query('hazards')
    .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', uploaderId))
    .take(REFERENCE_SCAN_CAP);
  if (hazards.length >= REFERENCE_SCAN_CAP) return null;
  const referenced = new Set<string>();
  for (const h of hazards) for (const id of h.photoIds) referenced.add(id);
  return referenced;
}

/**
 * Delete a photo row and both of its stored blobs. Returns whether the **row is gone** — `false` means
 * a blob outlived the attempt and the row was deliberately kept.
 *
 * This used to swallow both blob errors and delete the row regardless, reasoning that a throw would
 * strand the row *and* leave the blobs, "strictly worse than the blob leak the next sweep can't even
 * see." The premise is right and the conclusion doesn't follow, because those aren't the only two
 * options (PR #29 review). **The row is the only pointer to those two blobs** — `sweepOrphanPhotos`
 * finds its work by reading `photos` — so the parenthetical was the whole problem, not an aside: a
 * leak no sweep can see is a leak nobody will ever clean up, holding someone's private image bytes,
 * possibly with a GPS coordinate, indefinitely.
 *
 * So the third option: don't throw *and* don't drop the pointer. A photo whose blob is provably gone
 * loses its row; one whose blob is still there keeps it, and the daily sweep tries again — which costs
 * a row nobody can see and buys a retry that can actually happen. `lib/storageBlobs` is what makes
 * "provably gone" a real check rather than a swallowed error.
 *
 * **No operator alert at a threshold**, unlike the export bundles that share this shape. That's a
 * proportionality call, not an oversight: a stuck export is a complete copy of one account and worth
 * paging someone over, while a stuck photo is one image whose retry is free and whose count shows up
 * in the sweep's `retained` every day.
 */
export async function deletePhotoAndBlobs(
  ctx: MutationCtx,
  photo: Doc<'photos'>,
): Promise<boolean> {
  const failures = [
    await deleteStoredBlob(ctx, photo.storageId as Id<'_storage'>),
    await deleteStoredBlob(ctx, photo.thumbStorageId as Id<'_storage'>),
  ].filter((f): f is string => f !== null);

  if (failures.length > 0) {
    console.warn(
      `photos: keeping row ${photo._id} — ${failures.length} of its blobs could not be deleted (${failures.join('; ')}). It is the only pointer to them; the orphan sweep retries daily.`,
    );
    return false;
  }
  await ctx.db.delete(photo._id);
  return true;
}
