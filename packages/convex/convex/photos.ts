/**
 * Photo functions (D31/D42). The client optimizes + **strips EXIF** before upload; these functions
 * are the server side of that pipeline. The privacy-critical rule (D42) is enforced here, not just
 * on the client: a photo's GPS `coord` is retained **only** when the uploader explicitly opts into
 * `placeOnMap`, so a client bug can never leak a location.
 */

import { isMinor, isValidCoord, PHOTO_CAPTION_MAX_CHARS, tooLongMessage } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from './_generated/server';
import { failedAttempt } from './lib/attempts';
import { writeAudit } from './lib/audit';
import { requireContributor, requireProfile } from './lib/auth';
import { AUTHOR_DELETE_REASON } from './lib/authorDeletion';
import {
  PHOTO_PURGE_DELAY_MS,
  photoHeld,
  photoVisible,
  photoWithdrawnAt,
  resolvePhotoUrls,
  staffPhotoRead,
} from './lib/photoAccess';
import { errorClassOf } from './lib/readBudget';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { getViewableReport } from './lib/reportVisibility';
import { deleteStoredBlob } from './lib/storageBlobs';
import { recordTextLength } from './lib/textLengths';
import { latLng } from './lib/validators';

/** Mint a one-time Convex storage upload URL for the optimized full image / thumb (auth'd). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireContributor(ctx);
    // Minors are read-only (D41): don't even hand a minor an upload URL (they can't create the row).
    if (isMinor(profile.dateOfBirth, Date.now())) {
      throw new ConvexError('Minors cannot post');
    }
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Record a `photos` row after the client uploads the optimized full + thumb. **D42 enforcement:**
 * drop `coord` unless `placeOnMap === true` — the GPS coord is retained only on explicit opt-in.
 * `takenAt` is passed only when the user opts into the timestamp (client-gated; not location-sensitive).
 */
export const create = mutation({
  args: {
    storageId: v.id('_storage'),
    thumbStorageId: v.id('_storage'),
    caption: v.optional(v.string()),
    takenAt: v.optional(v.number()),
    coord: v.optional(latLng),
    placeOnMap: v.boolean(),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    // Minors are read-only (D41): photos only exist to back a report a minor can't post, so gate
    // the upload surface too — a minor never mints photo rows or storage blobs.
    if (isMinor(profile.dateOfBirth, Date.now())) {
      throw new ConvexError('Minors cannot post');
    }
    // Capped at the write, so a photo row has a known worst case for every read of it.
    const captionTooLong = tooLongMessage('The caption', args.caption, PHOTO_CAPTION_MAX_CHARS);
    if (captionTooLong !== null) throw new ConvexError(captionTooLong);
    // How long the caption is, for the cap's record (counts only).
    await recordTextLength(ctx, 'photo_caption', args.caption);
    // D42: retain a coord ONLY on placeOnMap opt-in — server-side, so a client bug can't leak it.
    const coord = args.placeOnMap ? args.coord : undefined;
    // Range-check before storing (the `latLng` validator checks types, not geographic bounds).
    if (coord !== undefined && !isValidCoord(coord)) {
      throw new ConvexError('Photo coordinate is out of range');
    }
    return ctx.db.insert('photos', {
      storageId: args.storageId,
      thumbStorageId: args.thumbStorageId,
      uploaderId: profile._id,
      ...(args.caption !== undefined ? { caption: args.caption } : {}),
      ...(args.takenAt !== undefined ? { takenAt: args.takenAt } : {}),
      ...(coord !== undefined ? { coord } : {}),
      placeOnMap: args.placeOnMap,
      createdAt: Date.now(),
    });
  },
});

/**
 * The uploader's delete of a photo of theirs (D31/D42) — the cleanup path for a report that never got
 * created, and the sheet's own *remove photo*. Owner-gated; a missing row is a no-op so a
 * double-cleanup or a since-deleted photo can't throw. Not a moderation delete.
 *
 * **An author can't drop evidence** (D248; the B01-5e fork 1 ruling): a photo that is **held** —
 * moderated, under an open flag, or under a standing verdict (`photoHeld`) — is not deleted. Its
 * uploader's delete **withdraws** it: hidden at once (removed, if it was up), the 30-day purge clock
 * started (an earlier one kept), the verdict kept, and an `author_delete` row naming them — final, as
 * every author's deletion is: no restore brings it back. The purge (`photoPurge`) deletes its bytes on
 * the clock and keeps the row as a tombstone. An unheld photo is deleted at once, row and blobs,
 * exactly as before.
 *
 * Shares `lib/photoOrphans`' delete with the background paths (PR #29 review): a blob that is
 * genuinely still there keeps its row, the only thing the orphan sweep could ever find it by.
 */
