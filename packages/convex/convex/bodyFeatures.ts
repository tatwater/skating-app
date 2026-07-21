/**
 * Known seasonal body features — persistent, non-decaying water-body hazards (D53, Phase 9).
 *
 * Some "hazards" are really permanent properties of a lake: springs and inlet/outlet current,
 * constrictions, bridges and narrows, gas holes over a delta, a reef that ices thin every year, and
 * pressure ridges that reform in the same place each season. Making skaters re-mark those every visit
 * is busywork *and* a false-negative risk — an un-re-marked spring looks "gone". So they live here
 * instead: always shown, no time decay, no confirmation loop.
 *
 * Population is admin/seed-driven. v1 ships the schema, the reads, and the promote/demote mutations;
 * the operator UI is Phase 7 (D49-style), which is why these mutations exist now with no screen
 * behind them — an admin can already graduate a recurring hazard during Phase 9.
 */

import { type HazardShape, hazardBbox } from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, query } from './_generated/server'
import { requireRole } from './lib/auth'
import { resolveSurvivor } from './lib/bodies'
import { BODY_FEATURE_TYPES } from './lib/enums'
import { geoJson, literals } from './lib/validators'

/** Active known features for a body — rendered alongside hazards with distinct styling. */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await resolveSurvivor(ctx, waterBodyId)
    if (!body) return []
    return ctx.db
      .query('bodyFeatures')
      .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', body._id).eq('active', true))
      .collect()
  },
})

/** Create a known feature directly (admin/seed path). */
export const create = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    type: literals(BODY_FEATURE_TYPES),
    geometry: geoJson,
    radiusMeters: v.optional(v.number()),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'admin')
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required')
    const body = await resolveSurvivor(ctx, args.waterBodyId)
    if (!body) throw new ConvexError('Water body not found')

    const id = await insertFeature(ctx, {
      waterBodyId: body._id,
      type: args.type,
      geometry: args.geometry,
      ...(args.radiusMeters !== undefined ? { radiusMeters: args.radiusMeters } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      addedByUserId: actor._id,
    })
    await audit(ctx, actor._id, 'promote_body_feature', id, args.reason, { source: 'create' })
    return id
  },
})

/**
 * Graduate a recurring hazard into a permanent body feature (D53).
 *
 * The source hazard is **archived, not deleted** — its history, photos and confirmations stay
 * readable, and the `promotedFromHazardId` backlink records where the feature came from. Archiving
 * rather than removing also means the promotion is reversible without data loss.
 */
export const promote = mutation({
  args: {
    hazardId: v.id('hazards'),
    type: literals(BODY_FEATURE_TYPES),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, { hazardId, type, note, reason }) => {
    const actor = await requireRole(ctx, 'admin')
    if (reason.trim().length === 0) throw new ConvexError('A reason is required')
    const hazard = await ctx.db.get(hazardId)
    if (!hazard) throw new ConvexError('Hazard not found')

    const id = await insertFeature(ctx, {
      waterBodyId: hazard.waterBodyId,
      type,
      geometry: hazard.geometry,
      ...(hazard.radiusMeters !== undefined ? { radiusMeters: hazard.radiusMeters } : {}),
      ...(note !== undefined ? { note } : {}),
      addedByUserId: actor._id,
      promotedFromHazardId: hazardId,
    })
    // The hazard's job is done — the feature carries the warning now, permanently and without decay.
    await ctx.db.patch(hazardId, { status: 'archived' })
    await audit(ctx, actor._id, 'promote_body_feature', id, reason, { hazardId })
    return id
  },
})

/** Reversible demotion — flips `active` off, never hard-deletes (D53). */
export const demote = mutation({
  args: { bodyFeatureId: v.id('bodyFeatures'), reason: v.string() },
  handler: async (ctx, { bodyFeatureId, reason }) => {
    const actor = await requireRole(ctx, 'admin')
    if (reason.trim().length === 0) throw new ConvexError('A reason is required')
    const feature = await ctx.db.get(bodyFeatureId)
    if (!feature) throw new ConvexError('Body feature not found')

    await ctx.db.patch(bodyFeatureId, { active: false })
    await audit(ctx, actor._id, 'demote_body_feature', bodyFeatureId, reason, {
      priorActive: feature.active,
    })
  },
})

async function insertFeature(
  ctx: MutationCtx,
  args: Omit<Doc<'bodyFeatures'>, '_id' | '_creationTime' | 'bbox' | 'active' | 'createdAt'>,
): Promise<Id<'bodyFeatures'>> {
  // Reuse the hazard footprint math so a feature's bbox is computed identically to a hazard's — a
  // promoted ridge must not shift or resize just because it changed tables.
  const shape: HazardShape =
    args.radiusMeters !== undefined
      ? {
          geometryKind: 'point_radius',
          geometry: args.geometry as HazardShape['geometry'],
          radiusMeters: args.radiusMeters,
        }
      : { geometryKind: 'polygon', geometry: args.geometry as HazardShape['geometry'] }

  return ctx.db.insert('bodyFeatures', {
    ...args,
    bbox: hazardBbox(shape),
    active: true,
    createdAt: Date.now(),
  })
}

async function audit(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  action: 'promote_body_feature' | 'demote_body_feature',
  targetId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    actorId,
    action,
    targetType: 'bodyFeature',
    targetId,
    reason,
    metadata,
    createdAt: Date.now(),
  })
}
