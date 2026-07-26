/**
 * The ladder grid (N1) — the spatial index math behind every viewport and containment read.
 *
 * **Why this exists.** Water bodies used to be found by indexing their *centroids* into
 * `@convex-dev/geospatial` and querying a rectangle. That component reads roughly ∝ the
 * `maxResults` you ask for (it walks an S2 covering internally), *not* ∝ what it returns — so a
 * wide, sparse viewport exhausted a large covering and blew Convex's hard 4,096-reads-per-query
 * cap. That is a **crash**, not slow paging, and it had to be patched twice (PR #10, #11) with a
 * margin-plus-outlier-list scheme whose safety rested on constants measured against a corpus that
 * has since grown 11.6×. See `plans/phase-N1-read-path-durability.md`.
 *
 * **The fix.** Index each object into *cells it covers*, in a plain Convex table. A plain index
 * range read costs only the rows it returns and an empty cell costs ~nothing, so the read bound
 * follows from the geometry rather than from a tuned number.
 *
 * **The grid.** Square-in-degrees and power-of-two: a cell at level `z` spans `360 / 2^z` degrees
 * in *both* axes, with `x` counted east from -180° and `y` north from -90°. Deliberately not Web
 * Mercator — the surrounding code already reasons in degrees of bbox extent, the map's zoom levels
 * ride the same power-of-two ladder anyway, and degree cells keep this file testable with no
 * projection in the middle.
 *
 * **The two theorems this file has to satisfy** (both property-tested):
 *  1. *Completeness* — at any fixed level, two intersecting bboxes share at least one cell. (The
 *     intersection contains a point; that point lies in exactly one cell; both coverings contain
 *     it.) This is what lets a query drop every margin and outlier list.
 *  2. *Bounded writes* — an object indexed at its own `fitLevel` never covers more than 4 cells,
 *     because its extent fits inside one cell in each axis and can straddle at most one boundary.
 */

import type { BBox, LatLng } from './geometry';

/** A grid cell: level `z`, then column `x` (east from -180°) and row `y` (north from -90°). */
export interface GridCell {
  z: number;
  x: number;
  y: number;
}

/** The half-open cell-index range covering a bbox at one level, plus how many cells that is. */
export interface CellRange {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** `(maxX - minX + 1) * (maxY - minY + 1)` — check this against a cap *before* materializing. */
  count: number;
}

/** Grid levels an index uses, inclusive. Coarser (smaller `z`) = bigger cells. */
export interface CellLadder {
  minZ: number;
  maxZ: number;
}

/** Cell width/height in degrees at level `z` — 360° at z=0, halving each level. */
export function cellSizeDeg(z: number): number {
  return 360 / 2 ** z;
}

/** Clamp to the valid coordinate domain so a wrapped/degenerate input can't produce a bogus cell. */
function clampLat(lat: number): number {
  return Math.min(90, Math.max(-90, lat));
}
function clampLng(lng: number): number {
  return Math.min(180, Math.max(-180, lng));
}

/**
 * The cell containing a point at level `z`. A coordinate exactly on the domain's upper edge
 * (lat 90 / lng 180) belongs to the last cell rather than a nonexistent one past the end.
 */
export function cellForPoint(point: LatLng, z: number): GridCell {
  const size = cellSizeDeg(z);
  const lastX = 2 ** z - 1;
  // The grid is square in degrees, so latitude — spanning 180°, not 360° — uses half as many rows.
  const lastY = Math.max(0, 2 ** (z - 1) - 1);
  return {
    z,
    x: Math.min(lastX, Math.floor((clampLng(point.lng) + 180) / size)),
    y: Math.min(lastY, Math.floor((clampLat(point.lat) + 90) / size)),
  };
}

/**
 * The index range covering `box` at level `z`, *without* materializing the cells — so a caller can
 * reject an absurd covering (a viewport far wider than its zoom implies) before paying for it.
 */
