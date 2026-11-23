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
  type ActionCtx,
  type MutationCtx,
  mutation,
  query,
} from './_generated/server';
import { failedAttempt, MAX_ATTEMPTS } from './lib/attempts';
import { writeAudit } from './lib/audit';
import { requireContributor, requireProfile } from './lib/auth';
import { AUTHOR_DELETE_REASON } from './lib/authorDeletion';
import {
  BLOB_NOT_FOUND,
  BLOB_TAKEN,
  blobReferenced,
  PHOTO_PURGE_DELAY_MS,
  photoHeld,
  photoVisible,
  photoWithdrawnAt,
  resolvePhotoUrls,
} from './lib/photoAccess';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { ROTATION_RETRY_MS, scheduleRotation, sweepRotationCopies } from './lib/photoRotation';
import { errorClassOf } from './lib/readBudget';
import { clearFailure, mirrorFailure } from './lib/recurringWork';
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
    // A blob belongs to at most one photo row (B01-5e): a storage id works like a key, so a second
    // row on a held photo's blobs could be removed — deleting the held photo's bytes — or attached
    // to a new report, serving them again. Each id must name a stored file no row holds yet.
    if (args.storageId === args.thumbStorageId) throw new ConvexError(BLOB_TAKEN);
    for (const id of [args.storageId, args.thumbStorageId]) {
      if ((await ctx.db.system.get(id)) === null) throw new ConvexError(BLOB_NOT_FOUND);
      if (await blobReferenced(ctx, id)) throw new ConvexError(BLOB_TAKEN);
    }
    return ctx.db.insert('photos', {
      storageId: args.storageId,
      thumbStorageId: args.thumbStorageId,
      uploaderId: profile._id,
      ...(args.caption !== undefined ? { caption: args.caption } : {}),
      ...(args.takenAt !== undefined ? { takenAt: args.takenAt } : {}),
      ...(coord !== undefined ? { coord } : {}),
      placeOnMap: args.placeOnMap,
      // Stamped at birth (B01-5e), so the rollout's count of rows lacking it reaches zero and stays.
      moderationStatus: 'visible',
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
 * uploader's delete **withdraws** it: down at once (removed, whatever it was), the 30-day purge clock
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

/** How long an unattached upload may be cleaned up by `removeBlob`: a form's life, at most. */
export const PENDING_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** What `removeBlob` says of a blob it won't take: a photo's, or not a fresh unattached upload. */
export const BLOB_ATTACHED = 'Only a fresh upload no photo uses can be removed this way.';

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
  // Always removed: the purge clock stands only on a removed photo (a hidden one's would read as
  // stale, and its bytes would never go). A moderator's verdict on it stands as it was.
  const priorStatus = photo.moderationStatus ?? 'visible';
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
 * Delete a storage blob the client uploaded but never attached to a `photos` row — the cleanup path
 * for a partial upload (one of the full/thumb pair lands, its sibling or `create` fails) or a form
 * abandoned between `generateUploadUrl` and `create`. Idempotent — an already-gone id is a no-op.
 *
 * **Only an unattached, fresh upload** (B01-5e): a storage id works like a key, so this refuses a blob
 * any photo row names (`blobReferenced` — a held photo's bytes can't be taken this way) and one older
 * than {@link PENDING_UPLOAD_MS} (an abandoned form is cleaned up within the hour, not weeks later).
 * Who uploaded a bare blob isn't recorded anywhere today — Convex's upload POST returns the id to the
 * client and writes no owner — so "the caller's own" can't be checked; that wants a pending-uploads
 * row written on upload (a seam). What is left to any signed-in contributor is deleting a fresh blob
 * no photo holds, whose id was only ever returned to its uploader and no read serves.
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
    await requireContributor(ctx);
    const blob = await ctx.db.system.get(storageId);
    if (blob === null) return; // already gone
    if (await blobReferenced(ctx, storageId)) throw new ConvexError(BLOB_ATTACHED);
    if (blob._creationTime < Date.now() - PENDING_UPLOAD_MS) throw new ConvexError(BLOB_ATTACHED);
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
  },
  handler: async (ctx, { reportId }) => {
    const report = await getViewableReport(ctx, reportId);
    if (!report) return [];
    // A photo that isn't visible is never returned, to anyone: its URL, caption and slot (B01-5e).
    // Staff see a down photo through the Inbox item and the record sheet (thumbnail), and its full
    // image only through `inbox.photoReveal`.
    return resolvePhotoUrls(ctx, report.photoIds);
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
  },
  handler: async (ctx, { hazardId }) => {
    const hazard = await ctx.db.get(hazardId);
    if (hazard?.moderationStatus !== 'visible') return [];
    return resolvePhotoUrls(ctx, hazard.photoIds);
  },
});