export const remove = mutation({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }): Promise<{ outcome: PhotoRemoveOutcome }> => {
    const profile = await requireProfile(ctx);
    const photo = await ctx.db.get(photoId);
    if (!photo) return { outcome: 'gone' }; // already gone — idempotent
    if (photo.uploaderId !== profile._id) throw new ConvexError('Not your photo');
    if (await photoHeld(ctx, photo)) {
      await withdrawHeldPhoto(ctx, profile, photo, Date.now());
      return { outcome: 'withdrawn' };
    }
    const result = await deletePhotoAndBlobs(ctx, photo);
    return { outcome: result === 'deleted' ? 'deleted' : 'kept' };
  },
});

/**
 * What the uploader's delete did: `deleted` (row and blobs), `withdrawn` (held: hidden, on the purge
 * clock), `kept` (a blob outlived the delete, so the row stays for the sweep to retry), `gone`.
 */
export type PhotoRemoveOutcome = 'deleted' | 'withdrawn' | 'kept' | 'gone';

/**
 * Withdraw a held photo for its uploader (see {@link remove}). Idempotent: a photo already withdrawn
 * writes nothing. Leaves its flags open and its verdict standing — a moderator still decides.
 */
async function withdrawHeldPhoto(
  ctx: MutationCtx,
  uploader: Doc<'profiles'>,
  photo: Doc<'photos'>,
  now: number,
): Promise<void> {
  if ((await photoWithdrawnAt(ctx, photo._id)) !== null) return;
  const priorStatus = photo.moderationStatus ?? 'visible';
  const newStatus = priorStatus === 'visible' ? 'removed' : priorStatus;
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
    await ctx.scheduler.runAfter(0, internal.photos.rotateBlobs, { photoId: photo._id });
  }
}

/**
 * Delete a storage blob the client uploaded but never attached to a `photos` row — the cleanup path
 * for a partial upload (one of the full/thumb pair lands, its sibling or `create` fails) or a form
 * abandoned between `generateUploadUrl` and `create`. Auth-gated; a bare blob carries no owner row so
 * we can't owner-check it, but a storage id is only ever handed back to the uploader (from an upload
 * URL POST) and isn't enumerable. Idempotent — an already-gone / never-finalized id is a no-op.
 *
 * **The one blob in the system with no row to keep**, so the review's "never drop the only pointer"
 * rule has nothing to hold onto here: a blob that was never attached is, by definition, not in
 * `photos`, and no sweep reads bare storage. What's available instead is honesty about which of the
 * two outcomes happened — `lib/storageBlobs` separates "already gone", the ordinary case this is
 * called for, from a delete that actually failed, which is now logged with its id rather than
 * swallowed indistinguishably. The client still holds that id and its retry is the real backstop.
 */
export const removeBlob = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    await requireProfile(ctx);
    const failure = await deleteStoredBlob(ctx, storageId);
    if (failure !== null) {
      console.warn(`photos.removeBlob: could not delete unattached blob ${storageId}: ${failure}`);
    }
  },
});

/**
 * Resolve serving URLs (full + thumb) for a report's photos — what the report detail UI renders.
 *
 * **Visibility (D13/D42):** URL/coord resolution is gated on the *same* decision as the report
 * query — we serve only the photos referenced by a report the current viewer may see. A caller who
 * once held a photo id therefore can't keep reading media (or its GPS coord) after losing report
 * access; an unviewable or missing report yields `[]`.
 *
 * A URL is `null` if its stored file is missing (deleted/never-finalized), so callers must guard it
 * (never assume a serving URL). Missing photo rows are skipped.
 */
export const getUrls = query({
  args: {
    reportId: v.id('reports'),
    /**
     * A staff read (B01-5e): a hidden or removed photo is returned marked `down`, only to a viewer
     * with `content.read` — the Inbox's photo subject's rule. Without it, or for anyone else, a photo
     * that isn't visible is never returned: not its URL, its caption or its place in the list.
     */
    staff: v.optional(v.boolean()),
  },
  handler: async (ctx, { reportId, staff }) => {
    const report = await getViewableReport(ctx, reportId);
    if (!report) return [];
    return resolvePhotoUrls(ctx, report.photoIds, { staff: await staffPhotoRead(ctx, staff) });
  },
});

