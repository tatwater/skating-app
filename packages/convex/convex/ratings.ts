/**
 * Polymorphic helpful/unhelpful thumbs (D50 decision 4) — the manual, human-in-the-loop trust lever.
 * The **same** one-vote-per-user rule + UI drive ratings for both reports and hazards via a
 * `(targetType, targetId)` discriminator, so a hazard (which ships with only the three-tier confirmation
 * vote) also gets a thumb.
 *
 * The asymmetry is the whole point (D50/D3):
 *   - **helpful**   → `helpful_thumb` points to the target's author (+ badge recompute + `report_rated`
 *                     notice). A boost.
 *   - **unhelpful** → **never a public penalty, never hides the target** (visibility of safety content is
 *                     not score-gated, D3). It only accumulates; once a target crosses a net-unhelpful
 *                     threshold it's routed to the Phase-7 mod queue via an `auto_low_quality` content
 *                     flag — surfaced for a human, not auto-actioned.
 *
 * **Block-aware (founder call):** a thumbs-**down** from a user in a block relationship (either
 * direction) is discarded as a possible grudge; a thumbs-**up** always counts. Trust is otherwise global
 * (one score, not per-viewer). A rater can never rate their own content.
 */

import { AUTO_LOW_QUALITY_NET_UNHELPFUL, POINT_WEIGHTS, RATING_TARGET_TYPES } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import { fulfillBountyOnHelpful } from './bounties';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { fileOrBumpAutoFlag } from './lib/autoFlag';
import { awardPointEvent, checkAndAwardBadges, tallyThumbs } from './lib/reputation';
import { literals } from './lib/validators';

type RatingTargetType = Doc<'reportRatings'>['targetType'];

/** The rating target's author (the earner of a helpful thumb), or `null` if it can't be rated. */
async function loadRatingTarget(
  ctx: QueryCtx,
  targetType: RatingTargetType,
  targetId: string,
): Promise<{ authorId: Id<'profiles'> } | null> {
  if (targetType === 'report') {
    const id = ctx.db.normalizeId('reports', targetId);
    if (!id) return null;
    const report = await ctx.db.get(id);
    if (!report) return null;
    // Only currently-visible content is rateable (a hidden/removed report/hazard isn't shown, D32).
    if (report.moderationStatus !== 'visible') return null;
    return { authorId: report.authorId };
  }
  const id = ctx.db.normalizeId('hazards', targetId);
  if (!id) return null;
  const hazard = await ctx.db.get(id);
  if (!hazard) return null;
  if (hazard.moderationStatus !== 'visible') return null;
  return { authorId: hazard.createdByUserId };
}

/** Is there a block relationship (either direction) between two users? (D32 — bidirectional.) */
async function hasBlockRelationship(
  ctx: QueryCtx,
  a: Id<'profiles'>,
  b: Id<'profiles'>,
): Promise<boolean> {
  const forward = await ctx.db
    .query('blocks')
    .withIndex('by_blocker', (q) => q.eq('blockerId', a))
    .filter((q) => q.eq(q.field('blockedId'), b))
    .first();
  if (forward) return true;
  const backward = await ctx.db
    .query('blocks')
    .withIndex('by_blocker', (q) => q.eq('blockerId', b))
    .filter((q) => q.eq(q.field('blockedId'), a))
    .first();
  return backward !== null;
}

/** This rater's existing vote on a target, if any (one row per `(rater, target)`, decision 4). */
async function findExistingRating(
  ctx: QueryCtx,
  raterId: Id<'profiles'>,
  targetType: RatingTargetType,
  targetId: string,
): Promise<Doc<'reportRatings'> | null> {
  return ctx.db
    .query('reportRatings')
    .withIndex('by_rater_target', (q) =>
      q.eq('raterId', raterId).eq('targetType', targetType).eq('targetId', targetId),
    )
    .unique();
}

