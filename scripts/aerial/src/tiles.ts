/**
 * **The tiles stage's logic** (B05 §2.2): what each work tile's Machine is asked to cut, what its
 * input hash is, and whether it has landed.
 *
 * The stage CLI (`cli/tiles.ts`) is a shell over this file; the worker (`cut-aerial.sh`) reads the
 * unit this file writes; `spawn.sh` starts the Machines. Everything that decides something lives
 * here, so it is tested here.
 *
 * - **The work unit** (`AerialWorkUnit`) is one work tile's whole job, computed on the laptop and
 *   handed to the Machine as a file: its cells, each cell's frames in the rule's order and the exact
 *   pixel extents the warps write, the tiler's chunks, the tile zooms and the shard's keys.
 *   The worker decides nothing the unit could have decided.
 * - **The input hash** is the manifest's (the select stage's, core's `naipWorkTileInputHash`): the
 *   rule's version, `NAIP_TILING_VERSION` and each cell's pick, stack and `partial`. This file only
 *   compares it. Everything in `TILE_SETTINGS` — and the GDAL arguments in `cut-aerial.sh` — draws
 *   pixels the hash can't see, so **changing any of it means bumping `NAIP_TILING_VERSION`** (or a
 *   rebuild copies stale tiles as unchanged); `tiles.test.ts` fingerprints both and fails until the
 *   bump and the new fingerprint land together.
 * - **Landed** is a done record whose input hash is the manifest's (`shard.ts`' `shardLanded`) —
 *   never presence. `runTileRounds` spawns what is outstanding, drains, asks again, three rounds.
 */

import { join } from 'node:path';
import {
  type BBox,
  NAIP_MAX_ZOOM,
  NAIP_TILE_SIZE,
  NAIP_WORK_ZOOM,
  type NaipManifest,
  type NaipManifestCell,
  type NaipState,
  naipTileZoom,
  parseWorkTileKey,
  quarterQuadCell,
  type WorkTile,
  workTileKey,
} from '@skating/core';
import {
  AERIAL_SCRATCH,
  buildManifestKey,
  inventoryKey,
  type ShardKeys,
  scratchPaths,
  shardKeys,
} from './keys';
import { type ShardDone, shardLanded } from './shard';

// ── The cut's settings ──────────────────────────────────────────────────────────────────────────

/**
 * The pixel zoom the per-cell counts are taken on (§2.2 step 4): the 256-px Web Mercator z16 grid,
 * about 2.4 m a pixel at 44°N (tile zoom 15 at 512 px). Verify's coverage divides by it.
 */
export const COUNT_PIXEL_ZOOM = 16;

/**
 * How a work tile is cut — every setting that changes its pixels, so every one is in the input hash.
 * `tileZooms` are archive tile numbers (512 px, `naipTileZoom`): the work tile's own level down to
 * the deepest.
 */
export const TILE_SETTINGS = {
  tileSize: NAIP_TILE_SIZE,
  maxTileZoom: naipTileZoom(NAIP_MAX_ZOOM),
  countTileZoom: naipTileZoom(COUNT_PIXEL_ZOOM),
  /**
   * The tiler runs one chunk at a time, each a tile at this zoom (16 to a work tile), so every run
   * starts with a SAS token that will outlive it: Planetary Computer's anonymous tokens live 15
   * minutes and the endpoint hands out the current one, however little of it is left (measured
   * 2026-11-25). The zooms above it are then built from the chunks' tiles (`overview`).
   */
  chunkTileZoom: 13,
  format: 'WEBP',
  quality: 80,
  /** The warp's kernel, from the source to the deepest zoom's grid (§2.2 step 1). */
  resampling: 'cubic',
  /**
   * Every shallower zoom is a box average of the one below. Not cubic: a kernel wider than its 2×2
   * block reads past the window's edge, where the mosaic is empty, and left a translucent rim on
   * every edge tile (alpha 211–238) and a one-pixel spill into the neighbors — a seam at every work
   * tile's edge at every zoom but the deepest (measured 2026-11-25). A 2×2 average reads only its
   * own block, so a work tile's overviews are the ones a single region-wide pyramid would have.
   */
  overviewResampling: 'average',
  /** NAIP's COGs declare no nodata; an unflown pixel is RGB 0,0,0 (measured, B05 §9). */
  srcNodata: '0 0 0',
  bands: [1, 2, 3],
} as const;

