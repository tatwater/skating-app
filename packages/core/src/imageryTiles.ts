/**
 * A fixed grid for aerial requests, so the same ground is always the same URL (N6e / D146).
 *
 * ## The measurement this exists for
 *
 * `aerialImagery`'s module note used to say the ImageServer has *"no CDN, and therefore a courtesy
 * problem"*. Measured against the live service on 2026-08-21, that is wrong in a way that was costing
 * us everything:
 *
 * ```
 * cold (a bbox never requested before)   29.3 s median   `x-cache: Miss from cloudfront`
 * warm (the identical URL again)          0.08 s median   `x-cache: Hit from cloudfront`
 * the same bbox shifted by one metre     32.3 s          a full miss
 * the same bbox, size 1921 not 1920      22.9 s          a full miss
 * ```
 *
 * There **is** a CDN — `cache-control: max-age=43200`, twelve hours — and it is 350× faster than the
 * renderer behind it. The catch is that a cache only helps a URL that repeats, and the first
 * architecture could not produce one: the bbox came from `map.getBounds()` and the size from
 * `clientWidth × devicePixelRatio`, so every reveal on every device at every camera position was a
 * unique URL. **Every fetch we made was a cold render**, and that is the whole of the "it takes
 * seconds" problem.
 *
 * So requests are snapped to this grid. A cell has a fixed level, a fixed integer position and a
 * fixed pixel size, which makes its URL a pure function of *which ground it is* — identical between
 * two pans, two sessions, two people and two devices with different screens.
 *
 * ## Why the cells are large
 *
 * 2,048 px is deliberately much bigger than a slippy tile. Reuse pulls toward small cells and the
 * service pulls hard the other way: eight concurrent small fetches measured 22 s wall and returned
 * several *truncated* bodies (a 200 with a 0–1 KB payload). A viewport overlaps one to four of these,
 * which is a concurrency the renderer tolerates, and a cell is big enough that an ordinary pan stays
 * inside ground already fetched.
 *
 * ## The levels are ours, not the slippy convention
 *
 * A cell at level `z` spans `WORLD / 2^z` metres and is always rendered at `AERIAL_TILE_PX`, so
 * resolution is `span / 2048`. That is the slippy ladder shifted by `log2(2048/256) = 3`; naming them
 * separately keeps a reader from assuming a level here is a MapLibre zoom, which it is not.
 */

import { MERCATOR_WORLD_M, type MercatorBox } from './webMercator';

/** The full projected width of the world, in metres — the span of a level-0 cell. */
const WORLD_SPAN_M = 2 * MERCATOR_WORLD_M;

/**
 * Pixels along each side of a cell.
 *
 * Under `AERIAL_MAX_EXPORT_PX` (4,000) with room to spare, so a cell is always renderable in one
 * call, and large enough that a viewport needs only a handful. See the module note for why small
 * tiles are the wrong trade against this service.
 */
export const AERIAL_TILE_PX = 2048;

/**
 * The sharpest level worth asking for: NAIP is flown at 0.3 m and the renderer will happily upsample
 * past it, returning a bigger file with no more information in it.
 *
 * Level 16 spans `WORLD / 65536` ≈ 611 m across 2,048 px ⇒ **0.299 m/px**, which lands on the source
 * resolution almost exactly.
 */
export const AERIAL_MAX_GRID_LEVEL = 16;

/**
 * How many cells one view may request.
 *
 * The cap is about **concurrency against the renderer**, not bytes: four parallel cold renders is
 * already at the edge of where the service starts truncating responses. When a view wants more than
 * this, `fitGridLevel` steps down a level rather than dropping cells — coarser everywhere beats sharp
 * in one corner and missing in the other three.
 */
export const AERIAL_MAX_TILES_PER_VIEW = 4;

/** Ground metres per pixel at a level. */
export function gridResolution(level: number): number {
  return WORLD_SPAN_M / 2 ** level / AERIAL_TILE_PX;
}

/** The projected span of one cell at a level, in metres. */
export function gridSpan(level: number): number {
  return WORLD_SPAN_M / 2 ** level;
}

/**
 * The coarsest level that is still at least as sharp as `metersPerPixel`.
 *
 * Rounded **up** (toward sharper) rather than to nearest: a level too coarse is visibly soft, where a
 * level too sharp costs bytes nobody sees. Clamped at both ends — never past NAIP's own resolution,
 * never below 0.
 */