/**
 * Serving URLs for a **hazard's** photos (Phase 09a).
 *
 * A standalone on-ice hazard has no report to inherit a gate from, so it carries its own: the hazard
 * must exist and be moderation-`visible`. Note it does **not** require `status: 'active'` — an
 * archived (community-healed) hazard's photos stay readable, because seeing what a spot looked like
 * when it was open is exactly the kind of evidence the next skater benefits from, and archiving is a
 * lifecycle verdict rather than a moderation one (D3).
 */
export const getHazardUrls = query({
  args: {
    hazardId: v.id('hazards'),
    /** A staff read, as `getUrls`' (B01-5e): down photos marked, only with `content.read`. */
    staff: v.optional(v.boolean()),
  },
  handler: async (ctx, { hazardId, staff }) => {
    const hazard = await ctx.db.get(hazardId);
    if (hazard?.moderationStatus !== 'visible') return [];
    return resolvePhotoUrls(ctx, hazard.photoIds, { staff: await staffPhotoRead(ctx, staff) });
  },
});

// ── The byte rotation (B01-5e; the founder's call: a takedown moves the bytes) ────────────────

/**
 * The most a rotation carries in one go: both blobs together. The apps upload a full image at most
 * 2,048 px on its long edge and a 400 px thumbnail (`photoPipeline`), a few MiB at worst; this bound
 * keeps a hand-crafted upload from holding an action's memory. A photo past it is never rotated — it
 * stays hidden from every read, and its old address answers until the purge — and its failure parks.
 */
export const ROTATE_MAX_BYTES = 24 * 1024 * 1024;

/** Retries after the first failures (1 min, 10 min, 1 h); parked after `MAX_ATTEMPTS`, then daily. */
export const ROTATION_RETRY_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;
const ROTATION_PARKED_RETRY_MS = 24 * 60 * 60 * 1000;

/** What one rotation did. */
export type RotationOutcome = 'rotated' | 'stale' | 'skipped' | 'retrying';

/**
 * **`photos.rotateBlobs` — a takedown moves the bytes** (B01-5e, D222). Scheduled by a photo's move from
 * up to down — a hide, a removal, an undo that takes it back down, an uploader's withdrawal — never by a
 * move between two down states (a hide then a removal rotates once). An action, because a mutation
 * can't read stored bytes: it reads the full image and the thumbnail (`ctx.storage.get`), stores each
 * as a new object (`ctx.storage.store`), then swaps the row's ids through {@link swapRotated} — only
 * while the row is **still moderated and still holds the old ids** — which deletes the old blobs in the
 * same transaction. The old address answers 404 from that moment (proven on dev: no edge cache), and a
 * restore serves the new copy, whose address no skater has seen; the restore never rotates back.
 *
 * - **Not audited on its own**: a system effect of the takedown.
 * - **A stale swap** (restored, purged, or rotated by another run meanwhile) writes nothing, and the
 *   copies this run stored are deleted — no orphan, no double delete of the old blobs.
 * - **A failure** (a read, a store, the swap) deletes the copies this run stored and retries by the
 *   attempts rule (`lib/attempts`): 1 min, 10 min, 1 h, then parked and retried daily — never dropped.
 *   The photo stays hidden from every read meanwhile (`photoVisible`). The attempts ride on the
 *   scheduled call; Machinery can't list a parked rotation until it has a `jobFailures` job of its own
 *   (a seam this PR asks for).
 * - **No sweep takes a blob mid-rotation**: the photo is moderated, so every deleter refuses it
 *   (`photoHeld`), and a copy not yet swapped in is on no row for any sweep to find. The purge reads the
 *   row's ids when it runs, so after a rotation it deletes the new blobs.
 *
 * A browser or app that already loaded the photo may keep its own copy for up to 30 days: Convex's
 * storage endpoint serves `cache-control: private, max-age=2592000`, a header of the platform's that
 * `getUrl` gives no way to set. Nothing server-side reaches a viewer's cache; the console says so.
 */
