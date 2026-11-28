/**
 * **The worker's last steps, in TypeScript** (B05 §2.2 steps 4–5): which frames a cell mosaics,
 * the shard's pack and index, and the done record — run inside the Machine by `cut-aerial.sh`
 * through `tilesPackMain.ts`, so the contract `shard.ts` states is written by code tested against
 * it rather than by `jq` in a shell.
 *
 * - **The layers.** The worker counts each frame's pixels on the counts' grid in the rule's order —
 *   the pick's alpha first, each fallback only where everything above it is empty — and mosaics
 *   exactly the frames that supply any (`mosaicLayers`), the pick last so it wins wherever it has
 *   pixels. A fallback under a pick that covers its cell is never read at full resolution.
 *   **The counts' grid can miss a strip narrower than one of its pixels** (about 2.4 m): an upper
 *   frame whose data stops just short of where its center samples reach reads as covering, and the
 *   frame below that would fill the strip counts zero. So where an upper frame's data ends within
 *   two counts' pixels of a lower frame's, `aerial-counts.py` checks at the deepest zoom, over just
 *   that band; a frame that fills anything there is mosaicked **in the band's windows only**
 *   (`readCellWindows`) and counted, so the date index still names exactly the frames that show.
 * - **The pack** holds the tiles in ascending PMTiles tile id, streamed to disk with each tile's
 *   SHA-256 and the whole pack's (`writeShard`); the index is checked by `checkShardIndex` before
 *   it is written, so the worker can't upload one the assembler would refuse.
 * - **The done record** is built last and checked by `parseShardDone`.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseWorkTileKey } from '@skating/core';
import { zxyToTileId } from 'pmtiles';
import {
  checkShardIndex,
  parseShardDone,
  SHARD_DONE_VERSION,
  SHARD_INDEX_VERSION,
  type ShardCellCounts,
  type ShardDone,
  type ShardIndex,
  type ShardIndexEntry,
  tileInWorkTile,
} from './shard';
import { type AerialWorkUnit, MERCATOR_ORIGIN, type MercatorBounds } from './tiles';

/** One tile file the tiler wrote: `<dir>/<z>/<x>/<y>.webp`. */
export interface TileFile {
  z: number;
  x: number;
  y: number;
  path: string;
}

const INT = /^\d+$/;

/** Every `<z>/<x>/<y>.webp` under `dir` (the tiler's xyz layout); any other file is ignored. */
export function listTiles(dir: string): TileFile[] {
  const out: TileFile[] = [];
  const dirs = (p: string) =>
    readdirSync(p).filter((n) => INT.test(n) && statSync(join(p, n)).isDirectory());
  for (const z of dirs(dir)) {
    for (const x of dirs(join(dir, z))) {
      for (const name of readdirSync(join(dir, z, x))) {
        const m = /^(\d+)\.webp$/.exec(name);
        if (!m) continue;
        out.push({ z: Number(z), x: Number(x), y: Number(m[1]), path: join(dir, z, x, name) });
      }
    }
  }
  return out;
}

/** One cell's per-frame counts as the counts helper wrote them: `{ "<itemId>": <pixels> }`. */
export type FrameCounts = Record<string, number>;

/**
 * The counts of every cell in the unit, read from `<dir>/<cellKey>.json`, checked against the unit:
 * a count is a non-negative integer, and only the cell's own frames may be named. Zero counts are
 * dropped, as are cells left with none (`ShardCellCounts` lists only frames that supply a pixel).
 */
export function readCellCounts(dir: string, unit: AerialWorkUnit): ShardCellCounts {
  const counts: ShardCellCounts = {};
  for (const cell of unit.cells) {
    const raw = JSON.parse(readFileSync(join(dir, `${cell.key}.json`), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`counts for ${cell.key}: not an object`);
    }
    const frames: Record<string, number> = {};
    for (const [itemId, n] of Object.entries(raw)) {
      if (!cell.frames.includes(itemId)) {
        throw new Error(`counts for ${cell.key} name ${itemId}, which is not one of its frames`);
      }
      if (!Number.isInteger(n) || (n as number) < 0) {
        throw new Error(`counts for ${cell.key} frame ${itemId}: ${String(n)}`);
      }
      if ((n as number) > 0) frames[itemId] = n as number;
    }
    if (Object.keys(frames).length > 0) counts[cell.key] = frames;
  }
  return counts;
}