// ── The byte rotation (B01-5e; the founder's call: a takedown moves the bytes) ────────────────

/**
 * The most a rotation carries in one go: both blobs together, read from `_storage` before either is
 * loaded. The apps upload a full image at most 2,048 px on its long edge and a 400 px thumbnail
 * (`photoPipeline`), a few MiB at worst; 20 MiB rotated in about 4 s on a real backend. A photo past it
 * is never copied — it stays hidden from every read, its old address answering until the purge — and
 * its watch parks.
 */
export const ROTATE_MAX_BYTES = 24 * 1024 * 1024;

export { ROTATION_RETRY_MS } from './lib/photoRotation';

const ROTATION_PARKED_RETRY_MS = 24 * 60 * 60 * 1000;
/** An action's longest life (Convex's 10-minute limit): a run older than this is dead. */
export const ACTION_LIFETIME_MS = 10 * 60 * 1000;

/** What one rotation run did. */
export type RotationOutcome = 'rotated' | 'stale' | 'skipped' | 'missing' | 'failed';

/** Whether the rotation started against `old` has landed, or no longer applies. */
function rotationOver(
  photo: Doc<'photos'> | null,
  old: { storageId: string; thumbStorageId: string },
): boolean {
  return (
    photo === null ||
    photoVisible(photo) ||
    photo.purgedAt !== undefined ||
    photo.bytesMissingAt !== undefined ||
    photo.storageId !== old.storageId ||
    photo.thumbStorageId !== old.thumbStorageId
  );
}

/**
 * **The rotation's watch** — a mutation, so it runs exactly once however the action fared (Convex never
 * retries an action, and one the runtime kills never reaches its own `catch`). It first sweeps the
 * rotation's copies that no row names (`sweepRotationCopies`: the recorded ones, and any stored
 * since the rotation began with the source's bytes — a copy the runtime killed before its record).
 * Then: if the row is no longer down, is purged, has lost its bytes, or no longer holds the old blobs,
 * the rotation is over — its record is cleared and the watch ends. Otherwise one more failure by the
 * attempts rule (`lib/attempts`), the action scheduled again at once and the watch again at the next
 * delay — 1 min, 10 min, 1 h, then parked and daily, never dropped. The attempts ride on its arguments,
 * mirrored into `jobFailures` (`photoRotation`) for Machinery.
 */
