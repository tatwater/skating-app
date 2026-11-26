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
 * - **The pack** holds the tiles in ascending PMTiles tile id, streamed to disk with each tile's
 *   SHA-256 and the whole pack's (`writeShard`); the index is checked by `checkShardIndex` before
 *   it is written, so the worker can't upload one the assembler would refuse.
 * - **The done record** is built last and checked by `parseShardDone`.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
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
import type { AerialWorkUnit } from './tiles';

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

/** One warp of the mosaic: a cell's frame. */
export interface MosaicLayer {
  cell: string;
  itemId: string;
  /** The frame's position in the cell's rule order (0 = the pick). */
  rank: number;
}

/**
 * The mosaic's sources, bottom to top: per cell, the frames that supply any pixel, in reverse rule
 * order (its lowest fallback first, its pick last). Cells don't overlap — each frame is cut to its
 * own cell — so the order between cells doesn't matter; within a cell it is the whole point.
 */
export function mosaicLayers(unit: AerialWorkUnit, counts: ShardCellCounts): MosaicLayer[] {
  const layers: MosaicLayer[] = [];
  for (const cell of unit.cells) {
    const supplied = counts[cell.key] ?? {};
    const shown = cell.frames
      .map((itemId, rank) => ({ cell: cell.key, itemId, rank }))
      .filter((l) => (supplied[l.itemId] ?? 0) > 0);
    layers.push(...shown.reverse());
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
