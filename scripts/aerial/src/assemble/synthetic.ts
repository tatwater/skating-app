/**
 * **Synthetic builds**: a hand-shaped manifest and the shards a cut would have left for it, written
 * into a directory laid out like the bucket (`keys.ts`' build prefix). The assembler and verify are
 * built and proven against these until the select stage and the worker land (B05 §7.2), and the
 * streaming proof (`proofs/stream.ts`) writes a large one.
 *
 * Tile bytes are deterministic noise, a function of the tile id (so a proof can regenerate any tile
 * to compare without holding them), with every `dupEvery`-th tile one shared "water" blob so dedupe
 * has something to find. They are not WebP; nothing here decodes them.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  NAIP_MANIFEST_VERSION,
  NAIP_RULE_VERSION,
  NAIP_WORK_ZOOM,
  type NaipManifest,
  type NaipManifestFrame,
  type NaipState,
  type WorkTile,
  workTileKey,
} from '@skating/core';
import { shardKeys } from '../keys';
import type { ShardCellCounts, ShardDone, ShardIndex } from '../shard';
import { prng } from './prng';
import { workTileIdRange } from './tileGrid';

export const SYNTHETIC_IMAGE = `registry.fly.io/skating-imagery@sha256:${'ab'.repeat(32)}`;

export interface SyntheticTiles {
  /** Mean bytes a tile (lengths vary ±50% around it). */
  meanBytes: number;
  /** Every `dupEvery`-th tile is the shared water blob (0: none). */
  dupEvery: number;
  /** Fraction of each zoom's tiles present, by tile zoom (default: all to 13, a sample deeper). */
  density?: (z: number) => number;
}

const WATER_SEED = 0x5eed;

/** A tile's length and bytes, deterministic from its id. */
export function syntheticTile(tileId: number, spec: SyntheticTiles): Uint8Array {
  const water = spec.dupEvery > 0 && tileId % spec.dupEvery === 0;
  const rand = prng(water ? WATER_SEED : tileId * 2_654_435_761);
  const length = Math.max(1, Math.round(spec.meanBytes * (0.5 + rand())));
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 4) {
    const v = (rand() * 4_294_967_296) >>> 0;
    out[i] = v & 0xff;
    if (i + 1 < length) out[i + 1] = (v >>> 8) & 0xff;
    if (i + 2 < length) out[i + 2] = (v >>> 16) & 0xff;
    if (i + 3 < length) out[i + 3] = v >>> 24;
  }
  return out;
}

/** Which of a work tile's descendants at zoom `z` the synthetic cut "drew". */
export function* syntheticIds(tile: WorkTile, z: number, density: number): Generator<number> {
  const [first, count] = workTileIdRange(tile, z);
  if (density <= 0) return;
  if (density >= 1) {
    for (let i = 0; i < count; i++) yield first + i;
    return;
  }
  const rand = prng(first);
  let any = false;
  for (let i = 0; i < count; i++) {
    if (rand() < density) {
      any = true;
      yield first + i;
    }
  }
  // A zoom drawn at all keeps at least one tile, so only a density of 0 empties it.
  if (!any) yield first;
}

const defaultDensity = (z: number): number => (z <= 13 ? 1 : 0.5 ** (z - 13));

/** A synthetic cell key: `44<lon 3><quad 2><quadrant>`, distinct per (work tile, slot). */
export function syntheticCell(workTileIndex: number, slot: number): string {
  const quadrant = (['nw', 'ne', 'sw', 'se'] as const)[slot % 4] as string;
  const lon = 70 + Math.floor(workTileIndex / 64);
  const quad = (workTileIndex % 64) + 1;
  return `44${String(lon).padStart(3, '0')}${String(quad).padStart(2, '0')}${quadrant}`;
}

/** An item id of the real shape for a cell, a state, a gsd (m) and an acquisition day. */
export function syntheticItem(
  cell: string,
  state: NaipState,
  gsd: number,
  acquired: string,
): string {
  const qq = cell.slice(0, 7);
  const quadrant = cell.slice(7);
  const zone = Number(cell.slice(2, 5)) >= 72 ? 18 : 19;
  return `${state.toLowerCase()}_m_${qq}_${quadrant}_${zone}_${String(Math.round(gsd * 100)).padStart(3, '0')}_${acquired.replaceAll('-', '')}`;
}

export interface SyntheticBuild {
  manifest: NaipManifest;
  /** The done records' counts, by work tile key. */
  counts: Map<string, ShardCellCounts>;
  /** Tiles written per work tile. */
  tiles: Map<string, number>;
  /** Pack bytes in all. */
  bytes: number;
}

/**
 * Write a synthetic build's shards under `root` and return its manifest. Each work tile touches two
 * cells of its own and shares a third with the next (so a cell spans work tiles); each cell's pick
 * is a 2025 0.3 m frame, and every third cell is partial, its 2023 fallback supplying pixels too.
 */