/**
 * Route a target to the Phase-7 mod queue once its net-unhelpful (unhelpful − helpful) reaches the
 * threshold — a single `auto_low_quality` content flag, deduped per target (never one-per-downvoter),
 * attributed to the vote that crossed the line. **Never hides** the target (D3). No-op below threshold
 * or if the flag already exists.
 */
async function maybeAutoFlag(
  ctx: MutationCtx,
  targetType: RatingTargetType,
  targetId: string,
  triggeredByRaterId: Id<'profiles'>,
  /**
   * True when this rater had no prior vote here — i.e. a *person* newly pushed the target down,
   * rather than one who already voted changing their mind. See `countsAsOccurrence` below.
   */
  isFirstVoteByRater: boolean,
): Promise<void> {
  const { helpful, unhelpful } = await tallyThumbs(ctx, targetType, targetId);
  if (unhelpful - helpful < AUTO_LOW_QUALITY_NET_UNHELPFUL) return;
  // Bundled (N2): a target that keeps crossing the threshold bumps one row's count rather than
  // filing an identical flag each time. The dedup used to live here, spelled out a second time in
  // `contradictions.ts` — see `lib/autoFlag.ts` for why the shared version never reopens a resolved
  // row.
  //
  // **Only a rater's first vote counts as an occurrence.** This function runs on every verdict
  // *change* to unhelpful, so without that, one person flipping helpful↔unhelpful on someone else's
  // report could run the count up indefinitely — and `occurrences` is what a moderator reads to
  // decide the D57 lever, so it has to be a fact about the content rather than something a rater can
  // author. Counting first votes only makes it "how many people pushed this over the line", which is
  // both meaningful and un-inflatable. A flag is still *filed* on a flip when none exists yet.
  await fileOrBumpAutoFlag(ctx, {
    targetType,
    targetId,
    reason: 'auto_low_quality',
    flaggerId: triggeredByRaterId, // the downvote that crossed the line; `reason` marks it system-generated
    countsAsOccurrence: isFirstVoteByRater,
  });
}

/** Notify a target's author that their content was thumbed helpful (in-app row; push deferred repo-wide). */
async function notifyHelpful(
  ctx: MutationCtx,
  authorId: Id<'profiles'>,
  targetType: RatingTargetType,
  targetId: string,
  raterId: Id<'profiles'>,
): Promise<void> {
  const author = await ctx.db.get(authorId);
  if (!author) return;
  if (author.status !== 'active' || !author.notificationPrefs.reportRated) return;
  await ctx.db.insert('notifications', {
    userId: authorId,
    type: 'report_rated',
    payload: { targetType, targetId, raterId },
    createdAt: Date.now(),
  });
}

/**
 * Cast (or change) a helpful/unhelpful thumb on a report or hazard. Returns the rating row id, or `null`
 * when the vote is discarded (a block-relationship thumbs-down). Idempotent per verdict; changing your
 * verdict reconciles points honestly (a retracted helpful writes a compensating negative ledger row).
 */