export function cellRangeCovering(box: BBox, z: number): CellRange {
  const lo = cellForPoint({ lat: box.minLat, lng: box.minLng }, z);
  const hi = cellForPoint({ lat: box.maxLat, lng: box.maxLng }, z);
  // A caller can hand us an inverted box; normalizing here keeps `count` honest either way.
  const minX = Math.min(lo.x, hi.x);
  const maxX = Math.max(lo.x, hi.x);
  const minY = Math.min(lo.y, hi.y);
  const maxY = Math.max(lo.y, hi.y);
  return { z, minX, maxX, minY, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) };
}

/** Every cell a bbox covers at level `z`, row-major. Bounded by construction at an object's own
 *  `fitLevel` (≤ 4 cells); check {@link cellRangeCovering}'s `count` first for anything else. */
export function cellsCovering(box: BBox, z: number): GridCell[] {
  const { minX, maxX, minY, maxY } = cellRangeCovering(box, z);
  const cells: GridCell[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) cells.push({ z, x, y });
  }
  return cells;
}

/** The widest span of a bbox in either axis, in degrees — what decides which rung an object rides. */
export function bboxExtentDeg(box: BBox): number {
  return Math.max(box.maxLat - box.minLat, box.maxLng - box.minLng);
}

/**
 * The **finest** ladder level whose cell is still at least as large as `extentDeg`, clamped to the
 * ladder. This is the write bound: at this level the object spans one cell per axis and so can
 * straddle at most one boundary in each — never more than 4 rows. A degenerate (zero-extent) or
 * non-finite extent rides the finest rung, which is correct for a point.
 */
export function fitLevel(extentDeg: number, ladder: CellLadder): number {
  if (!Number.isFinite(extentDeg) || extentDeg <= 0) return ladder.maxZ;
  const level = Math.floor(Math.log2(360 / extentDeg));
  return Math.min(ladder.maxZ, Math.max(ladder.minZ, level));
}

/**
 * The level an object is indexed at: the **coarser** of "how big it is" and an optional
 * `visibleFrom` ceiling (for water bodies, D49's `minVisibleZoom` — the zoom at which the body
 * first draws).
 *
 * Taking the coarser of the two is the entire completeness argument for a zoom-filtered query: an
 * object is always indexed at a level no finer than the zoom it first appears at, so scanning
 * levels `minZ … queryZoom` can never miss something that should be on screen. Without the
 * ceiling, a prominent-but-small body (a curated-boosted pond) would sit on a fine rung that a
 * wide-zoom query never scans, and would silently vanish from the map.
 */
export function indexLevelFor(box: BBox, ladder: CellLadder, visibleFrom?: number): number {
  const fit = fitLevel(bboxExtentDeg(box), ladder);
  const ceiling = visibleFrom === undefined ? ladder.maxZ : visibleFrom;
  return Math.min(ladder.maxZ, Math.max(ladder.minZ, Math.min(fit, ceiling)));
}

/**
 * The ladder levels a query at map zoom `zoom` must scan: every rung from the ladder's coarsest up
 * to (and including) the zoom itself. Every level returned is coarser than or equal to the
 * viewport's own zoom, so its cells are at least as large as the viewport — which is why each rung
 * contributes only a handful of cells no matter how far out you are.
 */
export function scanLevels(zoom: number, ladder: CellLadder): number[] {
  const top = Math.min(ladder.maxZ, Math.max(ladder.minZ, Math.floor(zoom)));
  const levels: number[] = [];
  for (let z = ladder.minZ; z <= top; z++) levels.push(z);
  return levels;
}

/** Every ladder level, coarsest first — what a *point* containment lookup scans (no zoom filter:
 *  a tiny pond you are standing on must be found regardless of how prominent it is). */
export function allLevels(ladder: CellLadder): number[] {
  const levels: number[] = [];
  for (let z = ladder.minZ; z <= ladder.maxZ; z++) levels.push(z);
  return levels;
}
