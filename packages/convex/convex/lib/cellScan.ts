/**
 * The ladder-grid **read** walk (N1, extracted in N2) — the shared half of every viewport query.
 *
 * `lib/cellIndex.ts` owns the write side (which cells an object occupies); this owns the read side
 * (which cells a query looks in, and how a bounded budget is spent across them). It was inlined in
 * `waterBodies.bodiesCoveringBox` until the sub-area layer needed the same walk over a second cell
 * table. Copying it was not an option: the ~100 lines below encode four separate review corrections
 * from PR #27, each of which fixed a *silent wrong answer* rather than a crash, and a second copy
 * would drift from them one edit at a time. N1's Decision 1 asked for one spatial mechanism; the
 * read path is half of that mechanism.
 *
 * The three properties a caller gets, and why each exists:
 *
 *  1. **Rungs are admitted whole or not at all.** Cells within a rung are enumerated row-major, so
 *     cutting an over-budget plan mid-rung blanks whichever corner of the box came last, and no
 *     downstream ranking can rank back in a cell that was never looked up. Dropping the *rung*
 *     degrades along prominence instead — the axis the query already degrades along — so a short
 *     plan still says something exact: scanning rungs `minZ…K` whole finds **every** object in the
 *     box with `minVisibleZoom ≤ K`, wherever it sits.
 *
 *  2. **The row budget is spent fairly across cells.** A cell takes what it wants only after setting
 *     aside a floor for every cell still unserved, so a dense early cell can't spend the budget
 *     before the walk reaches the rest of the viewport. Without it, the caller's prominence sort
 *     would be ranking a *spatially selected* prefix and the bias would survive one level down.
 *
 *  3. **Truncation is a fact, not a guess.** Each cell is probed one row past its share, so "this
 *     cell had more" is established rather than inferred from a full read — the boundary case
 *     `takeCapped` gets wrong, and the difference between a D5 warning worth reading and one nobody
 *     trusts.
 *
 * Ranking and hydration stay with the caller, because those are the parts that differ: each cell
 * table has its own row shape and its own document table to hydrate from.
 */

import {
  allLevels,
  type CellLadder,
  cellRangeCovering,
  cellsCovering,
  scanLevels,
} from '@skating/core';

/** What a cell row has to expose for the walk: which object it points at, and how prominent it is. */
export interface ScannedCellRow<Ref extends string> {
  ref: Ref;
  minVisibleZoom: number;
}

export interface CellScanBudget {
  /**
   * Cells one rung may contribute — an *absurdity* guard, not a tight bound. A square viewport at
   * its own zoom covers ≤ 4 cells at any rung (property-tested), but a real map is many tiles wide:
   * a 3840px window spans ~15 tiles, so its finest rung covers ~150 cells, which are empty-or-tiny
   * index lookups costing almost nothing. What this catches is the incoherent case — a 1°-wide
   * viewport claiming zoom 14, which would want ~2,000 cells.
   */
  maxCellsPerLevel: number;
  /** Total cells one read may look up across all rungs. Spent a whole rung at a time (property 1). */
  cellBudget: number;
  /** Total cell rows one read may scan. Also bounds the caller's hydration, one get per candidate. */
  rowBudget: number;
  /**
   * Rows held in reserve for each not-yet-scanned cell (property 2). A *floor*, not a ration: a cell
   * still takes everything it wants whenever the budget is ample, which is every real viewport
   * measured. Four, because that's what theorem 2 bounds an object's own-rung footprint to.
   */
  minRowsPerCell: number;
  /** The caller's render budget — caps what a single cell can usefully contribute. */
  limit: number;
}

export interface CellScanResult<Ref extends string> {
  /** Candidate ref → its best (coarsest, i.e. most prominent) `minVisibleZoom`, deduped. */
  candidates: Map<Ref, number>;
  truncated: boolean;
  rowsRead: number;
  cellsScanned: number;
}

/**
 * Walk the cells covering `box` and collect candidate refs with their prominence.
 *
 * `zoom` present ⇒ scan rungs up to that zoom and apply D49's cutoff as an index range (the map).
 * `zoom` absent ⇒ scan every rung with no cutoff (a containment lookup: the pond you are standing on
 * must be found however unprominent it is).
 *
 * `fetchCell` is the only table-specific part — it runs the `by_cell` range for one cell, honoring
 * the zoom cutoff when there is one, and takes at most `probe` rows.
 */
