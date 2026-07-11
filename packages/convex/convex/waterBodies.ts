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
import { waterBodiesGeo } from './lib/geospatial'
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
    const now = Date.now()
    const id = await ctx.db.insert('waterBodies', {
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
      createdAt: now,
    })
    // Index the centroid for viewport/nearest lookups (D5). `createdAt` is the sortKey
    // so results order newest-consistently; `reviewStatus` is a filter key so public
    // queries can request approved-only without a post-fetch drop (D37).
    await waterBodiesGeo.insert(
      ctx,
      id,
      { latitude: args.centroid.lat, longitude: args.centroid.lng },
      { reviewStatus: 'pending' },
      now,
    )
    return id
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
    // Keep the geospatial filter key in sync: re-insert (same key overwrites) so an
    // approved-only viewport query surfaces this body (D5/D37).
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { reviewStatus: 'approved' },
      body.createdAt,
    )
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

/**
 * Public: approved water bodies whose centroid falls inside the map viewport (D5).
 *
 * The geospatial component does the cheap centroid-in-rectangle prefilter and the
 * `reviewStatus` filter server-side; we then hydrate the matched ids to full rows.
 * A body's *polygon* may extend past the viewport even when its centroid sits inside
 * (and vice-versa) — precise polygon clipping is the Turf refine step, deferred.
 */
export const listInViewport = query({
  args: { viewport: bbox, limit: v.optional(v.number()) },
  handler: async (ctx, { viewport, limit }) => {
    const { results } = await waterBodiesGeo.query(ctx, {
      shape: {
        type: 'rectangle',
        rectangle: {
          west: viewport.minLng,
          east: viewport.maxLng,
          south: viewport.minLat,
          north: viewport.maxLat,
        },
      },
      filter: (q) => q.eq('reviewStatus', 'approved'),
      limit: limit ?? 64,
    })
    // TODO(D5): Turf refine — clip to the actual polygon, not just centroid-in-bbox.
    const bodies = await Promise.all(results.map(({ key }) => ctx.db.get(key)))
    return bodies.filter((body) => body !== null)
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
