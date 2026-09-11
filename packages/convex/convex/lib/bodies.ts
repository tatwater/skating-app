/**
 * Water-body resolution shared by every entity that attaches to a lake (reports, hazards, …).
 *
 * Lifted out of `reports.ts` in Phase 9 so hazards resolve bodies identically — a hazard and the
 * report it was drawn in must never end up on two different rows for the same lake.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/**
 * Follow a merged water body to its surviving row (D36 dedup merges tombstone the loser and point it
 * at the survivor). Hop-capped so a cyclic or pathological merge chain can't spin a query forever;
 * returns `null` if the chain dead-ends.
 */
export async function resolveSurvivor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodies'> | null> {
  let body = await ctx.db.get(waterBodyId);
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
    body = await ctx.db.get(body.mergedIntoId);
  }
  return body;
}

/**
 * The bay a client asked for, **only if it is really a live bay of this lake** — else `null`.
 *
 * The one validation every scoped weather read shares (N6h / open question 5): the archive panel,
 * the forecast strip and anything after them must refuse the same ids for the same reasons — a
 * delisted bay, or one that belongs to another body — and then answer for the lake rather than
 * erroring, because a stale deep link is not a fault a skater can act on. Two copies of this test
 * is how the past and the future of a Planning tab end up describing two different places.
 */
export async function liveSubAreaOf(
  ctx: QueryCtx,
  body: Pick<Doc<'waterBodies'>, '_id'>,
  subAreaId: Id<'waterBodySubAreas'> | undefined,
): Promise<Doc<'waterBodySubAreas'> | null> {
  if (!subAreaId) return null;
  const subArea = await ctx.db.get(subAreaId);
  if (!subArea || subArea.waterBodyId !== body._id || subArea.removedAt !== undefined) return null;
  return subArea;
}
