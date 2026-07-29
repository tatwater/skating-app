/**
 * Storage hygiene (N3) — the three sweeps that keep the app from accreting things nobody can reach.
 *
 * Same shape as the retention crons already shipped (`pruneGateEvents`, `pruneClientSignals`,
 * `pruneOAuthStates`): a bounded index read, a delete loop, a count returned. They live together
 * because they answer one question — *what did we write that nothing will ever read again?* — and
 * because account deletion (D62) is what finally made two of them load-bearing rather than tidy.
 *
 * Worth recording, since the roadmap's own entry didn't know it: Phase 7b built the `photo_orphans`
 * metric **and** `photos.by_created_at` expressly to decide whether the GC cron was worth building.
 * It reads 0 on dev because dev holds zero photos, so the gate it was supposed to be never had data to
 * decide with. These are built on first principles instead — and deletion now creates its own orphans,
 * which settles the question a different way.
 */

import { seasonOf, seasonStartMs } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { reclaimExportBlob } from './lib/exportBundles';
import {
  deletePhotoAndBlobs,
  hazardPhotoIds,
  PHOTO_ORPHAN_GRACE_MS,
  referencedPhotoIds,
} from './lib/photoOrphans';

/** Rows examined per tick. Bounded so a sweep is always one comfortable transaction. */
const SWEEP_LIMIT = 500;

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a `weatherCache` row is kept past the hour it belongs to.
 *
 * The retention argument here is much stronger than "old rows are stale", which is what the roadmap
 * entry assumed. The cache key is `(samplePointKey, windowStartMs, windowEndBucketMs)` and
 * `resolveWeatherSince` looks it up **by exact triple**, with `windowEndBucketMs = hourBucket(now)`.
 * So a row is only ever reachable *during its own hour*: the moment the wall clock ticks into the next
 * bucket, every row from the previous one is permanently unreadable. They aren't stale, they're
 * unaddressable.
 *
 * 24 hours rather than 1 is pure margin — for clock skew and for a caller that passes a slightly-past
 * `nowMs` — bought at the cost of a day's rows.
 */
const WEATHER_CACHE_RETENTION_MS = 24 * HOUR_MS;

/**
 * Delete `weatherCache` rows whose hour bucket has passed.
 *
 * Safe by construction (a miss just refetches), and now more than a disk-space chore: **N2 multiplied
 * the growth rate**. It shipped the `weatherSamplePoints` writer, so a large lake samples at several
 * points and rows accrue per hour *per point*, not per hour per lake.
 */
export const pruneWeatherCache = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - WEATHER_CACHE_RETENTION_MS;
    const stale = await ctx.db
      .query('weatherCache')
      .withIndex('by_window_end', (q) => q.lt('windowEndBucketMs', cutoff))
      .take(SWEEP_LIMIT);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length, truncated: stale.length >= SWEEP_LIMIT };
  },
});

/**
 * Delete photos past the grace window that no report or hazard references, plus their storage blobs.
 *
 * The durable backstop behind the client's best-effort reclaim (`photos.remove` / `removeBlob`): those
 * handle the abandoned form, but a killed app, a failed reclaim call, or an account deletion that hit
 * its reference-scan cap all still strand blobs.
 *
 * Candidates come off `by_created_at` **oldest first**, so the sweep drains the backlog from the end
 * that's certain rather than nibbling at the recent end where a photo might still be mid-submission.
 * Whether a photo is referenced is `lib/photoOrphans`' call, shared with account deletion so the two
 * destructive paths can't disagree; an uploader whose scan can't be completed is skipped, not guessed
 * at.
 */
