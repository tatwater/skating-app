/**
 * **Marking a body's geometry facts stale** (B01-3b) — split from `lib/bodyGeo.ts` so the cell index,
 * which every body creation and outline write goes through, can call it without an import cycle.
 *
 * The marks, and where they come from (the phase doc's table has every writer):
 *
 * - `syncWaterBodyCells` — **the choke point for a new body**: every creation re-cells the body, and
 *   one with no facts row yet is marked here. Nothing else is marked by a re-cell (B01-3c, the
 *   coordinator's ruling): a standing, listing or prominence change moves cells, not geometry, so a
 *   rollover never sends an unchanged body back;
 * - `importCanonical` — an outline whose stamp changed (`outlineStamp`), or a moved interior point
 *   (`placePointMoved`);
 * - a merge and a deletion (`mergeBodyInto`, the two campaign prunes) — the merged-away or deleted
 *   body, whose facts the store then drops, fanning out to every body holding its outline;
 * - `noteAdminAreasChanged` — the places layer: `adminAreas.importCanonical` when a boundary is new
 *   or changed, and the two boundary deletes;
 * - `bodyGeo.store` — the bodies whose relation to a recomputed body moved, and every body that holds
 *   a copy of an outline whose stamp changed (`bodyGeoLinks`);
 * - the drift repair (`bodyGeo.repairDrift`, `bodyGeo.repairMissing`) — whatever the rest missed.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Mark bodies' geometry facts stale, so the next `bodyGeo` run recomputes them. A body already stale
 * has its mark moved to now: a computation that read its inputs before this mark sees the mark move
 * and leaves the body stale (`bodyGeo.store`), so a relation that moved mid-computation is never lost.
 */
export async function markGeoStale(
  ctx: MutationCtx,
  ids: Iterable<Id<'waterBodies'>>,
  now: number = Date.now(),
): Promise<void> {
  for (const waterBodyId of new Set(ids)) {
    const row = await ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
      .first();
    if (row === null) await ctx.db.insert('bodyGeoFacts', { waterBodyId, staleAt: now });
    else if (row.staleAt === undefined || row.staleAt < now) {
      await ctx.db.patch(row._id, { staleAt: now });
    }
  }
}

/**
 * The cell index's mark: a body with no facts row at all — a new body — is owed its first
 * computation. One indexed read; a body that has a row is left alone, whatever its cells did.
 */
export async function markGeoStaleOnRecell(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<void> {
  const row = await ctx.db
    .query('bodyGeoFacts')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (row === null) await markGeoStale(ctx, [waterBodyId]);
}

/**
 * Record that the places layer (`adminAreas`) changed: an insert, never a read, so parallel loads
 * never contend. Facts computed before the newest mark are behind, and the drift repair recomputes
 * them (`bodyGeo.repairDrift`).
 */
export async function noteAdminAreasChanged(ctx: MutationCtx, now: number = Date.now()) {
  await ctx.db.insert('geoInputMarks', { input: 'adminAreas', at: now });
}
