/**
 * The notification pipeline: the coalescing queue, its flush, and — since N8 — the inbox that reads
 * the result.
 *
 * ## The queue (Phase 4, decision #4; widened in N8 / D166)
 *
 * Every notification the app sends is first a `notificationQueue` row, and `flushNotificationQueue`
 * is the **only** thing that writes `notifications`. Two families of rows:
 *
 * - **Report-audience buckets**, enqueued by `reports.create` for each candidate recipient — one row
 *   per (user, body, kind): **favorite** (`favorite_report`, any distance, default on), **digest**
 *   (`nearby_report_digest`, opt-in, rolled up to the next 8pm), **great** (`great_report_nearby`,
 *   opt-in, a `great` report within X₂). A row *bumps* `count`/`latestReportId` instead of stacking,
 *   keeping the earliest `flushAfter`, so two reports on one lake become one "2 new reports".
 * - **Actor-triggered rows** — thumbs, corroborations, comments, hazard lifecycle changes, flag
 *   verdicts, bounties — enqueued through `lib/notificationQueue.ts` with a short settle window and
 *   a `trigger` the flush re-reads. A misclick undone inside the window never sends; see that module.
 *
 * `coalesceKey` seeds the eventual push collapse-id / tag.
 *
 * ## The inbox (N8 / D164)
 *
 * `list`, `unreadCount` and `markRead` are the read path both clients share. Before N8 nothing in the
 * app could read a notification: six types were being generated and had never been seen — "push
 * delivery deferred, lands an in-app row" was true and the row was landfill. The rule from here on
 * is that a type may not exist without a producer *and* a place it renders (D165).
 *
 * **Scaling seam (decision #2):** digest/great eligibility is a per-user polygon test against that
 * viewer's cached drive-time bands, so there's no index to look recipients up by — it means walking
 * profiles. N1 moved that walk out of `reports.create` and into a **scheduled, self-continuing paged
 * job** (`fanOutNearbyNotifications`), so the write path no longer scales with user count. Making the
 * walk itself unnecessary — a reverse reach index — is designed in the N8 plan (Workstream D) and
 * deliberately unbuilt until ~1,000 profiles make it worth a second writer to keep in sync.
 */

import {
  bandForCoord,
  bandWithinRadius,
  type DriveTimeBands,
  isDriveTimeBand,
  nextZonedHourMs,
} from '@skating/core';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation, query } from './_generated/server';
import { canReceiveNotifications, getCurrentProfile, requireProfile } from './lib/auth';
import { recipientWants, settleReadCost, settleTrigger } from './lib/notificationQueue';
import { resolveNotifications } from './lib/notificationResolve';
import { loadBlockedAuthorIds } from './lib/reportVisibility';
import { takeCapped, takeCappedResult } from './lib/scan';

/** The digest rolls up to 8pm in this zone (single-timezone pilot; per-user zone lands in N8/C). */
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

/**
 * Queue rows scanned per flush *transaction* — see `flushNotificationQueue`. A safety bound, not a
 * throughput bound: a full batch schedules its own continuation, so a backlog drains in seconds
 * across several transactions rather than one batch per cron minute. Sized from the read budget
 * below: an actor row costs ~4 + N reads (row, target, one per coalesced id, its delete, plus the
 * recipient's profile and block set amortised), so 250 survives a window that coalesced a dozen
 * thumbs onto one row. The 1,000 it replaced was sized when every row cost two reads and sat at the
 * ceiling with zero coalescing.
 */
export const FLUSH_BATCH_CAP = 250;

/**
 * Document reads one flush transaction spends before it stops and hands the rest to its continuation.
 * Convex fails a function past 4,096 reads (`lib/scan.ts`), and the tally below is an estimate that
 * can't see inside every helper, so this leaves it a wide margin. The cap above bounds the *scan*;
 * this bounds the *work*, which is what actually varies — a digest user with forty lakes reporting,
 * a report with thirty thumbs in a minute.
 */
