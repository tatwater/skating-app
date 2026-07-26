/**
 * Notification coalescing queue + flush (Phase 4, decision #4). `reports.create` enqueues one queue
 * row per candidate recipient×bucket; the `flushNotificationQueue` cron drains rows whose `flushAfter`
 * has passed into `notifications` rows. Three buckets:
 *   - **favorite** (`favorite_report`) — any report on a favorited body, any distance, default on.
 *   - **digest** (`nearby_report_digest`) — opt-in; all reports within X₁, rolled up to the next 8pm ET.
 *   - **great** (`great_report_nearby`) — opt-in; a `great` report within X₂.
 *
 * Coalescing: a row keys on `(user, body, kind)` and *bumps* `count`/`latestReportId` instead of
 * stacking, keeping the earliest `flushAfter` — so two reports on one lake in quick succession become
 * one push ("2 new reports on Lake Morey"). `coalesceKey` seeds the eventual APNs collapse-id / Android
 * tag (push delivery itself is deferred, like Phase 3 — flush lands an in-app `notifications` row).
 *
 * **Scaling seam (decision #2):** digest/great eligibility is a per-user polygon test against that
 * viewer's cached drive-time bands, so there's no index to look recipients up by — it means walking
 * profiles. N1 moved that walk out of `reports.create` and into a **scheduled, self-continuing paged
 * job** (`fanOutNearbyNotifications`), so the write path no longer scales with user count. Making the
 * walk itself unnecessary — a reverse spatial index — is still the future optimization (roadmap N7).
 */

import {
  bandForCoord,
  bandWithinRadius,
  type DriveTimeBands,
  isDriveTimeBand,
  nextZonedHourMs,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { takeCapped } from './lib/scan';

/** The digest rolls up to 8pm in this zone (single-timezone pilot; per-user timing deferred). */
const DIGEST_HOUR = 20;
const DIGEST_TIMEZONE = 'America/New_York';
/** Favorite/great pushes fire after this quiet window so a burst on one lake coalesces into one. */
const DEBOUNCE_MS = 2 * 60 * 1000;

type QueueKind = Doc<'notificationQueue'>['kind'];
type NotificationType = Doc<'notificationQueue'>['type'];

/** Upsert a coalescing queue row for `(user, body, kind)` — bump an existing pending row, else insert. */
async function enqueue(
  ctx: MutationCtx,
  params: {
    userId: Id<'profiles'>;
    waterBodyId: Id<'waterBodies'>;
    reportId: Id<'reports'>;
    kind: QueueKind;
    type: NotificationType;
    flushAfter: number;
    now: number;
  },
): Promise<void> {
  const coalesceKey = `${params.userId}:${params.waterBodyId}:${params.kind}`;
  const existing = await ctx.db
    .query('notificationQueue')
    .withIndex('by_coalesce', (q) => q.eq('coalesceKey', coalesceKey))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      count: existing.count + 1,
      latestReportId: params.reportId,
      flushAfter: Math.min(existing.flushAfter, params.flushAfter),
    });
    return;
  }
  await ctx.db.insert('notificationQueue', {
    userId: params.userId,
    waterBodyId: params.waterBodyId,
    kind: params.kind,
    type: params.type,
    coalesceKey,
    latestReportId: params.reportId,
    count: 1,
    flushAfter: params.flushAfter,
    createdAt: params.now,
  });
}

/** Queue rows drained per flush tick — see `flushNotificationQueue`. */
const FLUSH_BATCH_CAP = 1000;

/** Profiles classified per scheduled fan-out page. Each costs a band test + at most two queue
 *  upserts, so a few hundred sits far inside a mutation's budget with room for the upserts. */
const FANOUT_PAGE_SIZE = 200;

