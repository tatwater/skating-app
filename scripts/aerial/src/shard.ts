/**
 * **The shard: what one work tile leaves behind** (B05 §2.2 step 5), the contract between the worker
 * that writes it and the assembler and reconcile that read it.
 *
 * Three objects per work tile (`keys.ts`' `shardKeys`):
 *
 * - **the pack** — the tiles' bytes concatenated, in ascending PMTiles tile id (which is zoom first,
 *   then Hilbert order within a zoom);
 * - **the index** (`ShardIndex`) — per tile its id, offset into the pack, length and SHA-256;
 * - **the done record** (`ShardDone`) — written last, naming the input hash it was cut for, the image
 *   that cut it, its timings and **what each frame supplied** to each cell (the date index's input,
 *   D318).
 *
 * **"Landed" is a done record whose input hash is the manifest's, never presence** (`shardLanded`):
 * A06e's reconcile by presence once reported 4,485 of 4,485 landed for a recut that spawned nothing.
 */

import {
  NAIP_MAX_ZOOM,
  NAIP_WORK_ZOOM,
  naipTileZoom,
  parseWorkTileKey,
  type WorkTile,
} from '@skating/core';
import { tileIdToZxy } from 'pmtiles';
import { parseCampaign } from './keys';

/** The archive tile zooms a shard holds: its work tile's own level down to the deepest (11–17). */
export const SHARD_TILE_ZOOMS = {
  min: naipTileZoom(NAIP_WORK_ZOOM + 1),
  max: naipTileZoom(NAIP_MAX_ZOOM),
} as const;

export const SHARD_INDEX_VERSION = 1;
export const SHARD_DONE_VERSION = 1;

/** One tile in a pack. */
export interface ShardIndexEntry {
  /** The PMTiles tile id (`zxyToTileId`), in the archive's 512-px numbering. */
  tileId: number;
  /** Byte offset into the pack. */
  offset: number;
  /** Byte length, at least 1 (`--skip-blank` writes no empty tile). */
  length: number;
  /** Hex SHA-256 of the tile's bytes: the assembler's dedupe key. */
  sha256: string;
}

/** `<x>/<y>.idx.json`. */
export interface ShardIndex {
  version: typeof SHARD_INDEX_VERSION;
  /** `workTileKey`: `11/<x>/<y>`. */
  workTile: string;
  /** Ascending by `tileId`, the pack's order; offsets contiguous from 0. */
  entries: ShardIndexEntry[];
}

/**
 * What each frame supplied: `cellCounts[cellKey][itemId]` is the number of z16-grid pixels that
 * frame supplies to that cell's part of the work tile, in the stack's order (the pick's alpha first,
 * each fallback only where everything above it is empty). Only frames that supply a pixel appear.
 */
export type ShardCellCounts = Record<string, Record<string, number>>;

