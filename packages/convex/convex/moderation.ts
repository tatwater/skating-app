/**
 * Moderation functions (D32/D37) — the minimal founder takedown path. Role-gated
 * (`requireRole('moderator')`); every action writes **exactly one** `moderationActions` audit row
 * (accountability for appeals/reversals). This is the inline hide/remove/restore + flag-resolution
 * surface; the full `/admin` work queues + email alerts are Phase 7 (D37/D38).
 *
 * Moderation applies to the UGC that carries a `moderationStatus` — **reports and comments**. Hiding
 * a report also hides its comments at read time (a comment on a hidden report is unreachable — see
 * `comments.listByReport`), so no cascade write is needed.
 */

import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { mutation } from './_generated/server'
import { requireRole } from './lib/auth'
import { bumpContributionCount, visibleDelta } from './lib/contributionCounts'
import { MODERATION_STATUSES } from './lib/enums'
import { literals } from './lib/validators'

/** The audit action implied by a target moderation status (D37). */
const ACTION_FOR_STATUS = {
  visible: 'restore',
  hidden: 'hide',
  removed: 'remove',
} as const

/**
 * Set a report's or comment's moderation status (D32/D37). `requireRole('moderator')`; patches the
 * target and writes one `hide` / `remove` / `restore` audit row with the required reason. A no-op
 * status change (already at `status`) still records the action — the moderator asserted a decision.
 */
export const setModerationStatus = mutation({
  args: {
    targetType: literals(['report', 'comment']),
    targetId: v.string(),
    status: literals(MODERATION_STATUSES),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'moderator')
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required')

    const table = args.targetType === 'report' ? 'reports' : 'comments'
    const targetId = ctx.db.normalizeId(table, args.targetId)
    if (!targetId) throw new ConvexError('Target not found')
    const target = await ctx.db.get(targetId)
    if (!target) throw new ConvexError('Target not found')

    const typedTarget = target as Doc<'reports'> | Doc<'comments'>
    const priorStatus = typedTarget.moderationStatus
    await ctx.db.patch(targetId, { moderationStatus: args.status })

    // Keep the author's denormalized contribution counter exact: a hide/remove of a visible item
    // decrements, a restore back to visible increments, a no-op transition moves it by 0.
    await bumpContributionCount(
      ctx,
      typedTarget.authorId,
      args.targetType === 'report' ? 'reportCount' : 'commentCount',
      visibleDelta(priorStatus, args.status),
    )

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: ACTION_FOR_STATUS[args.status],
      targetType: args.targetType,
      targetId: args.targetId,
      reason: args.reason,
      metadata: { priorStatus, newStatus: args.status },
      createdAt: Date.now(),
    })
    return targetId
  },
})

/**
 * Resolve a content flag (D32/D37). `requireRole('moderator')`; sets the flag terminal status
 * (`actioned` / `dismissed`) + `resolvedBy`/`resolvedAt` and writes one `resolve_flag` /
 * `dismiss_flag` audit row. Taking down the flagged content is a separate `setModerationStatus`
 * call (so the two decisions are each audited).
 */
export const resolveFlag = mutation({
  args: {
    flagId: v.id('contentFlags'),
    resolution: literals(['actioned', 'dismissed']),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'moderator')
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required')

    const flag = await ctx.db.get(args.flagId)
    if (!flag) throw new ConvexError('Flag not found')

    const now = Date.now()
    await ctx.db.patch(args.flagId, {
      status: args.resolution,
      resolvedByUserId: actor._id,
      resolvedAt: now,
    })

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: args.resolution === 'actioned' ? 'resolve_flag' : 'dismiss_flag',
      targetType: 'contentFlag',
      targetId: args.flagId,
      reason: args.reason,
      createdAt: now,
    })
    return args.flagId
  },
})