export const sweepOrphanPhotos = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const max = Math.min(Math.max(limit ?? SWEEP_LIMIT, 1), SWEEP_LIMIT);
    const candidates = await ctx.db
      .query('photos')
      .withIndex('by_created_at', (q) => q.lt('createdAt', Date.now() - PHOTO_ORPHAN_GRACE_MS))
      .take(max);

    // One reference scan per uploader, not per photo: a sweep page is usually a handful of people's
    // abandoned uploads, and re-deriving the same author's set 200 times would be the read cost that
    // makes an otherwise-cheap cron expensive.
    const byUploader = new Map<string, Set<string> | null>();
    /** Uploaders already escalated this tick — one job each, however many of their photos are here. */
    const escalated = new Set<string>();
    let deleted = 0;
    let skipped = 0;
    let retained = 0;

    for (const photo of candidates) {
      const key = photo.uploaderId;
      if (!byUploader.has(key))
        byUploader.set(key, await referencedPhotoIds(ctx, photo.uploaderId));
      const referenced = byUploader.get(key);
      if (referenced === null || referenced === undefined) {
        // Couldn't determine — keep the photo (see `referencedPhotoIds`) and **hand the uploader to
        // the determinate job** (PR #30 review).
        //
        // Keeping alone used to be the whole response, which quietly made this permanent: the scan
        // caps on a property of the *uploader*, not of the photo, so every subsequent tick re-derived
        // the same `null` and skipped again. Nothing ever reclaimed those blobs, including after the
        // account was deleted — reports survive a deletion, so a departed uploader stays exactly as
        // capped as they were in life.
        //
        // `photoReconcile` answers the same question across as many transactions as it needs, so this
        // is an escalation to a complete method rather than a retry of the one that just failed.
        skipped++;
        if (!escalated.has(key)) {
          escalated.add(key);
          await ctx.scheduler.runAfter(0, internal.photoReconcile.reconcileUploaderPhotos, {
            uploaderId: photo.uploaderId,
          });
        }
        continue;
      }
      if (referenced.has(photo._id)) continue;
      // `false` ⇒ a blob survived, so the row stayed as the only thing that can name it. It comes back
      // to the front of this sweep tomorrow, since candidates are read oldest-first.
      if (await deletePhotoAndBlobs(ctx, photo)) deleted++;
      else retained++;
    }

    if (skipped > 0) {
      console.warn(
        `sweepOrphanPhotos: kept ${skipped} photo(s) whose uploader's reference scan hit its cap — handed ${escalated.size} uploader(s) to photoReconcile for a complete pass`,
      );
    }
    return { scanned: candidates.length, deleted, skipped, retained, escalated: escalated.size };
  },
});

/**
 * Delete expired export bundles — the row and the blob behind it (D33/D62).
 *
 * An export is the densest concentration of one person's data anywhere in the system: every report,
 * every track, every photo, in one downloadable file. So it's deliberately short-lived, and this is
 * what makes `dataExports.expiresAt` mean something rather than being a number nobody enforces.
 *
 * A `building` row that expired is swept too. That's the crash case — an action that died before
 * writing its `storageId` — and leaving it would show the user a bundle that says "building" forever.
 *
 * **The row only goes when the blob is provably gone** (`lib/exportBundles`). This used to swallow a
 * storage failure and delete the row anyway, which destroyed the one pointer to a full account bundle
 * that a retry would have needed — see that module for why an export inverts the `photos.remove`
 * reasoning it was copied from.
 */
export const sweepExpiredExports = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('dataExports')
      .withIndex('by_expires_at', (q) => q.lt('expiresAt', Date.now()))
      .take(SWEEP_LIMIT);

    let deleted = 0;
    let retained = 0;
    for (const row of expired) {
      if (!(await reclaimExportBlob(ctx, row))) {
        retained++; // blob still there — keep the row so the next tick can try again
        continue;
      }
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted, retained };
  },
});

/** Tombstoned accounts examined per tick, and photos examined per account per tick. */
const DEPARTED_PAGE = 25;

