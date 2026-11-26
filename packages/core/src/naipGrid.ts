/**
 * **The quarter-quad grid and the archive's tile grid** for the summer aerial (B05 §2.2, D317).
 *
 * A NAIP key like `4407236se` is a 3.75′ cell: the 1° block at 44°N 72°W, the 7.5′ quad 36 of 64,
 * quadrant SE. Its nominal outline is exact from the key, so the grid is computed, never read.
 *
 * **Zooms are pixel zooms** (D317 is worded in pixel terms): the zoom a 256-px tile would carry at
 * that resolution, so z18 is 0.43 m a pixel at 44°N. The archive's tiles are 512 px (Governor fork
 * G-2), so a tile's own number in the archive is the pixel zoom minus one — `naipTileZoom`. The
 * work tile is a cell of the slippy grid, which is the same ground whatever the tile size.
 *
 * PLACEHOLDER (S's): the T0 seam. The constants, `WorkTile`, `workTileKey`, `parseWorkTileKey` and
 * `naipTileZoom` are final and built (`keys.ts` and the shard contract read them); the four grid
 * functions throw until S replaces their bodies.
 */

import type { BBox } from './geometry';

/** The zoom of the unit of work: one z11 slippy tile per Machine job (§2.2). */
export const NAIP_WORK_ZOOM = 11;
/** The archive's shallowest pixel zoom; below it the aerial draws nothing (§2.3). */
export const NAIP_MIN_ZOOM = 8;
/** The archive's deepest pixel zoom, everywhere (D317): 0.43 m a pixel at 44°N. */
export const NAIP_MAX_ZOOM = 18;
/** The archive's tile edge in pixels (G-2): a quarter of the requests 256-px tiles would need. */
export const NAIP_TILE_SIZE = 512;

/**
 * A pixel zoom's tile number in the archive: `z − log2(NAIP_TILE_SIZE / 256)`. So the archive's
 * header reads 7–17, a shard holds tile zooms 11–17 (the work tile itself down to the deepest level)
 * and the assembler builds 7–10 from the shards' z11 tiles.
 */
export function naipTileZoom(pixelZoom: number): number {
  return pixelZoom - Math.log2(NAIP_TILE_SIZE / 256);
}

/** One work tile: a slippy tile at `NAIP_WORK_ZOOM`. */
export interface WorkTile {
  z: number;
  x: number;
  y: number;
}

/** A work tile's stable name, `11/<x>/<y>`: the manifest's key for it and its shard's path. */
export function workTileKey(tile: WorkTile): string {
  if (tile.z !== NAIP_WORK_ZOOM) {
    throw new Error(`a work tile is at z${NAIP_WORK_ZOOM}, not z${tile.z}`);
  }
  const span = 2 ** NAIP_WORK_ZOOM;
  for (const [axis, n] of [
    ['x', tile.x],
    ['y', tile.y],
  ] as const) {
    if (!Number.isInteger(n) || n < 0 || n >= span) {
      throw new Error(`work tile ${axis} ${n} is not a z${NAIP_WORK_ZOOM} tile index`);
    }
  }
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** The inverse of `workTileKey`; throws on anything it wouldn't have written. */
export function parseWorkTileKey(key: string): WorkTile {
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!match) throw new Error(`not a work tile key: ${key}`);
  const tile = { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
  if (workTileKey(tile) !== key) throw new Error(`not a work tile key: ${key}`);
  return tile;
}

/** A quarter-quad's nominal outline (NAD83, read as WGS84), exact from its key. */
export function quarterQuadCell(key: string): BBox {
  void key;
  return placeholder('quarterQuadCell');
}

/** The key of the quarter-quad containing a point (a point on an edge belongs to one cell only). */
export function quarterQuadAt(lat: number, lng: number): string {
  void lat;
  void lng;
  return placeholder('quarterQuadAt');
}

/**
 * Every quarter-quad key the bounds touch, sorted — the cells under a map view (§4.2). Any point in
 * the bounds has its key in the set.
 */
export function quarterQuadsIn(bounds: BBox): string[] {
  void bounds;
  return placeholder('quarterQuadsIn');
}

/** The work tiles a quarter-quad's outline touches, sorted by `workTileKey`. */
export function workTilesOf(key: string): WorkTile[] {
  void key;
  return placeholder('workTilesOf');
}

function placeholder(fn: string): never {
  throw new Error(`PLACEHOLDER (S): naipGrid.${fn} is not built yet`);
}
