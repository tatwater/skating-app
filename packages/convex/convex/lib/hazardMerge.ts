/**
 * The server half of auto-merge (N5c / D80, layer 4) — the tombstone, the survivor chain, and the
 * footprint rule that keeps a merge from ever shrinking warned area.
 *
 * The bar itself is pure and lives in `@skating/core`'s `hazardMerge`; this module is the persistence
 * around it, modelled on D36's water-body merge (`lib/bodies.resolveSurvivor`) because that pattern is
 * already proven on this codebase and a moderator already knows how it behaves.
 */

import {
  clipFootprintToBody,
  type HazardShape,
  hazardBbox,
  hazardFootprintOf,
  MERGE_CHAIN_MAX_HOPS,
  type MergeCandidate,
  mergeSurvivorOf,
  polygonUnion,
  seasonOf,
  shouldAutoMerge,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/**
 * Follow a merged hazard to its surviving row, or `null` if the chain dead-ends.
 *
 * The twin of `resolveSurvivor` for water bodies, and hop-capped for the same reason: a cycle written
 * by a bug must degrade into "we couldn't resolve this" rather than into a query that never returns.
 * Every path that reaches a hazard by id — the permalink, the confirm mutation, a deep link from an
 * old notification — goes through here, so a link to a pin that has since been folded into another
 * lands on the live one instead of on nothing.
 */
export async function resolveHazardSurvivor(
  ctx: QueryCtx,
  hazardId: Id<'hazards'>,
): Promise<Doc<'hazards'> | null> {
  let hazard = await ctx.db.get(hazardId);
  for (
    let hops = 0;
    hazard?.mergedIntoHazardId !== undefined && hops < MERGE_CHAIN_MAX_HOPS;
    hops++
  ) {
    hazard = await ctx.db.get(hazard.mergedIntoHazardId);
  }
  // Still pointing somewhere after the cap means a cycle. Returning the tombstone would render a pin
  // that is supposed to be represented by another; `null` is the honest answer and the callers all
  // treat it as "not found".
  return hazard?.mergedIntoHazardId !== undefined ? null : hazard;
}

/** The shape a hazard row was authored as — what the footprint math reads. */
function shapeOf(hazard: Doc<'hazards'>): HazardShape {
  return {
    geometryKind: hazard.geometryKind,
    geometry: hazard.geometry as HazardShape['geometry'],
    ...(hazard.radiusMeters !== undefined ? { radiusMeters: hazard.radiusMeters } : {}),
    ...(hazard.bufferMeters !== undefined ? { bufferMeters: hazard.bufferMeters } : {}),
  };
}

/** A stored row as the pure bar reads it. */
function toCandidate(hazard: Doc<'hazards'>): MergeCandidate {
  return {
    id: hazard._id,
    type: hazard.type,
    geometryKind: hazard.geometryKind,
    geometry: hazard.geometry as HazardShape['geometry'],
    ...(hazard.radiusMeters !== undefined ? { radiusMeters: hazard.radiusMeters } : {}),
    ...(hazard.bufferMeters !== undefined ? { bufferMeters: hazard.bufferMeters } : {}),
    ...(hazard.clippedFootprint !== undefined
      ? { clippedFootprint: hazard.clippedFootprint as HazardShape['geometry'] }
      : {}),
    bbox: hazard.bbox,
    firstReportedAt: hazard.firstReportedAt,
    season: seasonOf(hazard.firstReportedAt),
    moderationStatus: hazard.moderationStatus,
    ...(hazard.mergedIntoHazardId !== undefined
      ? { mergedIntoHazardId: hazard.mergedIntoHazardId }
      : {}),
    ...(hazard.promotedToFeatureId !== undefined
      ? { promotedToFeatureId: hazard.promotedToFeatureId }
      : {}),
    ...(hazard.dismissedDuplicateOf !== undefined
      ? { dismissedDuplicateOf: hazard.dismissedDuplicateOf }
      : {}),
    ...(hazard.noMergeWith !== undefined ? { noMergeWith: hazard.noMergeWith } : {}),
  };
}

/**
 * Recompute a survivor's stored footprint as the **union of its whole chain**, clipped to the lake.
 *
 * This is the rule that makes a merge safe to automate: *a merge can never shrink the warned area*.
 * The union of two footprints is never smaller than either, so folding pins together can only ever
 * warn about more ice, never less — and because render, the stored bbox and the proximity evaluator
 * all read `clippedFootprint` when it is set, the drawn halo and the measured distance stay one shape
 * without a single client change.
 *
 * The survivor's own `geometry` / `radiusMeters` / `bufferMeters` are left untouched: those are what a
 * person drew, and a merge is not a correction of their drawing. That is also what lets `unmerge`
 * restore the original footprint by simply recomputing from them.
 */
async function refreshMergedFootprint(ctx: MutationCtx, survivor: Doc<'hazards'>): Promise<void> {
  const chain = await ctx.db
    .query('hazards')
    .withIndex('by_merged_into', (q) => q.eq('mergedIntoHazardId', survivor._id))
    .collect();

  const own = shapeOf(survivor);
  if (chain.length === 0) {
    // Nothing folded in any more (an unmerge emptied the chain): back to the pin's own footprint,
    // which is what `insertHazard` would have stored — a clip only when it actually removes area.
    const body = await ctx.db.get(survivor.waterBodyId);
    const footprint = hazardFootprintOf(toCandidateShapeOnly(survivor));
    const clipped =
      body && footprint
        ? clipFootprintToBody(footprint, body.polygon as Polygon | MultiPolygon)
        : null;
    await ctx.db.patch(survivor._id, {
      clippedFootprint: clipped ?? undefined,
      bbox: hazardBbox(own, clipped),
    });
    return;
  }

  const footprints = [survivor, ...chain]
    .map((h) => hazardFootprintOf(toCandidateShapeOnly(h)))
    .filter((f): f is Polygon | MultiPolygon => f !== null);
  const merged = polygonUnion(footprints);
  if (!merged) return; // clipper failure ⇒ leave the survivor's own footprint, which warns about less
  const body = await ctx.db.get(survivor.waterBodyId);
  const clipped = body ? clipFootprintToBody(merged, body.polygon as Polygon | MultiPolygon) : null;
  const stored = clipped ?? merged;
  await ctx.db.patch(survivor._id, {
    clippedFootprint: stored,
    bbox: hazardBbox(own, stored),
  });
}

/** The minimum `hazardFootprintOf` needs — id and time are irrelevant to a footprint. */
function toCandidateShapeOnly(hazard: Doc<'hazards'>) {
  return { ...toCandidate(hazard), id: hazard._id, firstReportedAt: hazard.firstReportedAt };
}

/**
 * Fold `loser` into `survivor`. Never called without `shouldAutoMerge` (or a moderator) saying yes.
 *
 * Writes the tombstone, then recomputes the survivor's union footprint. Confirmations are untouched
 * by design — the pooling read path counts the chain, so the survivor's consensus already includes
 * everyone who spoke about the loser, and every one of those statements stays attached to the pin the
 * person was actually looking at.
 */
export async function mergeHazards(
  ctx: MutationCtx,
  survivor: Doc<'hazards'>,
  loser: Doc<'hazards'>,
  { actorId, reason }: { actorId?: Id<'profiles'>; reason: string },
): Promise<void> {
  await ctx.db.patch(loser._id, { mergedIntoHazardId: survivor._id });
  const fresh = await ctx.db.get(survivor._id);
  if (fresh) await refreshMergedFootprint(ctx, fresh);
  // Every merge is audited, including the automatic ones — that is the whole reason auto-merge is
  // acceptable to ship. `actorId` is absent when the machine did it, because naming the creating
  // skater would record a member as having taken a moderation action they never took.
  await ctx.db.insert('moderationActions', {
    ...(actorId !== undefined ? { actorId } : {}),
    action: 'merge_hazards',
    targetType: 'hazard',
    targetId: loser._id,
    reason,
    metadata: { survivorId: survivor._id, automatic: actorId === undefined },
    createdAt: Date.now(),
  });
}

/** Separate a merged pair, and remember that a human did — so nothing re-merges them. */
export async function unmergeHazard(
  ctx: MutationCtx,
  loser: Doc<'hazards'>,
  { actorId, reason }: { actorId: Id<'profiles'>; reason: string },
): Promise<void> {
  const survivorId = loser.mergedIntoHazardId;
  if (survivorId === undefined) return;
  const survivor = await ctx.db.get(survivorId);
  await ctx.db.patch(loser._id, {
    mergedIntoHazardId: undefined,
    noMergeWith: [...(loser.noMergeWith ?? []), survivorId],
  });
  if (survivor) {
    await ctx.db.patch(survivor._id, {
      noMergeWith: [...(survivor.noMergeWith ?? []), loser._id],
    });
    const fresh = await ctx.db.get(survivor._id);
    if (fresh) await refreshMergedFootprint(ctx, fresh);
  }
  await ctx.db.insert('moderationActions', {
    actorId,
    action: 'unmerge_hazards',
    targetType: 'hazard',
    targetId: loser._id,
    reason,
    metadata: { survivorId },
    createdAt: Date.now(),
  });
}

/**
 * Try to fold a freshly-created hazard into an existing one (D80, layer 4).
 *
 * **Runs at create**, in the same mutation, which is the moment the duplicate actually appears and the
 * same moment the draw-time nudge fired. Any later — a sweep, a cron — and there is a window in which
 * the map shows two pins for one ridge, which is the state this exists to remove. The read is bounded
 * by body and season, exactly like the pooling scope it shares.
 *
 * Returns the surviving hazard's id, which is the new row's own id when nothing merged.
 */
export async function tryAutoMerge(
  ctx: MutationCtx,
  hazardId: Id<'hazards'>,
): Promise<{ survivorId: Id<'hazards'>; mergedLoserId?: Id<'hazards'> }> {
  const fresh = await ctx.db.get(hazardId);
  if (!fresh) return { survivorId: hazardId };

  const season = seasonOf(fresh.firstReportedAt);
  const siblings = await ctx.db
    .query('hazards')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', fresh.waterBodyId).eq('status', 'active'),
    )
    .collect();

  const candidate = toCandidate(fresh);
  for (const other of siblings) {
    if (other._id === fresh._id) continue;
    if (seasonOf(other.firstReportedAt) !== season) continue;
    if (shouldAutoMerge(candidate, toCandidate(other)).merge !== true) continue;

    // The earliest sighting survives — the honest first-seen date, and the one recurrence keys on.
    const survivorIsOther = mergeSurvivorOf(candidate, toCandidate(other)).id === other._id;
    const survivor = survivorIsOther ? other : fresh;
    const loser = survivorIsOther ? fresh : other;
    await mergeHazards(ctx, survivor, loser, {
      reason: 'Footprints overlap above the automatic-merge bar (D80).',
    });
    return { survivorId: survivor._id, mergedLoserId: loser._id };
  }
  return { survivorId: hazardId };
}