export async function writeSyntheticBuild(
  root: string,
  options: {
    campaign: string;
    pilot?: string;
    workTiles: readonly WorkTile[];
    tiles: SyntheticTiles;
    /** Skip these work tiles' shards (an incomplete set). */
    omit?: ReadonlySet<string>;
  },
): Promise<SyntheticBuild> {
  const { campaign, pilot } = options;
  const density = options.tiles.density ?? defaultDensity;
  const frames: Record<string, NaipManifestFrame> = {};
  const cells = new Map<string, NaipManifest['cells'][number]>();
  const counts = new Map<string, ShardCellCounts>();
  const tilesPer = new Map<string, number>();
  const workTiles: NaipManifest['workTiles'] = [];
  let total = 0;

  const sorted = [...options.workTiles].sort((a, b) =>
    workTileKey(a) < workTileKey(b) ? -1 : workTileKey(a) > workTileKey(b) ? 1 : 0,
  );
  for (const [w, tile] of sorted.entries()) {
    const key = workTileKey(tile);
    const own = [syntheticCell(w, 0), syntheticCell(w, 1), syntheticCell(w + 1, 2)];
    const shared = w > 0 ? [syntheticCell(w, 2)] : [];
    const touched = [...own, ...shared].sort();
    const cellCounts: ShardCellCounts = {};
    for (const [c, cell] of touched.entries()) {
      const pick = syntheticItem(cell, 'VT', 0.3, '2025-07-14');
      const fallback = syntheticItem(cell, 'NY', 0.6, '2023-08-02');
      frames[pick] = { acquired: '2025-07-14', gsd: 0.3, year: 2025, state: 'VT' };
      frames[fallback] = { acquired: '2023-08-02', gsd: 0.6, year: 2023, state: 'NY' };
      const partial = (w + c) % 3 === 0;
      const existing = cells.get(cell);
      cells.set(cell, {
        key: cell,
        states: partial ? ['NY', 'VT'] : ['VT'],
        pick,
        step: 'leafOn',
        stack: [fallback],
        partial,
        cloudScore: 0.01,
        workTiles: [...new Set([...(existing?.workTiles ?? []), key])].sort(),
      });
      cellCounts[cell] = partial
        ? { [pick]: 9000 + w, [fallback]: 300 + c }
        : { [pick]: 12_000 + c };
    }
    counts.set(key, cellCounts);
    workTiles.push({
      key,
      inputHash: createHash('sha256').update(`${campaign}:${key}`).digest('hex'),
      cells: touched,
      retile: true,
    });

    if (options.omit?.has(key)) continue;
    const shard = shardKeys(campaign, tile, pilot);
    const packPath = join(root, shard.pack);
    await mkdir(dirname(packPath), { recursive: true });
    const pack = createWriteStream(packPath);
    const index: ShardIndex = { version: 1, workTile: key, entries: [] };
    const hashPack = createHash('sha256');
    let offset = 0;
    for (let z = NAIP_WORK_ZOOM; z <= 17; z++) {
      for (const tileId of syntheticIds(tile, z, density(z))) {
        const bytes = syntheticTile(tileId, options.tiles);
        if (!pack.write(bytes)) await new Promise((r) => pack.once('drain', r));
        hashPack.update(bytes);
        index.entries.push({
          tileId,
          offset,
          length: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        offset += bytes.length;
      }
    }
    await new Promise<void>((done, fail) => {
      pack.once('error', fail);
      pack.end(() => done());
    });
    await writeFile(join(root, shard.index), JSON.stringify(index));
    const done: ShardDone = {
      version: 1,
      campaign,
      workTile: key,
      inputHash: workTiles[workTiles.length - 1]?.inputHash as string,
      image: SYNTHETIC_IMAGE,
      tiles: index.entries.length,
      bytes: offset,
      packSha256: hashPack.digest('hex'),
      timings: { warp: 1, tile: 2 },
      cellCounts,
      finishedAt: '2026-11-25T12:00:00.000Z',
    };
    await writeFile(join(root, shard.done), JSON.stringify(done));
    tilesPer.set(key, index.entries.length);
    total += offset;
  }

  const manifest: NaipManifest = {
    version: NAIP_MANIFEST_VERSION,
    campaign,
    pilot: pilot ?? null,
    createdAt: '2026-11-25T12:00:00.000Z',
    ruleVersion: NAIP_RULE_VERSION,
    catalog: { walkedOn: '2026-11-25', items: 2 * cells.size, perState: {}, archivedAt: null },
    exclusionsHash: 'e'.repeat(64),
    foliageStrikesHash: 'f'.repeat(64),
    offSeasonCells: [],
    basedOn: null,
    frames,
    cells: [...cells.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    workTiles,
  };
  return { manifest, counts, tiles: tilesPer, bytes: total };
}

/** A renderer for synthetic tiles: a parent is a hash of its children, so it is deterministic. */
export const hashRenderer = {
  async render(children: readonly { dx: number; dy: number; bytes: Uint8Array }[]) {
    const h = createHash('sha256');
    for (const c of children) h.update(`${c.dx}${c.dy}`).update(c.bytes);
    return new Uint8Array(h.digest());
  },
};
