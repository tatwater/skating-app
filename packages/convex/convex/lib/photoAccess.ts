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
import { getCurrentProfile, hasCapability } from './auth';
import { OPEN_FLAG_STATUSES } from './openFlags';

// ── The photo's moderation axis (B01-5e, D222) ──────────────────────────────────────────────────

/**
 * **The one visibility rule** — a photo is shown to a skater or the public only while it is `visible`.
 * Absent reads as visible (the field is widened optional until the backfill narrows it). Every
 * skater-facing read of a photo — its URL, its count, its thumbnail — asks this, never the field.
 */
export const photoVisible = (p: Pick<Doc<'photos'>, 'moderationStatus'>): boolean =>
  (p.moderationStatus ?? 'visible') === 'visible';

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

/** An uploader's detach of an access photo while it is held (flagged or under a decision). */
export const PHOTO_HELD_DETACH =
  'This photo is under review, so it stays attached until a moderator decides on it.';

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
 * **An author's edit keeps every held photo attached** (D248, B01-5e: an author can't drop evidence by
 * editing). `sent` is the list the edit asked for; each photo of `before` it leaves out that is held
 * ({@link photoHeld}: moderated, flagged, or under a decision) is kept, after the sent ones, in its
 * old order. A photo that is gone, or not held, drops as the edit asked.
 */
export async function keepHeldPhotos(
  ctx: QueryCtx,
  sent: readonly Id<'photos'>[],
  before: readonly Id<'photos'>[],
): Promise<Id<'photos'>[]> {
  const kept = new Set<string>(sent);
  const out = [...sent];
  for (const photoId of before) {
    if (kept.has(photoId)) continue;
    const photo = await ctx.db.get(photoId);
    if (photo && (await photoHeld(ctx, photo))) {
      out.push(photoId);
      kept.add(photoId);
    }
  }
  return out;
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

/**
 * Whether a photo read is a staff read (B01-5e): the caller asked for one **and** the viewer holds
 * `content.read` — the one rule the Inbox's photo subject asks too. Opt-in, so a moderator browsing
 * the skater app is served what any skater is, never a down photo drawn as if it were up.
 */
export async function staffPhotoRead(ctx: QueryCtx, asked: boolean | undefined): Promise<boolean> {
  if (asked !== true) return false;
  return hasCapability(await getCurrentProfile(ctx), 'content.read');
}

export interface ResolvedPhoto {
  photoId: Id<'photos'>;
  url: string | null;
  thumbUrl: string | null;
  caption?: string;
  coord?: { lat: number; lng: number };
  placeOnMap: boolean;
  /** Only on a staff read: the photo is hidden or removed (its moderation status says which). */
  down?: true;
  moderationStatus?: 'hidden' | 'removed';
}

/**
 * Resolve serving URLs for a set of photo ids. **Callers must have already applied their own gate on
 * the thing that references the photos** — the report, hazard or access point — so that gate is
 * visible at the call site. The photo's **own** moderation gate is applied here, the one place: a
 * photo that isn't visible ({@link photoVisible}) is skipped, unless the caller passes `staff` (a
 * viewer with `content.read`), when it is returned marked `down` with its status.
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
  opts: { staff?: boolean } = {},
): Promise<ResolvedPhoto[]> {
  const results: ResolvedPhoto[] = [];
  for (const photoId of photoIds) {
    const photo = await ctx.db.get(photoId);
    if (!photo) continue;
    const shown = photoVisible(photo);
    if (!shown && opts.staff !== true) continue;
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
      ...(shown
        ? {}
        : {
            down: true as const,
            moderationStatus: photo.moderationStatus as 'hidden' | 'removed',
          }),
    });
  }
  return results;
}