export const rotationWatch = internalMutation({
  args: {
    photoId: v.id('photos'),
    oldStorageId: v.string(),
    oldThumbStorageId: v.optional(v.string()),
    attempts: v.optional(v.number()),
    parkedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<'landed' | 'retrying' | 'waiting'> => {
    let photo = await ctx.db.get(args.photoId);
    // A run that began within an action's lifetime may still be alive: its copies aren't strays yet.
    // Look again once it can't be.
    const now = Date.now();
    const runAt = photo?.rotation?.runAt;
    if (runAt !== undefined && runAt > 0 && now - runAt < ACTION_LIFETIME_MS) {
      await ctx.scheduler.runAfter(runAt + ACTION_LIFETIME_MS - now, internal.photos.rotationWatch, args);
      return 'waiting';
    }
    if (photo) {
      await sweepRotationCopies(ctx, photo, { scan: true });
      photo = await ctx.db.get(args.photoId);
    }
    const old = {
      storageId: args.oldStorageId,
      thumbStorageId: args.oldThumbStorageId ?? photo?.thumbStorageId ?? '',
    };
    if (rotationOver(photo, old)) {
      if (photo?.rotation !== undefined) await ctx.db.patch(photo._id, { rotation: undefined });
      // A photo whose bytes are gone keeps its one Machinery row (`markBytesMissing`).
      if (photo?.bytesMissingAt === undefined) {
        await clearFailure(ctx, 'photoRotation', args.photoId);
      }
      return 'landed';
    }
    const { next } = failedAttempt(
      {
        ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
        ...(args.parkedAt !== undefined ? { parkedAt: args.parkedAt } : {}),
      },
      'NotRotated',
      now,
    );
    const delay =
      next.parkedAt !== undefined
        ? ROTATION_PARKED_RETRY_MS
        : (ROTATION_RETRY_MS[next.attempts ?? 1] ?? ROTATION_PARKED_RETRY_MS);
    await mirrorFailure(ctx, 'photoRotation', args.photoId, next, now);
    await ctx.scheduler.runAfter(0, internal.photos.rotateBlobs, { photoId: args.photoId });
    await ctx.scheduler.runAfter(delay, internal.photos.rotationWatch, {
      photoId: args.photoId,
      oldStorageId: old.storageId,
      oldThumbStorageId: old.thumbStorageId,
      ...(next.attempts !== undefined ? { attempts: next.attempts } : {}),
      ...(next.parkedAt !== undefined ? { parkedAt: next.parkedAt } : {}),
    });
    console.warn(
      `photos.rotationWatch: ${args.photoId} not rotated yet, attempt ${next.attempts ?? 1}${next.parkedAt !== undefined ? ', parked' : ''}; scheduled again`,
    );
    return 'retrying';
  },
});

/**
 * **`photos.rotateBlobs` — a takedown moves the bytes** (B01-5e, D222). Started by
 * `lib/photoRotation.scheduleRotation` on a photo's move from up to down (a hide, a removal, an undo
 * back down, an uploader's withdrawal) — never a move between two down states, so a hide then a
 * removal rotates once. An action, because a mutation can't read stored bytes:
 *
 * 1. {@link beginRotation} (a mutation) checks the row is still down and both blobs exist within
 *    {@link ROTATE_MAX_BYTES}, and writes the row's `rotation` record **before any copy exists**;
 * 2. each blob is read (`ctx.storage.get`), stored as a new object (`ctx.storage.store`), and the copy
 *    recorded at once ({@link recordRotationCopy});
 * 3. {@link swapRotated} swaps both ids together — only while the row is still down, still holds the
 *    old ids, and both copies are recorded and stored — and deletes the old blobs in that transaction.
 *
 * Image and thumbnail succeed or fail together: a blob gone at step 1 or 2 stops the rotation for good
 * ({@link markBytesMissing}); nothing is swapped alone. A stale swap or a failure drops this run's
 * copies; whatever a killed run left, the watch sweeps. The old address answers 404 from the swap (no
 * edge cache, proven on dev), a restore serves the new copy and never rotates back. Not audited on its
 * own: a system effect of the takedown.
 *
 * A browser or app that already loaded the photo may keep its own copy for up to 30 days: Convex's
 * storage endpoint serves `cache-control: private, max-age=2592000`, a header of the platform's that
 * `getUrl` gives no way to set.
 */
export const rotateBlobs = internalAction({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }): Promise<{ outcome: RotationOutcome; errorClass?: string }> => {
    const fresh: Id<'_storage'>[] = [];
    let begun = false;
    try {
      const src = await ctx.runMutation(internal.photos.beginRotation, { photoId });
      begun = src.kind === 'go';
      if (src.kind !== 'go') return { outcome: src.kind === 'missing' ? 'missing' : 'skipped' };
      const next: string[] = [];
      for (const id of [src.storageId, src.thumbStorageId]) {
        const bytes = await ctx.storage.get(id as Id<'_storage'>);
        if (bytes === null) {
          await ctx.runMutation(internal.photos.markBytesMissing, { photoId, old: src });
          await dropCopies(ctx, photoId, fresh);
          return { outcome: 'missing' };
        }
        const copy = await ctx.storage.store(bytes);
        fresh.push(copy);
        if (!(await ctx.runMutation(internal.photos.recordRotationCopy, { photoId, copy }))) {
          await dropCopies(ctx, photoId, fresh);
          return { outcome: 'stale' };
        }
        next.push(copy);
      }
      const swapped = await ctx.runMutation(internal.photos.swapRotated, {
        photoId,
        old: { storageId: src.storageId, thumbStorageId: src.thumbStorageId },
        next: { storageId: next[0] as string, thumbStorageId: next[1] as string },
      });
      if (swapped === 'stale') {
        await dropCopies(ctx, photoId, fresh);
        return { outcome: 'stale' };
      }
      return { outcome: 'rotated' };
    } catch (err) {
      const errorClass = errorClassOf(err);
      try {
        await dropCopies(ctx, photoId, fresh);
      } catch (dropErr) {
        console.error(`photos.rotateBlobs: could not drop ${photoId}'s copies; its watch sweeps`, dropErr);
      }
      console.warn(`photos.rotateBlobs: ${photoId} failed (${errorClass}); its watch retries`);
      return { outcome: 'failed', errorClass };
    } finally {
      // Ended, not killed: the watch needn't wait out this run's lifetime. (A run the runtime kills
      // never gets here, and its `runAt` stands until the lifetime has passed.)
      if (begun) await ctx.runMutation(internal.photos.endRotationRun, { photoId });
    }
  },
});