/**
 * The frames shown only in windows, per cell: `{ "<itemId>": [[minX, minY, maxX, maxY], …] }` in
 * `<dir>/<cellKey>.windows.json` (absent when none). Each is a frame that fills a strip the counts'
 * grid can't see (see the header), drawn only there so it is read only there.
 */
export type CellWindows = Record<string, Record<string, MercatorBounds[]>>;

/**
 * The windows of every cell in the unit, checked against it and its counts: only a frame of the
 * cell that the counts say supplies pixels may have windows, and each window is a box of positive
 * area inside the cell's pixels on the deepest zoom's grid (`extent`), on that grid.
 */
export function readCellWindows(
  dir: string,
  unit: AerialWorkUnit,
  counts: ShardCellCounts,
): CellWindows {
  const out: CellWindows = {};
  const onGrid = (v: number) => {
    const i = (v - MERCATOR_ORIGIN) / unit.resolution;
    return Math.abs(i - Math.round(i)) < 1e-6;
  };
  for (const cell of unit.cells) {
    const path = join(dir, `${cell.key}.windows.json`);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`windows for ${cell.key}: not an object`);
    }
    const frames: Record<string, MercatorBounds[]> = {};
    for (const [itemId, boxes] of Object.entries(raw)) {
      if (!((counts[cell.key]?.[itemId] ?? 0) > 0)) {
        throw new Error(`windows for ${cell.key} name ${itemId}, which supplies no pixel`);
      }
      if (!Array.isArray(boxes) || boxes.length === 0) {
        throw new Error(`windows for ${cell.key} frame ${itemId}: no window`);
      }
      const [ex0, ey0, ex1, ey1] = cell.extent;
      frames[itemId] = boxes.map((b: unknown) => {
        const ok =
          Array.isArray(b) &&
          b.length === 4 &&
          b.every((v) => typeof v === 'number' && Number.isFinite(v) && onGrid(v));
        const [x0, y0, x1, y1] = (ok ? b : [0, 0, 0, 0]) as MercatorBounds;
        const eps = unit.resolution * 1e-6;
        if (
          !ok ||
          !(x0 < x1 && y0 < y1) ||
          x0 < ex0 - eps ||
          y0 < ey0 - eps ||
          x1 > ex1 + eps ||
          y1 > ey1 + eps
        ) {
          throw new Error(
            `windows for ${cell.key} frame ${itemId}: ${JSON.stringify(b)} is not a box of its pixels`,
          );
        }
        return [x0, y0, x1, y1];
      });
    }
    if (Object.keys(frames).length > 0) out[cell.key] = frames;
  }
  return out;
}

/** One warp of the mosaic: a cell's frame, or one window of it. */
export interface MosaicLayer {
  cell: string;
  itemId: string;
  /** The frame's position in the cell's rule order (0 = the pick). */
  rank: number;
  /** Where it is drawn when it is drawn only in windows (`readCellWindows`); else the cell's extent. */
  window?: MercatorBounds;
}

/**
 * The mosaic's sources, bottom to top: per cell, the frames that supply any pixel, in reverse rule
 * order (its lowest fallback first, its pick last) — a frame shown only in windows as one layer a
 * window, at its place in that order. Cells don't overlap — each frame is cut to its own cell — so
 * the order between cells doesn't matter; within a cell it is the whole point.
 */
export function mosaicLayers(
  unit: AerialWorkUnit,
  counts: ShardCellCounts,
  windows: CellWindows = {},
): MosaicLayer[] {
  const layers: MosaicLayer[] = [];
  for (const cell of unit.cells) {
    const supplied = counts[cell.key] ?? {};
    const shown = cell.frames
      .map((itemId, rank) => ({ cell: cell.key, itemId, rank }))
      .filter((l) => (supplied[l.itemId] ?? 0) > 0);
    for (const l of shown.reverse()) {
      const boxes = windows[cell.key]?.[l.itemId];
      if (boxes === undefined) layers.push(l);
      else for (const window of boxes) layers.push({ ...l, window });
    }
  }
  return layers;
}

