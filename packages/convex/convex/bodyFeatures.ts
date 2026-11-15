/**
 * Known seasonal body features — persistent, non-decaying water-body hazards (D53, Phase 09a).
 *
 * Some "hazards" are really permanent properties of a lake: springs and inlet/outlet current,
 * constrictions, bridges and narrows, gas holes over a delta, a reef that ices thin every year, and
 * pressure ridges that reform in the same place each season. Making skaters re-mark those every visit
 * is busywork *and* a false-negative risk — an un-re-marked spring looks "gone". So they live here
 * instead: always shown, no time decay, no confirmation loop.
 *
 * Population is moderator/seed-driven (D37, refined 2026-07-23: promote/demote is part of the
 * moderator content toolkit, not admin-only). v1 shipped the schema, the reads, and the
 * promote/demote mutations; the operator UI is the lake editor's Known-features tool.
 */

import {
  bboxIntersects,
  HAZARD_MAX_VERTICES,
  type HazardShape,
  hazardBbox,
  isPubliclyVisible,
  isValidHazardShape,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { writeAudit, writeSnapshot } from './lib/audit';
import { requireCapability } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { BODY_FEATURE_TYPES } from './lib/enums';
import { HAZARD_GEOMETRY_KINDS } from './lib/hazardValidators';
import { MAX_BODY_CLUSTERS } from './lib/recurrence';
import { hazardCenter } from './lib/sampling';
import { geoJson, literals } from './lib/validators';
import { resolveSubAreaForPoint } from './subAreas';

/** Active known features for a body — rendered alongside hazards with distinct styling. */
export const listForBody = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    /**
     * Narrow to one named bay (A09) — the bay view's list, the same scope `hazards.listForBody`
     * takes. Filtered in memory off the row's stamp, like the hazards: the read is already bounded
     * by body, and a feature's bay is its footprint center's. A spring in the next bay over is a
     * standing fact about *that* bay, and listing it under this one would be the map's "known
     * features" card claiming a hazard that is not on the ice the skater picked.
     */
    subAreaId: v.optional(v.id('waterBodySubAreas')),
  },
  handler: async (ctx, { waterBodyId, subAreaId }) => {
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const rows = await ctx.db
      .query('bodyFeatures')
      .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', body._id).eq('active', true))
      .collect();
    return subAreaId === undefined ? rows : rows.filter((f) => f.subAreaId === subAreaId);
  },
});

/**
 * Operator: recent active body features across all bodies (D37/D53), each with its water-body name, for
 * the `/admin/features` management page. `requireCapability('corpus.read')`; bounded (never scans the corpus).
 */
export const listRecent = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'corpus.read');
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
    const actor = await requireCapability(ctx, 'corpus.preIce');
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
 * does (D53 amendment, A05c): the pin goes on rendering, goes on taking confirmations, and goes on
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
    const actor = await requireCapability(ctx, 'corpus.preIce');
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
    const actor = await requireCapability(ctx, 'corpus.preIce');
    await demoteImpl(ctx, actor, { bodyFeatureId, reason });
  },
});

/**
 * `demote`'s body — also what undoing a promotion runs (D226), so the undo clears the source hazard's
 * backlink and sends a promoted cluster back to the recurrence queue exactly as a demote does.
 */
export async function demoteImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  { bodyFeatureId, reason }: { bodyFeatureId: Id<'bodyFeatures'>; reason: string },
): Promise<void> {
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
  // (A05c / §8.2). Clearing only `promotedFromHazardId` would leave the rest of the cluster pointing
  // at a feature nobody can see any more — a provenance line in the drawer naming a standing
  // statement about the lake that has been withdrawn, which is worse than no line at all.
  //
  // Found by walking back from the promotion rather than by an index on the field: a body's clusters
  // are a handful of rows. Bounded anyway, at the shared ceiling — "a handful" is a fact about
  // today's corpus, and this phase has now twice been wrong about which of those stay true (§20).
  const clusters = await ctx.db
    .query('hazardRecurrence')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', feature.waterBodyId))
    .take(MAX_BODY_CLUSTERS);
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
}

// ── A feature's shape (B01-3d) ────────────────────────────────────────────────────────────────

