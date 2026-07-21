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
 * All the actual state math lives in `@skating/core`'s `applyConfirmation`, property-tested there —
 * this module is the persistence and gating shell around it.
 */

import { applyConfirmation, isMinor } from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, query } from './_generated/server'
import { loadVisibleHazard } from './hazards'
import { requireProfile } from './lib/auth'
import { HAZARD_CONFIRM_VERDICTS, HAZARD_CONFIRM_VIA } from './lib/enums'
import { latLng, literals } from './lib/validators'

/**
 * Re-confirming within this window updates the existing vote in place instead of stacking a new one,
 * so a skater doing laps can't inflate a hazard's counts (or archive it single-handedly) by tapping
 * the same button repeatedly. Tunable in Phase 7.
 */
export const CONFIRM_WINDOW_MS = 12 * 60 * 60 * 1000

/**
 * Cast a confirmation. Appends (or refreshes) the vote, runs the `@skating/core` lifecycle reducer,
 * patches the hazard, and records a `pointEvents` row for the eventual reputation signal (D50).
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
    const profile = await requireProfile(ctx)
    const now = Date.now()
    // TODO(16+): fold into the uniform 16+ pass with legal (D41). A confirmation is public safety
    // content that moves a hazard's lifecycle, so minors are read-only here too.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot confirm hazards')
    }

    const hazard = await loadVisibleHazard(ctx, hazardId)
    if (!hazard) throw new ConvexError('Hazard not found')

    // A future timestamp (device clock skew, or a client trying to freeze a pin as permanently fresh)
    // is clamped rather than trusted.
    const at = Math.min(observedAt ?? now, now)

    const existing = await findRecentVote(ctx, hazardId, profile._id, now)
    if (existing) {
      // Same window: replace the vote rather than counting it twice. If the verdict is unchanged this
      // is just a clock refresh; if it changed, unwind the old one before applying the new.
      await ctx.db.patch(existing._id, {
        verdict,
        ...(atCoord ? { atCoord } : {}),
        via,
        createdAt: at,
      })
      const unwound = unapplyVote(hazard, existing.verdict, isAuthor(hazard, profile._id))
      await patchLifecycle(ctx, hazardId, unwound, verdict, at, isAuthor(hazard, profile._id))
      return
    }

    await ctx.db.insert('hazardConfirmations', {
      hazardId,
      userId: profile._id,
      verdict,
      ...(atCoord ? { atCoord } : {}),
      via,
      createdAt: at,
    })
    await patchLifecycle(ctx, hazardId, hazard, verdict, at, isAuthor(hazard, profile._id))

    // Boost-only reputation signal (D50 prep). Confirming is a genuine contribution; no negative
    // events exist yet, and none should be inferred from a verdict.
    await ctx.db.insert('pointEvents', {
      userId: profile._id,
      delta: 1,
      reason: 'hazard_confirmed',
      refId: hazardId,
      createdAt: now,
    })
  },
})

function isAuthor(hazard: Doc<'hazards'>, userId: Id<'profiles'>): boolean {
  return hazard.createdByUserId === userId
}

async function findRecentVote(
  ctx: MutationCtx,
  hazardId: Id<'hazards'>,
  userId: Id<'profiles'>,
  now: number,
): Promise<Doc<'hazardConfirmations'> | null> {
  const votes = await ctx.db
    .query('hazardConfirmations')
    .withIndex('by_hazard_and_user', (q) => q.eq('hazardId', hazardId).eq('userId', userId))
    .collect()
  const recent = votes
    .filter((vote) => now - vote.createdAt < CONFIRM_WINDOW_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
  return recent[0] ?? null
}

/**
 * Reverse a previously-counted vote so a changed verdict doesn't double-count.
 *
 * Note it does **not** un-archive: `status` is left alone. Once a hazard has been archived by
 * consensus, a single person changing their mind shouldn't silently resurrect it — that path is a
 * fresh re-report, which is exactly why archiving keeps the row (D15).
 */
function unapplyVote(
  hazard: Doc<'hazards'>,
  priorVerdict: Doc<'hazardConfirmations'>['verdict'],
  author: boolean,
): Doc<'hazards'> {
  if (author) return hazard
  if (priorVerdict === 'still_there') {
    return { ...hazard, confirmCount: Math.max(0, hazard.confirmCount - 1) }
  }
  if (priorVerdict === 'fully_healed') {
    return { ...hazard, goneCount: Math.max(0, hazard.goneCount - 1) }
  }
  return hazard
}

async function patchLifecycle(
  ctx: MutationCtx,
  hazardId: Id<'hazards'>,
  hazard: Doc<'hazards'>,
  verdict: Doc<'hazardConfirmations'>['verdict'],
  at: number,
  author: boolean,
): Promise<void> {
  const next = applyConfirmation(
    {
      lastConfirmedAt: hazard.lastConfirmedAt,
      confirmCount: hazard.confirmCount,
      goneCount: hazard.goneCount,
      healingState: hazard.healingState ?? 'none',
      status: hazard.status,
    },
    verdict,
    at,
    { isAuthor: author },
  )
  await ctx.db.patch(hazardId, next)
}

/** The confirmation history for a hazard's detail drawer — newest first. */
export const listForHazard = query({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }) => {
    const hazard = await loadVisibleHazard(ctx, hazardId)
    if (!hazard) return []
    const votes = await ctx.db
      .query('hazardConfirmations')
      .withIndex('by_hazard', (q) => q.eq('hazardId', hazardId))
      .collect()
    return votes.sort((a, b) => b.createdAt - a.createdAt)
  },
})
