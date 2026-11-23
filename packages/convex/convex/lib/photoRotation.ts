/**
 * Starting a photo's byte rotation (B01-5e) — a leaf the writes that take a photo down call, so they
 * schedule it without importing the rotation's module (`photos.ts`).
 */
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { blobReferenced } from './photoAccess';
import { deleteStoredBlob } from './storageBlobs';

/** The watch's checks after the first (1 min, 10 min, 1 h); parked after `MAX_ATTEMPTS`, then daily. */
export const ROTATION_RETRY_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;

/**
 * **Start a photo's rotation** — what a move from up to down calls (a hide, a removal, an undo back
 * down, an uploader's withdrawal), never a move between two down states. Schedules the copy
 * (`rotateBlobs`, at once) and its watch (`rotationWatch`, a minute on), which holds the retry: Convex
 * never retries an action, and one the runtime kills (a transient error, a lost worker) never reaches
 * its own `catch` — proven on a local backend, where such a run died with "Transient error while
 * executing action". A scheduled mutation runs exactly once, so the watch can't be lost that way.
 */
export async function scheduleRotation(ctx: MutationCtx, photo: Doc<'photos'>): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.photos.rotateBlobs, { photoId: photo._id });
  await ctx.scheduler.runAfter(ROTATION_RETRY_MS[0], internal.photos.rotationWatch, {
    photoId: photo._id,
    oldStorageId: photo.storageId,
    oldThumbStorageId: photo.thumbStorageId,
  });
}

/** How long after a rotation began its scan looks for a copy (an action's longest life, and more). */
export const ROTATION_SCAN_WINDOW_MS = 15 * 60 * 1000;
/** Stored files the scan reads at most, from the rotation's start. */
export const ROTATION_SCAN_MAX = 200;

/**
 * **Sweep a rotation's copies that no row names** (B01-5e). The recorded ones first (`rotation.copies`
 * but not the row's current ids); then, with `scan`, any file stored in the window after the rotation
 * began whose sha256 is a source blob's and that no photo row names — the copy an action stored and
 * was killed before recording. A copy another photo row holds is never touched (`blobReferenced`).
 * Bounded: the recorded copies (two a run) and at most {@link ROTATION_SCAN_MAX} stored files.
 */
export async function sweepRotationCopies(
  ctx: MutationCtx,
  photo: Doc<'photos'>,
  { scan }: { scan: boolean },
): Promise<number> {
  const r = photo.rotation;
  if (r === undefined) return 0;
  const current = new Set([photo.storageId, photo.thumbStorageId]);
  const doomed = new Set(r.copies.filter((c) => !current.has(c)));
  if (scan) {
    const stored = await ctx.db.system
      .query('_storage')
      .withIndex('by_creation_time', (q) =>
        q
          .gte('_creationTime', r.startedAt)
          .lte('_creationTime', r.startedAt + ROTATION_SCAN_WINDOW_MS),
      )
      .take(ROTATION_SCAN_MAX);
    for (const f of stored) {
      if (r.sha256.includes(f.sha256) && !current.has(f._id)) doomed.add(f._id);
    }
  }
  let swept = 0;
  for (const id of doomed) {
    if (await blobReferenced(ctx, id)) continue;
    if ((await deleteStoredBlob(ctx, id as Id<'_storage'>)) === null) swept++;
  }
  if (doomed.size > 0) {
    await ctx.db.patch(photo._id, {
      rotation: { ...r, copies: r.copies.filter((c) => current.has(c)) },
    });
  }
  return swept;
}
