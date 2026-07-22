/**
 * Content-flag functions (D32/D3). Any active user can flag a report / comment / photo / user for
 * abuse. `unsafe_false_report` is a **first-class** reason: a dangerously false "ice is great" claim
 * is a safety incident, not mere spam (D3) — it lands in the admin flag queue's priority lane later
 * (Phase 7). No queue UI here; rows accrue as `contentFlags` the founder reads via the Convex
 * dashboard for now.
 */

import { ConvexError, v } from 'convex/values'
import type { Id, TableNames } from './_generated/dataModel'
import { mutation } from './_generated/server'
import { requireProfile } from './lib/auth'
import { FLAG_REASONS, FLAG_TARGET_TYPES } from './lib/enums'
import { literals } from './lib/validators'

/** The table each flag target type refers to — used to validate the target actually exists. */
const TARGET_TABLE: Record<(typeof FLAG_TARGET_TYPES)[number], TableNames> = {
  report: 'reports',
  comment: 'comments',
  photo: 'photos',
  user: 'profiles',
  hazard: 'hazards', // Phase 9 (D51) — mods can hide a bad pin
}

/**
 * Flag content for abuse/safety review (D32). `requireProfile`; the target must exist; deduped to
 * **one open flag per (flagger, target)** — a repeat flag returns the existing open row rather than
 * piling up duplicates. Resolution + the priority-lane queue are Phase 7.
 */
export const flag = mutation({
  args: {
    targetType: literals(FLAG_TARGET_TYPES),
    targetId: v.string(),
    reason: literals(FLAG_REASONS),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)

    // Validate the target exists (and that targetId is a real id for its table).
    const table = TARGET_TABLE[args.targetType]
    const targetId = ctx.db.normalizeId(table, args.targetId)
    if (!targetId) throw new ConvexError('Target not found')
    const target = await ctx.db.get(targetId as Id<TableNames>)
    if (!target) throw new ConvexError('Target not found')

    // Dedupe: one *open* flag per (flagger, target). A repeat flag is a no-op that returns the row.
    const existing = await ctx.db
      .query('contentFlags')
      .withIndex('by_target', (q) =>
        q.eq('targetType', args.targetType).eq('targetId', args.targetId),
      )
      .filter((q) => q.eq(q.field('flaggerId'), profile._id))
      .filter((q) => q.eq(q.field('status'), 'open'))
      .first()
    if (existing) return existing._id

    return ctx.db.insert('contentFlags', {
      flaggerId: profile._id,
      targetType: args.targetType,
      targetId: args.targetId,
      reason: args.reason,
      ...(args.note !== undefined ? { note: args.note } : {}),
      status: 'open',
      createdAt: Date.now(),
    })
  },
})