export const rotateBlobs = internalAction({
  args: {
    photoId: v.id('photos'),
    /** The attempts rule's state, carried on the retry (absent on the first). */
    attempts: v.optional(v.number()),
    errorClass: v.optional(v.string()),
    parkedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ outcome: RotationOutcome; errorClass?: string }> => {
    const { photoId } = args;
    const fresh: Id<'_storage'>[] = [];
    try {
      const src = await ctx.runQuery(internal.photos.rotationSource, { photoId });
      if (src === null) return { outcome: 'skipped' };
      const [full, thumb] = await Promise.all([
        ctx.storage.get(src.storageId as Id<'_storage'>),
        ctx.storage.get(src.thumbStorageId as Id<'_storage'>),
      ]);
      if ((full?.size ?? 0) + (thumb?.size ?? 0) > ROTATE_MAX_BYTES) {
        throw new RotationError('TooLarge');
      }
      // A blob already gone (never finalized, or deleted) has nothing to carry: its id stays, and
      // still serves nothing.
      const nextFull = full ? await ctx.storage.store(full) : (src.storageId as Id<'_storage'>);
      if (full) fresh.push(nextFull);
      const nextThumb = thumb
        ? await ctx.storage.store(thumb)
        : (src.thumbStorageId as Id<'_storage'>);
      if (thumb) fresh.push(nextThumb);
      const swapped = await ctx.runMutation(internal.photos.swapRotated, {
        photoId,
        old: src,
        next: { storageId: nextFull, thumbStorageId: nextThumb },
      });
      if (swapped === 'stale') {
        await ctx.runMutation(internal.photos.dropRotationCopies, { storageIds: fresh });
        return { outcome: 'stale' };
      }
      return { outcome: 'rotated' };
    } catch (err) {
      const errorClass = err instanceof RotationError ? err.message : errorClassOf(err);
      if (fresh.length > 0) {
        try {
          await ctx.runMutation(internal.photos.dropRotationCopies, { storageIds: fresh });
        } catch (dropErr) {
          console.error(`photos.rotateBlobs: could not drop ${photoId}'s copies`, dropErr);
        }
      }
      const now = Date.now();
      const { next } = failedAttempt(
        {
          ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
          ...(args.parkedAt !== undefined ? { parkedAt: args.parkedAt } : {}),
        },
        errorClass,
        now,
      );
      const delay =
        next.parkedAt !== undefined
          ? ROTATION_PARKED_RETRY_MS
          : (ROTATION_RETRY_MS[(next.attempts ?? 1) - 1] ?? ROTATION_PARKED_RETRY_MS);
      await ctx.scheduler.runAfter(delay, internal.photos.rotateBlobs, {
        photoId,
        ...(next.attempts !== undefined ? { attempts: next.attempts } : {}),
        errorClass,
        ...(next.parkedAt !== undefined ? { parkedAt: next.parkedAt } : {}),
      });
      console.warn(
        `photos.rotateBlobs: ${photoId} failed (${errorClass}), attempt ${next.attempts ?? 1}${next.parkedAt !== undefined ? ', parked' : ''}; retried`,
      );
      return { outcome: 'retrying', errorClass };
    }
  },
});

/** A rotation failure whose class is its message (never content). */
class RotationError extends Error {}

/** What a rotation reads: the row's blob ids, while it is still down and not purged. */
export const rotationSource = internalQuery({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }) => {
    const photo = await ctx.db.get(photoId);
    if (!photo || photoVisible(photo) || photo.purgedAt !== undefined) return null;
    return { storageId: photo.storageId, thumbStorageId: photo.thumbStorageId };
  },
});

/**
 * The swap: the row takes the new ids **only while it is still moderated and still holds the old ones**
 * (else `stale`, nothing written), and the old blobs are deleted in the same transaction — each
 * honestly (`lib/storageBlobs`); one that won't delete throws, rolling the swap back, so the row keeps
 * pointing at what still answers and the rotation retries.
 */
export const swapRotated = internalMutation({
  args: {
    photoId: v.id('photos'),
    old: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
    next: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
  },
  handler: async (ctx, { photoId, old, next }): Promise<'rotated' | 'stale'> => {
    const photo = await ctx.db.get(photoId);
    if (
      !photo ||
      photoVisible(photo) ||
      photo.purgedAt !== undefined ||
      photo.storageId !== old.storageId ||
      photo.thumbStorageId !== old.thumbStorageId
    ) {
      return 'stale';
    }
    await ctx.db.patch(photoId, { storageId: next.storageId, thumbStorageId: next.thumbStorageId });
    for (const [was, now] of [
      [old.storageId, next.storageId],
      [old.thumbStorageId, next.thumbStorageId],
    ] as const) {
      if (was === now) continue;
      const failure = await deleteStoredBlob(ctx, was as Id<'_storage'>);
      if (failure !== null) throw new RotationError('OldBlobKept');
    }
    return 'rotated';
  },
});

/** A rotation's own copies, when they weren't swapped in: deleted, so none is left on no row. */
export const dropRotationCopies = internalMutation({
  args: { storageIds: v.array(v.string()) },
  handler: async (ctx, { storageIds }) => {
    for (const id of storageIds) {
      const failure = await deleteStoredBlob(ctx, id as Id<'_storage'>);
      if (failure !== null) {
        console.error(`photos.dropRotationCopies: could not delete copy ${id}: ${failure}`);
      }
    }
  },
});