/**
 * The most positions a known feature's geometry carries — a ridge or an inlet, not a shoreline. The
 * hazards' shape gate's own ceiling, checked first so a long geometry is refused with its count
 * before the gate's self-intersection pass runs over it.
 */
export const MAX_FEATURE_POSITIONS = HAZARD_MAX_VERTICES;

/** A feature's shape as one edit sets it: its kind, its geometry, and the width that goes with it. */
export interface FeatureShape {
  geometryKind: Doc<'bodyFeatures'>['geometryKind'];
  geometry: unknown;
  radiusMeters?: number;
  bufferMeters?: number;
}

/**
 * A feature's shape as the hazards' gate and footprint math read it — one rule for a feature created
 * and one redrawn. Built from the feature's own `geometryKind`, NOT re-inferred from whether
 * `radiusMeters` is set — a line feature (a promoted `recurring_pressure_ridge`) has a
 * `bufferMeters`, no `radiusMeters`, and must stay a line, not get mis-classified as a polygon and
 * rejected by the shape gate.
 */
function featureHazardShape(shape: FeatureShape): HazardShape {
  return shape.geometryKind === 'point_radius'
    ? {
        geometryKind: 'point_radius',
        geometry: shape.geometry as HazardShape['geometry'],
        radiusMeters: shape.radiusMeters ?? 0,
      }
    : {
        geometryKind: shape.geometryKind,
        geometry: shape.geometry as HazardShape['geometry'],
        ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
      };
}

/** How many positions a GeoJSON geometry holds, every ring and line counted. */
function positionCount(coords: unknown): number {
  if (!Array.isArray(coords)) return 0;
  if (coords.length > 0 && typeof coords[0] === 'number') return 1;
  return coords.reduce((n: number, c) => n + positionCount(c), 0);
}

/**
 * The shape a feature may take, checked once at the write: the hazards' own gate (a valid point,
 * line or polygon with its width), at most {@link MAX_FEATURE_POSITIONS} positions, and a footprint
 * that meets the body's box — a feature is on its lake. Returns the shape and its footprint's box.
 */
function checkedShape(
  shape: FeatureShape,
  bodyBox: Doc<'waterBodies'>['bbox'],
): { shape: HazardShape; bbox: Doc<'bodyFeatures'>['bbox'] } {
  if (shape.geometryKind === 'point_radius' && shape.radiusMeters === undefined) {
    throw new ConvexError('radiusMeters is required for point_radius body features');
  }
  const coords = (shape.geometry as { coordinates?: unknown } | null)?.coordinates;
  if (positionCount(coords) > MAX_FEATURE_POSITIONS) {
    throw new ConvexError(`A known feature's shape is at most ${MAX_FEATURE_POSITIONS} points`);
  }
  const hazardShape = featureHazardShape(shape);
  if (!isValidHazardShape(hazardShape)) throw new ConvexError('Invalid body-feature geometry');
  const bbox = hazardBbox(hazardShape);
  if (!bboxIntersects(bbox, bodyBox)) {
    throw new ConvexError('A known feature has to be on its lake');
  }
  return { shape: hazardShape, bbox };
}

/**
 * Why a redraw of this feature is refused as the rows stand, or `null` — one rule for the write and
 * for whether its undo is offered (B01-3d): a feature gone or demoted, a lake merged away (a merge
 * leaves its features on the loser), and — given a `shape` — a shape the write would turn down, which
 * includes one an outline redrawn or re-imported since has left off the lake.
 */
export function shapeRefusal(
  feature: Doc<'bodyFeatures'> | null,
  body: Doc<'waterBodies'> | null,
  shape?: FeatureShape,
): string | null {
  if (!feature) return 'Known feature not found';
  if (!feature.active) return 'This feature was demoted — restore it before redrawing';
  if (!body || body.dedupStatus === 'merged') return 'This feature’s lake was merged into another';
  if (shape === undefined) return null;
  try {
    checkedShape(shape, body.bbox);
    return null;
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === 'string') return error.data;
    throw error;
  }
}

/**
 * Moderator: redraw a known feature (B01-3d, `corpus.preIce`, as creating one is). What it changes:
 * the feature's geometry, its box, and the bay it is stamped into — never the body's outline or its
 * geometry facts, and no library fact counts a feature's shape. A demoted feature, or one on a body
 * merged away, is refused. Audited with the replaced shape as the row's snapshot; undone as this
 * write of the previous shape.
 */