/** A run that ended (whatever its outcome) takes its `runAt` off the record. */
export const endRotationRun = internalMutation({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }) => {
    const photo = await ctx.db.get(photoId);
    if (photo?.rotation !== undefined && photo.rotation.runAt !== 0) {
      await ctx.db.patch(photoId, { rotation: { ...photo.rotation, runAt: 0 } });
    }
  },
});

/** This run's copies, dropped (and taken off the row's record). */
async function dropCopies(
  ctx: { runMutation: ActionCtx['runMutation'] },
  photoId: Id<'photos'>,
  copies: readonly string[],
): Promise<void> {
  if (copies.length > 0) {
    await ctx.runMutation(internal.photos.dropRotationCopies, { photoId, storageIds: [...copies] });
  }
}

/**
 * A rotation's first step: the row still down and unpurged, both blobs in `_storage` within the byte
 * bound (read from the system table, before anything is loaded), and its `rotation` record written —
 * kept as it was if an earlier run's stands, so the watch's scan covers that run's copies too. A blob
 * gone stops the rotation for good (`missing`).
 */
export const beginRotation = internalMutation({
  args: { photoId: v.id('photos') },
  handler: async (
    ctx,
    { photoId },
  ): Promise<
    | { kind: 'go'; storageId: string; thumbStorageId: string }
    | { kind: 'skip' }
    | { kind: 'missing' }
  > => {
    const photo = await ctx.db.get(photoId);
    if (
      !photo ||
      photoVisible(photo) ||
      photo.purgedAt !== undefined ||
      photo.bytesMissingAt !== undefined
    ) {
      return { kind: 'skip' };
    }
    const full = await ctx.db.system.get(photo.storageId as Id<'_storage'>);
    const thumb = await ctx.db.system.get(photo.thumbStorageId as Id<'_storage'>);
    if (full === null || thumb === null) {
      await markMissing(ctx, photo, Date.now());
      return { kind: 'missing' };
    }
    if (full.size + thumb.size > ROTATE_MAX_BYTES) throw new ConvexError('TooLarge');
    const now = Date.now();
    await ctx.db.patch(photoId, {
      rotation:
        photo.rotation === undefined
          ? { startedAt: now, runAt: now, sha256: [full.sha256, thumb.sha256], copies: [] }
          : { ...photo.rotation, runAt: now },
    });
    return { kind: 'go', storageId: photo.storageId, thumbStorageId: photo.thumbStorageId };
  },
});

/**
 * A copy just stored, recorded on the row before anything else can lose it. `false` (and the copy
 * deleted) when the rotation no longer applies — restored, purged, its record swept, or the copy gone.
 */
