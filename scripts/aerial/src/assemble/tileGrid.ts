/**
 * The slippy-tile arithmetic the assembler and verify need beyond `pmtiles`' own `zxyToTileId`: a
 * work tile's descendants as one run of tile ids, a tile's ground in degrees, and the header's
 * bounds.
 *
 * **Why a work tile's tiles are one run at every zoom.** A PMTiles tile id is the zoom's base
 * (`(4^z − 1) / 3`) plus the tile's distance along that zoom's Hilbert curve, and the curve visits
 * every aligned `2^k × 2^k` block whole, in the order of the coarser curve. So the descendants of
 * `(11, x, y)` at zoom `z` are exactly the ids
 * `base(z) + d(11, x, y) · 4^(z − 11) … + 4^(z − 11) − 1` — which is what lets the archive be laid
 * out zoom by zoom, work tile by work tile, and still be in tile-id order (clustered). The tests hold
 * this against `zxyToTileId` for every descendant.
 */

import { NAIP_WORK_ZOOM, type WorkTile } from '@skating/core';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';

/** The first tile id at zoom `z`: `(4^z − 1) / 3`. */
export function zoomBase(z: number): number {
  return (4 ** z - 1) / 3;
}

/** `[first, count]`: the ids of `tile`'s descendants at tile zoom `z` (≥ the work zoom). */
export function workTileIdRange(tile: WorkTile, z: number): [number, number] {
  const k = z - NAIP_WORK_ZOOM;
  if (k < 0) throw new Error(`zoom ${z} is above the work tile's own zoom ${NAIP_WORK_ZOOM}`);
  const d = zxyToTileId(NAIP_WORK_ZOOM, tile.x, tile.y) - zoomBase(NAIP_WORK_ZOOM);
  const span = 4 ** k;
  return [zoomBase(z) + d * span, span];
}

/** The work tile (`z = 11`) a tile at zoom ≥ 11 lies in. */
export function workTileOf(tileId: number): WorkTile {
  const [z, x, y] = tileIdToZxy(tileId);
  const k = z - NAIP_WORK_ZOOM;
  if (k < 0) throw new Error(`tile ${tileId} is at zoom ${z}, above the work zoom`);
  return { z: NAIP_WORK_ZOOM, x: Math.floor(x / 2 ** k), y: Math.floor(y / 2 ** k) };
}

/** The parent's id of a tile at zoom ≥ 1. */
export function parentTileId(tileId: number): number {
  const [z, x, y] = tileIdToZxy(tileId);
  if (z === 0) throw new Error('the zoom 0 tile has no parent');
  return zxyToTileId(z - 1, x >> 1, y >> 1);
}

/** A lon/lat box, degrees. */
export interface LonLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

function lonOf(x: number, n: number): number {
  return (x / n) * 360 - 180;
}

function latOf(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

/** The ground a slippy tile covers. */
export function tileBox(z: number, x: number, y: number): LonLatBox {
  const n = 2 ** z;
  return { west: lonOf(x, n), east: lonOf(x + 1, n), north: latOf(y, n), south: latOf(y + 1, n) };
}

/** Fractional world pixel coordinates of a point at a pixel zoom (256-px tiles). */
export function worldPixel(lon: number, lat: number, pixelZoom: number): { x: number; y: number } {
  const size = 256 * 2 ** pixelZoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/** The union of work tiles' ground: the archive header's bounds. */
export function workTilesBox(tiles: Iterable<WorkTile>): LonLatBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x);
    maxY = Math.max(maxY, t.y);
  }
  if (minX === Infinity) return null;
  const nw = tileBox(NAIP_WORK_ZOOM, minX, minY);
  const se = tileBox(NAIP_WORK_ZOOM, maxX, maxY);
  return { west: nw.west, north: nw.north, east: se.east, south: se.south };
}