// ── Web Mercator ────────────────────────────────────────────────────────────────────────────────

const EARTH_RADIUS = 6378137;
/** The left (and bottom) edge of the Web Mercator square, meters. */
export const MERCATOR_ORIGIN = -Math.PI * EARTH_RADIUS;
/** The Web Mercator square's edge, meters. */
export const MERCATOR_WORLD = 2 * Math.PI * EARTH_RADIUS;

/** EPSG:3857 bounds, `[minX, minY, maxX, maxY]`. */
export type MercatorBounds = [number, number, number, number];

/** Degrees to EPSG:3857 meters. */
export function toMercator(lng: number, lat: number): [number, number] {
  const x = (lng * Math.PI * EARTH_RADIUS) / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

/** A slippy tile's EPSG:3857 bounds (`y` counted from the top, the xyz convention). */
export function tileBounds(z: number, x: number, y: number): MercatorBounds {
  const span = MERCATOR_WORLD / 2 ** z;
  const minX = MERCATOR_ORIGIN + x * span;
  const maxY = -MERCATOR_ORIGIN - y * span;
  return [minX, maxY - span, minX + span, maxY];
}

/** The pixel edge, meters, at an archive tile zoom (512-px tiles). */
export function tileResolution(tileZoom: number): number {
  return MERCATOR_WORLD / (NAIP_TILE_SIZE * 2 ** tileZoom);
}

/**
 * The pixels of `bounds` on the grid at `res` (whose lines run through the Mercator origin, so they
 * are every tile's edges too), clipped to `within`, which must itself be on the grid: **exactly the
 * pixels whose centers lie in `bounds`**, west and south edges in, east and north edges out. Two
 * cells that share an edge therefore split its pixels between them with none left over and none
 * claimed twice — which is what cuts each frame to its own cell (§2.2 step 1), with no cutline:
 * a quarter-quad is a parallel-and-meridian rectangle, which is a rectangle in Web Mercator, and a
 * cutline is applied on each source's own pixel grid, so two frames on different grids disagreed
 * about the edge pixel (a one-pixel gap or overlap; measured 2026-11-25). `null` when no pixel of
 * `bounds` is inside `within`.
 */
export function pixelExtent(
  bounds: MercatorBounds,
  res: number,
  within: MercatorBounds,
): MercatorBounds | null {
  // The first pixel whose center is at or past `v`: i with origin + (i + ½)·res >= v.
  const first = (v: number) => Math.ceil((v - MERCATOR_ORIGIN) / res - 0.5);
  const at = (i: number) => MERCATOR_ORIGIN + i * res;
  const minX = Math.max(at(first(bounds[0])), within[0]);
  const minY = Math.max(at(first(bounds[1])), within[1]);
  const maxX = Math.min(at(first(bounds[2])), within[2]);
  const maxY = Math.min(at(first(bounds[3])), within[3]);
  return minX < maxX && minY < maxY ? [minX, minY, maxX, maxY] : null;
}

// ── The work unit ───────────────────────────────────────────────────────────────────────────────

export const WORK_UNIT_VERSION = 1;

/** One quarter-quad's part of a work unit. */
export interface AerialUnitCell {
  key: string;
  /** The cell's outline in degrees, `[west, south, east, north]`, as the grid states it. */
  outline: [number, number, number, number];
  /**
   * The frames this cell may draw, in the rule's order — the pick first, then the fallbacks that
   * may show through it. The worker counts each frame's pixels in this order (§2.2 step 4) and
   * mosaics the ones that supply any, reversed (the pick last, on top).
   */
  frames: string[];
  /**
   * The cell's pixels on the deepest zoom's grid, clipped to the window (`pixelExtent`): what each
   * of its warps writes, and so what cuts each frame to its cell.
   */
  extent: MercatorBounds;
  /** The same on the counts' grid (`COUNT_PIXEL_ZOOM`). */
  countExtent: MercatorBounds;
}

/**
 * One work tile's job, handed to its Machine as a file. `window` is the tile actually cut: the work
 * tile itself in a build; a smaller tile inside it for a local proof (`proofs/`), which is why the
 * two are separate fields.
 */
export interface AerialWorkUnit {
  version: typeof WORK_UNIT_VERSION;
  campaign: string;
  pilot: string | null;
  /** `workTileKey`, `11/<x>/<y>`. */
  workTile: string;
  /** `z/x/y` of the tile cut, at `NAIP_WORK_ZOOM` or deeper. */
  window: string;
  /** The manifest's input hash for the work tile; the done record carries it back. */
  inputHash: string;
  /** EPSG:3857 bounds of `window`. */
  bounds: MercatorBounds;
  /** Archive tile zooms written: `window`'s own level down to the deepest. */
  tileZooms: { min: number; max: number };
  /** The pixel edge, meters, at the deepest zoom and on the counts' grid. */
  resolution: number;
  countResolution: number;
  settings: typeof TILE_SETTINGS;
  /** Sorted by key. */
  cells: AerialUnitCell[];
  /** The tiler's runs, each started with a fresh-enough SAS token (`TILE_SETTINGS.chunkTileZoom`). */
  chunks: AerialChunk[];
  /**
   * The zooms above the chunks, built from the chunks' top tiles with no source read; `null` when
   * the window is a chunk (a proof's) or smaller.
   */
  overview: AerialOverview | null;
  /** Where the shard goes (`keys.ts`). */
  keys: ShardKeys;
}

/** One run of the tiler: a tile at the chunk zoom, by the deepest-zoom tiles it covers. */
export interface AerialChunk {
  /** `z/x/y`. */
  tile: string;
  zooms: { min: number; max: number };
  /** Inclusive, in deepest-zoom tile numbers: `gdal raster tile --min-x … --max-y`. */
  range: { minX: number; maxX: number; minY: number; maxY: number };
}

/** The zooms above the chunks: built from the chunks' top tiles, each placed by its bounds. */
export interface AerialOverview {
  zooms: { min: number; max: number };
  from: { tile: string; bounds: MercatorBounds }[];
}

/** The chunks and the overview pass for a window (`TILE_SETTINGS.chunkTileZoom`). */
export function chunksOf(window: WorkTile): {
  chunks: AerialChunk[];
  overview: AerialOverview | null;
} {
  const max = TILE_SETTINGS.maxTileZoom;
  const cz = Math.max(window.z, TILE_SETTINGS.chunkTileZoom);
  const side = 2 ** (cz - window.z);
  const chunks: AerialChunk[] = [];
  for (let dy = 0; dy < side; dy++) {
    for (let dx = 0; dx < side; dx++) {
      const x = window.x * side + dx;
      const y = window.y * side + dy;
      const span = 2 ** (max - cz);
      chunks.push({
        tile: `${cz}/${x}/${y}`,
        zooms: { min: cz, max },
        range: {
          minX: x * span,
          maxX: x * span + span - 1,
          minY: y * span,
          maxY: y * span + span - 1,
        },
      });
    }
  }
  const overview =
    cz === window.z
      ? null
      : {
          zooms: { min: window.z, max: cz - 1 },
          from: chunks.map((c) => {
            const [, x, y] = c.tile.split('/').map(Number) as [number, number, number];
            return { tile: c.tile, bounds: tileBounds(cz, x, y) };
          }),
        };
  return { chunks, overview };
}

/** What a cell's outline is: core's grid, injectable so a test or a proof can supply its own. */
export type CellOutline = (key: string) => BBox;

/**
 * The frames a cell's stack contributes to the cut, in the rule's order: the pick alone, unless the
 * pick doesn't cover the cell (`partial`) or the cell sits on a state line, where a flight may end
 * and the other state's frame must show through (§2.2, "fallbacks are read only where needed").
 */
export function framesToCut(cell: Pick<NaipManifestCell, 'pick' | 'stack' | 'partial' | 'states'>) {
  return cell.partial || cell.states.length > 1 ? [cell.pick, ...cell.stack] : [cell.pick];
}

function outlineOf(key: string, cellOutline: CellOutline): [number, number, number, number] {
  const b = cellOutline(key);
  return [b.minLng, b.minLat, b.maxLng, b.maxLat];
}

function parseWindow(window: string): WorkTile {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(window);
  if (!m) throw new Error(`not a tile: ${window}`);
  const t = { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
  if (t.z < NAIP_WORK_ZOOM || t.z > naipTileZoom(NAIP_MAX_ZOOM)) {
    throw new Error(
      `a window is at z${NAIP_WORK_ZOOM}–z${naipTileZoom(NAIP_MAX_ZOOM)}, not z${t.z}`,
    );
  }
  const span = 2 ** t.z;
  if (t.x >= span || t.y >= span) throw new Error(`not a z${t.z} tile: ${window}`);
  return t;
}

/** Is `window` the work tile or inside it? */
function windowInside(window: WorkTile, work: WorkTile): boolean {
  const shift = window.z - work.z;
  return (
    Math.floor(window.x / 2 ** shift) === work.x && Math.floor(window.y / 2 ** shift) === work.y
  );
}

/** What one unit is built from: the manifest's names for its cells, read as frames to cut. */
export interface UnitSpec {
  campaign: string;
  pilot: string | null;
  workTile: string;
  inputHash: string;
  /** Each cell's key and its frames in the rule's order (`framesToCut`). */
  cells: { key: string; frames: string[] }[];
  /** Default: the work tile itself. */
  window?: string;
}

/**
 * One work unit. Cells whose outline misses the window are left out (a cell is listed under every
 * work tile its outline touches; a proof's window holds fewer).
 */
export function buildWorkUnit(
  spec: UnitSpec,
  cellOutline: CellOutline = quarterQuadCell,
): AerialWorkUnit {
  const work = parseWorkTileKey(spec.workTile);
  const windowKey = spec.window ?? spec.workTile;
  const window = parseWindow(windowKey);
  if (!windowInside(window, work)) {
    throw new Error(`window ${windowKey} is not inside work tile ${spec.workTile}`);
  }
  const bounds = tileBounds(window.z, window.x, window.y);
  const resolution = tileResolution(TILE_SETTINGS.maxTileZoom);
  const countResolution = tileResolution(TILE_SETTINGS.countTileZoom);
  const cells: AerialUnitCell[] = [];
  for (const cell of [...spec.cells].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (cell.frames.length === 0) throw new Error(`cell ${cell.key} has no frame to cut`);
    const outline = outlineOf(cell.key, cellOutline);
    const [minX, minY] = toMercator(outline[0], outline[1]);
    const [maxX, maxY] = toMercator(outline[2], outline[3]);
    const m: MercatorBounds = [minX, minY, maxX, maxY];
    const extent = pixelExtent(m, resolution, bounds);
    const countExtent = pixelExtent(m, countResolution, bounds);
    if (extent === null || countExtent === null) continue;
    cells.push({ key: cell.key, outline, frames: [...cell.frames], extent, countExtent });
  }
  const unit: AerialWorkUnit = {
    version: WORK_UNIT_VERSION,
    campaign: spec.campaign,
    pilot: spec.pilot,
    workTile: spec.workTile,
    window: windowKey,
    inputHash: spec.inputHash,
    bounds,
    tileZooms: { min: window.z, max: TILE_SETTINGS.maxTileZoom },
    resolution,
    countResolution,
    settings: TILE_SETTINGS,
    cells,
    ...chunksOf(window),
    keys: shardKeys(spec.campaign, work, spec.pilot ?? undefined),
  };
  return unit;
}

/** The cells of a manifest by key. */
function cellsByKey(manifest: NaipManifest): Map<string, NaipManifestCell> {
  return new Map(manifest.cells.map((c) => [c.key, c]));
}

/**
 * Every work unit a build cuts: one per work tile with `retile` (a `--from-current` build copies
 * the rest), in the manifest's order. Throws on a work tile naming a cell the manifest doesn't hold.
 */
export function workUnitsFor(
  manifest: NaipManifest,
  cellOutline: CellOutline = quarterQuadCell,
): AerialWorkUnit[] {
  const byKey = cellsByKey(manifest);
  return manifest.workTiles
    .filter((w) => w.retile)
    .map((w) =>
      buildWorkUnit(
        {
          campaign: manifest.campaign,
          pilot: manifest.pilot,
          workTile: w.key,
          inputHash: w.inputHash,
          cells: w.cells.map((key) => {
            const cell = byKey.get(key);
            if (cell === undefined) throw new Error(`work tile ${w.key} names unknown cell ${key}`);
            return { key, frames: framesToCut(cell) };
          }),
        },
        cellOutline,
      ),
    );
}

/** A unit's file name in the stage's units directory: `11_<x>_<y>.json`. */
export function unitFileName(workTile: string): string {
  return `${workTileKey(parseWorkTileKey(workTile)).replaceAll('/', '_')}.json`;
}

// ── Reconcile and rounds ────────────────────────────────────────────────────────────────────────

/** What a work tile was cut for, and the done record the bucket holds for it (`null`: none). */
export interface ShardStatus {
  workTile: string;
  inputHash: string;
  done: ShardDone | null;
}

/**
 * Split work tiles into landed and outstanding by their done records alone (`shardLanded`): a
 * missing record, a stale input hash or another campaign's record is outstanding, whatever else
 * sits beside it. Both lists keep the input's order.
 */
export function reconcileShards(
  campaign: string,
  statuses: readonly ShardStatus[],
): { landed: string[]; outstanding: string[] } {
  const landed: string[] = [];
  const outstanding: string[] = [];
  for (const s of statuses) {
    const ok = shardLanded(s.done, { campaign, workTile: s.workTile, inputHash: s.inputHash });
    (ok ? landed : outstanding).push(s.workTile);
  }
  return { landed, outstanding };
}

/** The heartbeat's step (§2.6): a progress row every this many work tiles landed. */
export const HEARTBEAT_EVERY = 25;

/** Has a heartbeat boundary been crossed between two landed counts? */
export function heartbeatDue(before: number, after: number, every = HEARTBEAT_EVERY): boolean {
  return Math.floor(after / every) > Math.floor(before / every);
}

/** The rounds' default: spawn, drain, ask again — three times, then report (backfill.sh's shape). */
export const MAX_ROUNDS = 3;

export interface RoundsIo {
  /** Every work tile's done record as the bucket holds it now. */
  readDone: (workTiles: readonly string[]) => Promise<Map<string, ShardDone | null>>;
  /** Spawn these work tiles and return once their Machines have drained. */
  spawn: (workTiles: readonly string[], round: number) => Promise<void>;
  /** After each reconcile: what has landed and what is still out. */
  onReconcile?: (round: number, landed: number, outstanding: number) => void;
}

export interface RoundsResult {
  landed: string[];
  /** Still outstanding after the last round: reported by work tile, never published. */
  failed: string[];
  /** Spawn rounds actually run. */
  rounds: number;
}

/**
 * Run a set of work units to completion: reconcile, spawn what is outstanding, drain, and again, up
 * to `maxRounds` spawns; then reconcile once more. A round that lands nothing still counts — a work
 * tile that fails three times is reported, never retried forever, and never assumed done.
 */
export async function runTileRounds(
  campaign: string,
  units: readonly Pick<AerialWorkUnit, 'workTile' | 'inputHash'>[],
  io: RoundsIo,
  maxRounds = MAX_ROUNDS,
): Promise<RoundsResult> {
  const hashes = new Map(units.map((u) => [u.workTile, u.inputHash]));
  const keys = [...hashes.keys()];
  const reconcile = async (round: number) => {
    const dones = await io.readDone(keys);
    const result = reconcileShards(
      campaign,
      keys.map((workTile) => ({
        workTile,
        inputHash: hashes.get(workTile) as string,
        done: dones.get(workTile) ?? null,
      })),
    );
    io.onReconcile?.(round, result.landed.length, result.outstanding.length);
    return result;
  };
  let state = await reconcile(0);
  let rounds = 0;
  while (state.outstanding.length > 0 && rounds < maxRounds) {
    rounds++;
    await io.spawn(state.outstanding, rounds);
    state = await reconcile(rounds);
  }
  return { landed: state.landed, failed: state.outstanding, rounds };
}

// ── The run row's scope (§2.6) ──────────────────────────────────────────────────────────────────

/**
 * `aerial_tiles`' scope: `archive`, the states its work tiles' cells list, and `complete` only for a
 * full build — a production campaign from nothing (`basedOn: null`) cutting every work tile.
 */
export function tilesScope(
  manifest: NaipManifest,
  cut: readonly Pick<AerialWorkUnit, 'cells'>[],
): { pass: 'archive'; states: NaipState[]; complete: boolean } {
  const byKey = cellsByKey(manifest);
  const states = new Set<NaipState>();
  for (const unit of cut) {
    for (const cell of unit.cells) for (const s of byKey.get(cell.key)?.states ?? []) states.add(s);
  }
  const complete =
    manifest.pilot === null &&
    manifest.basedOn === null &&
    manifest.workTiles.every((w) => w.retile) &&
    cut.length === manifest.workTiles.length;
  return { pass: 'archive', states: [...states].sort(), complete };
}

// ── Before the cut: the select stage's outputs into the build prefix ────────────────────────────

/** One local file and the bucket key it is copied to. */
export interface Upload {
  local: string;
  key: string;
}

/**
 * What the tiles stage uploads before it spawns anything: the select stage writes its manifest and
 * the catalog snapshot to the campaign's scratch and records where the snapshot belongs
 * (`catalog.archivedAt`) without uploading; the assembler and verify read the manifest from
 * `buildManifestKey`. The snapshot goes to `inventoryKey`, one file per state the walk read — only
 * when `archivedAt` says it should, and refused when `archivedAt` names another day's prefix.
 */
export function selectUploads(manifest: NaipManifest, scratch: string = AERIAL_SCRATCH): Upload[] {
  const pilot = manifest.pilot ?? undefined;
  const paths = scratchPaths(manifest.campaign, scratch);
  const uploads: Upload[] = [
    { local: paths.manifest, key: buildManifestKey(manifest.campaign, pilot) },
  ];
  const { archivedAt, walkedOn, perState } = manifest.catalog;
  if (archivedAt === null) return uploads;
  const states = (Object.keys(perState) as NaipState[]).sort();
  if (states.length === 0) throw new Error('the manifest archives a catalog that read no state');
  for (const state of states) {
    const key = inventoryKey(walkedOn, state);
    if (!key.startsWith(archivedAt)) {
      throw new Error(
        `the manifest says the snapshot is at ${archivedAt}, but ${walkedOn}'s is ${key}`,
      );
    }
    uploads.push({ local: join(paths.inventory, `${state.toLowerCase()}.jsonl.gz`), key });
  }
  return uploads;
}

// ── Where the run rows go ─────────────────────────────────────────────────────────────────────

/**
 * A pilot's run rows go to a throwaway local backend only (G-8 a, §3.1): refuse a pilot whose
 * target is anything else — dev, prod, or a deploy key whose target can't be known. The same rule
 * as the assembler's `checkRunTarget`; after integration the two should be one function.
 */
export function checkPilotTarget(pilot: string | null, target: { label: string }): void {
  if (pilot === null) return;
  if (!/^(local|anonymous):/.test(target.label)) {
    throw new Error(
      `a pilot writes its run rows to a local deployment only, not ${JSON.stringify(target.label)}`,
    );
  }
}