/** `<x>/<y>.done.json`. */
export interface ShardDone {
  version: typeof SHARD_DONE_VERSION;
  campaign: string;
  /** `workTileKey`. */
  workTile: string;
  /** The manifest's input hash for this work tile, as it was when the shard was cut. */
  inputHash: string;
  /** The image that cut it, pinned by digest: `…@sha256:<64 hex>`. */
  image: string;
  /** The index's entry count. */
  tiles: number;
  /** The pack's length in bytes. */
  bytes: number;
  /** Hex SHA-256 of the whole pack. */
  packSha256: string;
  /** Milliseconds per step of the cut, by the worker's own step names (`warp`, `tile`, …). */
  timings: Record<string, number>;
  cellCounts: ShardCellCounts;
  /** An ISO instant. */
  finishedAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /sha256:[0-9a-f]{64}$/;
const CELL_KEY = /^\d{7}(?:ne|nw|se|sw)$/;

function fail(what: string, why: string): never {
  throw new Error(`${what}: ${why}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Is the archive tile `tileId` inside `tile`, at one of a shard's zooms? */
export function tileInWorkTile(tileId: number, tile: WorkTile): boolean {
  const [z, x, y] = tileIdToZxy(tileId);
  if (z < SHARD_TILE_ZOOMS.min || z > SHARD_TILE_ZOOMS.max) return false;
  const shift = z - NAIP_WORK_ZOOM;
  return Math.floor(x / 2 ** shift) === tile.x && Math.floor(y / 2 ** shift) === tile.y;
}

/**
 * A shard's index, checked: version, a work tile key, every entry's fields, ids strictly ascending
 * and inside the work tile at a shard zoom, offsets contiguous from 0 — and, given the pack's length,
 * that the entries end exactly there. Throws naming the first fault.
 */
export function checkShardIndex(json: unknown, packBytes?: number): ShardIndex {
  const what = 'shard index';
  if (!isRecord(json)) fail(what, 'not an object');
  if (json.version !== SHARD_INDEX_VERSION) fail(what, `version ${String(json.version)}`);
  if (typeof json.workTile !== 'string') fail(what, 'no work tile');
  let tile: WorkTile;
  try {
    tile = parseWorkTileKey(json.workTile);
  } catch (e) {
    fail(what, (e as Error).message);
  }
  if (!Array.isArray(json.entries)) fail(what, 'no entries');
  let next = 0;
  let lastId = -1;
  const entries: ShardIndexEntry[] = [];
  json.entries.forEach((raw: unknown, i: number) => {
    const at = `${what} ${json.workTile} entry ${i}`;
    if (!isRecord(raw)) fail(at, 'not an object');
    const { tileId, offset, length, sha256 } = raw;
    if (!isCount(tileId)) fail(at, `tile id ${String(tileId)}`);
    if (tileId <= lastId) fail(at, `tile id ${tileId} after ${lastId}: not ascending`);
    if (!tileInWorkTile(tileId, tile)) fail(at, `tile id ${tileId} is not in ${json.workTile}`);
    if (offset !== next) fail(at, `offset ${String(offset)}, expected ${next}`);
    if (!isCount(length) || length === 0) fail(at, `length ${String(length)}`);
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) fail(at, 'sha256 is not 64 hex');
    entries.push({ tileId, offset, length, sha256 });
    lastId = tileId;
    next = offset + length;
  });
  if (packBytes !== undefined && next !== packBytes) {
    fail(what, `entries end at ${next}, the pack is ${packBytes} bytes`);
  }
  return { version: SHARD_INDEX_VERSION, workTile: json.workTile, entries };
}

/** A done record, checked field by field; throws naming the first fault. */
export function parseShardDone(json: unknown): ShardDone {
  const what = 'done record';
  if (!isRecord(json)) fail(what, 'not an object');
  const d = json;
  if (d.version !== SHARD_DONE_VERSION) fail(what, `version ${String(d.version)}`);
  if (typeof d.campaign !== 'string') fail(what, 'no campaign');
  try {
    parseCampaign(d.campaign);
    if (typeof d.workTile !== 'string') fail(what, 'no work tile');
    parseWorkTileKey(d.workTile);
  } catch (e) {
    fail(what, (e as Error).message);
  }
  const at = `${what} ${d.workTile}`;
  if (typeof d.inputHash !== 'string' || d.inputHash === '') fail(at, 'no input hash');
  if (typeof d.image !== 'string' || !DIGEST.test(d.image)) {
    fail(at, 'the image is not pinned by digest (…@sha256:<64 hex>)');
  }
  if (!isCount(d.tiles)) fail(at, `tiles ${String(d.tiles)}`);
  if (!isCount(d.bytes)) fail(at, `bytes ${String(d.bytes)}`);
  if (typeof d.packSha256 !== 'string' || !HEX64.test(d.packSha256)) {
    fail(at, 'pack sha256 is not 64 hex');
  }
  if (!isRecord(d.timings)) fail(at, 'no timings');
  for (const [step, ms] of Object.entries(d.timings)) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) fail(at, `timing ${step}`);
  }
  if (!isRecord(d.cellCounts)) fail(at, 'no cell counts');
  for (const [cell, frames] of Object.entries(d.cellCounts)) {
    if (!CELL_KEY.test(cell)) fail(at, `${JSON.stringify(cell)} is not a cell key`);
    if (!isRecord(frames) || Object.keys(frames).length === 0) {
      fail(at, `cell ${cell} names no frame`);
    }
    for (const [itemId, n] of Object.entries(frames)) {
      if (itemId === '') fail(at, `cell ${cell} has an empty item id`);
      if (!isCount(n) || n === 0) fail(at, `cell ${cell} frame ${itemId}: count ${String(n)}`);
    }
  }
  if (typeof d.finishedAt !== 'string' || !Number.isFinite(Date.parse(d.finishedAt))) {
    fail(at, 'finishedAt is not an instant');
  }
  return d as unknown as ShardDone;
}

/** What a work tile must have been cut for: the campaign, its key and the manifest's input hash. */
export interface ShardExpectation {
  campaign: string;
  workTile: string;
  inputHash: string;
}

/**
 * Has this work tile landed? Only a done record for the same campaign and work tile whose input hash
 * is the manifest's. A missing record (`null`), a stale hash or another work tile's record is
 * outstanding — whatever else sits in the bucket.
 */
export function shardLanded(done: ShardDone | null, expected: ShardExpectation): boolean {
  return (
    done !== null &&
    done.campaign === expected.campaign &&
    done.workTile === expected.workTile &&
    done.inputHash === expected.inputHash
  );
}