/**
 * Enqueue the notifications that belong to the report's *own* audience — the people who favorited
 * this lake — and hand the distance-based fan-out to a scheduled job (N1).
 *
 * Called from `reports.create` after insert. Favorites are keyed by
 * `waterBodyFavorites.by_water_body`, so this scans only the handful of people who care about this
 * one lake and stays inside the create transaction.
 *
 * **Why the rest is scheduled.** Digest/great recipients can't be found by an index — each viewer's
 * eligibility is a polygon test against *their* cached drive-time bands — so it means walking
 * profiles. Doing that inline meant `reports.create` scanned **every profile in the app** on every
 * report: an unbounded read inside the app's most important write, which starts failing outright
 * somewhere around a few thousand users. Now it's a paged, self-continuing job. Users can't tell:
 * these notifications were already debounced two minutes (great) or rolled up to 8pm (digest).
 */
export async function enqueueReportNotifications(
  ctx: MutationCtx,
  report: Doc<'reports'>,
): Promise<void> {
  const now = Date.now();
  const body = await ctx.db.get(report.waterBodyId);
  if (!body) return;

  // 1. Favorites — notify anyone who favorited this body (any distance), default on.
  const favorites = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', report.waterBodyId))
    .collect();
  for (const fav of favorites) {
    if (fav.userId === report.authorId) continue;
    const user = await ctx.db.get(fav.userId);
    if (!user) continue;
    if (user.status !== 'active' || !user.notificationPrefs.favoriteReport) continue;
    await enqueue(ctx, {
      userId: fav.userId,
      waterBodyId: report.waterBodyId,
      reportId: report._id,
      kind: 'favorite',
      type: 'favorite_report',
      flushAfter: now + DEBOUNCE_MS,
      now,
    });
  }

  // 2 & 3. Digest + great — scheduled, not inline (see above).
  await ctx.scheduler.runAfter(0, internal.notifications.fanOutNearbyNotifications, {
    reportId: report._id,
  });
}

/**
 * One page of the distance-based fan-out (N1): classify up to `FANOUT_PAGE_SIZE` profiles against
 * the report's body, enqueue the digest/great rows they qualify for, and schedule the next page.
 *
 * Self-continuing rather than capped, because a cap here would mean quietly not telling someone
 * about ice near them — a silent wrong answer, which is the one outcome worse than a slow one (D5).
 * Bounded per invocation, unbounded in total.
 *
 * The report is re-read each page: it may have been hidden or removed mid-fan-out, and there's no
 * reason to keep notifying people about something no longer on the map.
 */
