/**
 * Storage hygiene (A03) — the three sweeps that keep the app from accreting things nobody can reach.
 *
 * Same shape as the retention crons already shipped (`pruneGateEvents`, `pruneClientSignals`,
 * `pruneOAuthStates`): a bounded index read, a delete loop, a count returned. They live together
 * because they answer one question — *what did we write that nothing will ever read again?* — and
 * because account deletion (D62) is what finally made two of them load-bearing rather than tidy.
 *
 * Worth recording, since the roadmap's own entry didn't know it: Phase 07-2 built the `photo_orphans`
 * metric **and** `photos.by_created_at` expressly to decide whether the GC cron was worth building.
 * It reads 0 on dev because dev holds zero photos, so the gate it was supposed to be never had data to
 * decide with. These are built on first principles instead — and deletion now creates its own orphans,
 * which settles the question a different way.
 */

import { seasonOf, seasonStartMs } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { owePhotos } from './erasure';
import { reclaimExportBlob } from './lib/exportBundles';
import { deletePhotoAndBlobs, durablePhotoIds, PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';
import { ReadBudget, traced } from './lib/readBudget';
import {
  affords,
  asItem,
  clearFailure,
  forgetFailuresBefore,
  type ItemBudget,
  lapOf,
  MiB,
  type Position,
  positionOf,
  recordFailure,
  runIsolated,
  saveLap,
} from './lib/recurringWork';
import { claimPhotoReconcile } from './photoReconcile';

/** Rows examined per tick. Bounded so a sweep is always one comfortable transaction. */
const SWEEP_LIMIT = 500;

const HOUR_MS = 60 * 60 * 1000;

/**
 * ⚠ **`weatherDays` and `weatherCells` are deliberately absent from this file (A06h / D153).**
 *
 * Every other weather table swept here expires because its rows are only *addressable* for a window —
 * a `weatherCache` row's key contains its hour bucket, so yesterday's rows are unreachable rather
 * than merely stale, and pruning reclaims dead weight without invalidating anything. A `weatherDays`
 * row is the opposite: it describes what happened between two past instants, so it stays true for ever
 * and reachable for ever. Sweeping it would destroy observations that cannot be re-fetched past the
 * 92-day Open-Meteo horizon — exactly the history the past-weather panel is built on.
 *
 * A season of Tier-B rows is ~548 MB against Convex Pro's included 50 GB, so there is no pressure to
 * reclaim. If retention is ever wanted it belongs as a **season rollup** (150 daily rows compacted
 * into one columnar document at the A05a boundary), not as a sweep.
 */
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
 * Safe by construction (a miss just refetches), and now more than a disk-space chore: **A02 multiplied
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
 * The inbox empties at the season boundary (A08 §1.5) — delete every `notifications` row created before
 * the current season's start (July 1, D63), **read or not**.
 *
 * It's the right clock rather than a convenient one. Every notification is about a *moment* —
 * someone thumbed your report, a bounty opened on a lake, three lakes near you had new ice — and none
 * of that survives a summer; a July inbox holding February's ice reports is landfill with a badge on
 * it. Reusing the season boundary means no new concept: D66 already expires a departed skater's
 * condition photos on exactly this line.
 *
 * **Daily rather than annually** for a clock that turns over once a year, the same posture as
 * `sweepDepartedPhotos`: the rows are created continuously, the boundary is one day, and a bounded
 * pass means the day after July 1 clears everything without one enormous transaction. A pass that
 * fills its cap schedules the next one immediately rather than waiting a day — a season's backlog is
 * many multiples of `SWEEP_LIMIT`, and at one pass a day the "landfill with a badge on it" would sit
 * in the inbox for weeks past the boundary.
 *
 * **Read state doesn't matter.** An *unread* notification about last season's ice is worth less than a
 * read one, not more — keeping it would be the only mechanism in the app that treats an unopened row
 * as more durable than an opened one. This makes the inbox non-archival: the record of what happened
 * to your contributions is the data export (A03), which reads the live tables.
 */
export const purgeLastSeasonNotifications = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const seasonStart = seasonStartMs(seasonOf(now));
    const stale = await ctx.db
      .query('notifications')
      .withIndex('by_created_at', (q) => q.lt('createdAt', seasonStart))
      .take(SWEEP_LIMIT);
    for (const row of stale) await ctx.db.delete(row._id);
    const truncated = stale.length >= SWEEP_LIMIT;
    // Self-continuing while there's more, like `sweepDepartedPhotos`: each pass is one bounded
    // transaction, and the query shrinks under it, so a repeated first-page read walks the backlog.
    // A pinned `now` is carried along so a continuation purges against the same boundary.
    if (truncated) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.purgeLastSeasonNotifications, {
        ...(args.now !== undefined ? { now: args.now } : {}),
      });
    }
    return { deleted: stale.length, truncated, seasonStart };
  },
});

