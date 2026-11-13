/**
 * An author withdrawing their own hazard (founder ruling, 2026-11-13): "any hazard that has
 * confirmations from other users shouldn't be able to be deleted, only hazards that are either
 * disputed or have no interactions at all."
 *
 * **What a withdrawal says.** "This was never here, or not here" — D65's sense, the one `never_existed`
 * votes carry — never "it healed". So the pin leaves as if it had not been posted: its
 * `moderationStatus` becomes `removed` and its lifecycle `status` is left exactly where it was. Every
 * skater-facing read gates on moderation (`isUserVisibleHazard`), so the pin simply stops being drawn;
 * nothing archives it, retires it or marks it healed, which are the states that read as an all-clear
 * on ice (D3).
 *
 * **When it is allowed.** While no other skater has said it is there: another skater's `still_there`
 * or `healing_unsafe` blocks it — the warning is theirs now as much as the author's. No votes, or only
 * others' `fully_healed` / `never_existed`, leave it withdrawable; the author's own votes never count
 * either way. A moderator having acted on it does not block it (their verdict stays on the record,
 * as on any withdrawn content), except a promotion to a permanent feature, which made it the lake's.
 *
 * **Never: a pin joined to others' records** (founder ruling, 2026-11-13). Once a pin is folded
 * together with other people's pins (a merge's tombstone or its survivor), or counted in a
 * cross-season pattern, or made a permanent feature by a moderator, it is a shared record — the same
 * principle as another skater confirming it — and stays up.
 *
 * Final like any author withdrawal (D248): nothing restores it, and it is erased 30 days on unless a
 * verdict or an open flag holds it (`erasure`).
 */

import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type QueryCtx } from './_generated/server';
import { writeAudit } from './lib/audit';
import { requireProfile } from './lib/auth';
import { AUTHOR_DELETE_REASON } from './lib/authorDeletion';
import { recomputeBodySummary } from './lib/bodySummary';
import { refreshEraseClock } from './lib/eraseClock';
import { MAX_BODY_CLUSTERS } from './lib/recurrence';

/** The refusals, worded once for the mutation and its tests. */
export const HAZARD_WITHDRAW_REFUSALS = {
  notYours: 'Only the person who posted this hazard can withdraw it.',
  confirmed:
    'Another skater has reported this hazard is there, so it stays up. You can still say what you see now.',
  feature:
    'A moderator made this hazard a permanent feature of the lake, so it is a shared record now and stays up.',
  joined:
    // Not "other skaters'": merge and recurrence don't look at who posted, so the others may be the
    // author's own pins from another day or season.
    'This hazard has been combined with other reports of the same spot, so it is a shared record now and stays up.',
} as const;

/**
 * Whether anyone but the author has said the hazard is there. Exact, with no cap to reach: a skater
 * has one vote row per hazard (`hazardConfirmations.confirm` patches theirs in place), so within one
 * verdict the author owns at most a row — a few, from rows older than that upsert — and the read
 * stops at the first row that is someone else's.
 */
async function othersSayItIsThere(ctx: QueryCtx, hazard: Doc<'hazards'>): Promise<boolean> {
  for (const verdict of ['still_there', 'healing_unsafe'] as const) {
    const someoneElse = await ctx.db
      .query('hazardConfirmations')
      .withIndex('by_hazard_and_verdict', (q) =>
        q.eq('hazardId', hazard._id).eq('verdict', verdict),
      )
      .filter((q) => q.neq(q.field('userId'), hazard.createdByUserId))
      .first();
    if (someoneElse) return true;
  }
  return false;
}

/** Whether merge or recurrence machinery has joined this pin to others. */
async function isJoined(ctx: QueryCtx, hazard: Doc<'hazards'>): Promise<boolean> {
  if (hazard.mergedIntoHazardId !== undefined) return true;
  const folded = await ctx.db
    .query('hazards')
    .withIndex('by_merged_into', (q) => q.eq('mergedIntoHazardId', hazard._id))
    .first();
  if (folded) return true;
  const patterns = await ctx.db
    .query('hazardRecurrence')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', hazard.waterBodyId))
    .take(MAX_BODY_CLUSTERS);
  return patterns.some(
    (p) => p.memberHazardIds.includes(hazard._id) || p.representativeHazardId === hazard._id,
  );
}

/** Why this author can't withdraw this hazard now, or `null` when they can. */
export async function hazardWithdrawRefusal(
  ctx: QueryCtx,
  hazard: Doc<'hazards'>,
  authorId: Id<'profiles'>,
): Promise<string | null> {
  if (hazard.createdByUserId !== authorId) return HAZARD_WITHDRAW_REFUSALS.notYours;
  if (hazard.promotedToFeatureId !== undefined) return HAZARD_WITHDRAW_REFUSALS.feature;
  if (await isJoined(ctx, hazard)) return HAZARD_WITHDRAW_REFUSALS.joined;
  if (await othersSayItIsThere(ctx, hazard)) return HAZARD_WITHDRAW_REFUSALS.confirmed;
  return null;
}

/** The author withdraws their own hazard: gone from the map as if never posted. Idempotent. */
export const withdraw = mutation({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }) => {
    const profile = await requireProfile(ctx);
    const hazard = await ctx.db.get(hazardId);
    if (!hazard) throw new ConvexError('Hazard not found');
    if (hazard.createdByUserId !== profile._id) {
      throw new ConvexError(HAZARD_WITHDRAW_REFUSALS.notYours);
    }
    if (hazard.authorDeletedAt !== undefined) return hazardId;
    const refusal = await hazardWithdrawRefusal(ctx, hazard, profile._id);
    if (refusal) throw new ConvexError(refusal);

    const now = Date.now();
    // Moderation only, never the lifecycle: `status` stays as it was, so the pin is gone, not healed.
    await ctx.db.patch(hazardId, { moderationStatus: 'removed', authorDeletedAt: now });
    // It leaves the lake's card with the map (A06c §5).
    await recomputeBodySummary(ctx, hazard.waterBodyId);
    await writeAudit(ctx, {
      actorId: profile._id,
      action: 'author_delete',
      targetType: 'hazard',
      targetId: hazardId,
      reason: AUTHOR_DELETE_REASON,
      metadata: { priorStatus: hazard.moderationStatus, newStatus: 'removed' },
      createdAt: now,
    });
    await refreshEraseClock(ctx, 'hazard', hazardId, now);
    return hazardId;
  },
});
