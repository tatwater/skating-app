/**
 * Starting a photo's byte rotation (B01-5e) — a leaf the writes that take a photo down call, so they
 * schedule it without importing the rotation's module (`photos.ts`).
 */
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

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
  });
}