/**
 * Delete `weatherForecastCache` rows whose hour bucket has passed (A06c §2.5b).
 *
 * **The same unaddressable-by-construction argument as `pruneWeatherCache` above**, and it applies
 * more forcefully: a forecast row is keyed on `(samplePointKey, forecastBucketMs)`, so the instant
 * the clock ticks into the next hour every row from the previous one is permanently unreadable. They
 * are not stale, they are unreachable — and unlike a weather-since row they were never durable in the
 * first place, because a prediction stops being true almost immediately.
 *
 * **This existed as an index with no sweep behind it until a self-review caught it.** The table would
 * have grown by one row per sample point per hour, for ever — roughly 24 rows a day for every lake
 * anyone opened, with nothing to reclaim them. The `by_forecast_bucket` index was added *for* this
 * pruner and then the pruner was never written, which is the same shape as A06b's `hasContours`
 * shipping with no producer.
 */
export const pruneForecastCache = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - WEATHER_CACHE_RETENTION_MS;
    const stale = await ctx.db
      .query('weatherForecastCache')
      .withIndex('by_forecast_bucket', (q) => q.lt('forecastBucketMs', cutoff))
      .take(SWEEP_LIMIT);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length, truncated: stale.length >= SWEEP_LIMIT };
  },
});

/**
 * **The orphan-photo walk** (D258): every photo past the grace window, examined once a lap, from a
 * durable position that advances and wraps — so a photo still in use is passed, never re-read at the
 * head of the next run.
 *
 * It used to read the oldest 500 photos past grace every day and skip the ones in use without
 * marking them: once 500 in-use photos were old, it re-read those 500 for ever and never reached a
 * newer orphan. Now each pass starts where the last stopped (`jobPositions`), a lap ends at the
 * newest photo past grace and the next cron tick starts the next lap, and a chain owns its lap
 * (`run`, renewed with a lease each pass) so a tick that finds one running stands down.
 *
 * **One rule for "is this photo still shown anywhere": the photo settlement's.** This walk does not
 * judge a photo unused. It passes the ones the settlement would keep without reading anyone's
 * history — a Report's back-link (`reportId`) or an access point that shows it — and *owes* the rest
 * to the settlement (`erasure.owePhotos`), which reads the uploader's Reports and hazards to the end,
 * the last of them in the very transaction that deletes, and so keeps a photo a hazard filed mid-walk
 * shows. A photo an erasure already let go of (`erasedAt`) whose blob outlived the delete is retried
 * here directly: that question was answered when it was marked.
 *
 * **One photo that fails never stops the walk.** Each is examined in its own nested transaction; a
 * failure is recorded (`jobFailures`, job `orphanPhotos`) and the walk moves past it. A lap visits each
 * photo once, so the next lap is the failing photo's retry — the daily one — and three failures in a
 * row mark it parked, which only the Machinery read reports.
 */
