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
  type MutationCtx,
  mutation,
  query,
} from './_generated/server';
import { failedAttempt, MAX_ATTEMPTS } from './lib/attempts';
import { requireContributor, requireProfile } from './lib/auth';
import {
  BLOB_NOT_FOUND,
  BLOB_TAKEN,
  photoHeld,
  photoVisible,
  resolvePhotoUrls,
} from './lib/photoAccess';
import {
  ACTION_LIFETIME_MS,
  attemptAlive,
  copyContentType,
  DOOMED_PER_PASS,
  fileTaken,
  holdersOf,
  isRotationCopy,
  ledgerOfPhoto,
  ledgerRowOf,
  openAttempts,
  photoFilesSettled,
  reconcileAttempt,
  recordCopy,
  releaseFile,
  retryDoomed,
  SAME_BYTES_MAX,
} from './lib/photoFiles';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { ROTATION_RETRY_MS } from './lib/photoRotation';
import { withdrawHeldPhoto } from './lib/photoWithdraw';
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
      if (await fileTaken(ctx, id)) throw new ConvexError(BLOB_TAKEN);
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
    if (await fileTaken(ctx, storageId)) throw new ConvexError(BLOB_ATTACHED);
    // A rotation's copy (recorded or not yet) is no one's upload: its attempt lets it go.
    if (isRotationCopy(blob.contentType)) throw new ConvexError(BLOB_ATTACHED);
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
//
// Every step keeps `lib/photoFiles`' invariants: an attempt row before anything is stored, each copy
// recorded the moment it is stored, a released file deleted or owed a deletion, the watch ending only
// when nothing of the photo's is in flight or owed.

/**
 * The most a rotation carries in one go: both files together, read from `_storage` before either is
 * loaded. The apps upload a full image at most 2,048 px on its long edge and a 400 px thumbnail
 * (`photoPipeline`), a few MiB at worst; 20 MiB rotated in about 4 s on a real backend. A photo past it
 * is never copied — it stays hidden from every read, its old address answering until the purge — and
 * its watch parks.
 */
export const ROTATE_MAX_BYTES = 24 * 1024 * 1024;

export { ACTION_LIFETIME_MS } from './lib/photoFiles';
export { ROTATION_RETRY_MS } from './lib/photoRotation';

const ROTATION_PARKED_RETRY_MS = 24 * 60 * 60 * 1000;

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
 * retries an action, and one the runtime kills never reaches its own `catch`). Each run:
 *
 * 1. waits, if an attempt's action may still be alive (its lifetime from `startedAt`);
 * 2. reconciles every attempt that can't be alive — its unswapped copies released, a page of its own
 *    window searched for a copy it stored and never recorded — and retries the photo's due doomed files;
 * 3. if the rotation is not over, starts another attempt by the attempts rule (1 min, 10 min, 1 h,
 *    then parked and daily), mirrored to Machinery (`photoRotation`);
 * 4. ends only when the rotation is over **and** nothing of the photo's is in flight or owed;
 *    otherwise it looks again (a minute on while there is reconciling to do, else when the next doomed
 *    retry is due).
 */