export const FLUSH_READ_BUDGET = 3_000;

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
    if (!user || !recipientWants(user, 'favorite_report')) continue;
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
      if (p._id === report.authorId || !canReceiveNotifications(p)) continue;
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
 *
 * ## Batching (N1, reshaped in N8 after the PR #52 review)
 *
 * One transaction scans at most `FLUSH_BATCH_CAP` due rows and spends at most `FLUSH_READ_BUDGET`
 * reads; if either stops it short, it schedules itself again at once, so the cap costs nothing in
 * latency and the cron is only the heartbeat that starts a drain. Rows survive until delivered, so
 * stopping early delays a notification by one transaction rather than losing it — and a backlog too
 * big for one transaction no longer crashes the whole flush and delivers nothing. The cron's own
 * tick can overlap a live chain during a long drain; the two contend on the same `by_flush` prefix
 * and Convex's OCC retries the loser, which then finds the rows gone. Nothing is lost either way — a
 * chain that dies (retries exhausted, logged) is restarted by the next tick — but the overlap is a
 * cost, not a free lunch, and it is bounded at one extra chain per cron minute of backlog.
 *
 * **A digest is assembled from `by_user`, not from the batch.** Every digest row enqueued today is
 * due at the same 8pm, so `by_flush` orders them by creation — the order reports arrived, which
 * interleaves users freely. A user's rows are not contiguous in the scan, and a batch that took its
 * digest from the slice it happened to see would send "2 lakes" now and "1 lake" in the next
 * transaction. So the batch is treated as *which users' digests are due*: the first row seen for a
 * user pulls all of that user's due digest rows through `by_user` (per-user bounded — one row per
 * lake reported in their band today), builds the one digest, and deletes them all. Rows past the cap
 * that the pull reached are delivered now and never show up in a later batch. Never two digests,
 * never a partial one, and nothing re-run.
 *
 * **The budget guard stops between rows, never inside one.** Before each row the tally is checked;
 * past the budget, that row and everything after it are left untouched — no notification, no
 * delete — and the batch ends. Everything the batch *did* deliver is gone, so the untouched rows are
 * at the front of the next scan, with a fresh budget. A digest user can overrun the soft budget by
 * one user's row count, since the size of their digest isn't known until it's read; the margin
 * under the hard limit exists for exactly that. The first row of a batch is exempt from the guard,
 * so every transaction moves the queue and the continuation cannot spin.
 */
