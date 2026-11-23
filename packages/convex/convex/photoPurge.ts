/**
 * **A removed photo's purge, 30 days on** (B01-5e, D222; the founder's clock, §11 call 4). A moderator's
 * removal — or an uploader's withdrawal of a held photo (`photos.remove`) — sets `purgeAt`; a restore
 * clears it. Daily, this job takes the photos whose clock is due and deletes their **bytes** (both
 * blobs, `lib/photoOrphans.purgePhotoBlobs`), keeping the **row** as a tombstone: `purgedAt` set, the
 * caption cleared, the uploader kept — so the verdict on the uploader's record and History still name
 * what was removed (D248: a verdict outlives the content). Each purge writes a `purge_photo` row: the
 * system's, with no actor, and no undo (`lib/undoPolicy`).
 *
 * - **The due range is read with a lower bound** — `by_purge_at`, `gt(0).lte(now)` — never a bare
 *   `lte()`: the field is optional and the index not sparse, so every photo without a clock sorts first.
 * - **Bounded per run** by rows ({@link PURGE_PAGE}) and by the transaction's live metrics: each photo
 *   is its own nested transaction under {@link PURGE_ITEM}'s limits, started only while the run can pay
 *   them and its reserve (`lib/recurringWork.affords`). A full page schedules the next at once.
 * - **One photo that fails never stops the run.** A throw rolls back that photo alone. A blob that won't
 *   delete keeps the row (the only pointer to it) and moves its clock a day on
 *   ({@link PURGE_RETRY_MS}), so it leaves the due range and is tried again tomorrow — it never holds the
 *   head of the range. Each failure is a `jobFailures` row (`photoPurge`), parked at the third and
 *   shown on Machinery; the photo's purge or its clock's clearing forgets it.
 * - **An open flag defers it** (D248: a complaint still undecided keeps its evidence): the clock moves a
 *   day on and the purge is asked again then.
 * - **A photo no longer removed** (restored, or its clock stale) has its clock cleared and is skipped.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { composed, writeAudit } from './lib/audit';
import { OPEN_FLAG_STATUSES } from './lib/openFlags';
import { PHOTO_PURGE_DELAY_MS, TOMBSTONE_FILE } from './lib/photoAccess';
import {
  ACTION_LIFETIME_MS,
  DOOMED_PER_PASS,
  reconcileAttempt,
  retryDoomed,
} from './lib/photoFiles';
import { purgePhotoBlobs } from './lib/photoOrphans';
import {
  affords,
  asItem,
  clearFailure,
  type ItemBudget,
  MiB,
  recordFailure,
  runIsolated,
} from './lib/recurringWork';

/** How long past its first due date an open flag may hold a removed photo's bytes: two months. */
export const PURGE_FLAG_HOLD_MAX_MS = 60 * 24 * 60 * 60 * 1000;

/** Due photos one run takes at most; a full page continues at once. */
export const PURGE_PAGE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far a blob that wouldn't delete, or a photo an open flag holds, moves its clock. */
export const PURGE_RETRY_MS = DAY_MS;

/**
 * One photo's purge, at most: its row, its open-flag checks, two blob checks and deletes, the row's
 * patch and its audit row. Generous (a row is at most a document); the reserve is the next due read
 * and the continuation.
 */
export const PURGE_ITEM: ItemBudget = {
  limits: { bytesRead: 2 * MiB, documentsRead: 20, databaseQueries: 20, documentsWritten: 6 },
  reserve: { bytesRead: 4 * MiB, documentsRead: 400, databaseQueries: 200, documentsWritten: 20 },
};

/** What one photo's purge did. */
export type PurgeOutcome = 'purged' | 'retained' | 'deferred' | 'cleared' | 'gone';

/** What a run did, or why it stood down. */
export interface PurgeRunResult {
  examined: number;
  purged: number;
  retained: number;
  deferred: number;
  cleared: number;
  failed: number;
  more: boolean;
}

/** The due photos, oldest clock first: `gt(0)` first — `purgeAt` is optional (CLAUDE.md). */
export function duePhotos(ctx: MutationCtx, now: number, n: number): Promise<Doc<'photos'>[]> {
  return ctx.db
    .query('photos')
    .withIndex('by_purge_at', (q) => q.gt('purgeAt', 0).lte('purgeAt', now))
    .take(n);
}