export async function scanCells<Ref extends string>(
  box: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  ladder: CellLadder,
  budget: CellScanBudget,
  opts: { zoom?: number; label: string },
  fetchCell: (
    cell: { z: number; x: number; y: number },
    probe: number,
    zoom: number | undefined,
  ) => Promise<ScannedCellRow<Ref>[]>,
): Promise<CellScanResult<Ref>> {
  const { zoom, label } = opts;
  let rowsLeft = budget.rowBudget;
  let cellsScanned = 0;
  let truncated = false;

  // The full cell walk, materialized before any I/O so the row budget can be divided by how many
  // cells still have to be served. Pure arithmetic on the bbox — no reads — and both cell guards run
  // here, so a rung that never gets scanned doesn't inflate anyone else's share.
  //
  // Stopping at the first rung that doesn't fit (rather than skipping it and trying the next) loses
  // nothing: a finer rung's cells are strictly smaller, so its covering of the same box is never
  // smaller either. Once a rung doesn't fit, none behind it does.
  const levels = zoom === undefined ? allLevels(ladder) : scanLevels(zoom, ladder);
  const plan: { z: number; x: number; y: number }[] = [];
  for (const level of levels) {
    const range = cellRangeCovering(box, level);
    // Two ways a rung can fail to fit, worth telling apart in the log. The per-rung guard is an
    // absurdity check — only a box far wider than its zoom implies (a hand-rolled client, a wrapped
    // bbox) reaches it. The budget guard is reachable from a real window that is very wide and
    // short, whose rungs each stay under the per-rung cap but sum past the total.
    if (range.count > budget.maxCellsPerLevel) {
      console.warn(
        `${label}: box covers ${range.count} cells at level ${level} (max ${budget.maxCellsPerLevel}); rungs ${level}+ skipped, so objects that first draw at zoom ≥ ${level} are omitted (N1).`,
      );
      truncated = true;
      break;
    }
    if (plan.length + range.count > budget.cellBudget) {
      console.warn(
        `${label}: cell budget ${budget.cellBudget} would be exceeded by level ${level} (${plan.length} cells planned + ${range.count}); rungs ${level}+ skipped whole, so the answer is complete for objects drawing at zoom < ${level} and omits finer-indexed ones (N1).`,
      );
      truncated = true;
      break;
    }
    plan.push(...cellsCovering(box, level));
  }

  // An object straddling a cell boundary appears in several cells (and at several rungs when `zoom`
  // is absent); keep the coarsest rung's value, which is the object's own `minVisibleZoom`, so the
  // rank never depends on which cell found it.
  const candidates = new Map<Ref, number>();
  for (const [i, cell] of plan.entries()) {
    if (rowsLeft <= 0) {
      truncated = true;
      break;
    }
    cellsScanned++;
    // Greedy, but never at the expense of a cell behind this one (property 2). Rationing only bites
    // when the budget is actually scarce — dividing it evenly up front instead would cap an ordinary
    // 39-cell viewport at 38 rows a cell and truncate reads that comfortably fit, which is a worse
    // answer than the bias it fixes. `limit + 1` still caps a single cell: rows arrive ascending by
    // `minVisibleZoom`, so anything past a full render budget's worth from one cell is less
    // prominent than `limit` objects already in hand and can never win.
    const unserved = plan.length - i - 1;
    const floorPerCell = Math.min(budget.minRowsPerCell, Math.floor(rowsLeft / (unserved + 1)));
    const take = Math.max(1, Math.min(rowsLeft - unserved * floorPerCell, budget.limit + 1));
    // Clamped to what's left so the probe is *inside* the budget rather than beside it: every row
    // returned is charged below, and the clamp is what keeps `rowBudget` an exact ceiling instead of
    // one-per-cell more than it says.
    const probe = Math.min(take + 1, rowsLeft);
    const rows = await fetchCell(cell, probe, zoom);
    rowsLeft -= rows.length;
    if (rows.length > take) {
      // Exact: the probe row came back, so this cell holds more than its share. Those rows are the
      // least prominent in it and can't change the top of the ranking, but the answer is partial.
      truncated = true;
    } else if (rows.length === probe && probe < take + 1) {
      // The budget cut the probe short, so "there was nothing more" was never actually established.
      // On any cell but the last, the exhausted budget flags this on the next iteration — on the
      // last one, nothing would have (Greptile PR #27, round 6). D5 would rather a warning that
      // occasionally fires on a scan that happened to fit exactly than a silent truncation.
      truncated = true;
    }
    for (const row of rows) {
      const best = candidates.get(row.ref);
      if (best === undefined || row.minVisibleZoom < best)
        candidates.set(row.ref, row.minVisibleZoom);
    }
  }

  return { candidates, truncated, rowsRead: budget.rowBudget - rowsLeft, cellsScanned };
}

/**
 * Candidates in **global prominence order**, most prominent first — the second pass.
 *
 * Ranking after the scan rather than during it is the load-bearing part. `by_cell` returns ascending
 * `minVisibleZoom` within one cell, but a viewport spans many cells: accepting objects as the walk
 * reached them meant an early cell's least prominent ponds displaced a later cell's headline lake
 * whenever the budget bound, so which lakes the map showed depended on row-major cell order rather
 * than on prominence (Greptile PR #27). Sorting the whole candidate set first makes the answer
 * traversal-independent.
 *
 * Ties break on ref purely so the same viewport returns the same objects twice running.
 */
export function rankCandidates<Ref extends string>(candidates: Map<Ref, number>): Ref[] {
  return [...candidates]
    .sort(([aRef, aZoom], [bRef, bZoom]) =>
      aZoom !== bZoom ? aZoom - bZoom : aRef < bRef ? -1 : 1,
    )
    .map(([ref]) => ref);
}
