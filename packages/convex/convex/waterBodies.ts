/**
 * Water-body functions.
 *
 * User-created bodies are **auto-visible then reviewed-after** (D37): `create` writes
 * a `pending` body immediately, and a moderator later resolves it via `approve`,
 * which also writes the required `moderationActions` audit row (D37). `create` steers
 * onto existing bodies through dedup at write time (D36) — stubbed here for v1.
 */

import { WATER_BODY_TYPES } from '@skating/core'
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireProfile, requireRole } from './lib/auth'
import { bbox, geoJson, latLng, literals } from './lib/validators'

/** Create a user-contributed water body, queued for after-the-fact review (D14/D37). */
export const create = mutation({
  args: {
    name: v.string(),
    type: literals(WATER_BODY_TYPES),
    polygon: geoJson,
    bbox,
    centroid: latLng,
    surfaceAreaSqM: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    // TODO(D36): match-on-create dedup (bbox prefilter → Turf IoU / name similarity)
    // to steer onto an existing body before inserting. Stubbed for the v1 scaffold.
    return ctx.db.insert('waterBodies', {
      name: args.name,
      type: args.type,
      source: 'user',
      polygon: args.polygon,
      bbox: args.bbox,
      centroid: args.centroid,
      surfaceAreaSqM: args.surfaceAreaSqM,
      createdByUserId: profile._id,
      reviewStatus: 'pending', // auto-visible, review-after (D37)
      dedupStatus: 'clean', // default (D36)
      createdAt: Date.now(),
    })
  },
})

/** Moderator/admin: approve a pending user-created body + write the audit row (D37). */
export const approve = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'moderator')
    const body = await ctx.db.get(args.waterBodyId)
    if (!body) throw new ConvexError('Water body not found')
    // Only user-created bodies enter the review queue; approving canonical (OSM/NHD)
    // bodies is meaningless and would stamp a `reviewStatus` they shouldn't have.
    if (body.source !== 'user') {
      throw new ConvexError('Only user-created water bodies can be reviewed')
    }
    // Idempotency + audit integrity: only a pending body can be approved, so we never
    // reverse a rejection or write duplicate audit rows on a re-approve.
    if (body.reviewStatus !== 'pending') {
      throw new ConvexError('Water body is not pending review')
    }

    await ctx.db.patch(args.waterBodyId, { reviewStatus: 'approved' })
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'approve_waterbody',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: 'Approved user-created water body',
      createdAt: Date.now(),
    })
    return args.waterBodyId
  },
})

/** Moderator/admin: the after-the-fact review queue of pending user bodies (D37). */
export const listPendingReview = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator')
    return ctx.db
      .query('waterBodies')
      .withIndex('by_review_status', (q) => q.eq('reviewStatus', 'pending'))
      .collect()
  },
})