/**
 * **A departed skater's photos, split on evidential value and expired with their season** (D66).
 *
 * The last place D62's "what a person typed vs what they observed" seam doesn't cut cleanly. Under the
 * second amendment a photo on a surviving report is kept whole — bytes, timestamp, coordinate — and
 * only its caption is redacted. But the image is the largest identifiability surface in the system:
 * faces, a licence plate, a house behind the put-in, the departed skater themselves. It is
 * *observation*, which is why no bucket ever questioned it, and it is also the richest personal data
 * we hold.
 *
 * So: **a photo attached to a hazard is kept**, indefinitely and whole — a picture of an open lead is
 * worth more than any sentence describing one, and it is what the next skater on that shore needs.
 * **Everything else expires at the end of the season it was taken in**, including (a real cost,
 * accepted) the put-in documentation S1 calls the corpus's most-discussed concern. The loss falls only
 * on people who chose to leave, and only on the images with the least evidential value.
 *
 * **Why this is a cron and not a finalize stage.** Finalization lands 30 days after the request, which
 * is mid-season by construction, so the season this person left in has not ended yet. The clock is
 * N5a's season boundary rather than a fourth deletion timer — that is the argument for building it
 * here at all — and it therefore has to outlive the tombstone. `writeTombstone` clears
 * `deletionRequestedAt`, dropping the row out of the pending index no cron can reach again, so this
 * one reads `by_status` instead.
 *
 * Two transactions on purpose: Convex allows one `.paginate()` per function execution, and both the
 * account list and each account's photos need paging. This one walks accounts and fans out.
 */
export const sweepDepartedPhotos = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('profiles')
      .withIndex('by_status', (q) => q.eq('status', 'deleted'))
      .paginate({ cursor: cursor ?? null, numItems: DEPARTED_PAGE });

    for (const profile of page.page) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.expireDepartedPhotos, {
        userId: profile._id,
      });
    }
    // Self-continuing rather than looping: a page of accounts is a bounded transaction, and the
    // number of them only ever grows.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.sweepDepartedPhotos, {
        cursor: page.continueCursor,
      });
    }
    return { accounts: page.page.length, done: page.isDone };
  },
});

/**
 * One departed account's photos, one page per call (D66). See {@link sweepDepartedPhotos} for the rule.
 *
 * Three things this deliberately does **not** do:
 *
 * - **It doesn't touch this season's photos.** A skater who left in January keeps their January
 *   pictures until July, because the expiry clock is the season boundary and not the deletion. That is
 *   the whole reason this can't be a finalize stage.
 * - **It doesn't rewrite `reports.photoIds`.** The read paths already skip a photo id that resolves to
 *   nothing (`thumbUrlsFor`, `photos.getHazardUrls`), so a dangling id renders as one fewer photo,
 *   which is exactly the intended outcome. Patching every report to prune ids would be a write per
 *   report for a display that is already correct.
 * - **It doesn't guess when the hazard scan caps.** A `null` answer keeps the photo, because an image
 *   deleted on an unanswered question is the one thing here that can't be undone. `photoReconcile` is
 *   the determinate path if that ever becomes common.
 */
export const expireDepartedPhotos = internalMutation({
  args: { userId: v.id('profiles'), cursor: v.optional(v.string()) },
  handler: async (ctx, { userId, cursor }) => {
    const owner = await ctx.db.get(userId);
    // Only tombstones. A cancelled deletion restores an ordinary account, and an ordinary account's
    // photos are not on any clock at all — aging never removes anything (D62 second amendment).
    if (owner?.status !== 'deleted') return { deleted: 0, done: true, kept: 0 };

    const seasonStart = seasonStartMs(seasonOf(Date.now()));
    const keep = await hazardPhotoIds(ctx, userId);
    const page = await ctx.db
      .query('photos')
      .withIndex('by_uploader', (q) => q.eq('uploaderId', userId))
      .paginate({ cursor: cursor ?? null, numItems: DEPARTED_PAGE });

    let deleted = 0;
    let kept = 0;
    for (const photo of page.page) {
      // `takenAt` when the skater opted into keeping EXIF (D42), else the upload. The photo's own
      // season is the honest one: a picture taken in February and uploaded in July belongs to the
      // winter it shows.
      const takenAt = photo.takenAt ?? photo.createdAt;
      if (takenAt >= seasonStart) {
        kept++;
        continue;
      }
      if (keep === null || keep.has(photo._id)) {
        kept++;
        continue;
      }
      if (await deletePhotoAndBlobs(ctx, photo)) deleted++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.expireDepartedPhotos, {
        userId,
        cursor: page.continueCursor,
      });
    }
    if (keep === null) {
      console.warn(
        `expireDepartedPhotos: hazard scan for ${userId} hit its cap — keeping this page rather than deleting images on an unanswered question`,
      );
    }
    return { deleted, kept, done: page.isDone };
  },
});
