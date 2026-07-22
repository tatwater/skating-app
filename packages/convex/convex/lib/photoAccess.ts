/**
 * Shared photo ownership + URL resolution (D31/D42).
 *
 * Lifted out of `reports.ts`/`photos.ts` in Phase 9, when hazards became the second entity that can
 * carry photos. The important part is that **every** photo-bearing entity gates its URLs on its own
 * visibility rule: a serving URL (and any GPS coord on it) must never outlive the viewer's access to
 * the thing that references it. Sharing the *resolver* while each caller keeps its own gate is what
 * makes that easy to get right, and easy to audit.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** Verify every photo id exists and belongs to the author (no attaching someone else's photo). */
export async function assertOwnedPhotos(
  ctx: MutationCtx,
  photoIds: readonly Id<'photos'>[],
  authorId: Doc<'profiles'>['_id'],
): Promise<void> {
  for (const photoId of photoIds) {
    const photo = await ctx.db.get(photoId);
    if (!photo || photo.uploaderId !== authorId) {
      throw new ConvexError('Photo not found or not owned by the author');
    }
  }
}

export interface ResolvedPhoto {
  photoId: Id<'photos'>;
  url: string | null;
  thumbUrl: string | null;
  caption?: string;
  coord?: { lat: number; lng: number };
  placeOnMap: boolean;
}

/**
 * Resolve serving URLs for a set of photo ids. **Callers must have already applied their own
 * visibility gate** — this function deliberately performs no access check of its own, so that the
 * gate is always visible at the call site rather than hidden in here.
 *
 * A URL is `null` when its stored file is missing (deleted / never finalized), so callers must guard
 * it rather than assume a serving URL. Missing photo rows are skipped.
 */
export async function resolvePhotoUrls(
  ctx: QueryCtx,
  photoIds: readonly Id<'photos'>[],
): Promise<ResolvedPhoto[]> {
  const results: ResolvedPhoto[] = [];
  for (const photoId of photoIds) {
    const photo = await ctx.db.get(photoId);
    if (!photo) continue;
    // Stored as v.string() per the data model; they're storage ids, so cast for `getUrl`.
    const [url, thumbUrl] = await Promise.all([
      ctx.storage.getUrl(photo.storageId as Id<'_storage'>),
      ctx.storage.getUrl(photo.thumbStorageId as Id<'_storage'>),
    ]);
    results.push({
      photoId,
      url,
      thumbUrl,
      ...(photo.caption !== undefined ? { caption: photo.caption } : {}),
      ...(photo.coord !== undefined ? { coord: photo.coord } : {}),
      placeOnMap: photo.placeOnMap,
    });
  }
  return results;
}