export const fanOutNearbyNotifications = internalMutation({
  args: { reportId: v.id('reports'), cursor: v.optional(v.string()) },
  handler: async (ctx, { reportId, cursor }) => {
    const now = Date.now();
    const report = await ctx.db.get(reportId);
    if (report?.moderationStatus !== 'visible') return { stopped: 'report_gone' as const };
    const body = await ctx.db.get(report.waterBodyId);
    if (!body) return { stopped: 'body_gone' as const };
    const centroid = body.centroid;

    const isGreat = report.skateQuality === 'great';
    const digestFlushAfter = nextZonedHourMs(now, DIGEST_HOUR, DIGEST_TIMEZONE);
    const page = await ctx.db
      .query('profiles')
      .paginate({ cursor: cursor ?? null, numItems: FANOUT_PAGE_SIZE });

    let enqueued = 0;
    for (const p of page.page) {
      if (p._id === report.authorId || p.status !== 'active') continue;
      const bands: DriveTimeBands = {
        band30: p.cachedIsochrones?.band30 as DriveTimeBands['band30'],
        band60: p.cachedIsochrones?.band60 as DriveTimeBands['band60'],
        outerRadiusMeters: p.outerRadiusMeters,
      };
      const band = bandForCoord(centroid, bands, p.homeCoord);

      if (
        p.notificationPrefs.nearbyReportDigest &&
        isDriveTimeBand(p.allRadiusMinutes) &&
        bandWithinRadius(band, p.allRadiusMinutes)
      ) {
        await enqueue(ctx, {
          userId: p._id,
          waterBodyId: report.waterBodyId,
          reportId: report._id,
          kind: 'digest',
          type: 'nearby_report_digest',
          flushAfter: digestFlushAfter,
          now,
        });
        enqueued++;
      }

      if (
        isGreat &&
        p.notificationPrefs.greatReportNearby &&
        isDriveTimeBand(p.greatRadiusMinutes) &&
        bandWithinRadius(band, p.greatRadiusMinutes)
      ) {
        await enqueue(ctx, {
          userId: p._id,
          waterBodyId: report.waterBodyId,
          reportId: report._id,
          kind: 'great',
          type: 'great_report_nearby',
          flushAfter: now + DEBOUNCE_MS,
          now,
        });
        enqueued++;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.notifications.fanOutNearbyNotifications, {
        reportId,
        cursor: page.continueCursor,
      });
    }
    // `cursor` is returned as well as self-scheduled, so the job can also be driven page-by-page
    // from an operator console or a test without re-scanning page one forever.
    return {
      scanned: page.page.length,
      enqueued,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Drain every queue row whose `flushAfter` has passed into an in-app `notifications` row and delete it
 * (decision #4). Run by the `crons.ts` interval; also directly callable in tests. The payload carries
 * the coalesced `count` + `coalesceKey` (the collapse-id / tag seed) so a later push layer can replace
 * rather than stack.
 *
 * **Favorite / great** rows deliver **one notification per row** (already coalesced per user×body×kind).
 * **Digest** rows are different (decision #4, refined): the "all nearby" digest is inherently per-user —
 * scoped to *that* user's drive-time bands — so all of a user's due digest rows roll up into **one**
 * `nearby_report_digest` notification whose payload enumerates the bodies ("3 lakes near you have new
 * reports"), instead of one row per lake. Grouping happens *inside* the single digest, not across N of them.
 */
export const flushNotificationQueue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Bounded per tick (N1). Rows survive until delivered, so a cap delays a notification by one
    // interval rather than losing it — and a very large backlog would otherwise crash the whole flush,
    // delivering nothing at all. The one visible edge: if a single user's due digest rows straddle a
    // cap boundary they arrive as two digests instead of one.
    const due = await takeCapped(
      ctx.db.query('notificationQueue').withIndex('by_flush', (q) => q.lte('flushAfter', now)),
      FLUSH_BATCH_CAP,
      'notifications.flushNotificationQueue',
    );

    // Digest rows accumulate per user into a single consolidated notification; fav/great deliver 1:1.
    const digestByUser = new Map<Id<'profiles'>, Doc<'notificationQueue'>[]>();
    let delivered = 0;
    for (const row of due) {
      if (row.kind === 'digest') {
        const rows = digestByUser.get(row.userId);
        if (rows) rows.push(row);
        else digestByUser.set(row.userId, [row]);
        continue;
      }
      await ctx.db.insert('notifications', {
        userId: row.userId,
        type: row.type,
        payload: {
          waterBodyId: row.waterBodyId,
          reportId: row.latestReportId,
          count: row.count,
          coalesceKey: row.coalesceKey,
        },
        createdAt: now,
      });
      await ctx.db.delete(row._id);
      delivered++;
    }

    // One consolidated digest per user: enumerate the bodies (each with its own coalesced count),
    // carry the grand `totalCount`, and key the collapse-id per user so a later push replaces cleanly.
    for (const [userId, rows] of digestByUser) {
      const bodies = rows.map((r) => ({
        waterBodyId: r.waterBodyId,
        reportId: r.latestReportId,
        count: r.count,
      }));
      const totalCount = bodies.reduce((sum, b) => sum + b.count, 0);
      await ctx.db.insert('notifications', {
        userId,
        type: 'nearby_report_digest',
        payload: { bodies, totalCount, coalesceKey: `${userId}:digest` },
        createdAt: now,
      });
      for (const r of rows) await ctx.db.delete(r._id);
      delivered++;
    }
    return { delivered };
  },
});
