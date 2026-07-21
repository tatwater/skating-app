/**
 * Water-body resolution shared by every entity that attaches to a lake (reports, hazards, …).
 *
 * Lifted out of `reports.ts` in Phase 9 so hazards resolve bodies identically — a hazard and the
 * report it was drawn in must never end up on two different rows for the same lake.
 */

import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/**
 * Follow a merged water body to its surviving row (D36 dedup merges tombstone the loser and point it
 * at the survivor). Hop-capped so a cyclic or pathological merge chain can't spin a query forever;
 * returns `null` if the chain dead-ends.
 */
export async function resolveSurvivor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'waterBodies'> | null> {
  let body = await ctx.db.get(waterBodyId)
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
    body = await ctx.db.get(body.mergedIntoId)
  }
  return body
}
