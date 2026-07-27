/**
 * Deleting a file from Convex storage, and knowing which of the two failures you got (PR #29 review).
 *
 * Every destructive path in the app that owns a blob — export bundles, photos and their thumbnails —
 * needs the same distinction, and none of them can make it from the error alone: `storage.delete`
 * **throws on a file that isn't there**, and there's no error type to switch on. So "already gone" and
 * "delete failed" arrive identically, and the natural `.catch(() => {})` collapses them into a shrug.
 *
 * That shrug is why this module exists. The rows those paths delete next are the *only* pointers to
 * their blobs — the sweeps that would otherwise reclaim them (`sweepExpiredExports`,
 * `sweepOrphanPhotos`) both find their work by reading those tables — so a swallowed failure followed
 * by an unconditional `db.delete` leaves private bytes in storage that nothing in the system can ever
 * name again. Not a leak that a later job cleans up: a leak no later job can see.
 *
 * `storage.getUrl` separates the two cleanly by returning `null` for a missing file. That isn't a
 * guess — it's the behavior `photos.getUrls` already documents and relies on ("a URL is `null` if its
 * stored file is missing").
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Delete one stored blob.
 *
 * Returns `null` when the blob is **provably gone** — deleted just now, or already absent, which for a
 * caller about to drop its pointer are the same happy answer. Returns the failure message when the
 * file is still there, which means: *keep whatever row points at this, or nothing can retry.*
 */
export async function deleteStoredBlob(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
): Promise<string | null> {
  try {
    // `null` ⇒ no such file. Not an error to a caller that wanted it gone.
    if ((await ctx.storage.getUrl(storageId)) === null) return null;
    await ctx.storage.delete(storageId);
    return null;
  } catch (err) {
    // Includes the case where `getUrl` itself rejects — a malformed id, or storage refusing to answer.
    // Reported as a failure rather than as "gone" on purpose: the caller's next move is to keep or
    // drop the only pointer to this blob, and "we couldn't find out" must not be spent as "certain".
    // It also can't take a 500-row sweep down with it; one stuck blob costs one retained row.
    return err instanceof Error ? err.message : String(err);
  }
}
