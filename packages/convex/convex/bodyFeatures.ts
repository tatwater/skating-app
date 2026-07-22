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

import { type HazardShape, hazardBbox, isValidHazardShape } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { BODY_FEATURE_TYPES } from './lib/enums';
import { HAZARD_GEOMETRY_KINDS } from './lib/hazardValidators';
import { geoJson, literals } from './lib/validators';

/** Active known features for a body — rendered alongside hazards with distinct styling. */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    return ctx.db
      .query('bodyFeatures')
      .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', body._id).eq('active', true))
      .collect();
  },
});

/** Create a known feature directly (admin/seed path). */
export const create = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    type: literals(BODY_FEATURE_TYPES),
    // Optional for back-compat: a plain point feature can omit it (inferred from `radiusMeters`); a
    // line/polygon feature supplies it explicitly along with `bufferMeters`.
    geometryKind: v.optional(literals(HAZARD_GEOMETRY_KINDS)),
    geometry: geoJson,
    radiusMeters: v.optional(v.number()),
    bufferMeters: v.optional(v.number()),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'admin');
    if (args.reason.trim().length === 0) throw new ConvexError('A reason is required');
    const body = await resolveSurvivor(ctx, args.waterBodyId);
    if (!body) throw new ConvexError('Water body not found');

    // An explicit `point_radius` with no radius would otherwise fall through to the generic "Invalid
    // body-feature geometry" from the shape gate — surface the actual missing field instead.
    if (args.geometryKind === 'point_radius' && args.radiusMeters === undefined) {
      throw new ConvexError('radiusMeters is required for point_radius body features');
    }
    const geometryKind =
      args.geometryKind ?? (args.radiusMeters !== undefined ? 'point_radius' : 'polygon');
    const id = await insertFeature(ctx, {
      waterBodyId: body._id,
      type: args.type,
      geometryKind,
      geometry: args.geometry,
      ...(args.radiusMeters !== undefined ? { radiusMeters: args.radiusMeters } : {}),
      ...(args.bufferMeters !== undefined ? { bufferMeters: args.bufferMeters } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      addedByUserId: actor._id,
    });
    await audit(ctx, actor._id, 'promote_body_feature', id, args.reason, { source: 'create' });
    return id;
  },
});

/**
 * Graduate a recurring hazard into a permanent body feature (D53).
 *
 * The source hazard is **superseded, not archived** — `promotedToFeatureId` is set so it stops
 * rendering (the feature carries the warning now), but its lifecycle `status` is left untouched. This
 * distinction is load-bearing: setting `status: archived` here would make an admin's promotion
 * indistinguishable from the community voting the hazard healed, laundering a moderation action into a
 * safety verdict (D3). The `promotedFromHazardId` backlink records where the feature came from, and
 * `demote` clears the supersession so the hazard resurfaces intact.
 */
export const promote = mutation({
  args: {
    hazardId: v.id('hazards'),
    type: literals(BODY_FEATURE_TYPES),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, { hazardId, type, note, reason }) => {
    const actor = await requireRole(ctx, 'admin');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const hazard = await ctx.db.get(hazardId);
    if (!hazard) throw new ConvexError('Hazard not found');
    // A second promote would insert a *second* active feature while `promotedToFeatureId` only ever
    // records the last one — leaving the first feature orphaned and active with no automated cleanup,
    // rendering alongside the hazard once the newer feature is demoted. One hazard promotes once; demote
    // first to re-promote.
    if (hazard.promotedToFeatureId !== undefined) {
      throw new ConvexError('Hazard is already promoted to a body feature');
    }

    const id = await insertFeature(ctx, {
      waterBodyId: hazard.waterBodyId,
      type,
      // Carry the hazard's own primitive across — a promoted line stays a line with its buffer, so the
      // feature's footprint matches the hazard it came from rather than collapsing to a hairline.
      geometryKind: hazard.geometryKind,
      geometry: hazard.geometry,
      ...(hazard.radiusMeters !== undefined ? { radiusMeters: hazard.radiusMeters } : {}),
      ...(hazard.bufferMeters !== undefined ? { bufferMeters: hazard.bufferMeters } : {}),
      ...(note !== undefined ? { note } : {}),
      addedByUserId: actor._id,
      promotedFromHazardId: hazardId,
    });
    // The feature carries the warning now, permanently and without decay — so hide the source hazard
    // via the supersession axis, NOT by archiving it (which would read as a community all-clear, D3).
    await ctx.db.patch(hazardId, { promotedToFeatureId: id });
    await audit(ctx, actor._id, 'promote_body_feature', id, reason, { hazardId });
    return id;
  },
});

/**
 * Reversible demotion — flips `active` off, never hard-deletes (D53). If the feature was promoted from
 * a hazard, the source hazard is un-superseded so it returns to the map in whatever lifecycle state it
 * was in — the promotion round-trips with no data loss and no laundered safety verdict.
 */
export const demote = mutation({
  args: { bodyFeatureId: v.id('bodyFeatures'), reason: v.string() },
  handler: async (ctx, { bodyFeatureId, reason }) => {
    const actor = await requireRole(ctx, 'admin');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const feature = await ctx.db.get(bodyFeatureId);
    if (!feature) throw new ConvexError('Body feature not found');

    await ctx.db.patch(bodyFeatureId, { active: false });
    if (feature.promotedFromHazardId) {
      const source = await ctx.db.get(feature.promotedFromHazardId);
      // Only clear supersession if this feature is still the one superseding it — a hazard promoted,
      // demoted, then re-promoted elsewhere must not be resurfaced by the stale demotion.
      if (source?.promotedToFeatureId === bodyFeatureId) {
        await ctx.db.patch(feature.promotedFromHazardId, { promotedToFeatureId: undefined });
      }
    }
    await audit(ctx, actor._id, 'demote_body_feature', bodyFeatureId, reason, {
      priorActive: feature.active,
    });
  },
});

async function insertFeature(
  ctx: MutationCtx,
  args: Omit<Doc<'bodyFeatures'>, '_id' | '_creationTime' | 'bbox' | 'active' | 'createdAt'>,
): Promise<Id<'bodyFeatures'>> {
  // Reuse the hazard footprint math so a feature's bbox is computed identically to a hazard's — a
  // promoted ridge must not shift or resize just because it changed tables. The shape is built from
  // the feature's own `geometryKind`, NOT re-inferred from whether `radiusMeters` is set — a line
  // feature (a promoted `recurring_pressure_ridge`) has a `bufferMeters`, no `radiusMeters`, and must
  // stay a line, not get mis-classified as a polygon and rejected by the shape gate.
  const shape: HazardShape =
    args.geometryKind === 'point_radius'
      ? {
          geometryKind: 'point_radius',
          geometry: args.geometry as HazardShape['geometry'],
          radiusMeters: args.radiusMeters ?? 0,
        }
      : {
          geometryKind: args.geometryKind,
          geometry: args.geometry as HazardShape['geometry'],
          ...(args.bufferMeters !== undefined ? { bufferMeters: args.bufferMeters } : {}),
        };

  // Same single gate hazards use. `create` takes raw GeoJSON from an admin, and a malformed ring or a
  // MultiLineString would otherwise reach `turf/buffer` and throw mid-mutation or store a junk bbox.
  if (!isValidHazardShape(shape)) throw new ConvexError('Invalid body-feature geometry');

  return ctx.db.insert('bodyFeatures', {
    ...args,
    bbox: hazardBbox(shape),
    active: true,
    createdAt: Date.now(),
  });
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
  });
}