export const recordRotationCopy = internalMutation({
  args: { photoId: v.id('photos'), copy: v.string() },
  handler: async (ctx, { photoId, copy }): Promise<boolean> => {
    const photo = await ctx.db.get(photoId);
    const alive = (await ctx.db.system.get(copy as Id<'_storage'>)) !== null;
    if (!photo || photo.rotation === undefined || photoVisible(photo) || !alive) {
      if (alive) await deleteStoredBlob(ctx, copy as Id<'_storage'>);
      return false;
    }
    await ctx.db.patch(photoId, {
      rotation: { ...photo.rotation, copies: [...photo.rotation.copies, copy] },
    });
    return true;
  },
});

/** A blob gone when the rotation looked: the photo can't be restored with its bytes. */
export const markBytesMissing = internalMutation({
  args: {
    photoId: v.id('photos'),
    old: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
  },
  handler: async (ctx, { photoId, old }) => {
    const photo = await ctx.db.get(photoId);
    if (!photo || photo.storageId !== old.storageId || photo.thumbStorageId !== old.thumbStorageId) {
      return;
    }
    await markMissing(ctx, photo, Date.now());
  },
});

/** Mark the bytes missing, once, with one parked Machinery row (never retried daily). */
async function markMissing(ctx: MutationCtx, photo: Doc<'photos'>, now: number): Promise<void> {
  if (photo.bytesMissingAt !== undefined) return;
  await ctx.db.patch(photo._id, { bytesMissingAt: now });
  await mirrorFailure(
    ctx,
    'photoRotation',
    photo._id,
    { attempts: MAX_ATTEMPTS, errorClass: 'BytesMissing', parkedAt: now },
    now,
  );
}

/**
 * The swap: both ids together, **only while the row is still down, still holds the old ids, and both
 * copies are recorded and stored** (else `stale`, nothing written). The old blobs are deleted in the
 * same transaction — each honestly (`lib/storageBlobs`); one that won't delete throws, rolling the
 * swap back, so the row keeps pointing at what still answers. The record keeps its start and source
 * hashes for the watch's last sweep; its copies list empties.
 */
export const swapRotated = internalMutation({
  args: {
    photoId: v.id('photos'),
    old: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
    next: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
  },
  handler: async (ctx, { photoId, old, next }): Promise<'rotated' | 'stale'> => {
    const photo = await ctx.db.get(photoId);
    if (photo === null || rotationOver(photo, old) || photo.rotation === undefined) return 'stale';
    for (const id of [next.storageId, next.thumbStorageId]) {
      if (!photo.rotation.copies.includes(id)) return 'stale';
      if ((await ctx.db.system.get(id as Id<'_storage'>)) === null) return 'stale';
    }
    await ctx.db.patch(photoId, {
      storageId: next.storageId,
      thumbStorageId: next.thumbStorageId,
      rotation: { ...photo.rotation, copies: [] },
    });
    for (const was of [old.storageId, old.thumbStorageId]) {
      const failure = await deleteStoredBlob(ctx, was as Id<'_storage'>);
      if (failure !== null) throw new ConvexError('OldBlobKept');
    }
    return 'rotated';
  },
});

/** A run's own copies, when they weren't swapped in: deleted and taken off the record. */
export const dropRotationCopies = internalMutation({
  args: { photoId: v.id('photos'), storageIds: v.array(v.string()) },
  handler: async (ctx, { photoId, storageIds }) => {
    const photo = await ctx.db.get(photoId);
    for (const id of storageIds) {
      if (photo && (photo.storageId === id || photo.thumbStorageId === id)) continue;
      const failure = await deleteStoredBlob(ctx, id as Id<'_storage'>);
      if (failure !== null) {
        console.error(`photos.dropRotationCopies: could not delete copy ${id}: ${failure}`);
      }
    }
    if (photo?.rotation !== undefined) {
      await ctx.db.patch(photoId, {
        rotation: {
          ...photo.rotation,
          copies: photo.rotation.copies.filter((c) => !storageIds.includes(c)),
        },
      });
    }
  },
});
