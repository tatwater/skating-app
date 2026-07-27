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
 * **The precise part** — telling "already gone" from "delete failed" — is `lib/storageBlobs`, which
 * the photo paths turned out to need too. What stays here is the *policy* that distinction feeds: an
 * export row is never dropped on a failed reclaim, it's retried and eventually escalated.
 */

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { deleteStoredBlob } from './storageBlobs';

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
  // `null` ⇒ deleted now, or already gone and the row was a dangling pointer. Either way the row may go.
  const failure = await deleteStoredBlob(ctx, storageId);
  if (failure === null) return true;

  const attempts = (row.cleanupAttempts ?? 0) + 1;
  await ctx.db.patch(row._id, { cleanupAttempts: attempts });
  console.warn(
    `dataExports: could not reclaim ${storageId} for ${row._id} (attempt ${attempts}): ${failure}`,
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

/**
 * Put a pointer *back* in front of a stored bundle that has no row left (PR #29 review, second pass).
 *
 * `finishExport`'s missing-row branch is the one place in the system holding a `storageId` with no row
 * behind it — the account was deleted while its export was still building. When the reclaim there
 * fails, the previous version's entire durable record was a `console.error` plus one fire-and-forget
 * operator email, and **that email is a no-op until the prod cutover** (`OPERATOR_ALERT_EMAIL` and the
 * Resend keys ship unset, by design). So the realistic outcome of a failed reclaim was: a complete copy
 * of a just-deleted person's account, in storage, with its only identifier in a log line.
 *
 * Re-inserting the row fixes that with no new machinery: an already-expired `dataExports` row is
 * exactly what `sweepExpiredExports` looks for, so the bundle re-enters the hourly retry loop and
 * escalates to a human at the usual threshold. It is inert as a user-facing export — `failed`, expired,
 * so `myExports` offers no URL for it — and it disappears on its own the moment the blob is gone.
 *
 * `userId` is why `finishExport` takes one: it's the single field the re-created pointer can't
 * recover from the row it's replacing, and the schema requires it. The profile it names is a tombstone
 * by now, which is fine — nothing reads this row except the sweep, which only wants the `storageId`.
 */
export async function retainOrphanedBundle(
  ctx: MutationCtx,
  args: { userId: Id<'profiles'>; storageId: Id<'_storage'>; error: string },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('dataExports', {
    userId: args.userId,
    status: 'failed',
    storageId: args.storageId,
    error: args.error,
    cleanupAttempts: 1, // this failure counts — the sweep escalates after MAX_CLEANUP_ATTEMPTS more
    requestedAt: now,
    expiresAt: now, // expired on arrival: the next hourly sweep picks it up
  });
}