/** The pack and its index, written. */
export interface WrittenShard {
  index: ShardIndex;
  bytes: number;
  packSha256: string;
}

/**
 * Stream `tiles` into `packPath` in ascending tile id, hashing each tile and the whole. Refuses a
 * tile outside the unit's window or zooms, an empty tile, or two files for one tile id. The index
 * returned is the one `checkShardIndex` accepts for this pack.
 */
export function writeShard(
  unit: AerialWorkUnit,
  tiles: readonly TileFile[],
  packPath: string,
): WrittenShard {
  const work = parseWorkTileKey(unit.workTile);
  const ordered = tiles
    .map((t) => {
      if (t.z < unit.tileZooms.min || t.z > unit.tileZooms.max) {
        throw new Error(
          `tile ${t.z}/${t.x}/${t.y} is outside zooms ${unit.tileZooms.min}–${unit.tileZooms.max}`,
        );
      }
      const tileId = zxyToTileId(t.z, t.x, t.y);
      if (!tileInWorkTile(tileId, work)) {
        throw new Error(`tile ${t.z}/${t.x}/${t.y} is not in work tile ${unit.workTile}`);
      }
      return { ...t, tileId };
    })
    .sort((a, b) => a.tileId - b.tileId);
  // The assembler builds the archive's shallow zooms from each work tile's own top tile (§2.3), so
  // a shard with any tile must hold its window's: the worker writes it without `--skip-blank`.
  const top = unit.window.split('/').map(Number) as [number, number, number];
  if (
    ordered.length > 0 &&
    !ordered.some((t) => t.z === top[0] && t.x === top[1] && t.y === top[2])
  ) {
    throw new Error(
      `the shard has ${ordered.length} tiles but not its own top tile ${unit.window}`,
    );
  }
  const whole = createHash('sha256');
  const entries: ShardIndexEntry[] = [];
  const fd = openSync(packPath, 'w');
  let offset = 0;
  try {
    for (const [i, t] of ordered.entries()) {
      if (i > 0 && ordered[i - 1]?.tileId === t.tileId) {
        throw new Error(`two files for tile ${t.z}/${t.x}/${t.y}`);
      }
      const bytes = readFileSync(t.path);
      if (bytes.length === 0) throw new Error(`tile ${t.z}/${t.x}/${t.y} is empty`);
      writeSync(fd, bytes);
      whole.update(bytes);
      entries.push({
        tileId: t.tileId,
        offset,
        length: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      offset += bytes.length;
    }
  } finally {
    closeSync(fd);
  }
  const index = checkShardIndex(
    { version: SHARD_INDEX_VERSION, workTile: unit.workTile, entries },
    offset,
  );
  return { index, bytes: offset, packSha256: whole.digest('hex') };
}

/** The done record for a written shard, checked. */
export function buildDone(
  unit: AerialWorkUnit,
  shard: WrittenShard,
  extra: {
    image: string;
    timings: Record<string, number>;
    cellCounts: ShardCellCounts;
    finishedAt: string;
  },
): ShardDone {
  return parseShardDone({
    version: SHARD_DONE_VERSION,
    campaign: unit.campaign,
    workTile: unit.workTile,
    inputHash: unit.inputHash,
    image: extra.image,
    tiles: shard.index.entries.length,
    bytes: shard.bytes,
    packSha256: shard.packSha256,
    timings: extra.timings,
    cellCounts: extra.cellCounts,
    finishedAt: extra.finishedAt,
  });
}

/** Bytes per archive tile zoom in a written index: what the pilot reports to firm §6.1. */
export function bytesByZoom(
  index: ShardIndex,
  zoomOf: (tileId: number) => number,
): Record<number, { tiles: number; bytes: number }> {
  const out: Record<number, { tiles: number; bytes: number }> = {};
  for (const e of index.entries) {
    const z = zoomOf(e.tileId);
    const row = out[z] ?? { tiles: 0, bytes: 0 };
    row.tiles++;
    row.bytes += e.length;
    out[z] = row;
  }
  return out;
}
