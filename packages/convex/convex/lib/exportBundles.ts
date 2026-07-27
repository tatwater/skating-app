/**
 * Reclaiming a data-export bundle's stored blob (PR #29 review).
 *
 * Both callers — the expiry sweep and account deletion — used to do this inline, identically, and
 * identically wrong: `storage.delete(...).catch(() => {})` followed unconditionally by `db.delete(row)`.
 * That reasoning came from `photos.remove`, where swallowing a blob error to make sure the row still
 * goes is right, because a stranded photo row is worse than a stranded thumbnail. **An export bundle
 * inverts it.** The row is the only pointer to the densest concentration of one person's data in the
 * system, and a Convex storage URL can't be revoked except by deleting the blob — so dropping the row
 * after a failed delete is the one move that makes the bundle permanently unreachable *by us* and
 * indefinitely reachable by anyone holding an old link.
 *
 * So this is the one place that decision is made, for both callers.
 *
 * **The precise part** is telling "already gone" from "delete failed", which matters because
 * `storage.delete` throws on a missing blob and there's no error type to switch on. `storage.getUrl`
 * answers it directly: it returns `null` for a file that isn't there. That isn't a guess — it's the
 * same behavior `photos.getUrls` already documents and relies on ("a URL is `null` if its stored file
 * is missing").
 */

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * How many failed reclaims before a human is told. Five hourly attempts is most of a working day —
 * long enough that a transient storage blip resolves itself, short enough that a genuinely stuck
 * bundle doesn't sit unmentioned.
 */
const MAX_CLEANUP_ATTEMPTS = 5;

/**
 * Reclaim an export's blob. Returns whether the **row may now be deleted** — which is only true when
 * the blob is provably gone.
 *
 * When it returns `false` the caller must keep the row: that row is what the next sweep tick uses to
 * try again. The counter is bounded not by giving up on the row (we never drop the pointer) but by
 * alerting once at the threshold, so a stuck bundle produces one page rather than one per hour.
 */
export async function reclaimExportBlob(
  ctx: MutationCtx,
  row: Doc<'dataExports'>,
): Promise<boolean> {
  if (row.storageId === undefined) return true; // never got as far as storing anything

  const storageId = row.storageId as Id<'_storage'>;
  // Already gone — the row is a dangling pointer, so dropping it strands nothing.
  if ((await ctx.storage.getUrl(storageId)) === null) return true;

  try {
    await ctx.storage.delete(storageId);
    return true;
  } catch (err) {
    const attempts = (row.cleanupAttempts ?? 0) + 1;
    await ctx.db.patch(row._id, { cleanupAttempts: attempts });
    console.warn(
      `dataExports: could not reclaim ${storageId} for ${row._id} (attempt ${attempts}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Exactly at the threshold, not past it — the row is kept and retried forever, but a human is
    // told once. The `storageId` is in the alert because it is the only handle they have.
    if (attempts === MAX_CLEANUP_ATTEMPTS) {
      await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
        subject: 'Data-export bundle could not be deleted',
        heading: `Stuck export bundle ${storageId}`,
        lines: [
          `Storage id: ${storageId} (dataExports row ${row._id}).`,
          `${attempts} attempts to delete it have failed. The bundle is a full copy of one account's data — profile, reports, tracks and photos — and a Convex storage URL stays valid until the file is deleted, so anyone holding an old link can still fetch it.`,
          'Delete the file from the Convex dashboard. The row is deliberately being kept so this stays findable; it disappears on its own once the blob is gone.',
        ],
        deepLinkPath: '/admin',
      });
    }
    return false;
  }
}
