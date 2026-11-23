/**
 * Shared photo ownership + URL resolution (D31/D42).
 *
 * Lifted out of `reports.ts`/`photos.ts` in Phase 09a, when hazards became the second entity that can
 * carry photos. The important part is that **every** photo-bearing entity gates its URLs on its own
 * visibility rule: a serving URL (and any GPS coord on it) must never outlive the viewer's access to
 * the thing that references it. Sharing the *resolver* while each caller keeps its own gate is what
 * makes that easy to get right, and easy to audit.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { OPEN_FLAG_STATUSES } from './openFlags';

// ── The photo's moderation axis (B01-5e, D222) ──────────────────────────────────────────────────

/**
 * **The one visibility rule** — a photo is shown to a skater or the public only while it is `visible`.
 * Every skater-facing read of a photo — its URL, its count, its thumbnail — asks this, never the
 * field.
 */
export const photoVisible = (p: Pick<Doc<'photos'>, 'moderationStatus'>): boolean =>
  p.moderationStatus === 'visible';

/** A removal's purge, 30 days on (D222, the founder's clock; §11 call 4). */
export const PHOTO_PURGE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows {@link photoHeld} reads at most beyond the photo: one verdict, one flag per open status. */
export const PHOTO_HOLD_READS = 1 + OPEN_FLAG_STATUSES.length;

/**
 * **What keeps a photo from every deleter** (D248: an author can't drop evidence; D222): a photo that
 * is moderated (hidden or removed — an uploader's withdrawal of a held photo leaves it removed), under
 * an open flag, or under a standing verdict. Point reads on exact prefixes (`first()` each), so the
 * answer is the same at one flag or five thousand. Every path that deletes a photo row or its blobs
 * asks it (`lib/photoOrphans.deletePhotoAndBlobs` asks it itself; `packages/guards`'
 * `photoDeleters.test.ts` holds the list), and a removal's bytes go only by the purge
 * (`photoPurge`), which deletes blobs and keeps the row.
 */
export async function photoHeld(ctx: QueryCtx, photo: Doc<'photos'>): Promise<boolean> {
  if (!photoVisible(photo)) return true;
  const verdict = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_target_standing', (q) =>
      q.eq('targetType', 'photo').eq('targetId', photo._id).eq('standing', true),
    )
    .first();
  if (verdict) return true;
  for (const status of OPEN_FLAG_STATUSES) {
    const flag = await ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q.eq('targetType', 'photo').eq('targetId', photo._id).eq('status', status),
      )
      .first();
    if (flag) return true;
  }
  return false;
}

// ── A blob belongs to one photo (B01-5e) ─────────────────────────────────────────────────────

/**
 * What a purged tombstone holds in both file slots (B01-5e): no file. The purge clears the slots
 * before it releases the files, so a tombstone is never a holder and every reference check is exact.
 */
export const TOMBSTONE_FILE = '';

/** What `photos.create` says of a storage id a photo row already holds (or the same id twice). */
export const BLOB_TAKEN = 'This upload already belongs to a photo.';
/** What it says of a storage id that names no stored file. */
export const BLOB_NOT_FOUND = 'This upload could not be found.';

/**
 * Whether any photo row other than `except` names `storageId` — as its image or its thumbnail. Point
 * reads on `by_storage` and `by_thumb_storage` (both fields required). With `except`, each index is read
 * on either side of that row's `_creationTime`, so its own row — which may weigh near a document, if
 * written before the caption cap — is never read: an unshared blob costs index ranges and no documents.
 */
export async function blobReferenced(
  ctx: QueryCtx,
  storageId: string,
  except?: Pick<Doc<'photos'>, '_id' | '_creationTime'>,
): Promise<boolean> {
  // An exact lookup: any row in either slot — image or thumbnail, so a file one row holds as its
  // image and another as its thumbnail is found from either side — of any state (hidden, removed,
  // withdrawn, mid-rotation, its bytes marked missing). Only a purged tombstone names nothing, and it
  // holds {@link TOMBSTONE_FILE} in both slots, so no row is ever passed over.
  for (const index of ['by_storage', 'by_thumb_storage'] as const) {
    const field = index === 'by_storage' ? 'storageId' : 'thumbStorageId';
    const ranges =
      except === undefined
        ? [ctx.db.query('photos').withIndex(index, (q) => q.eq(field as never, storageId as never))]
        : [
            ctx.db
              .query('photos')
              .withIndex(index, (q) =>
                q.eq(field as never, storageId as never).lt('_creationTime', except._creationTime),
              ),
            ctx.db
              .query('photos')
              .withIndex(index, (q) =>
                q.eq(field as never, storageId as never).gt('_creationTime', except._creationTime),
              ),
          ];
    for (const range of ranges) if ((await range.first()) !== null) return true;
  }
  return false;
}

/** An uploader's detach of an access photo while it is held (flagged or under a decision). */
export const PHOTO_HELD_DETACH =
  'This photo is under review, so it stays attached until a moderator decides on it.';

/**
 * The ids of a list a skater or the public may learn of (B01-5e): the visible photos', in order. A
 * hidden, removed or missing photo leaves no id — its existence, count and id are staff's. One read a
 * photo, bounded by the list.
 */
