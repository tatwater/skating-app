/**
 * Bounties (D10/D17/D44) — "someone wants fresh eyes on this lake." A request, not safety content, so
 * reputation never gates who may post; the only junk controls are a **freshness gate** (no bounty on a
 * body that already has fresh eyes, decision 8) and a **rolling per-requester cap** (decision 7). Both
 * gates are pure `@skating/core` functions, re-enforced here at the trust boundary.
 *
 * Lifecycle: `open` → `fulfilled` (the requester thumbs a fulfilling report helpful), `cancelled` (the
 * requester cancels), or `expired` (the sweep, past `expiresAt`). The reward is a **separate currency**
 * (`bountyPoints`, decision 11): fulfilling awards `bounties.rewardPoints` to the *report author*, never
 * touching `reputationPoints`, so trust stays purely about report/hazard accuracy.
 *
 * The GPS-skate half of eligibility (D44) is dark until Phase 8; Phase 6 fans out to authors who
 * *reported* on the body recently.
 */

import {
  BOUNTY_DAILY_WINDOW_MS,
  BOUNTY_ELIGIBILITY_WINDOW_HOURS,
  DEFAULT_BOUNTY_LIFETIME_MS,
  DEFAULT_BOUNTY_REWARD_POINTS,
  FRESH_REPORT_HOURS,
  isBodyFreshForBounty,
  isMinor,
  MAX_OPEN_BOUNTIES_PER_DAY,
  withinDailyBountyLimit,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { isListed } from './lib/listing';
import { awardPointEvent, checkAndAwardBadges } from './lib/reputation';

const HOUR_MS = 60 * 60 * 1000;

/** Visible reports on a body with a skate-end at or after `cutoff` — the input to both create gates. */
async function recentReports(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  cutoff: number,
): Promise<Doc<'reports'>[]> {
  return ctx.db
    .query('reports')
    .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
      q
        .eq('waterBodyId', waterBodyId)
        .eq('moderationStatus', 'visible')
        .gte('skateEndTime', cutoff),
    )
    .collect();
}

/**
 * Post a bounty on a body (decision 7). `requireProfile`; **reject minors** (a bounty is a broadcast
 * write, so the app-wide read-only stance applies — TODO(16+): fold into the uniform legal pass).
 * Blocked when the body already has a fresh report (decision 8) or the requester is at their rolling
 * open-bounty cap (decision 7). On success, fans out `bounty_request` notices to recent reporters.
 */
export const create = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post bounties');
    }

    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body || !isListed(body)) throw new ConvexError('Water body not found');

    // Freshness gate — a body with fresh eyes doesn't need a bounty (decision 8).
    const fresh = await recentReports(ctx, body._id, now - FRESH_REPORT_HOURS * HOUR_MS);
    if (isBodyFreshForBounty(fresh, now, FRESH_REPORT_HOURS)) {
      throw new ConvexError('This lake already has a fresh report — no bounty needed');
    }

    // Rolling per-requester cap — count the requester's currently-open bounties in the window (decision 7).
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_requester_status', (q) =>
        q.eq('requesterId', profile._id).eq('status', 'open'),
      )
      .collect();
    if (
      !withinDailyBountyLimit(
        open.map((b) => b.createdAt),
        now,
        MAX_OPEN_BOUNTIES_PER_DAY,
        BOUNTY_DAILY_WINDOW_MS,
      )
    ) {
      throw new ConvexError('You already have the maximum number of open bounties');
    }

    const bountyId = await ctx.db.insert('bounties', {
      requesterId: profile._id,
      waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
      windowHours: BOUNTY_ELIGIBILITY_WINDOW_HOURS,
      status: 'open',
      rewardPoints: DEFAULT_BOUNTY_REWARD_POINTS,
      fulfillingReportIds: [],
      createdAt: now,
      expiresAt: now + DEFAULT_BOUNTY_LIFETIME_MS,
    });

    await fanOutEligibility(ctx, {
      bountyId,
      waterBodyId: body._id,
      requesterId: profile._id,
      windowHours: BOUNTY_ELIGIBILITY_WINDOW_HOURS,
      now,
    });
    return bountyId;
  },
});

/**
 * Notify the eligible: authors who reported on this body within `windowHours` (decision 9). Per-actor
 * `bounty_request` rows inserted **directly** (the body-keyed coalescing queue doesn't fit a one-off
 * request), respecting `notificationPrefs.bountyRequest` + `status === 'active'`, never the requester.
 * The GPS-skate half of eligibility (D44) lands in Phase 8.
 */
async function fanOutEligibility(
  ctx: MutationCtx,
  args: {
    bountyId: Id<'bounties'>;
    waterBodyId: Id<'waterBodies'>;
    requesterId: Id<'profiles'>;
    windowHours: number;
    now: number;
  },
): Promise<void> {
  const recent = await recentReports(ctx, args.waterBodyId, args.now - args.windowHours * HOUR_MS);
  const notified = new Set<string>([args.requesterId]); // never notify the requester; dedup authors
  for (const report of recent) {
    if (notified.has(report.authorId)) continue;
    notified.add(report.authorId);
    const author = await ctx.db.get(report.authorId);
    if (!author) continue;
    if (author.status !== 'active' || !author.notificationPrefs.bountyRequest) continue;
    await ctx.db.insert('notifications', {
      userId: report.authorId,
      type: 'bounty_request',
      payload: {
        bountyId: args.bountyId,
        waterBodyId: args.waterBodyId,
        requesterId: args.requesterId,
      },
      createdAt: args.now,
    });
  }
}