export const sweepOrphanPhotos = internalMutation({
  args: {
    /** The chain this pass belongs to; absent on the cron's tick. */
    run: v.optional(v.string()),
    /** Test seam: photos examined per pass at most. */
    limit: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<OrphanSweepResult> =>
    traced('storageHygiene.sweepOrphanPhotos', args, async (): Promise<OrphanSweepResult> => {
      const now = Date.now();
      const graceCutoff = now - PHOTO_ORPHAN_GRACE_MS;
      const lap = await lapOf(ctx, 'orphanPhotos');
      const leased = lap?.run !== undefined && (lap.leaseUntil ?? 0) > now;
      if (args.run === undefined && leased) return { skipped: 'a lap is running' as const };
      if (args.run !== undefined && lap?.run !== args.run)
        return { skipped: 'superseded' as const };
      const run = args.run ?? `${now}-${Math.random().toString(36).slice(2, 10)}`;
      const max = Math.max(1, Math.floor(args.limit ?? Number.POSITIVE_INFINITY));
      let position = positionOf(lap);
      const counts = {
        examined: 0,
        owed: 0,
        deleted: 0,
        retained: 0,
        kept: 0,
        failed: 0,
        parked: 0,
      };
      const owe = new Map<Id<'profiles'>, Id<'photos'>[]>();
      let lapDone = false;
      while (counts.examined < max) {
        if (!(await affords(ctx, PHOTO_ITEM))) break;
        const photo = await nextPhotoAfter(ctx, position, graceCutoff);
        if (!photo) {
          lapDone = true;
          break;
        }
        position = { value: photo.createdAt, creationTime: photo._creationTime };
        counts.examined++;
        const result = await runIsolated<{ outcome: PhotoOutcome }>(
          ctx,
          internal.storageHygiene.examinePhoto,
          { photoId: photo._id },
          PHOTO_ITEM.limits,
        );
        if (!result.ok) {
          counts.failed++;
          const r = await recordFailure(ctx, 'orphanPhotos', photo._id, result.errorClass, now);
          if (r === 'parked') counts.parked++;
          continue;
        }
        const { outcome } = result.value;
        if (outcome === 'candidate') {
          const ids = owe.get(photo.uploaderId) ?? [];
          ids.push(photo._id);
          owe.set(photo.uploaderId, ids);
          counts.owed++;
        } else if (outcome === 'deleted') counts.deleted++;
        else if (outcome === 'retained') counts.retained++;
        else counts.kept++;
      }
      // A fresh transaction always affords a photo; one that examined none and isn't done would
      // reschedule itself over the same place for ever.
      if (!lapDone && counts.examined === 0) {
        throw new Error('storageHygiene.sweepOrphanPhotos: a pass made no progress');
      }
      // Each uploader's candidates as one debt, so the settlement reads their history once for all.
      for (const [uploaderId, photoIds] of owe) {
        await owePhotos(ctx, new ReadBudget(), { uploaderId, photoIds }, now);
      }
      if (owe.size > 0) await ctx.scheduler.runAfter(0, internal.erasure.settleOwed, {});
      if (lapDone) {
        // A lap visits every photo past grace, and each one examined either clears its failure or
        // fails again in this lap: a failure from before the lap began is a photo that is gone, and
        // left alone it would read as failing on the Machinery read for ever.
        await forgetFailuresBefore(
          ctx,
          'orphanPhotos',
          lap?.lapStartedAt ?? now,
          LAP_END_FORGET_CAP,
        );
        await saveLap(ctx, 'orphanPhotos', lap, undefined, now);
      } else {
        await saveLap(ctx, 'orphanPhotos', lap, position, now, {
          run,
          leaseUntil: now + LAP_LEASE_MS,
        });
        await ctx.scheduler.runAfter(0, internal.storageHygiene.sweepOrphanPhotos, {
          run,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
      }
      if (counts.failed > 0) {
        console.warn(
          `sweepOrphanPhotos: ${counts.failed} photo(s) could not be examined (${counts.parked} newly parked); the walk went on past them`,
        );
      }
      return { ...counts, lapDone };
    }),
});

/** What one pass of the orphan walk did, or why it stood down. */
type OrphanSweepResult =
  | { skipped: 'a lap is running' | 'superseded' }
  | {
      examined: number;
      owed: number;
      deleted: number;
      retained: number;
      kept: number;
      failed: number;
      parked: number;
      lapDone: boolean;
    };

/** What examining one photo found. */
type PhotoOutcome = 'gone' | 'deleted' | 'retained' | 'kept' | 'candidate';

/** How long a lap's chain is trusted between passes before a cron tick takes the lap over. */
const LAP_LEASE_MS = HOUR_MS;
/** Failures of gone photos a lap's end forgets at most (inside the pass's reserve); the rest next lap. */
const LAP_END_FORGET_CAP = 100;

/**
 * One photo of the orphan walk: its own read, its access-photo check, and — for a photo an erasure
 * already let go of — the delete. Generous for any photo (a row is at most a document).
 */
const PHOTO_ITEM: ItemBudget = {
  limits: { bytesRead: 2 * MiB, documentsRead: 20, databaseQueries: 20, documentsWritten: 10 },
  // The next photo's read, each owed uploader's queue place and debt, the position and the chain.
  reserve: {
    bytesRead: 3 * MiB,
    documentsRead: 2000,
    databaseQueries: 1000,
    documentsWritten: 1000,
  },
};

/** The next photo past grace after `at` on `by_created_at` (created time, then creation order). */
async function nextPhotoAfter(
  ctx: MutationCtx,
  at: Position | undefined,
  graceCutoff: number,
): Promise<Doc<'photos'> | null> {
  if (at !== undefined) {
    const tied = await ctx.db
      .query('photos')
      .withIndex('by_created_at', (q) =>
        q.eq('createdAt', at.value).gt('_creationTime', at.creationTime),
      )
      .first();
    if (tied && tied.createdAt < graceCutoff) return tied;
  }
  return ctx.db
    .query('photos')
    .withIndex('by_created_at', (q) =>
      at !== undefined
        ? q.gt('createdAt', at.value).lt('createdAt', graceCutoff)
        : q.lt('createdAt', graceCutoff),
    )
    .first();
}

/**
 * Examine one photo of the orphan walk, as its own nested transaction:
 *
 * - **erased** (`erasedAt`): an erasure found nothing of its uploader's uses it and its blob outlived
 *   the delete — delete it again (`retained` when a blob still outlives it; its row stays the only
 *   pointer to the blob).
 * - **kept**: a Report's back-link or an access point shows it — the settlement's own early answer.
 * - **candidate**: nothing cheap says it is shown; the walk owes it to the settlement, which decides.
 */
export const examinePhoto = internalMutation({
  args: { photoId: v.id('photos') },
  handler: (ctx, { photoId }): Promise<{ outcome: PhotoOutcome }> =>
    asItem(photoId, async () => {
      const photo = await ctx.db.get(photoId);
      let outcome: PhotoOutcome;
      if (!photo) outcome = 'gone';
      else if (photo.erasedAt !== undefined) {
        outcome = (await deletePhotoAndBlobs(ctx, photo)) ? 'deleted' : 'retained';
      } else if (photo.reportId !== undefined) outcome = 'kept';
      else {
        const onAccess = await ctx.db
          .query('accessPhotos')
          .withIndex('by_photo', (q) => q.eq('photoId', photoId))
          .first();
        outcome = onAccess ? 'kept' : 'candidate';
      }
      await clearFailure(ctx, 'orphanPhotos', photoId);
      return { outcome };
    }),
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
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const max = Math.min(Math.max(limit ?? SWEEP_LIMIT, 1), SWEEP_LIMIT);
    // **A turn each, from where the last tick stopped** (D258): a bundle whose blob can't be deleted
    // keeps its row, and five hundred of them at the head of the oldest-first read would have held
    // every tick's page. Each tick now starts after the last row it reached and wraps at the end of
    // the expired range, so a stuck bundle only ever takes its own turn.
    const lap = await lapOf(ctx, 'expiredExports');
    const from = positionOf(lap);
    const expired: Doc<'dataExports'>[] = [];
    if (from !== undefined) {
      expired.push(
        ...(await ctx.db
          .query('dataExports')
          .withIndex('by_expires_at', (q) =>
            q.eq('expiresAt', from.value).gt('_creationTime', from.creationTime),
          )
          .take(max + 1)),
      );
    }
    // One past the page, to tell a full page from the end of the range.
    if (expired.length <= max) {
      expired.push(
        ...(await ctx.db
          .query('dataExports')
          .withIndex('by_expires_at', (q) =>
            from !== undefined
              ? q.gt('expiresAt', from.value).lt('expiresAt', now)
              : q.lt('expiresAt', now),
          )
          .take(max + 1 - expired.length)),
      );
    }
    const more = expired.length > max;
    expired.length = Math.min(expired.length, max);
    const last = expired.at(-1);
    const next =
      more && last !== undefined
        ? { value: last.expiresAt, creationTime: last._creationTime }
        : undefined;
    if (next !== undefined || from !== undefined) {
      await saveLap(ctx, 'expiredExports', lap, next, now);
    }

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
 * faces, a license plate, a house behind the put-in, the departed skater themselves. It is
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
 * A05a's season boundary rather than a fourth deletion timer — that is the argument for building it
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
    // The season is resolved **here**, once, and carried down into every continuation of every
    // account's paging. Re-reading the clock per page would let a July 1 rollover land mid-account:
    // earlier pages judged against the old boundary, the completion marker written for the new one,
    // and the just-ended season's photos on those pages never swept by anybody.
    const season = seasonOf(Date.now());
    // **Only accounts that haven't been swept for this season.** `photosExpiredForSeason` is absent
    // until an account's first complete pass and `undefined` sorts before every number, so this range
    // returns never-swept tombstones first and stops returning an account once it's marked — turning a
    // daily re-walk of every departure the app has ever had into one pass per account per season.
    const page = await ctx.db
      .query('profiles')
      .withIndex('by_status_photos_expired', (q) =>
        q.eq('status', 'deleted').lt('photosExpiredForSeason', season),
      )
      .paginate({ cursor: cursor ?? null, numItems: DEPARTED_PAGE });

    for (const profile of page.page) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.expireDepartedPhotos, {
        userId: profile._id,
        season,
      });
    }
    // Self-continuing rather than looping: a page of accounts is a bounded transaction, and the
    // number of them only ever grows.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.sweepDepartedPhotos, {
        cursor: page.continueCursor,
      });
    }
    return { accounts: page.page.length, done: page.isDone, season };
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
 *   deleted on an unanswered question is the one thing here that can't be undone — and it hands the
 *   account to `photoReconcile`'s `season_expiry` mode, which answers the same question completely
 *   across as many transactions as it needs. See the escalation below for why *retrying* the capped
 *   scan was the wrong instinct in two separate ways.
 */