export const flushNotificationQueue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // "Exactly cap rows" would be ambiguous between a complete drain and a full batch, and here that
    // decides whether to continue — the helper's cap+1 probe settles it. `paged`: a full batch is
    // paging, not an answer that came back short, so it isn't logged as a truncation.
    const { rows: due, truncated: batchFull } = await takeCappedResult(
      ctx.db.query('notificationQueue').withIndex('by_flush', (q) => q.lte('flushAfter', now)),
      FLUSH_BATCH_CAP,
      'notifications.flushNotificationQueue',
      { paged: true },
    );

    let delivered = 0;
    let dropped = 0;
    // The read tally. Each helper below adds what it costs — an estimate, deliberately on the high
    // side, so the budget is a floor on headroom rather than a ceiling on accuracy. The probe read
    // one row past the cap when the batch is full.
    let reads = due.length + (batchFull ? 1 : 0);
    // Users whose digest this batch has already delivered (their later rows in `due` are gone).
    const digested = new Set<Id<'profiles'>>();
    // Set when the budget stopped the batch before it finished `due`.
    let stoppedEarly = false;

    // **Eligibility is re-checked at delivery, not only at enqueue** (PR #30 review). Rows survive in
    // this table across a debounce window or until 8pm, so the state they were queued against is not
    // the state they are delivered into: a person can request deletion — or be suspended or banned —
    // in between, and the row would land anyway. Gating only where notifications are *generated* would
    // have left exactly the backlog a departing user can no longer mute.
    //
    // Memoized per tick because a batch is many rows over few users (that's what coalescing is for), so
    // this costs a handful of reads rather than one per row. An ineligible row is deleted rather than
    // left: it will never become deliverable again by sitting here, and a ghost's rows are erased by
    // finalization regardless.
    const eligibility = new Map<Id<'profiles'>, Doc<'profiles'> | null>();
    async function deliverable(userId: Id<'profiles'>): Promise<Doc<'profiles'> | null> {
      const memo = eligibility.get(userId);
      if (memo !== undefined) return memo;
      const profile = await ctx.db.get(userId);
      reads += 1;
      const ok = profile !== null && canReceiveNotifications(profile) ? profile : null;
      eligibility.set(userId, ok);
      return ok;
    }
    // The recipient's block set, for the actor rows' re-check — loaded once per recipient per tick
    // for the same reason eligibility is memoized.
    const blockSets = new Map<Id<'profiles'>, ReadonlySet<string>>();
    async function blockedFor(userId: Id<'profiles'>): Promise<ReadonlySet<string>> {
      const memo = blockSets.get(userId);
      if (memo) return memo;
      const set = await loadBlockedAuthorIds(ctx, userId);
      // Two index scans, one row per block *edge* — a mutual block is two rows and one set entry,
      // so the +2 is the pad for that as much as for the scans themselves.
      reads += 2 + set.size;
      blockSets.set(userId, set);
      return set;
    }
    // A delete fetches the row it removes, so it is charged like a read. Every row the batch
    // processes ends in one (delivered or dropped), as does every digest row the pull reaches — left
    // uncharged, a full batch would sit ~250 + one digest's worth under the tally it reports.
    async function remove(id: Id<'notificationQueue'>): Promise<void> {
      await ctx.db.delete(id);
      reads += 1;
    }

    /**
     * Every due digest row this user has — the whole of their digest, wherever the rows sit in the
     * `by_flush` order (see the doc above). `by_user` also returns their pending favorite/great/actor
     * rows; it's per-user-small either way, and they're filtered here rather than through a wider
     * index nothing else would use.
     */
    async function dueDigestRowsFor(userId: Id<'profiles'>): Promise<Doc<'notificationQueue'>[]> {
      const rows = await ctx.db
        .query('notificationQueue')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect();
      reads += rows.length;
      return rows.filter((r) => r.kind === 'digest' && r.flushAfter <= now);
    }

    for (const [i, row] of due.entries()) {
      // Delivered (and deleted) earlier this batch by its user's digest pull. Skipped ahead of the
      // budget guard: it costs nothing, and letting it trip the guard would schedule a continuation
      // for rows that are already gone.
      if (row.kind === 'digest' && digested.has(row.userId)) continue;
      // Checked before the row is touched, so a row is delivered whole or not at all; the first row
      // is exempt (the progress guarantee, see the doc above).
      if (i > 0 && reads >= FLUSH_READ_BUDGET) {
        stoppedEarly = true;
        break;
      }
      const profile = await deliverable(row.userId);
      // The type's own toggle is re-read too: a person who switched "comments on my reports" off
      // during the settle window meant it to apply to the comment that was already queued.
      if (!profile || !recipientWants(profile, row.type)) {
        await remove(row._id);
        dropped++;
        continue;
      }
      if (row.kind === 'digest') {
        const rows = await dueDigestRowsFor(row.userId);
        // One consolidated digest per user: enumerate the bodies (each with its own coalesced
        // count), carry the grand `totalCount`, and key the collapse-id per user so a later push
        // replaces cleanly.
        const bodies = rows.flatMap((r) =>
          r.waterBodyId !== undefined && r.latestReportId !== undefined
            ? [{ waterBodyId: r.waterBodyId, reportId: r.latestReportId, count: r.count }]
            : [],
        );
        const totalCount = bodies.reduce((sum, b) => sum + b.count, 0);
        await ctx.db.insert('notifications', {
          userId: row.userId,
          type: 'nearby_report_digest',
          payload: { bodies, totalCount, coalesceKey: `${row.userId}:digest` },
          createdAt: now,
        });
        for (const r of rows) await remove(r._id);
        digested.add(row.userId);
        delivered++;
        continue;
      }
      if (row.trigger !== undefined) {
        // An actor row (D166): re-read the trigger and deliver only what's still true. A dropped row
        // is deleted, not retried — the thing that would make it true again is a *new* action, which
        // enqueues its own row.
        const payload = await settleTrigger(ctx, row.trigger, await blockedFor(row.userId));
        reads += settleReadCost(row.trigger);
        await remove(row._id);
        if (!payload) {
          dropped++;
          continue;
        }
        await ctx.db.insert('notifications', {
          userId: row.userId,
          type: row.type,
          payload: { ...payload, coalesceKey: row.coalesceKey },
          createdAt: now,
        });
        delivered++;
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
      await remove(row._id);
      delivered++;
    }

    // More behind this batch, or a budget stop: go again now rather than at the next cron minute.
    // An overlap with the cron's own tick is harmless — rows are deleted as they deliver, so two
    // flushes on the same rows conflict, one retries, and it finds them gone.
    const continued = batchFull || stoppedEarly;
    if (continued) {
      await ctx.scheduler.runAfter(0, internal.notifications.flushNotificationQueue, {});
    }
    return { delivered, dropped, reads, continued };
  },
});

// ── The inbox read path (N8 / A1) ────────────────────────────────────────────────────────────────