/** Cancel your own open bounty (→ `cancelled`, decision 10). Only the requester; only while open. */
export const cancel = mutation({
  args: { bountyId: v.id('bounties') },
  handler: async (ctx, { bountyId }) => {
    const profile = await requireProfile(ctx);
    const bounty = await ctx.db.get(bountyId);
    if (!bounty) throw new ConvexError('Bounty not found');
    if (bounty.requesterId !== profile._id) throw new ConvexError('Only the requester can cancel');
    if (bounty.status !== 'open') throw new ConvexError('Bounty is not open');
    await ctx.db.patch(bountyId, { status: 'cancelled' });
  },
});

/**
 * Auto-attach (decision 10) — invoked from `reports.create` for each new **visible** report. Appends the
 * report to every open bounty on its body's `fulfillingReportIds` (the minimum bar is deliberately simple:
 * any new visible report on the body). Fulfillment itself waits for the requester's helpful thumb.
 */
export async function attachReportToOpenBounties(
  ctx: MutationCtx,
  report: Doc<'reports'>,
): Promise<void> {
  const open = await ctx.db
    .query('bounties')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', report.waterBodyId).eq('status', 'open'),
    )
    .collect();
  for (const bounty of open) {
    if (bounty.fulfillingReportIds.includes(report._id)) continue;
    await ctx.db.patch(bounty._id, {
      fulfillingReportIds: [...bounty.fulfillingReportIds, report._id],
    });
  }
}

/**
 * Fulfillment-on-helpful (decisions 10–11) — invoked from `ratings.rate` when the **requester** thumbs a
 * fulfilling report helpful. Flips the bounty to `fulfilled` and awards `rewardPoints` (as
 * `bounty_fulfilled` → `bountyPoints`) to the **report author**, then notifies them. Guarded so a bounty
 * fulfills once: no-op unless still `open`, the rater is the requester, and the report is in its
 * fulfilling set. (The rater can't be the report author — self-rating is already blocked upstream — so
 * nobody rewards themselves.)
 */
export async function fulfillBountyOnHelpful(
  ctx: MutationCtx,
  args: { bountyId: Id<'bounties'>; reportId: Id<'reports'>; raterId: Id<'profiles'> },
): Promise<void> {
  const bounty = await ctx.db.get(args.bountyId);
  if (!bounty) return;
  if (bounty.status !== 'open') return;
  if (bounty.requesterId !== args.raterId) return;
  if (!bounty.fulfillingReportIds.includes(args.reportId)) return;
  const report = await ctx.db.get(args.reportId);
  if (!report) return;

  await ctx.db.patch(args.bountyId, { status: 'fulfilled' });
  await awardPointEvent(ctx, {
    userId: report.authorId,
    reason: 'bounty_fulfilled',
    refId: args.bountyId,
    delta: bounty.rewardPoints,
  });
  await checkAndAwardBadges(ctx, report.authorId);

  const author = await ctx.db.get(report.authorId);
  if (!author) return;
  if (author.status !== 'active' || !author.notificationPrefs.bountyFulfilled) return;
  await ctx.db.insert('notifications', {
    userId: report.authorId,
    type: 'bounty_fulfilled',
    payload: { bountyId: args.bountyId, reportId: args.reportId, requesterId: bounty.requesterId },
    createdAt: Date.now(),
  });
}

/**
 * Expiry sweep (decision 12) — flip every `open` bounty past `expiresAt` to `expired`. Reads the
 * dedicated `by_status_expires` index so a global sweep never full-scans. Run by the `crons.ts` interval.
 */
export const expireBounties = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('bounties')
      .withIndex('by_status_expires', (q) => q.eq('status', 'open').lte('expiresAt', now))
      .collect();
    for (const bounty of due) await ctx.db.patch(bounty._id, { status: 'expired' });
    return { expired: due.length };
  },
});

/** One bounty for its detail view. Public — bounties aren't gated by trust or blocks. */
export const get = query({
  args: { bountyId: v.id('bounties') },
  handler: (ctx, { bountyId }) => ctx.db.get(bountyId),
});

/** The open bounties on a body (for the map/detail surfaces), newest first, with the requester's name. */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_water_body_status', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('status', 'open'),
      )
      .collect();
    open.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(
      open.map(async (b) => {
        const requester = await ctx.db.get(b.requesterId);
        return {
          _id: b._id,
          requester: requester
            ? { displayName: requester.displayName, username: requester.username }
            : { displayName: 'Unknown', username: '' },
          rewardPoints: b.rewardPoints,
          fulfillingCount: b.fulfillingReportIds.length,
          createdAt: b.createdAt,
          expiresAt: b.expiresAt,
        };
      }),
    );
  },
});

/** The caller's own bounties across all statuses, newest first (the "my bounties" surface). */
export const myBounties = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getCurrentProfile(ctx);
    if (!viewer) return [];
    const mine = await ctx.db
      .query('bounties')
      .withIndex('by_requester_status', (q) => q.eq('requesterId', viewer._id))
      .collect();
    return mine.sort((a, b) => b.createdAt - a.createdAt);
  },
});