export function imageryGridLevel(metersPerPixel: number): number {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return AERIAL_MAX_GRID_LEVEL;
  const exact = Math.log2(WORLD_SPAN_M / (AERIAL_TILE_PX * metersPerPixel));
  return Math.max(0, Math.min(AERIAL_MAX_GRID_LEVEL, Math.ceil(exact)));
}

/** One cell of the grid: its address, and the projected box it covers. */
export interface ImageryTile {
  level: number;
  x: number;
  y: number;
  box: MercatorBox;
}

/**
 * A cell's stable identity — the cache key, and the reason a pan back is free.
 *
 * Address only. Deliberately carries no bbox floats: two computations of the same cell must produce
 * the same string, and floats reformatted through a different code path are exactly how that stops
 * being true.
 */
export function tileKey(tile: { level: number; x: number; y: number }): string {
  return `${tile.level}/${tile.x}/${tile.y}`;
}

/** The projected box of a cell address. */
export function tileBox(level: number, x: number, y: number): MercatorBox {
  const span = gridSpan(level);
  const minX = -MERCATOR_WORLD_M + x * span;
  // Row 0 at the top, the slippy convention — y grows southward, so it counts down from +worldMax.
  const maxY = MERCATOR_WORLD_M - y * span;
  return { minX, minY: maxY - span, maxX: minX + span, maxY };
}

/** The half-open cell range a box touches at a level, as integer addresses. */
export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Which cell addresses `box` touches at `level`, **without building them**.
 *
 * Separate from `imageryTilesFor` because the count has to be knowable before the array exists.
 * `fitGridLevel` starts at the sharpest level, and at level 16 a region-wide box spans some four
 * billion cells — materialising that to measure its length is not a slow path, it is an out-of-memory
 * crash, which is exactly how this function came to be written.
 *
 * Clamped to the world rather than wrapped: our region is nowhere near the antimeridian, and a wrap
 * would silently request the far side of the planet for an off-by-one at the edge.
 */
export function tileRangeFor(box: MercatorBox, level: number): TileRange {
  const span = gridSpan(level);
  const count = 2 ** level;
  const clamp = (value: number) => Math.max(0, Math.min(count - 1, value));
  return {
    minX: clamp(Math.floor((box.minX + MERCATOR_WORLD_M) / span)),
    maxX: clamp(Math.floor((box.maxX + MERCATOR_WORLD_M) / span)),
    minY: clamp(Math.floor((MERCATOR_WORLD_M - box.maxY) / span)),
    maxY: clamp(Math.floor((MERCATOR_WORLD_M - box.minY) / span)),
  };
}

/** How many cells that range holds. */
export function tileCount(range: TileRange): number {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
}

/**
 * Every cell of `level` that `box` touches, in row-major order.
 *
 * ⚠ **Go through `fitGridLevel` for anything driven by a live camera.** This builds the whole array,
 * and a sharp level over a wide box is an arbitrarily large one — see `tileRangeFor`.
 */
export function imageryTilesFor(box: MercatorBox, level: number): ImageryTile[] {
  const { minX, maxX, minY, maxY } = tileRangeFor(box, level);
  const tiles: ImageryTile[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      tiles.push({ level, x, y, box: tileBox(level, x, y) });
    }
  }
  return tiles;
}

/** The union of a set of cells — the box the composited canvas actually covers. */
export function tilesBounds(tiles: readonly ImageryTile[]): MercatorBox | null {
  if (tiles.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    minX = Math.min(minX, tile.box.minX);
    minY = Math.min(minY, tile.box.minY);
    maxX = Math.max(maxX, tile.box.maxX);
    maxY = Math.max(maxY, tile.box.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Pick the sharpest level whose cell count fits the budget, and return those cells.
 *
 * **Stepping down rather than truncating is the whole point.** A view that wants nine cells could be
 * served by dropping five of them, and the result is a photograph with holes in it — which reads as
 * broken, where uniformly coarser reads as "zoomed out". The loop is bounded by the level itself, so
 * it terminates at level 0 with a single cell covering the world.
 *
 * **Counted before it is built** (`tileRangeFor`), because the first level tried is the sharpest one
 * and a wide box there spans billions of cells — the array is only ever materialised once the level
 * is settled.
 */
export function fitGridLevel(
  box: MercatorBox,
  metersPerPixel: number,
  maxTiles: number = AERIAL_MAX_TILES_PER_VIEW,
): { level: number; tiles: ImageryTile[] } {
  const budget = Math.max(1, maxTiles);
  let level = imageryGridLevel(metersPerPixel);
  while (level > 0 && tileCount(tileRangeFor(box, level)) > budget) level -= 1;
  return { level, tiles: imageryTilesFor(box, level) };
}
