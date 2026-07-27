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

import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { reclaimExportBlob } from './lib/exportBundles';
import { deletePhotoAndBlobs, PHOTO_ORPHAN_GRACE_MS, referencedPhotoIds } from './lib/photoOrphans';

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
    let deleted = 0;
    let skipped = 0;

    for (const photo of candidates) {
      const key = photo.uploaderId;
      if (!byUploader.has(key))
        byUploader.set(key, await referencedPhotoIds(ctx, photo.uploaderId));
      const referenced = byUploader.get(key);
      if (referenced === null || referenced === undefined) {
        skipped++; // couldn't determine — keep (see `referencedPhotoIds`)
        continue;
      }
      if (referenced.has(photo._id)) continue;
      await deletePhotoAndBlobs(ctx, photo);
      deleted++;
    }

    if (skipped > 0) {
      console.warn(
        `sweepOrphanPhotos: kept ${skipped} photo(s) whose uploader's reference scan hit its cap`,
      );
    }
    return { scanned: candidates.length, deleted, skipped };
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