export const updateShape = mutation({
  args: {
    bodyFeatureId: v.id('bodyFeatures'),
    geometryKind: literals(HAZARD_GEOMETRY_KINDS),
    geometry: geoJson,
    radiusMeters: v.optional(v.number()),
    bufferMeters: v.optional(v.number()),
    reason: v.string(),
  },
  handler: async (ctx, { bodyFeatureId, reason, ...shape }) => {
    const actor = await requireCapability(ctx, 'corpus.preIce');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    return updateShapeImpl(ctx, actor, { bodyFeatureId, shape, reason: reason.trim() });
  },
});

/** `updateShape`'s body, shared with its undo. */
export async function updateShapeImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  {
    bodyFeatureId,
    shape,
    reason,
  }: { bodyFeatureId: Id<'bodyFeatures'>; shape: FeatureShape; reason: string },
): Promise<Id<'bodyFeatures'>> {
  const feature = await ctx.db.get(bodyFeatureId);
  const body = feature ? await ctx.db.get(feature.waterBodyId) : null;
  const refused = shapeRefusal(feature, body);
  if (refused !== null || !feature || !body)
    throw new ConvexError(refused ?? 'Known feature not found');
  const { bbox } = checkedShape(shape, body.bbox);
  const subArea = await resolveSubAreaForPoint(ctx, feature.waterBodyId, hazardCenter({ bbox }));
  const prev: FeatureShape = {
    geometryKind: feature.geometryKind,
    geometry: feature.geometry,
    ...(feature.radiusMeters !== undefined ? { radiusMeters: feature.radiusMeters } : {}),
    ...(feature.bufferMeters !== undefined ? { bufferMeters: feature.bufferMeters } : {}),
  };
  await ctx.db.patch(bodyFeatureId, {
    geometryKind: shape.geometryKind,
    geometry: shape.geometry as Doc<'bodyFeatures'>['geometry'],
    radiusMeters: shape.geometryKind === 'point_radius' ? shape.radiusMeters : undefined,
    bufferMeters: shape.geometryKind === 'point_radius' ? undefined : shape.bufferMeters,
    bbox,
    subAreaId: subArea?.subAreaId,
  });
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'update_body_feature_shape',
    targetType: 'bodyFeature',
    targetId: bodyFeatureId,
    reason,
    metadata: { geometryKind: shape.geometryKind, prev: { snapshot: true } },
    createdAt: Date.now(),
  });
  await writeSnapshot(ctx, actionId, prev);
  return bodyFeatureId;
}

export async function insertBodyFeature(
  ctx: MutationCtx,
  args: Omit<
    Doc<'bodyFeatures'>,
    '_id' | '_creationTime' | 'bbox' | 'active' | 'createdAt' | 'subAreaId'
  >,
): Promise<Id<'bodyFeatures'>> {
  // Reuse the hazard footprint math so a feature's bbox is computed identically to a hazard's — a
  // promoted ridge must not shift or resize just because it changed tables.
  const shape = featureHazardShape(args);

  // Same single gate hazards use. `create` takes raw GeoJSON from an admin, and a malformed ring or a
  // MultiLineString would otherwise reach `turf/buffer` and throw mid-mutation or store a junk bbox.
  if (!isValidHazardShape(shape)) throw new ConvexError('Invalid body-feature geometry');

  const bbox = hazardBbox(shape);
  // The bay the feature sits in (A09) — the hazard rule, by the footprint's center. Re-stamped by
  // `subAreas.restampParent` on a redraw, like the hazard it may have been promoted from.
  const subArea = await resolveSubAreaForPoint(ctx, args.waterBodyId, hazardCenter({ bbox }));
  return ctx.db.insert('bodyFeatures', {
    ...args,
    bbox,
    active: true,
    createdAt: Date.now(),
    ...(subArea !== null ? { subAreaId: subArea.subAreaId } : {}),
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
  await writeAudit(ctx, {
    actorId,
    action,
    targetType: 'bodyFeature',
    targetId,
    reason,
    metadata,
    createdAt: Date.now(),
  });
}
