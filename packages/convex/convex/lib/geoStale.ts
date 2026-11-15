/**
 * **Marking a body's geometry facts stale** (B01-3b) — split from `lib/bodyGeo.ts` so the cell index,
 * which every body creation and outline write goes through, can call it without an import cycle.
 *
 * The marks, and where they come from (the phase doc's table has every writer):
 *
 * - `syncWaterBodyCells` — **the choke point**: a body's creation, a box that moved, a listing that
 *   changed (approve, reject, merge, delete) all re-cell the body, and a changed cell set, or a body
 *   with no facts row yet, marks it here;
 * - `importCanonical` — an outline that moved inside the same box (`footprintMoved`), or a moved
 *   interior point (`placePointMoved`);
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
 * The cell index's mark: a body whose cells changed (created, moved, listed or unlisted) — or one
 * with no facts row at all — is owed a recompute. One indexed read when nothing changed.
 */
export async function markGeoStaleOnRecell(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  cellsChanged: boolean,
): Promise<void> {
  if (!cellsChanged) {
    const row = await ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
      .first();
    if (row !== null) return;
  }
  await markGeoStale(ctx, [waterBodyId]);
}

/**
 * Record that the places layer (`adminAreas`) changed: an insert, never a read, so parallel loads
 * never contend. Facts computed before the newest mark are behind, and the drift repair recomputes
 * them (`bodyGeo.repairDrift`).
 */
export async function noteAdminAreasChanged(ctx: MutationCtx, now: number = Date.now()) {
  await ctx.db.insert('geoInputMarks', { input: 'adminAreas', at: now });
}
