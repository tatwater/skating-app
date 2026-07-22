/**
 * Reputation ledger + denormalized counters + badge awarding (D50, Phase 6).
 *
 * `pointEvents` is the **audit ledger** (append-only, one row per earning event); `profiles`
 * `reputationPoints` / `bountyPoints` are the **denormalized running totals**, bumped in lockstep the
 * way `bumpContributionCount` maintains `reportCount`. Every point award goes through `awardPointEvent`,
 * which inserts the ledger row *and* bumps the right counter — trust reasons feed `reputationPoints`;
 * `bounty_fulfilled` is a separate currency feeding `bountyPoints` (decision 11), so the trust model
 * stays purely about report/hazard accuracy.
 *
 * Because the ledger is the source of truth, `backfillReputation` (see `reputation.ts`) can recompute
 * every counter + badge from it — so a mid-alpha weight change in `reputationConfig` is a replay, not a
 * migration (D40). The point weights live in `@skating/core` (the single Phase-7 tuning surface).
 */

import {
  type BadgeStats,
  deriveEarnedBadges,
  deriveTrustClass,
  POINT_WEIGHTS,
  type TrustClass,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type PointReason = Doc<'pointEvents'>['reason'];

/**
 * The cosmetic trust class for a profile, derived server-side for the **multi-author read surfaces**
 * (feed cards, comments, report/hazard/bounty authors). We return the derived class *string* — never the
 * raw number — from those queries so the "no raw score in the UI, except to admins" rule (D50 decision 5)
 * holds without every author payload shipping `reputationPoints` + a creation time. The single-author
 * profile read still returns raw points alongside this (the admin-visible number). `now` is threaded so
 * one query stamps every author against a single clock. `null` ⇒ no ring (below `trusted`, past the New
 * window). Boost-only ⇒ points never negative in Phase 6.
 */
export function trustClassFor(profile: Doc<'profiles'>, now: number): TrustClass | null {
  return deriveTrustClass(profile.reputationPoints, now - profile.createdAt);
}

/** True for the reasons whose delta is single-sourced in `POINT_WEIGHTS` (all bump `reputationPoints`). */
function isTrustReason(reason: PointReason): reason is keyof typeof POINT_WEIGHTS {
  return reason in POINT_WEIGHTS;
}

/** Adjust a profile's `reputationPoints` by `delta`, clamped at 0. A missing profile is a no-op. */
export async function bumpReputation(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const profile = await ctx.db.get(userId);
  if (!profile) return;
  await ctx.db.patch(userId, { reputationPoints: Math.max(0, profile.reputationPoints + delta) });
}

/** Adjust a profile's `bountyPoints` by `delta`, clamped at 0 (absent ⇒ treated as 0). No-op if missing. */
export async function bumpBountyPoints(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const profile = await ctx.db.get(userId);
  if (!profile) return;
  await ctx.db.patch(userId, { bountyPoints: Math.max(0, (profile.bountyPoints ?? 0) + delta) });
}

/**
 * The single entry point for awarding points: insert the `pointEvents` ledger row and bump the matching
 * counter. Trust reasons default their delta from `POINT_WEIGHTS` (the single-sourced weight);
 * `bounty_fulfilled` has no fixed weight — it's valued per-bounty, so the caller **must** pass `delta`
 * (`bounties.rewardPoints`), and it routes to `bountyPoints` rather than `reputationPoints`.
 *
 * An explicit `delta` overrides the default even for a trust reason — used to **honestly reverse** an
 * award (a retracted helpful thumb writes a compensating negative `helpful_thumb` row). The ledger stays
 * append-only; `backfillReputation` recomputes from the net sum, so compensations replay correctly.
 */
export async function awardPointEvent(
  ctx: MutationCtx,
  args: { userId: Id<'profiles'>; reason: PointReason; refId?: string; delta?: number },
): Promise<void> {
  const trust = isTrustReason(args.reason);
  let delta = args.delta;
  if (delta === undefined && isTrustReason(args.reason)) delta = POINT_WEIGHTS[args.reason];
  if (delta === undefined) {
    throw new Error(`awardPointEvent: reason "${args.reason}" requires an explicit delta`);
  }
  await ctx.db.insert('pointEvents', {
    userId: args.userId,
    delta,
    reason: args.reason,
    ...(args.refId !== undefined ? { refId: args.refId } : {}),
    createdAt: Date.now(),
  });
  if (trust) await bumpReputation(ctx, args.userId, delta);
  else await bumpBountyPoints(ctx, args.userId, delta);
}

/** Helpful / unhelpful thumb counts for one polymorphic rating target (reports + hazards, decision 4). */
export async function tallyThumbs(
  ctx: QueryCtx,
  targetType: Doc<'reportRatings'>['targetType'],
  targetId: string,
): Promise<{ helpful: number; unhelpful: number }> {
  const ratings = await ctx.db
    .query('reportRatings')
    .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
    .collect();
  let helpful = 0;
  let unhelpful = 0;
  for (const r of ratings) {
    if (r.verdict === 'helpful') helpful++;
    else unhelpful++;
  }
  return { helpful, unhelpful };
}

/**
 * Recompute a user's badge stats from live rows (decision 6). Every field is a *quality-gated* count, so
 * `deriveEarnedBadges` in `@skating/core` is a pure threshold check over the result.
 *
 * **Scan cost (alpha-scale, documented seam).** This reads the user's whole ledger + their reports +
 * their hazards (each with a thumb tally) + their confirmations + their hazard thumbs. Fine at
 * dozens–hundreds of items per user; Phase 7 can move to incremental counters or a scheduled recompute
 * if a power user's history grows. Kept a pure read so `backfillReputation` and the live paths share it.
 */
export async function computeBadgeStats(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
): Promise<BadgeStats> {
  // Ledger-derived families — one `by_user` scan (helpful thumbs received, corroborations, measured
  // reports, bounties fulfilled all map 1:1 to a ledger reason).
  const events = await ctx.db
    .query('pointEvents')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  let helpfulThumbsReceived = 0;
  let reportsCorroborated = 0;
  let measuredReports = 0;
  let bountiesFulfilled = 0;
  for (const e of events) {
    // Count **net** events, not rows. A retracted helpful writes a *compensating* negative-delta
    // `helpful_thumb` ledger row (see `ratings.rate`), so a given-then-retracted thumb must net to zero
    // — counting rows would tally it as two and inflate the `Appreciated` badge (and the backfill,
    // which shares this fn). The other reasons never carry a negative delta today, so `unit` is a no-op
    // for them, but it keeps every family correct if reversals are added later.
    const unit = e.delta < 0 ? -1 : 1;
    if (e.reason === 'helpful_thumb') helpfulThumbsReceived += unit;
    else if (e.reason === 'report_corroborated') reportsCorroborated += unit;
    else if (e.reason === 'measured_thickness') measuredReports += unit;
    else if (e.reason === 'bounty_fulfilled') bountiesFulfilled += unit;
  }

  // Author's reports: `trusted_reporter` (≥2 helpful thumbs) and `straight_shooter` (a helpful
  // "don't skate" report — proxied by `skateQuality: 'poor'`, the strongest negative signal we store).
  const reports = await ctx.db
    .query('reports')
    .withIndex('by_author', (q) => q.eq('authorId', userId))
    .collect();
  let reportsWithHelpfulThumbs = 0;
  let negativeReportsHelpful = 0;
  for (const r of reports) {
    if (r.moderationStatus !== 'visible') continue;
    const { helpful } = await tallyThumbs(ctx, 'report', r._id);
    if (helpful >= 2) reportsWithHelpfulThumbs++;
    if (r.skateQuality === 'poor' && helpful >= 1) negativeReportsHelpful++;
  }

  // Author's hazards: `hazard_spotter` = confirmed by ≥2 peers AND thumbed helpful by ≥2.
  const hazards = await ctx.db
    .query('hazards')
    .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', userId))
    .collect();
  let hazardsConfirmedHelpful = 0;
  for (const h of hazards) {
    if (h.moderationStatus !== 'visible') continue;
    const { helpful } = await tallyThumbs(ctx, 'hazard', h._id);
    if (h.confirmCount >= 2 && helpful >= 2) hazardsConfirmedHelpful++;
  }

  // `watchdog` = distinct hazards **reported by other people** that this user confirmed or thumbed.
  const actedOthersHazards = new Set<string>();
  const myConfirms = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  for (const c of myConfirms) {
    const h = await ctx.db.get(c.hazardId);
    if (h && h.createdByUserId !== userId) actedOthersHazards.add(c.hazardId);
  }
  const myRatings = await ctx.db
    .query('reportRatings')
    .withIndex('by_rater', (q) => q.eq('raterId', userId))
    .collect();
  for (const rt of myRatings) {
    if (rt.targetType !== 'hazard') continue;
    const hid = ctx.db.normalizeId('hazards', rt.targetId);
    if (!hid) continue;
    const h = await ctx.db.get(hid);
    if (h && h.createdByUserId !== userId) actedOthersHazards.add(rt.targetId);
  }

  return {
    reportsWithHelpfulThumbs,
    bountiesFulfilled,
    helpfulThumbsReceived,
    hazardsConfirmedHelpful,
    othersHazardsActedOn: actedOthersHazards.size,
    reportsCorroborated,
    negativeReportsHelpful,
    measuredReports,
  };
}

/**
 * Recompute a user's earned badges from live stats and patch `profiles.badges` if the set changed.
 * Idempotent + backfillable — the stored set is always exactly `deriveEarnedBadges(stats)` in the stable
 * `BADGE_TYPES` order, so re-running never duplicates and a Phase-7 threshold change replays cleanly.
 */
export async function checkAndAwardBadges(ctx: MutationCtx, userId: Id<'profiles'>): Promise<void> {
  const profile = await ctx.db.get(userId);
  if (!profile) return;
  const earned = deriveEarnedBadges(await computeBadgeStats(ctx, userId));
  const current = profile.badges ?? [];
  if (earned.length === current.length && earned.every((b, i) => b === current[i])) return;
  await ctx.db.patch(userId, { badges: earned });
}