/**
 * **The daily purge** (the cron's tick, and each continuation). Takes up to {@link PURGE_PAGE} due
 * photos (one past it, to know whether more follow), purges each in its own nested transaction while
 * the run can afford it, and schedules itself again when more are due.
 */
export const purgeDuePhotos = internalMutation({
  args: {
    /** Test seam: the run's clock. */
    now: v.optional(v.number()),
    /** Test seam: photos a run takes at most (clamped to `PURGE_PAGE`). */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PurgeRunResult> => {
    const now = args.now ?? Date.now();
    const max = Math.min(Math.max(Math.floor(args.limit ?? PURGE_PAGE), 1), PURGE_PAGE);
    const due = await duePhotos(ctx, now, max + 1);
    const counts = { examined: 0, purged: 0, retained: 0, deferred: 0, cleared: 0, failed: 0 };
    let stopped = false;
    for (const photo of due.slice(0, max)) {
      if (!(await affords(ctx, PURGE_ITEM))) {
        stopped = true;
        break;
      }
      counts.examined++;
      const result = await runIsolated<{ outcome: PurgeOutcome }>(
        ctx,
        internal.photoPurge.purgeOne,
        { photoId: photo._id, now },
        PURGE_ITEM.limits,
      );
      if (!result.ok) {
        // Rolled back: its clock is where it was. Moved a day on here, outside the failed item, so it
        // leaves the due range and the next run's head is not the same failure.
        counts.failed++;
        await ctx.db.patch(photo._id, { purgeAt: now + PURGE_RETRY_MS });
        // Machinery sees it (`jobFailures`), parked at the third in a row.
        await recordFailure(ctx, 'photoPurge', photo._id, result.errorClass, now);
        console.warn(
          `photoPurge: photo ${photo._id} failed (${result.errorClass}); retried in a day`,
        );
        continue;
      }
      const o = result.value.outcome;
      if (o === 'purged') counts.purged++;
      else if (o === 'retained') counts.retained++;
      else if (o === 'deferred') counts.deferred++;
      else if (o === 'cleared') counts.cleared++;
    }
    // A fresh transaction always affords a photo; one that took none while some are due would
    // reschedule itself over the same place for ever.
    if (stopped && counts.examined === 0) {
      throw new Error('photoPurge.purgeDuePhotos: a run made no progress');
    }
    const more = stopped || due.length > max;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.photoPurge.purgeDuePhotos, {
        ...(args.now !== undefined ? { now: args.now } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    }
    if (counts.retained > 0 || counts.failed > 0) {
      console.warn(
        `photoPurge: ${counts.retained} photo(s) kept a blob and ${counts.failed} failed; each is retried in a day`,
      );
    }
    return { ...counts, more };
  },
});

/** Whether an open flag is on the photo: one point read per open status. */
async function openFlagOn(ctx: MutationCtx, photoId: Id<'photos'>): Promise<boolean> {
  for (const status of OPEN_FLAG_STATUSES) {
    const flag = await ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q.eq('targetType', 'photo').eq('targetId', photoId).eq('status', status),
      )
      .first();
    if (flag) return true;
  }
  return false;
}

/**
 * One photo's purge, as its own nested transaction: re-read, re-checked (still removed, still due),
 * deferred under an open flag, then its blobs deleted and its row made a tombstone with the system's
 * `purge_photo` row — or, when a blob outlives the delete, its row kept and its clock moved a day on.
 */
export const purgeOne = internalMutation({
  args: { photoId: v.id('photos'), now: v.number() },
  handler: (ctx, { photoId, now }): Promise<{ outcome: PurgeOutcome }> =>
    asItem(photoId, async () => {
      const photo = await ctx.db.get(photoId);
      if (!photo) {
        await clearFailure(ctx, 'photoPurge', photoId);
        return { outcome: 'gone' as const };
      }
      if (photo.purgeAt === undefined || photo.purgeAt > now || photo.purgedAt !== undefined) {
        // Moved since the page was read (a restore cleared it, a run already purged it).
        if (photo.purgedAt !== undefined && photo.purgeAt !== undefined) {
          await ctx.db.patch(photoId, { purgeAt: undefined });
        }
        await clearFailure(ctx, 'photoPurge', photoId);
        return { outcome: 'cleared' as const };
      }
      if (photo.moderationStatus !== 'removed') {
        // A clock on a photo that is no longer removed is stale: the restore's write clears it, so
        // this only meets a row written before that rule. Cleared, never purged.
        await ctx.db.patch(photoId, { purgeAt: undefined });
        await clearFailure(ctx, 'photoPurge', photoId);
        return { outcome: 'cleared' as const };
      }
      // An open flag defers it a day at a time — but not past the bound: a complaint gets two months
      // beyond the 30 days to be decided, then the bytes go (the tombstone, the flag and the verdict
      // stay). From the photo's takedown that is 90 days at most.
      const firstDue = (photo.moderatedAt ?? photo.purgeAt) + PHOTO_PURGE_DELAY_MS;
      if (now < firstDue + PURGE_FLAG_HOLD_MAX_MS && (await openFlagOn(ctx, photoId))) {
        await ctx.db.patch(photoId, { purgeAt: now + PURGE_RETRY_MS });
        return { outcome: 'deferred' as const };
      }
      // The tombstone keeps what names what was removed — the row's id, its uploader, the report it
      // documented, when it was made and taken down, its status and clocks — and nothing of the
      // person's: the caption, the time it was taken and its place go with the bytes.
      // Its two slots are cleared (`TOMBSTONE_FILE`): a tombstone names no file, so every reference
      // check is an exact lookup — no row is ever skipped as "only a tombstone".
      await ctx.db.patch(photoId, {
        purgedAt: now,
        purgeAt: undefined,
        caption: undefined,
        takenAt: undefined,
        coord: undefined,
        placeOnMap: false,
        storageId: TOMBSTONE_FILE,
        thumbStorageId: TOMBSTONE_FILE,
      });
      // Then the files it named: each deleted, left to another row that still names it, or owed a
      // deletion on the ledger and retried until it is gone (`lib/photoFiles`).
      await purgePhotoBlobs(ctx, photo, now);
      await clearFailure(ctx, 'photoPurge', photoId);
      await writeAudit(ctx, {
        action: 'purge_photo',
        targetType: 'photo',
        targetId: photoId,
        reason: composed`Its file was deleted 30 days after its removal`,
        metadata: { subjectUserId: photo.uploaderId, removedAt: photo.moderatedAt ?? null },
        createdAt: now,
      });
      return { outcome: 'purged' as const };
    }),
});

/** Attempts one ledger sweep reconciles at most (a page of each); a full pass continues itself. */
const ATTEMPTS_PER_SWEEP = 20;

/**
 * **The stored-files sweep** (B01-5e, `lib/photoFiles`' invariants 3–4), daily and self-continuing:
 * every rotation attempt that can't be alive is reconciled a page at a time — its unswapped copies
 * released, its own window searched for a copy stored and never recorded — and every doomed file whose
 * retry is due is tried again. The watch does the same for its own photo; this is what reaches an
 * attempt or a doomed file whose photo is gone, or whose watch has ended.
 */
export const sweepPhotoFiles = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ reconciled: number; deleted: number; more: boolean }> => {
    const now = args.now ?? Date.now();
    let reconciled = 0;
    let more = false;
    const stale = [
      ...(await ctx.db
        .query('photoRotations')
        .withIndex('by_status_started', (q) =>
          q.eq('status', 'running').lt('startedAt', now - ACTION_LIFETIME_MS),
        )
        .take(ATTEMPTS_PER_SWEEP)),
      ...(await ctx.db
        .query('photoRotations')
        .withIndex('by_status_started', (q) => q.eq('status', 'ended'))
        .take(ATTEMPTS_PER_SWEEP)),
    ];
    for (const attempt of stale) {
      if (await reconcileAttempt(ctx, attempt, now)) reconciled++;
      else more = true;
    }
    if (stale.length >= ATTEMPTS_PER_SWEEP) more = true;
    const deleted = await retryDoomed(ctx, now);
    if (deleted >= DOOMED_PER_PASS) more = true;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.photoPurge.sweepPhotoFiles, {
        ...(args.now !== undefined ? { now: args.now } : {}),
      });
    }
    return { reconciled, deleted, more };
  },
});