export async function shownPhotoIds(
  ctx: QueryCtx,
  photoIds: readonly Id<'photos'>[],
): Promise<Id<'photos'>[]> {
  const out: Id<'photos'>[] = [];
  for (const id of photoIds) {
    const photo = await ctx.db.get(id);
    if (photo && photoVisible(photo) && photo.purgedAt === undefined) out.push(id);
  }
  return out;
}

/**
 * When the photo's uploader withdrew it, if they did — their delete of a photo that was held
 * (`photos.remove`, the B01-5e fork 1 ruling) writes an `author_delete` row on it and leaves it removed
 * on the purge clock. Final, as every author's deletion is (D248): no restore brings it back. One
 * point read (`by_target_action`); the row is never deleted.
 */
export async function photoWithdrawnAt(
  ctx: QueryCtx,
  photoId: Id<'photos'>,
): Promise<number | null> {
  return (await photoWithdrawalRow(ctx, photoId))?.createdAt ?? null;
}

/** The uploader's `author_delete` row on a photo, if any — {@link photoWithdrawnAt}'s one read. */
export function photoWithdrawalRow(
  ctx: QueryCtx,
  photoId: Id<'photos'>,
): Promise<Doc<'moderationActions'> | null> {
  return ctx.db
    .query('moderationActions')
    .withIndex('by_target_action', (q) =>
      q.eq('targetType', 'photo').eq('targetId', photoId).eq('action', 'author_delete'),
    )
    .first();
}

/**
 * Verify every photo id exists and belongs to the author (no attaching someone else's photo).
 *
 * With `claim`, also that no photo is already the back-linked photo of a *different* report (A10 /
 * D186): `photos.reportId` is one id, so one photo documents one report, and the place to hold
 * that is here, at the write — not in a reader trying to pick between two reports that both list
 * it. The same id sent twice in one list is folded rather than refused; it is one photo either way.
 */
export async function assertOwnedPhotos(
  ctx: MutationCtx,
  photoIds: readonly Id<'photos'>[],
  authorId: Doc<'profiles'>['_id'],
  claim?: { reportId: Id<'reports'> | null },
): Promise<void> {
  for (const photoId of photoIds) {
    const photo = await ctx.db.get(photoId);
    if (!photo || photo.uploaderId !== authorId) {
      throw new ConvexError('Photo not found or not owned by the author');
    }
    if (claim && photo.reportId !== undefined && photo.reportId !== claim.reportId) {
      throw new ConvexError('Photo already belongs to another report');
    }
  }
}

/**
 * Keep `photos.reportId` — the back-link beside `reports.photoIds` (A10 / D186) — in step with a
 * report's photo list: stamped on every photo the list gains, cleared on every one it drops. Called
 * by each writer of `reports.photoIds` in the same transaction as the list write, after
 * `assertOwnedPhotos` with the claim, so the two never disagree. `posts.backfillFromReports` covers
 * the rows written before this existed.
 */
export async function syncReportPhotoLinks(
  ctx: MutationCtx,
  reportId: Id<'reports'>,
  before: readonly Id<'photos'>[],
  after: readonly Id<'photos'>[],
): Promise<void> {
  const kept = new Set(after);
  for (const photoId of new Set(before)) {
    if (kept.has(photoId)) continue;
    const photo = await ctx.db.get(photoId);
    if (photo?.reportId === reportId) await ctx.db.patch(photoId, { reportId: undefined });
  }
  for (const photoId of kept) {
    const photo = await ctx.db.get(photoId);
    if (photo && photo.reportId !== reportId) await ctx.db.patch(photoId, { reportId });
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
 * Resolve serving URLs for a set of photo ids. **Callers must have already applied their own gate on
 * the thing that references the photos** — the report, hazard or access point — so that gate is
 * visible at the call site. The photo's **own** moderation gate is applied here, the one place: a
 * photo that isn't visible ({@link photoVisible}) is skipped, for every viewer — staff see a down
 * photo through the Inbox item and the record sheet, and its full image only through
 * `inbox.photoReveal`.
 *
 * Each result carries its `photoId`, and **callers join by id, never by position**: a skipped or
 * missing photo leaves no slot, so the i-th result is not the i-th id.
 *
 * A URL is `null` when its stored file is missing (deleted / never finalized / purged), so callers
 * must guard it rather than assume a serving URL. Missing photo rows are skipped.
 */
export async function resolvePhotoUrls(
  ctx: QueryCtx,
  photoIds: readonly Id<'photos'>[],
): Promise<ResolvedPhoto[]> {
  const results: ResolvedPhoto[] = [];
  for (const photoId of photoIds) {
    const photo = await ctx.db.get(photoId);
    if (!photo) continue;
    if (!photoVisible(photo)) continue;
    // Stored as v.string() per the data model; they're storage ids, so cast for `getUrl`. A purged
    // photo's tombstone serves no address, whatever storage still holds (D222).
    const [url, thumbUrl] =
      photo.purgedAt !== undefined
        ? [null, null]
        : await Promise.all([
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