export const rotationWatch = internalMutation({
  args: {
    photoId: v.id('photos'),
    oldStorageId: v.string(),
    oldThumbStorageId: v.optional(v.string()),
    attempts: v.optional(v.number()),
    parkedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<'landed' | 'retrying' | 'waiting' | 'settling'> => {
    const now = Date.now();
    const again = (delay: number, extra: Record<string, unknown> = {}) =>
      ctx.scheduler.runAfter(delay, internal.photos.rotationWatch, { ...args, ...extra });
    const attempts = await openAttempts(ctx, args.photoId);
    const alive = attempts.find((a) => attemptAlive(a, now));
    if (alive) {
      await again(alive.startedAt + ACTION_LIFETIME_MS - now);
      return 'waiting';
    }
    let reconciled = true;
    for (const a of attempts) reconciled = (await reconcileAttempt(ctx, a, now)) && reconciled;
    await retryDoomed(ctx, now, args.photoId);

    const photo = await ctx.db.get(args.photoId);
    const old = {
      storageId: args.oldStorageId,
      thumbStorageId: args.oldThumbStorageId ?? photo?.thumbStorageId ?? '',
    };
    if (rotationOver(photo, old)) {
      if (await photoFilesSettled(ctx, args.photoId)) {
        // A photo whose bytes are gone keeps its one Machinery row (`markBytesMissing`).
        if (photo?.bytesMissingAt === undefined) {
          await clearFailure(ctx, 'photoRotation', args.photoId);
        }
        return 'landed';
      }
      // Something is still owed: look again once it can have moved.
      const owed = await ledgerOfPhoto(ctx, args.photoId, DOOMED_PER_PASS);
      const nextDue = Math.min(
        ...owed.filter((r) => r.state === 'doomed').map((r) => r.nextTryAt),
        now + (reconciled ? ROTATION_PARKED_RETRY_MS : ROTATION_RETRY_MS[0]),
      );
      await again(Math.max(ROTATION_RETRY_MS[0], nextDue - now));
      return 'settling';
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
    await again(delay, {
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
 * back down, an uploader's withdrawal) — never a move between two down states. An action, because a
 * mutation can't read stored bytes:
 *
 * 1. {@link beginRotation} checks the row is still down and both files exist within
 *    {@link ROTATE_MAX_BYTES}, and writes the attempt row **before anything is stored**;
 * 2. each file is read, stored as a new object, and the copy recorded at once ({@link recordRotationCopy});
 * 3. {@link swapRotated} swaps both ids together — only while the row is still down, still holds the
 *    old ids, and both copies are this attempt's — and releases the old files: deleted, or owed a
 *    deletion, or left to another row that still names one (a legacy shared file).
 *
 * Image and thumbnail succeed or fail together: a file gone stops the rotation for good
 * ({@link markBytesMissing}). Whatever a run leaves — a stale swap, a failure, a kill at any step — the
 * attempt's reconcile releases (`lib/photoFiles.reconcileAttempt`). The old address answers 404 once
 * its file is deleted (no edge cache, proven on dev); a restore serves the new copy and never rotates
 * back. A browser that already loaded the photo may keep it up to 30 days (`private, max-age=2592000`,
 * Convex's header, not ours to set). Not audited on its own: a system effect of the takedown.
 */
export const rotateBlobs = internalAction({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }): Promise<{ outcome: RotationOutcome; errorClass?: string }> => {
    let attemptId: Id<'photoRotations'> | null = null;
    try {
      const src = await ctx.runMutation(internal.photos.beginRotation, { photoId });
      if (src.kind !== 'go') return { outcome: src.kind === 'missing' ? 'missing' : 'skipped' };
      attemptId = src.attemptId;
      const next: string[] = [];
      for (const id of [src.storageId, src.thumbStorageId]) {
        const bytes = await ctx.storage.get(id as Id<'_storage'>);
        if (bytes === null) {
          await ctx.runMutation(internal.photos.markBytesMissing, { photoId, old: src });
          return { outcome: 'missing' };
        }
        // Tagged with its attempt (a content-type parameter; it still serves as the image), so the
        // window's search can tell this attempt's unrecorded copy from anyone's same bytes.
        const copy = await ctx.storage.store(
          bytes.slice(0, bytes.size, copyContentType(bytes.type, attemptId)),
        );
        await ctx.runMutation(internal.photos.recordRotationCopy, { attemptId, copy });
        next.push(copy);
      }
      const swapped = await ctx.runMutation(internal.photos.swapRotated, {
        attemptId,
        old: { storageId: src.storageId, thumbStorageId: src.thumbStorageId },
        next: { storageId: next[0] as string, thumbStorageId: next[1] as string },
      });
      return { outcome: swapped };
    } catch (err) {
      const errorClass = errorClassOf(err);
      console.warn(`photos.rotateBlobs: ${photoId} failed (${errorClass}); its watch retries`);
      return { outcome: 'failed', errorClass };
    } finally {
      // Ended, not killed: its leftovers released now, its window searched by the reconcile.
      if (attemptId !== null) await ctx.runMutation(internal.photos.endRotation, { attemptId });
    }
  },
});

/**
 * A rotation attempt's first step: the row still down, unpurged, its files in `_storage` within the
 * byte bound (read from the system table, before anything is loaded), no other attempt alive — and the
 * attempt row written before anything is stored (invariant 3). A file gone stops the rotation for good.
 */
export const beginRotation = internalMutation({
  args: { photoId: v.id('photos') },
  handler: async (
    ctx,
    { photoId },
  ): Promise<
    | { kind: 'go'; attemptId: Id<'photoRotations'>; storageId: string; thumbStorageId: string }
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
    const now = Date.now();
    if ((await openAttempts(ctx, photoId)).some((a) => attemptAlive(a, now)))
      return { kind: 'skip' };
    const full = await ctx.db.system.get(photo.storageId as Id<'_storage'>);
    const thumb = await ctx.db.system.get(photo.thumbStorageId as Id<'_storage'>);
    if (full === null || thumb === null) {
      await markMissing(ctx, photo, now);
      return { kind: 'missing' };
    }
    if (full.size + thumb.size > ROTATE_MAX_BYTES) throw new ConvexError('TooLarge');
    const attemptId = await ctx.db.insert('photoRotations', {
      photoId,
      startedAt: now,
      sha256: [full.sha256, thumb.sha256],
      // Exclusive lower bound of the window's search: anything this attempt stores is later.
      scanFrom: now - 1,
      status: 'running',
    });
    return {
      kind: 'go',
      attemptId,
      storageId: photo.storageId,
      thumbStorageId: photo.thumbStorageId,
    };
  },
});

/**
 * A copy just stored, recorded on the ledger before anything else can lose it (invariant 3). An attempt
 * no longer running (its reconcile may already have run) can't take it: the copy is released at once —
 * deleted, or owed a deletion.
 */
export const recordRotationCopy = internalMutation({
  args: { attemptId: v.id('photoRotations'), copy: v.string() },
  handler: async (ctx, { attemptId, copy }) => {
    const attempt = await ctx.db.get(attemptId);
    const now = Date.now();
    if (attempt?.status !== 'running') {
      if (attempt) await releaseFile(ctx, attempt.photoId, copy, now);
      return;
    }
    await recordCopy(ctx, attempt, copy, now);
  },
});

/** An attempt's action ended (any outcome): marked so, and its unswapped copies released now. */
export const endRotation = internalMutation({
  args: { attemptId: v.id('photoRotations') },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt) return;
    if (attempt.status === 'running') await ctx.db.patch(attemptId, { status: 'ended' });
    const now = Date.now();
    for (const row of await ledgerOfPhoto(ctx, attempt.photoId, 50)) {
      if (row.state === 'copy' && row.attemptId === attemptId) {
        await releaseFile(ctx, attempt.photoId, row.storageId, now);
      }
    }
  },
});

/** A file gone when the rotation looked: the photo can't be restored with its bytes. */
export const markBytesMissing = internalMutation({
  args: {
    photoId: v.id('photos'),
    old: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
  },
  handler: async (ctx, { photoId, old }) => {
    const photo = await ctx.db.get(photoId);
    if (
      !photo ||
      photo.storageId !== old.storageId ||
      photo.thumbStorageId !== old.thumbStorageId
    ) {
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
 * copies are this running attempt's, recorded and stored** (else `stale`, nothing written). The copies'
 * ledger rows go as the row takes them; each old file is released (`lib/photoFiles.releaseFile`):
 * left to another row that still names it, deleted, or owed a deletion — never thrown back.
 */
export const swapRotated = internalMutation({
  args: {
    attemptId: v.id('photoRotations'),
    old: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
    next: v.object({ storageId: v.string(), thumbStorageId: v.string() }),
  },
  handler: async (ctx, { attemptId, old, next }): Promise<'rotated' | 'stale'> => {
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.status !== 'running') return 'stale';
    const photo = await ctx.db.get(attempt.photoId);
    if (photo === null || rotationOver(photo, old)) return 'stale';
    const rows: Doc<'photoFiles'>[] = [];
    for (const id of [next.storageId, next.thumbStorageId]) {
      const row = await ledgerRowOf(ctx, id);
      if (row?.state !== 'copy' || row.attemptId !== attemptId) return 'stale';
      if ((await ctx.db.system.get(id as Id<'_storage'>)) === null) return 'stale';
      rows.push(row);
    }
    // A shared old file (a legacy row's twin) stays with the rows still naming it; this photo, taken
    // down, gets its own copy — and records the twins, which still show the same image, for staff.
    const twins = new Set<Id<'photos'>>(photo.sameBytesAs ?? []);
    for (const was of [old.storageId, old.thumbStorageId]) {
      for (const h of await holdersOf(ctx, was, photo._id)) twins.add(h._id);
    }
    await ctx.db.patch(photo._id, {
      storageId: next.storageId,
      thumbStorageId: next.thumbStorageId,
      ...(twins.size > 0 ? { sameBytesAs: [...twins].slice(0, SAME_BYTES_MAX) } : {}),
    });
    for (const row of rows) await ctx.db.delete(row._id);
    const now = Date.now();
    for (const was of [old.storageId, old.thumbStorageId]) {
      await releaseFile(ctx, photo._id, was, now);
    }
    return 'rotated';
  },
});
