/**
 * Known seasonal body features — persistent, non-decaying water-body hazards (D53, Phase 9).
 *
 * Some "hazards" are really permanent properties of a lake: springs and inlet/outlet current,
 * constrictions, bridges and narrows, gas holes over a delta, a reef that ices thin every year, and
 * pressure ridges that reform in the same place each season. Making skaters re-mark those every visit
 * is busywork *and* a false-negative risk — an un-re-marked spring looks "gone". So they live here
 * instead: always shown, no time decay, no confirmation loop.
 *
 * Population is moderator/seed-driven (D37, refined 2026-07-23: promote/demote is part of the
 * moderator content toolkit, not admin-only). v1 shipped the schema, the reads, and the
 * promote/demote mutations; the operator UI lands in Phase 7 (D49-style).
 */

import { type HazardShape, hazardBbox, isPubliclyVisible, isValidHazardShape } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { requireContributorRole, requireRole } from './lib/auth';
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

/**
 * Operator: recent active body features across all bodies (D37/D53), each with its water-body name, for
 * the `/admin/features` management page. `requireRole('moderator')`; bounded (never scans the corpus).
 */
export const listRecent = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator');
    const features = await ctx.db.query('bodyFeatures').order('desc').take(100);
    const active = features.filter((f) => f.active);
    return Promise.all(
      active.map(async (f) => {
        const body = await ctx.db.get(f.waterBodyId);
        return {
          id: f._id,
          type: f.type,
          note: f.note,
          waterBodyId: f.waterBodyId,
          waterBodyName: body?.name ?? 'Unknown water body',
          promotedFromHazardId: f.promotedFromHazardId,
          createdAt: f.createdAt,
        };
      }),
    );
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
    const actor = await requireContributorRole(ctx, 'moderator');
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
    const id = await insertBodyFeature(ctx, {
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
 * **The source hazard is left alone.** `promotedToFeatureId` is set as a backlink and that is all it
 * does (D53 amendment, N5c): the pin goes on rendering, goes on taking confirmations, and goes on
 * resolving by permalink, because a feature is a *pattern* and a hazard is a *sighting*, and users
 * keep filing sightings of a thing the map already knows about. Its lifecycle `status` is likewise
 * untouched — setting `status: archived` here would make a moderator's promotion indistinguishable
 * from the community voting the hazard healed, laundering a moderation action into a safety verdict
 * (D3). `promotedFromHazardId` records the other direction, and `demote` clears both.
 *
 * Double-rendering is confined to the season of promotion, since the pass that promotes runs
 * pre-first-ice when last season's sightings are already season-hidden (D63) — and within that season
 * the drawer carries one line saying the spot is also marked as a recurring feature, so the two read
 * as one story.
 */
export const promote = mutation({
  args: {
    hazardId: v.id('hazards'),
    type: literals(BODY_FEATURE_TYPES),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, { hazardId, type, note, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
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

    const id = await insertBodyFeature(ctx, {
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
    // Provenance only — this hides nothing (D53 amendment). See the docstring.
    await ctx.db.patch(hazardId, { promotedToFeatureId: id });
    await audit(ctx, actor._id, 'promote_body_feature', id, reason, { hazardId });
    return id;
  },
});

/**
 * Reversible demotion — flips `active` off, never hard-deletes (D53). If the feature was promoted from
 * a hazard, the backlink is cleared, so the promotion round-trips with no data loss and no laundered
 * safety verdict. Since the D53 amendment the hazard never left the map to return to; what clearing
 * the backlink restores is its place in `listPromotionCandidates`, which is the one reader that still
 * treats a promoted pin as finished.
 */
export const demote = mutation({
  args: { bodyFeatureId: v.id('bodyFeatures'), reason: v.string() },
  handler: async (ctx, { bodyFeatureId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const feature = await ctx.db.get(bodyFeatureId);
    if (!feature) throw new ConvexError('Body feature not found');

    await ctx.db.patch(bodyFeatureId, { active: false });
    if (feature.promotedFromHazardId) {
      const source = await ctx.db.get(feature.promotedFromHazardId);
      // Only clear the backlink if this feature is still the one it points at — a hazard promoted,
      // demoted, then re-promoted elsewhere must not have the stale demotion clear the new link.
      if (source?.promotedToFeatureId === bodyFeatureId) {
        await ctx.db.patch(feature.promotedFromHazardId, { promotedToFeatureId: undefined });
      }
    }
    // **A cluster promotion set the backlink on every member, so a demotion has to clear every one**
    // (N5c / §8.2). Clearing only `promotedFromHazardId` would leave the rest of the cluster pointing
    // at a feature nobody can see any more — a provenance line in the drawer naming a standing
    // statement about the lake that has been withdrawn, which is worse than no line at all.
    //
    // Found by walking back from the promotion rather than by an index on the field: a body's clusters
    // are a handful of rows, so the read is bounded by the same thing every other per-body read is.
    const clusters = await ctx.db
      .query('hazardRecurrence')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', feature.waterBodyId))
      .collect();
    for (const cluster of clusters) {
      if (cluster.promotedToFeatureId !== bodyFeatureId) continue;
      for (const memberId of cluster.memberHazardIds) {
        const member = await ctx.db.get(memberId);
        if (member?.promotedToFeatureId !== bodyFeatureId) continue;
        await ctx.db.patch(memberId, { promotedToFeatureId: undefined });
      }
      // The cluster returns to the suggestion queue — the promotion round-trips, and an operator who
      // demoted by mistake finds the pattern where they left it rather than having to wait for July.
      await ctx.db.patch(cluster._id, {
        promotedToFeatureId: undefined,
        publiclyVisible: isPubliclyVisible({
          family: cluster.family,
          seasonsObserved: cluster.seasonsObserved,
          ...(cluster.suppressedAt !== undefined ? { suppressedAt: cluster.suppressedAt } : {}),
        }),
      });
    }
    await audit(ctx, actor._id, 'demote_body_feature', bodyFeatureId, reason, {
      priorActive: feature.active,
    });
  },
});

export async function insertBodyFeature(
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