export const rate = mutation({
  args: {
    targetType: literals(RATING_TARGET_TYPES),
    targetId: v.string(),
    verdict: literals(['helpful', 'unhelpful'] as const),
    // Set when the rater is a bounty's requester rating a fulfilling report — carried through so the
    // bounty fulfillment check (Convex bounties, commit 3) can flip the bounty on a helpful rating.
    bountyId: v.optional(v.id('bounties')),
  },
  handler: async (ctx, { targetType, targetId, verdict, bountyId }) => {
    const rater = await requireProfile(ctx);

    const target = await loadRatingTarget(ctx, targetType, targetId);
    if (!target) throw new ConvexError('Rating target not found');
    if (target.authorId === rater._id) throw new ConvexError('You cannot rate your own content');

    // Block-aware discard: a thumbs-down across a block relationship is a possible grudge (founder
    // call). We leave any existing legitimate vote untouched and record nothing. Thumbs-up always counts.
    if (verdict === 'unhelpful' && (await hasBlockRelationship(ctx, rater._id, target.authorId))) {
      return null;
    }

    const existing = await findExistingRating(ctx, rater._id, targetType, targetId);
    if (existing?.verdict === verdict) {
      // A no-op re-vote normally short-circuits. But the requester may have already thumbed this report
      // helpful from the *feed* (where `ThumbControl` renders with no `bountyId`), then opened the bounty
      // page and clicked the already-active helpful button (this time *with* `bountyId`) to fulfill. The
      // verdict is unchanged — so we skip the points/badge/notify churn — but we must STILL run the
      // fulfillment check, or the bounty is left permanently un-fulfillable through that report. Safe to
      // call unconditionally: `fulfillBountyOnHelpful` is fully guarded (open + requester + attached) and
      // idempotent, so a plain re-click on an already-fulfilled bounty is a no-op.
      if (verdict === 'helpful' && bountyId !== undefined && targetType === 'report') {
        const reportId = ctx.db.normalizeId('reports', targetId);
        if (reportId) await fulfillBountyOnHelpful(ctx, { bountyId, reportId, raterId: rater._id });
      }
      return existing._id; // no-op re-vote (bounty fulfillment aside)
    }

    const now = Date.now();
    let ratingId: Id<'reportRatings'>;
    if (existing) {
      // Verdict change. If they retract a helpful (→ unhelpful), reverse the award honestly.
      if (existing.verdict === 'helpful') {
        await awardPointEvent(ctx, {
          userId: target.authorId,
          reason: 'helpful_thumb',
          refId: targetId,
          delta: -POINT_WEIGHTS.helpful_thumb,
        });
      }
      await ctx.db.patch(existing._id, { verdict, createdAt: now });
      ratingId = existing._id;
    } else {
      ratingId = await ctx.db.insert('reportRatings', {
        targetType,
        targetId,
        raterId: rater._id,
        ...(bountyId !== undefined ? { bountyId } : {}),
        verdict,
        createdAt: now,
      });
    }

    if (verdict === 'helpful') {
      await awardPointEvent(ctx, {
        userId: target.authorId,
        reason: 'helpful_thumb',
        refId: targetId,
      });
      await notifyHelpful(ctx, target.authorId, targetType, targetId, rater._id);
      // A requester thumbing a fulfilling report helpful fulfills the bounty (Phase 6, decisions 10–11).
      if (bountyId !== undefined && targetType === 'report') {
        const reportId = ctx.db.normalizeId('reports', targetId);
        if (reportId) {
          await fulfillBountyOnHelpful(ctx, { bountyId, reportId, raterId: rater._id });
        }
      }
    } else {
      await maybeAutoFlag(ctx, targetType, targetId, rater._id, existing === null);
    }
    // Recompute the target author's badges from live stats (a thumb feeds Appreciated / Trusted Reporter
    // / Hazard Spotter). Runs on both branches: a retracted helpful can drop a badge back below threshold.
    await checkAndAwardBadges(ctx, target.authorId);

    return ratingId;
  },
});

/**
 * A target's thumb tallies plus the viewer's own verdict — the read behind the thumbs control. Public
 * counts (helpful/unhelpful); `mine` is the caller's current verdict, or `null` if they haven't voted.
 */
export const summaryForTarget = query({
  args: { targetType: literals(RATING_TARGET_TYPES), targetId: v.string() },
  handler: async (ctx, { targetType, targetId }) => {
    const counts = await tallyThumbs(ctx, targetType, targetId);
    const viewer = await getCurrentProfile(ctx);
    let mine: Doc<'reportRatings'>['verdict'] | null = null;
    if (viewer) {
      const existing = await findExistingRating(ctx, viewer._id, targetType, targetId);
      mine = existing?.verdict ?? null;
    }
    return { ...counts, mine };
  },
});