/**
 * The signed-in user's notifications, newest first, **paginated** — a season of notification history
 * is unbounded, and `.collect()` on a per-user table is the pattern N1 spent a phase removing. Each
 * page is resolved into renderable views (`lib/notificationResolve.ts`); rows whose actors are all
 * blocked are omitted, so a page can come back slightly short.
 */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    // Fail soft like `unreadCount`: the route is behind the auth gate, but a hard refresh can run
    // the subscription a frame before the Convex client has its token, and an empty page beats an
    // error boundary for that frame.
    const profile = await getCurrentProfile(ctx);
    if (!profile) return { page: [], isDone: true, continueCursor: '' };
    const now = Date.now();
    const page = await ctx.db
      .query('notifications')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .order('desc')
      .paginate(paginationOpts);
    const blocked = await loadBlockedAuthorIds(ctx, profile._id);
    return {
      ...page,
      page: await resolveNotifications(ctx, page.page, blocked, now),
    };
  },
});

/**
 * The badge stops counting here — `unreadCount` never returns more than this. The mobile You tab
 * shows its dot on every screen, so `unreadCount` is effectively an app-wide subscription and has to
 * stay one bounded indexed read: a badge that says "99" for an inbox of ten thousand is right, and
 * a query that scans ten thousand rows to say "10,000" is not.
 */
export const UNREAD_COUNT_CAP = 99;

/**
 * Unread notifications for the badge, capped at `UNREAD_COUNT_CAP` — an indexed equality on
 * `(userId, readAt = undefined)`. Answers 0 rather than throwing when there's no profile yet: both
 * clients subscribe from their shell, which can render a frame before the profile row exists after
 * sign-up.
 */
export const unreadCount = query({
  args: {},
  handler: async (ctx): Promise<number> => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return 0;
    const unread = await ctx.db
      .query('notifications')
      .withIndex('by_user_read', (q) => q.eq('userId', profile._id).eq('readAt', undefined))
      .take(UNREAD_COUNT_CAP);
    return unread.length;
  },
});

/** Unread rows stamped per `markRead` call — the same posture as the flush cap. */
const MARK_READ_BATCH_CAP = 500;

/**
 * Stamp `readAt` on one notification, or on every unread one created at or before `before` — the
 * "mark all read" the list calls once, when it opens. `before` defaults to **the server's now**, and
 * the default is the one the clients use: `list` omits rows whose actors are all blocked but
 * `unreadCount` counts them, so a bound taken from the newest row the list *showed* would leave a
 * blocked actor's row unread forever and the badge lit for something nobody can see. Stamping
 * everything that exists at open keeps the badge and the list agreeing; a notification that lands
 * after the open is newer than the bound and stays unread until the next visit. Owner-only; a
 * foreign or vanished id is a no-op rather than an error, because the client sends ids it was shown
 * and a row can be purged in between.
 *
 * **Returns the ids it stamped.** The list is reactive, so the moment this lands every row it just
 * showed re-renders with `readAt` set — and the "new since your last visit" dot would vanish before
 * anyone saw it. The client keeps this set for the life of the visit and draws the dot from it, which
 * is the inbox convention (new until you leave, not new until the server hears you arrived).
 */
export const markRead = mutation({
  args: { notificationId: v.optional(v.id('notifications')), before: v.optional(v.number()) },
  handler: async (ctx, { notificationId, before }): Promise<Id<'notifications'>[]> => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    if (notificationId !== undefined) {
      const row = await ctx.db.get(notificationId);
      if (row && row.userId === profile._id && row.readAt === undefined) {
        await ctx.db.patch(notificationId, { readAt: now });
        return [notificationId];
      }
      return [];
    }
    const bound = before ?? now;
    // Bounded like the flush, and **newest first**: the caller is a list that just showed its top
    // rows, so those are the ones that must be stamped. A pathological backlog older than the cap
    // stays unread — it's the part nobody has scrolled to.
    const unread = await takeCapped(
      ctx.db
        .query('notifications')
        .withIndex('by_user_read', (q) => q.eq('userId', profile._id).eq('readAt', undefined))
        .order('desc'),
      MARK_READ_BATCH_CAP,
      'notifications.markRead',
    );
    const stamped: Id<'notifications'>[] = [];
    for (const row of unread) {
      if (row.createdAt > bound) continue;
      await ctx.db.patch(row._id, { readAt: now });
      stamped.push(row._id);
    }
    return stamped;
  },
});
