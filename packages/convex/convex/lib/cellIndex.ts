/**
 * The ladder-grid spatial index (N1) — the Convex half of `@skating/core`'s `spatialCells`.
 *
 * Replaces `@convex-dev/geospatial`. That component indexed a single *point* per row and read
 * roughly ∝ the `maxResults` asked for rather than ∝ what it returned, so a wide sparse viewport
 * blew Convex's 4,096-reads cap — a crash, patched twice before this (PR #10, #11) with a
 * margin-plus-outlier-list whose safety rested on constants measured against a corpus that has
 * since grown 11.6×. A plain Convex index costs only the rows it returns, and an empty cell costs
 * ~nothing, so the bound here comes from the geometry. See
 * `plans/phase-N1-read-path-durability.md`.
 *
 * Each indexed object gets one row per cell its **bbox** covers, at the level
 * `indexLevelFor` picks. Reads walk `by_cell` for the cells covering the query shape; writes diff
 * the desired cell set against the stored one. Both are bounded: an object never spans more than 4
 * cells at its own level (theorem 2), and a query never scans a level finer than its own zoom
 * (theorem 1's corollary), so neither side has a tuned number holding it up.
 */

import {
  type BBox,
  type CellLadder,
  cellsCovering,
  type GridCell,
  indexLevelFor,
  MIN_VISIBLE_ZOOM_FLOOR,
  MIN_VISIBLE_ZOOM_WIDEST,
} from '@skating/core';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * The water-body ladder. Its rungs are D49's zoom bounds *exactly* — the coarsest is the widest
 * zoom any body draws at and the finest is the discoverability floor every body draws by — so
 * there is no second set of spatial constants to keep in sync with the display scoring.
 */
export const WATER_BODY_LADDER: CellLadder = {
  minZ: MIN_VISIBLE_ZOOM_WIDEST,
  maxZ: MIN_VISIBLE_ZOOM_FLOOR,
};

/**
 * The admin-boundary ladder (Phase 5 place labels). Boundaries span from a small New England town
 * (~0.05°) to a whole state (~10°), so the rungs run coarser and finer than the water ladder's; a
 * containment lookup scans them all, since a point sits inside exactly one area per level and
 * prominence has no meaning here.
 */
export const ADMIN_AREA_LADDER: CellLadder = { minZ: 4, maxZ: 13 };

/** A stored cell row, whichever table it lives in. */
interface StoredCell {
  _id: Id<'waterBodyCells'> | Id<'adminAreaCells'> | Id<'waterBodySubAreaCells'>;
  z: number;
  x: number;
  y: number;
}

const cellKey = (c: { z: number; x: number; y: number }) => `${c.z}/${c.x}/${c.y}`;

/**
 * Diff a desired cell set against what's stored: what to insert, what to delete, what to leave.
 * Pure, so the reconciliation is testable without a database, and small — both sides are bounded
 * to ~4 rows by theorem 2, which is why the callers' `collect()` of the existing rows is safe.
 */
export function diffCells<T extends StoredCell>(
  desired: GridCell[],
  stored: T[],
): { insert: GridCell[]; remove: T[] } {
  const storedByKey = new Map(stored.map((row) => [cellKey(row), row]));
  const desiredKeys = new Set(desired.map(cellKey));
  return {
    insert: desired.filter((cell) => !storedByKey.has(cellKey(cell))),
    remove: stored.filter((row) => !desiredKeys.has(cellKey(row))),
  };
}

/**
 * Reconcile a water body's cell rows with its current geometry, prominence and listing.
 *
 * **Unlisted means absent.** A removed / rejected / merged body has *no* rows, so the listing
 * filter costs a read path nothing — where the old geospatial index kept a `listed` filter key it
 * couldn't afford to actually use (the component's filter-stream intersection roughly halved the
 * read-cap-safe ceiling, so `listInViewport` fetched unlisted bodies and dropped them in JS,
 * "cheap only because Phase 1 has ~no unlisted bodies"). Dedup and takedown both make that
 * assumption weaker over time; this makes it irrelevant.
 *
 * Call it after **any** patch to a body's bbox, `minVisibleZoom`, or listing-bearing fields
 * (`removedAt` / `reviewStatus` / `dedupStatus`).
 */
