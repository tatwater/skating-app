/**
 * Hazard confirmations — the three-tier "is it still there?" vote (D52/D54, Phase 9).
 *
 * This is where the lifecycle actually turns, and the asymmetry baked into it is the whole point:
 *
 *   still_there    → resets the decay clock, counts toward confirmation (1 → promotes to a real alert)
 *   healing_unsafe → annotates the pin and KEEPS it up, counts toward nothing
 *   fully_healed   → the only verdict that moves toward removal (2 → archives, never deletes)
 *
 * Confirming is *harder* to use destructively than constructively on purpose. A wrong "still here"
 * costs someone a detour; a wrong "all clear" can kill someone (D3). The author's own vote refreshes
 * the clock but counts toward neither threshold, so one person can't both plant a pin and promote it
 * into a warning for everyone else on that ice (D54).
 *
 * All the actual state math lives in `@skating/core`'s `deriveHazardLifecycle`, property-tested there —
 * this module upserts the skater's one vote row and asks core to recompute the hazard from the full
 * vote set. It is the persistence and gating shell around that.
 */

import { deriveHazardLifecycle, type HazardVoteRecord, isMinor } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { loadVisibleHazard } from './hazards';
import { requireProfile } from './lib/auth';
import { HAZARD_CONFIRM_VERDICTS, HAZARD_CONFIRM_VIA } from './lib/enums';
import { latLng, literals } from './lib/validators';

/**
 * Re-confirming within this window refreshes the skater's existing vote in place rather than logging a
 * fresh audit row every time — a skater doing laps shouldn't spray rows. Note it is NOT a correctness
 * gate: counts are derived from *distinct users' latest votes* (`deriveHazardLifecycle`), so a stored
 * count is right regardless of the window. The window only governs row/audit granularity. Tunable in
 * Phase 7.
 */
export const CONFIRM_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Cast a confirmation. Upserts this skater's single vote for the hazard, then recomputes the hazard's
 * lifecycle from the whole vote set via `@skating/core` and patches it.
 *
 * **One vote row per user per hazard** is the invariant that makes this safe *and* idempotent: a queued
 * confirmation that replays on flush updates the same row and re-derives the same counts, so a lost ack
 * can never double-count toward archival (the offline-path twin of the same-account abuse the
 * distinct-user derivation prevents).
 */
export const confirm = mutation({
  args: {
    hazardId: v.id('hazards'),
    verdict: literals(HAZARD_CONFIRM_VERDICTS),
    atCoord: v.optional(latLng),
    via: literals(HAZARD_CONFIRM_VIA),
    /**
     * When the skater actually observed it (epoch ms). Passed in rather than read from the clock so an
     * offline confirmation flushed hours later still stamps the moment they stood there. Clamped to
     * "not in the future" below.
     */
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, { hazardId, verdict, atCoord, via, observedAt }) => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    // TODO(16+): fold into the uniform 16+ pass with legal (D41). A confirmation is public safety
    // content that moves a hazard's lifecycle, so minors are read-only here too.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot confirm hazards');
    }

    const hazard = await loadVisibleHazard(ctx, hazardId);
    if (!hazard) throw new ConvexError('Hazard not found');

    // A future timestamp (device clock skew, or a client trying to freeze a pin as permanently fresh)
    // is clamped rather than trusted.
    const at = Math.min(observedAt ?? now, now);

    const existing = await findUserVote(ctx, hazardId, profile._id);
    let firstContribution: boolean;
    if (existing) {
      // This skater already has a vote on this hazard: refresh it. `createdAt` stays monotonic so a
      // late-arriving offline replay can't drag their observation time backward.
      await ctx.db.patch(existing._id, {
        verdict,
        ...(atCoord ? { atCoord } : {}),
        via,
        createdAt: Math.max(existing.createdAt, at),
      });
      firstContribution = false;
    } else {
      await ctx.db.insert('hazardConfirmations', {
        hazardId,
        userId: profile._id,
        verdict,
        ...(atCoord ? { atCoord } : {}),
        via,
        createdAt: at,
      });
      firstContribution = true;
    }

    await recomputeLifecycle(ctx, hazard);

    // Boost-only reputation signal (D50 prep). Awarded once per user per hazard — on their first vote,
    // not on every re-confirm — so laps, verdict changes, and offline replays can't farm points.
    if (firstContribution) {
      await ctx.db.insert('pointEvents', {
        userId: profile._id,
        delta: 1,
        reason: 'hazard_confirmed',
        refId: hazardId,
        createdAt: now,
      });
    }
  },
});

/**
 * This user's current vote on a hazard, if any. `confirm` keeps one row per (user, hazard), so there is
 * normally at most one — but we `collect()` and take the latest rather than `.unique()` on purpose:
 * `.unique()` *throws* if a stray duplicate ever exists (a pre-invariant row, a backfill), which would
 * brick `confirm` for that hazard entirely. Tolerating duplicates keeps the mutation robust; the count
 * derivation already collapses multiple rows per user to their latest, so the counts stay correct.
 */
async function findUserVote(
  ctx: MutationCtx,
  hazardId: Id<'hazards'>,
  userId: Id<'profiles'>,
): Promise<Doc<'hazardConfirmations'> | null> {
  const rows = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard_and_user', (q) => q.eq('hazardId', hazardId).eq('userId', userId))
    .collect();
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (row.createdAt >= latest.createdAt ? row : latest));
}

/** Re-derive the hazard's lifecycle from every vote and patch the stored counts/status. */
async function recomputeLifecycle(ctx: MutationCtx, hazard: Doc<'hazards'>): Promise<void> {
  const votes = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard', (q) => q.eq('hazardId', hazard._id))
    .collect();
  const records: HazardVoteRecord[] = votes.map((v) => ({
    userId: v.userId,
    verdict: v.verdict,
    at: v.createdAt,
  }));
  const next = deriveHazardLifecycle(records, {
    authorId: hazard.createdByUserId,
    createdAt: hazard.firstReportedAt,
    priorStatus: hazard.status,
  });
  await ctx.db.patch(hazard._id, next);
}

/** The confirmation history for a hazard's detail drawer — newest first. */
export const listForHazard = query({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }) => {
    const hazard = await loadVisibleHazard(ctx, hazardId);
    if (!hazard) return [];
    const votes = await ctx.db
      .query('hazardConfirmations')
      .withIndex('by_hazard', (q) => q.eq('hazardId', hazardId))
      .collect();
    return votes.sort((a, b) => b.createdAt - a.createdAt);
  },
});