export const expireDepartedPhotos = internalMutation({
  args: {
    userId: v.id('profiles'),
    cursor: v.optional(v.string()),
    /** The season this pass is expiring *through*, fixed by the sweeper — see its note on rollover. */
    season: v.optional(v.number()),
    /** Test seam: force the hazard scan to cap, so the escalation path is reachable in a test. */
    scanCap: v.optional(v.number()),
  },
  handler: async (ctx, { userId, cursor, season, scanCap }) => {
    const owner = await ctx.db.get(userId);
    // Only tombstones. A canceled deletion restores an ordinary account, and an ordinary account's
    // photos are not on any clock at all — aging never removes anything (D62 second amendment).
    if (owner?.status !== 'deleted') return { deleted: 0, done: true, kept: 0 };

    const target = season ?? seasonOf(Date.now());
    const seasonStart = seasonStartMs(target);
    const keep = await durablePhotoIds(ctx, userId, scanCap);
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

    // **A `null` is a method to escalate from, not an answer to retry** (PR #30's lesson, re-learned
    // here). The cap is a property of the *uploader* — how many hazards they hold — so re-running
    // tomorrow returns `null` again, and every day after that. Retrying was doubly wrong: the photos
    // were retained forever with no automated path, which is exactly the problem `photoReconcile` was
    // built to end; and because a retried account is never marked, it sat at the front of the
    // sweeper's range permanently occupying a slot in a bounded page. Enough of them and no other
    // tombstone is ever reached — the same starvation A03/A04's pending sweep shipped and had to fix.
    //
    // So: hand it to the determinate pass, and mark it, because that job now owns the account.
    if (keep === null) {
      // **Claim, don't mark.** `photosExpiredForSeason` means *this account's photos have been
      // answered*, and at this point they haven't — the job that will answer them hasn't run. Writing
      // it here excluded the account from every later sweep, so a reconcile run that died left the
      // eligible photos undeleted with nothing scheduled to look again. The lease says "someone is on
      // it" instead, and the finishing run writes the marker; a run that dies stops refreshing, the
      // lease goes stale, and tomorrow's tick re-escalates.
      const claimed = await claimPhotoReconcile(ctx, userId, Date.now());
      if (claimed) {
        await ctx.scheduler.runAfter(0, internal.photoReconcile.reconcileUploaderPhotos, {
          uploaderId: userId,
          mode: 'season_expiry',
        });
      }
      console.warn(
        claimed
          ? `expireDepartedPhotos: hazard scan for ${userId} hit its cap — escalated to photoReconcile (season_expiry) for a complete pass`
          : `expireDepartedPhotos: hazard scan for ${userId} hit its cap — a reconcile run already holds the lease, so this tick defers to it`,
      );
      return { deleted, kept, done: true, escalated: claimed };
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.storageHygiene.expireDepartedPhotos, {
        userId,
        cursor: page.continueCursor,
        season: target,
      });
    } else {
      // The last page of a pass that could answer the hazard question: this account is done for the
      // season and drops out of the sweeper's range until the boundary turns over.
      await ctx.db.patch(userId, { photosExpiredForSeason: target });
    }
    return { deleted, kept, done: page.isDone };
  },
});