export async function syncWaterBodyCells(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  body: { bbox: BBox; minVisibleZoom: number; listed: boolean },
): Promise<void> {
  const desired = body.listed
    ? cellsCovering(body.bbox, indexLevelFor(body.bbox, WATER_BODY_LADDER, body.minVisibleZoom))
    : [];
  // Bounded to ~4 rows by theorem 2 — the one `collect()` in this file that needs no cap.
  const stored = await ctx.db
    .query('waterBodyCells')
    .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();

  const { insert, remove } = diffCells(desired, stored);
  for (const row of remove) await ctx.db.delete(row._id);
  for (const cell of insert) {
    await ctx.db.insert('waterBodyCells', {
      waterBodyId,
      ...cell,
      minVisibleZoom: body.minVisibleZoom,
    });
  }
  // A body that stayed in the same cells but changed prominence still needs its rows restamped —
  // `minVisibleZoom` is part of the read range, so a stale copy would show or hide it at the wrong
  // zoom (the `setCuratedBoost` path).
  const removed = new Set(remove.map((row) => row._id));
  for (const row of stored) {
    if (removed.has(row._id)) continue;
    if (row.minVisibleZoom !== body.minVisibleZoom) {
      await ctx.db.patch(row._id, { minVisibleZoom: body.minVisibleZoom });
    }
  }
}

/**
 * Reconcile a **named sub-area's** cell rows (N2 / D60) — the third caller of this one mechanism,
 * and structurally the water-body one with a second listing term.
 *
 * **`listed` here is a conjunction, and that's the whole point** (Decision 11). A sub-area is
 * reachable only while it is itself un-delisted *and* its parent body `isListed`. The plan gave
 * sub-areas their own `removedAt` and their own cell table and never connected the two, which would
 * have meant a landowner takedown on Lake Champlain dropping the lake's cell rows while "Malletts
 * Bay" stayed outlined and labelled on a map that no longer had the lake. N1's invariant is that an
 * unreachable object has *no rows at all*, so the filter costs nothing; inheriting the mechanism
 * without inheriting the rule would have quietly reintroduced the filter-you-have-to-remember.
 *
 * Callers therefore include every mutation that changes a **parent's** listing — `approve`, `remove`,
 * `restore`, `reject`, `merge`, `importCanonical` — not just the sub-area's own writes. See
 * `subAreas.syncCellsForParent`, which walks `by_parent` and calls this for each.
 */
export async function syncSubAreaCells(
  ctx: MutationCtx,
  subAreaId: Id<'waterBodySubAreas'>,
  subArea: { bbox: BBox; minVisibleZoom: number; listed: boolean },
): Promise<void> {
  const desired = subArea.listed
    ? cellsCovering(
        subArea.bbox,
        indexLevelFor(subArea.bbox, WATER_BODY_LADDER, subArea.minVisibleZoom),
      )
    : [];
  // Bounded to ~4 rows by theorem 2, same as the body path.
  const stored = await ctx.db
    .query('waterBodySubAreaCells')
    .withIndex('by_sub_area', (q) => q.eq('subAreaId', subAreaId))
    .collect();

  const { insert, remove } = diffCells(desired, stored);
  for (const row of remove) await ctx.db.delete(row._id);
  for (const cell of insert) {
    await ctx.db.insert('waterBodySubAreaCells', {
      subAreaId,
      ...cell,
      minVisibleZoom: subArea.minVisibleZoom,
    });
  }
  // Same restamp as the body path: `minVisibleZoom` is part of `by_cell`'s range, so a boost that
  // didn't move the shape still has to move its rows or the bay draws at the old zoom.
  const removed = new Set(remove.map((row) => row._id));
  for (const row of stored) {
    if (removed.has(row._id)) continue;
    if (row.minVisibleZoom !== subArea.minVisibleZoom) {
      await ctx.db.patch(row._id, { minVisibleZoom: subArea.minVisibleZoom });
    }
  }
}

/** Reconcile an admin boundary's cell rows (Phase 5 place labels). No listing or prominence: a
 *  boundary is always indexed, and containment doesn't care how big the area is. */
export async function syncAdminAreaCells(
  ctx: MutationCtx,
  adminAreaId: Id<'adminAreas'>,
  area: { bbox: BBox; level: string },
): Promise<void> {
  const desired = cellsCovering(area.bbox, indexLevelFor(area.bbox, ADMIN_AREA_LADDER));
  const stored = await ctx.db
    .query('adminAreaCells')
    .withIndex('by_area', (q) => q.eq('adminAreaId', adminAreaId))
    .collect();

  const { insert, remove } = diffCells(desired, stored);
  for (const row of remove) await ctx.db.delete(row._id);
  for (const cell of insert) {
    await ctx.db.insert('adminAreaCells', { adminAreaId, ...cell, level: area.level });
  }
  const removed = new Set(remove.map((row) => row._id));
  for (const row of stored) {
    if (removed.has(row._id)) continue;
    if (row.level !== area.level) await ctx.db.patch(row._id, { level: area.level });
  }
}
