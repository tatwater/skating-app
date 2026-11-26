/**
 * **The assembler** (B05 §2.3–§2.4, §2.7): every landed shard (and, for a partial rebuild, every
 * unchanged work tile out of the current archive) into one PMTiles archive, streamed to its dated
 * key, with its date index and the completed manifest beside it.
 *
 * The order of work, so nothing is written that a later step could refuse:
 *
 * 1. **Read every input's index.** A work tile the build cut must have **landed** — a done record
 *    for this campaign, this work tile and the manifest's input hash (`shardLanded`, never presence)
 *    — and its index must agree with the record. An unchanged work tile (`retile: false`) is read out
 *    of the current archive's directory, and its counts out of the current manifest, which must hold
 *    the same input hash. Any miss refuses the whole build: **an incomplete set is never published**.
 * 2. **Date every pixel** (`cellIndex.ts`) and check the index (`verifyDates.ts`): a count naming a
 *    frame outside its cell's stack, or a cell the index can't date, refuses here.
 * 3. **The overviews** from the work tiles' top tiles (`overviews.ts`).
 * 4. **The layout** (`layout.ts`) and the plan: directories, metadata, header.
 * 5. **Refuse to overwrite**: the three published keys are immutable (the CDN caches them), so an
 *    existing one stops the build.
 * 6. **Stream the archive** (`writer.ts`), hashing as it goes; then the index (gzip-encoded) and,
 *    last, the manifest naming both with their sizes and hashes — so a manifest never names an
 *    archive that didn't finish. The assembly record goes under the build prefix for verify.
 */

import {
  NAIP_MAX_ZOOM,
  NAIP_MIN_ZOOM,
  NAIP_WORK_ZOOM,
  type NaipManifest,
  type NaipManifestWorkTile,
  type NaipPublishedObject,
  naipTileZoom,
  parseWorkTileKey,
  type WorkTile,
} from '@skating/core';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import {
  archiveKey,
  archiveName,
  buildPrefix,
  indexKey,
  indexName,
  manifestKey,
  parseArchiveKey,
  parseCampaign,
  publishPrefix,
  shardKeys,
} from '../keys';
import {
  checkShardIndex,
  parseShardDone,
  SHARD_TILE_ZOOMS,
  type ShardCellCounts,
  shardLanded,
} from '../shard';
import { checkCellIndex } from '../verifyDates';
import { type ArchiveEntries, readArchiveEntries, storeSource, tilesInRange } from './archiveRead';
import { buildCellIndex, encodeCellIndex, totalCounts } from './cellIndex';
import { contentKey } from './contentTable';
import { type Layout, layoutArchive, type TileSegment } from './layout';
import { buildOverviews, type OverviewRenderer } from './overviews';
import { type ByteSink, hashingSink, type ObjectStore, sha256Hex } from './stores';
import { workTileIdRange, workTilesBox } from './tileGrid';
import { planArchive, type RunReader, type WriteOptions, writeArchive } from './writer';

/** The archive's tile zooms: 7–10 the overviews, 11–17 the shards (pixel zooms 8–18). */
export const ARCHIVE_ZOOMS = { min: naipTileZoom(NAIP_MIN_ZOOM), max: naipTileZoom(NAIP_MAX_ZOOM) };
/** The work tiles' own level, the overviews' source. */
const TOP_ZOOM = naipTileZoom(NAIP_WORK_ZOOM + 1);

/**
 * The manifest's work tile as the assembler publishes it: core's `NaipManifestWorkTile` with its
 * `cellCounts` written (the shard's own, or the copied work tile's from the build it came from), so a
 * later `--from-current` build that copies it can date it without its deleted shard.
 */
export type AssembledWorkTile = NaipManifestWorkTile & {
  cellCounts: NonNullable<NaipManifestWorkTile['cellCounts']>;
};

/**
 * The manifest as published: core's `NaipManifest` with its archive, its index and every work tile's
 * counts filled in. A manifest read back from the bucket is typed `NaipManifest` (an older or a
 * hand-made one may lack any of them) and checked where it is used.
 */
export type AssembledManifest = Omit<NaipManifest, 'workTiles' | 'archive' | 'cellIndex'> & {
  workTiles: AssembledWorkTile[];
  archive: NaipPublishedObject;
  cellIndex: NaipPublishedObject;
};

/** What the assembler leaves for verify and the run row, at `<build prefix>assembly.json`. */
export interface AssemblyRecord {
  version: 1;
  campaign: string;
  pilot: string | null;
  startedAt: string;
  finishedAt: string;
  archive: NaipPublishedObject & { key: string };
  cellIndex: NaipPublishedObject & { key: string; gzipBytes: number };
  manifest: { key: string; bytes: number; sha256: string };
  /** The current archive the unchanged work tiles were copied from, or `null`. */
  copiedFrom: string | null;
  header: {
    addressed: number;
    entries: number;
    contents: number;
    minZoom: number;
    maxZoom: number;
    rootBytes: number;
    leafBytes: number;
    leaves: number;
    dataBytes: number;
  };
  /** Tiles per tile zoom. */
  perZoom: Record<string, number>;
  workTiles: { total: number; cut: number; copied: number; empty: number };
  /** Tiles copied from the current archive. */
  copiedTiles: number;
  /** Every overview tile, so verify can check each against what was written. */
  overviews: { tileId: number; length: number; sha256: string }[];
  cells: { dated: number; flights: number };
  timings: Record<string, number>;
  memory: { peakRssBytes: number; peakHeapBytes: number };
}

export const ASSEMBLY_RECORD_VERSION = 1;

/** `<build prefix>assembly.json` and `<build prefix>assembly-progress.json`. */
export function assemblyKeys(
  campaign: string,
  pilot?: string,
): { record: string; progress: string } {
  const prefix = buildPrefix(campaign, pilot);
  return { record: `${prefix}assembly.json`, progress: `${prefix}assembly-progress.json` };
}

/** A step the assembler reports, for the run row's heartbeat. */
export type AssembleProgress =
  | { step: 'indexes'; done: number; total: number }
  | { step: 'overviews'; tiles: number }
  | { step: 'layout'; tiles: number; bytes: number }
  | { step: 'zoom'; zoom: number; dataBytes: number; totalBytes: number }
  | { step: 'published'; archiveBytes: number };

/** How a published object is uploaded. */
export interface PublishOptions {
  contentType: string;
  contentEncoding?: 'gzip';
  cacheControl: string;
}

export interface AssembleDeps {
  /** The private bucket: the build prefix and the current published objects. */
  store: ObjectStore;
  /** A sink that uploads to `key` (rclone rcat on a Machine; files in the tests). */
  upload(key: string, options: PublishOptions): ByteSink;
  renderer: OverviewRenderer;
  progress?(event: AssembleProgress): void | Promise<void>;
  now?(): Date;
  /** Peak memory so far (`process.resourceUsage().maxRSS` on a Machine). */
  memory?(): { rss: number; heap: number };
  write?: WriteOptions;
  /** Concurrent reads of the indexes and the top tiles (default 16). */
  concurrency?: number;
}

/** Public, immutable, and cached for a year: the keys are never overwritten. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A refusal: the build is incomplete or inconsistent, and nothing was published. */
export class AssembleRefusal extends Error {
  override name = 'AssembleRefusal';
}

const refuse = (message: string): never => {
  throw new AssembleRefusal(message);
};

const zoomOf = (tileId: number): number => tileIdToZxy(tileId)[0];

/** Map with bounded concurrency, results in input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** One work tile's tiles, columnar, ascending, from one source; plus its counts. */
interface WorkTileInput {
  key: string;
  tile: WorkTile;
  source: string;
  tileId: Float64Array;
  srcOffset: Float64Array;
  length: Uint32Array;
  key4: Uint32Array;
  counts: ShardCellCounts;
  copied: boolean;
}

async function readCut(
  deps: AssembleDeps,
  campaign: string,
  pilot: string | undefined,
  wt: NaipManifestWorkTile,
): Promise<WorkTileInput> {
  const tile = parseWorkTileKey(wt.key);
  const keys = shardKeys(campaign, tile, pilot);
  const doneBytes = await deps.store.get(keys.done);
  const done =
    doneBytes === null ? null : parseShardDone(JSON.parse(new TextDecoder().decode(doneBytes)));
  if (!shardLanded(done, { campaign, workTile: wt.key, inputHash: wt.inputHash })) {
    refuse(
      done === null
        ? `work tile ${wt.key} has not landed: no done record`
        : `work tile ${wt.key} has not landed: its done record is for ${done.campaign} ${done.workTile} at input ${done.inputHash}, the manifest wants ${wt.inputHash}`,
    );
  }
  const record = done as NonNullable<typeof done>;
  const indexBytes = await deps.store.get(keys.index);
  if (indexBytes === null) refuse(`work tile ${wt.key}: its done record has no index beside it`);
  const index = checkShardIndex(
    JSON.parse(new TextDecoder().decode(indexBytes as Uint8Array)),
    record.bytes,
  );
  if (index.workTile !== wt.key) refuse(`work tile ${wt.key}: its index is ${index.workTile}'s`);
  if (index.entries.length !== record.tiles) {
    refuse(
      `work tile ${wt.key}: the index holds ${index.entries.length} tiles, the record ${record.tiles}`,
    );
  }
  const n = index.entries.length;
  const input: WorkTileInput = {
    key: wt.key,
    tile,
    source: keys.pack,
    tileId: new Float64Array(n),
    srcOffset: new Float64Array(n),
    length: new Uint32Array(n),
    key4: new Uint32Array(n * 4),
    counts: record.cellCounts,
    copied: false,
  };
  index.entries.forEach((e, i) => {
    input.tileId[i] = e.tileId;
    input.srcOffset[i] = e.offset;
    input.length[i] = e.length;
    contentKey(e.sha256, input.key4, i * 4);
  });
  return input;
}

function readCopied(
  old: { key: string; archive: ArchiveEntries; manifest: NaipManifest },
  wt: NaipManifestWorkTile,
): WorkTileInput {
  const before = old.manifest.workTiles.find((w) => w.key === wt.key);
  if (before === undefined)
    refuse(`work tile ${wt.key} is unchanged, but ${old.key}'s manifest lacks it`);
  const prior = before as NaipManifestWorkTile;
  if (prior.inputHash !== wt.inputHash) {
    refuse(`work tile ${wt.key} is marked unchanged, but its input hash differs from ${old.key}'s`);
  }
  if (prior.cellCounts === undefined)
    refuse(`work tile ${wt.key}: ${old.key}'s manifest has no counts for it`);
  const tile = parseWorkTileKey(wt.key);
  const tiles: { tileId: number; offset: number; length: number }[] = [];
  for (let z = SHARD_TILE_ZOOMS.min; z <= SHARD_TILE_ZOOMS.max; z++) {
    const [first, count] = workTileIdRange(tile, z);
    for (const t of tilesInRange(old.archive, first, count)) tiles.push(t);
  }
  const n = tiles.length;
  const input: WorkTileInput = {
    key: wt.key,
    tile,
    source: old.key,
    tileId: new Float64Array(n),
    srcOffset: new Float64Array(n),
    length: new Uint32Array(n),
    key4: new Uint32Array(n * 4),
    counts: prior.cellCounts as ShardCellCounts,
    copied: true,
  };
  tiles.forEach((t, i) => {
    input.tileId[i] = t.tileId;
    input.srcOffset[i] = t.offset;
    input.length[i] = t.length;
    // The old archive carries no hash per tile; its blob's place stands in. Two entries sharing a
    // blob stay shared; a copied tile is never deduplicated against a new one (rare, and harmless).
    contentKey(sha256Hex(`copied:${t.offset}:${t.length}`), input.key4, i * 4);
  });
  return input;
}

/** The segment of `input` at tile zoom `z` (views, no copy), or `null` when it has none there. */
function segmentAt(input: WorkTileInput, z: number): TileSegment | null {
  const [first, count] = workTileIdRange(input.tile, z);
  let lo = 0;
  while (lo < input.tileId.length && (input.tileId[lo] as number) < first) lo++;
  let hi = lo;
  while (hi < input.tileId.length && (input.tileId[hi] as number) < first + count) hi++;
  if (hi === lo) return null;
  return {
    source: input.source,
    tileId: input.tileId.subarray(lo, hi),
    srcOffset: input.srcOffset.subarray(lo, hi),
    length: input.length.subarray(lo, hi),
    key: input.key4.subarray(lo * 4, hi * 4),
  };
}

const OVERVIEWS = 'memory:overviews';

/** Assemble and publish one build. Returns the record it also writes. */
export async function assemble(
  manifest: NaipManifest,
  deps: AssembleDeps,
): Promise<AssemblyRecord> {
  return (await run(manifest, deps, false)) as AssemblyRecord;
}

/** What a dry run learns: every input read and checked, the overviews, the layout, no upload. */
export interface AssemblyPlanSummary {
  planned: true;
  archiveBytes: number;
  addressed: number;
  entries: number;
  contents: number;
  leaves: number;
  rootBytes: number;
  perZoom: Record<string, number>;
  cellsDated: number;
  flights: number;
  indexBytes: number;
  indexGzipBytes: number;
  overviews: number;
  timings: Record<string, number>;
}

/** The dry run (`--dry-run`): everything up to the first byte written, and the plan's numbers. */
export async function planAssembly(
  manifest: NaipManifest,
  deps: Omit<AssembleDeps, 'upload'>,
): Promise<AssemblyPlanSummary> {
  const upload = (): never => {
    throw new Error('a dry run uploads nothing');
  };
  return (await run(manifest, { ...deps, upload }, true)) as AssemblyPlanSummary;
}

async function run(
  manifest: NaipManifest,
  deps: AssembleDeps,
  planOnly: boolean,
): Promise<AssemblyRecord | AssemblyPlanSummary> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const lap = (name: string): void => {
    timings[name] = Date.now() - mark;
    mark = Date.now();
  };
  const concurrency = deps.concurrency ?? 16;
  const { campaign } = manifest;
  const pilot = manifest.pilot ?? undefined;
  const read = parseCampaign(campaign);
  if (read.pilot !== (manifest.pilot !== null)) {
    refuse(`manifest ${campaign} and its pilot ${String(manifest.pilot)} disagree`);
  }
  if (manifest.workTiles.length === 0) refuse('the manifest has no work tiles');

  // ── 1. Inputs ───────────────────────────────────────────────────────────────────────────────
  const copiedTiles = manifest.workTiles.filter((w) => !w.retile);
  let old: { key: string; archive: ArchiveEntries; manifest: NaipManifest } | null = null;
  if (copiedTiles.length > 0) {
    if (manifest.basedOn === null)
      refuse('work tiles are marked unchanged, but the manifest is based on no build');
    const basedOn = manifest.basedOn as NonNullable<NaipManifest['basedOn']>;
    const prefix = publishPrefix(campaign, pilot);
    const key = `${prefix}${basedOn.archive}`;
    parseArchiveKey(key);
    const oldManifestBytes = await deps.store.get(`${prefix}${basedOn.manifest}`);
    if (oldManifestBytes === null)
      refuse(`the current manifest ${basedOn.manifest} is not in the bucket`);
    old = {
      key,
      archive: await readArchiveEntries(storeSource(deps.store, key)),
      manifest: JSON.parse(
        new TextDecoder().decode(oldManifestBytes as Uint8Array),
      ) as NaipManifest,
    };
    if (old.manifest.archive?.name !== basedOn.archive) {
      refuse(
        `the current manifest names ${String(old.manifest.archive?.name)}, not ${basedOn.archive}`,
      );
    }
  }
  let doneCount = 0;
  const inputs = await mapLimit(manifest.workTiles, concurrency, async (wt) => {
    const input = wt.retile
      ? await readCut(deps, campaign, pilot, wt)
      : readCopied(old as NonNullable<typeof old>, wt);
    const cells = new Set(wt.cells);
    for (const cell of Object.keys(input.counts)) {
      if (!cells.has(cell))
        refuse(`work tile ${wt.key} counts cell ${cell}, which it doesn't touch`);
    }
    doneCount++;
    if (doneCount % 25 === 0 || doneCount === manifest.workTiles.length) {
      await deps.progress?.({ step: 'indexes', done: doneCount, total: manifest.workTiles.length });
    }
    return input;
  });
  lap('indexes');

  // ── 2. The dates, checked before anything is drawn ───────────────────────────────────────────
  const name = archiveName(campaign);
  const totals = totalCounts(inputs.map((i) => i.counts));
  const index = buildCellIndex(manifest, totals, name);
  const problems = checkCellIndex({ json: index, archiveName: name, manifest, totals });
  if (problems.length > 0) {
    refuse(
      `the date index fails its own check (${problems.length}): ${problems.slice(0, 5).join('; ')}`,
    );
  }
  const encodedIndex = encodeCellIndex(index);
  lap('index');

  // ── 3. Overviews from the top tiles ──────────────────────────────────────────────────────────
  const ordered = [...inputs].sort(
    (a, b) =>
      zxyToTileId(NAIP_WORK_ZOOM, a.tile.x, a.tile.y) -
      zxyToTileId(NAIP_WORK_ZOOM, b.tile.x, b.tile.y),
  );
  const tops = ordered
    .map((input) => ({ input, seg: segmentAt(input, TOP_ZOOM) }))
    .filter((t): t is { input: WorkTileInput; seg: TileSegment } => t.seg !== null);
  const reader = storeReader(deps.store);
  const top = new Map<number, Uint8Array>();
  await mapLimit(tops, concurrency, async ({ seg }) => {
    top.set(
      seg.tileId[0] as number,
      await reader.read(seg.source, seg.srcOffset[0] as number, seg.length[0] as number),
    );
  });
  const levels = await buildOverviews(top, deps.renderer, {
    fromZoom: TOP_ZOOM,
    minZoom: ARCHIVE_ZOOMS.min,
  });
  top.clear();
  const overviewTiles = levels.flatMap((l) => l.tiles);
  const overviewBuffer = Buffer.concat(overviewTiles.map((t) => t.bytes));
  reader.memory.set(OVERVIEWS, new Uint8Array(overviewBuffer));
  await deps.progress?.({ step: 'overviews', tiles: overviewTiles.length });
  lap('overviews');

  // ── 4. Layout ───────────────────────────────────────────────────────────────────────────────
  const segments: TileSegment[] = [];
  let at = 0;
  for (const level of levels) {
    const n = level.tiles.length;
    const seg: TileSegment = {
      source: OVERVIEWS,
      tileId: new Float64Array(n),
      srcOffset: new Float64Array(n),
      length: new Uint32Array(n),
      key: new Uint32Array(n * 4),
    };
    level.tiles.forEach((t, i) => {
      seg.tileId[i] = t.tileId;
      seg.srcOffset[i] = at;
      seg.length[i] = t.bytes.length;
      contentKey(sha256Hex(t.bytes), seg.key, i * 4);
      at += t.bytes.length;
    });
    segments.push(seg);
  }
  for (let z = SHARD_TILE_ZOOMS.min; z <= SHARD_TILE_ZOOMS.max; z++) {
    for (const input of ordered) {
      const seg = segmentAt(input, z);
      if (seg !== null) segments.push(seg);
    }
  }
  const layout: Layout = layoutArchive(segments, zoomOf, { releaseKeys: true });
  for (const input of inputs) input.key4 = new Uint32Array(0);
  const bounds = workTilesBox(inputs.filter((i) => i.tileId.length > 0).map((i) => i.tile));
  if (bounds === null || layout.addressed === 0)
    refuse('no work tile has any tile: nothing to assemble');
  const zooms = [...layout.perZoom.keys()].sort((a, b) => a - b);
  const plan = planArchive({
    layout,
    minZoom: ARCHIVE_ZOOMS.min,
    maxZoom: ARCHIVE_ZOOMS.max,
    bounds: bounds as NonNullable<typeof bounds>,
    centerZoom: ARCHIVE_ZOOMS.min + 2,
    metadata: archiveMetadata(manifest),
  });
  for (let z = ARCHIVE_ZOOMS.min; z <= ARCHIVE_ZOOMS.max; z++) {
    if (!zooms.includes(z)) refuse(`the archive would have no tile at zoom ${z}`);
  }
  await deps.progress?.({ step: 'layout', tiles: layout.addressed, bytes: plan.bytes });
  lap('layout');

  // ── 5. Never overwrite a published key ──────────────────────────────────────────────────────
  const keys = {
    archive: archiveKey(campaign, pilot),
    index: indexKey(campaign, pilot),
    manifest: manifestKey(campaign, pilot),
  };
  for (const key of Object.values(keys)) {
    if (await deps.store.exists(key))
      refuse(`${key} already exists: a published key is never overwritten`);
  }
  if (planOnly) {
    return {
      planned: true,
      archiveBytes: plan.bytes,
      addressed: layout.addressed,
      entries: layout.entries.count,
      contents: layout.contents,
      leaves: plan.directories.leafCount,
      rootBytes: plan.directories.root.length,
      perZoom: Object.fromEntries([...layout.perZoom].map(([z, n]) => [String(z), n])),
      cellsDated: Object.keys(index.cells).length,
      flights: index.flights.length,
      indexBytes: encodedIndex.json.length,
      indexGzipBytes: encodedIndex.gzip.length,
      overviews: overviewTiles.length,
      timings,
    };
  }

  // ── 6. Stream the archive, then the index, then the manifest ────────────────────────────────
  const sink = hashingSink(
    deps.upload(keys.archive, { contentType: 'application/vnd.pmtiles', cacheControl: IMMUTABLE }),
  );
  let zoom = -1;
  await writeArchive(plan, layout, reader, sink, {
    ...deps.write,
    onRun: async (data, run) => {
      const reached = zoomOf(run.tileId);
      if (reached !== zoom) {
        zoom = reached;
        await deps.progress?.({ step: 'zoom', zoom, dataBytes: data, totalBytes: plan.bytes });
      }
      await deps.write?.onRun?.(data, run);
    },
  });
  lap('write');
  const archive: NaipPublishedObject = { name, bytes: sink.bytes, sha256: sink.sha256() };

  const indexSink = deps.upload(keys.index, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
    cacheControl: IMMUTABLE,
  });
  await indexSink.write(encodedIndex.gzip);
  await indexSink.end();
  const cellIndex: NaipPublishedObject = {
    name: indexName(campaign),
    bytes: encodedIndex.json.length,
    sha256: encodedIndex.sha256,
  };

  const counts = new Map(inputs.map((i) => [i.key, i.counts]));
  const assembled: AssembledManifest = {
    ...manifest,
    workTiles: manifest.workTiles.map((w) => ({
      ...w,
      cellCounts: counts.get(w.key) as ShardCellCounts,
    })),
    archive,
    cellIndex,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(assembled));
  const manifestSink = deps.upload(keys.manifest, {
    contentType: 'application/json',
    cacheControl: IMMUTABLE,
  });
  await manifestSink.write(manifestBytes);
  await manifestSink.end();
  await deps.progress?.({ step: 'published', archiveBytes: archive.bytes });
  lap('publish');

  const memory = deps.memory?.() ?? { rss: 0, heap: 0 };
  const record: AssemblyRecord = {
    version: ASSEMBLY_RECORD_VERSION,
    campaign,
    pilot: manifest.pilot,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    archive: { ...archive, key: keys.archive },
    cellIndex: { ...cellIndex, key: keys.index, gzipBytes: encodedIndex.gzip.length },
    manifest: { key: keys.manifest, bytes: manifestBytes.length, sha256: sha256Hex(manifestBytes) },
    copiedFrom: old?.key ?? null,
    header: {
      addressed: plan.header.numAddressedTiles,
      entries: plan.header.numTileEntries,
      contents: plan.header.numTileContents,
      minZoom: plan.header.minZoom,
      maxZoom: plan.header.maxZoom,
      rootBytes: plan.directories.root.length,
      leafBytes: plan.directories.leaves.length,
      leaves: plan.directories.leafCount,
      dataBytes: layout.dataLength,
    },
    perZoom: Object.fromEntries([...layout.perZoom].map(([z, n]) => [String(z), n])),
    workTiles: {
      total: inputs.length,
      cut: inputs.filter((i) => !i.copied).length,
      copied: inputs.filter((i) => i.copied).length,
      empty: inputs.filter((i) => i.tileId.length === 0).length,
    },
    copiedTiles: inputs.filter((i) => i.copied).reduce((n, i) => n + i.tileId.length, 0),
    overviews: overviewTiles.map((t) => ({
      tileId: t.tileId,
      length: t.bytes.length,
      sha256: sha256Hex(t.bytes),
    })),
    cells: { dated: Object.keys(index.cells).length, flights: index.flights.length },
    timings,
    memory: { peakRssBytes: memory.rss, peakHeapBytes: memory.heap },
  };
  const recordSink = deps.upload(assemblyKeys(campaign, pilot).record, {
    contentType: 'application/json',
    cacheControl: 'no-store',
  });
  await recordSink.write(new TextEncoder().encode(JSON.stringify(record)));
  await recordSink.end();
  return record;
}

/** The archive's JSON metadata: no `attribution` — the console draws its own dated credit (D318). */
export function archiveMetadata(manifest: NaipManifest): Record<string, unknown> {
  return {
    name: archiveName(manifest.campaign).replace(/\.pmtiles$/, ''),
    description:
      'USDA NAIP summer aerial photographs, one frame per quarter-quad by the summer aerial rule; ' +
      'each cell is dated in the index beside this archive.',
    type: 'overlay',
    format: 'webp',
    tileSize: 512,
    campaign: manifest.campaign,
    ruleVersion: manifest.ruleVersion,
  };
}

/** A reader over a store, plus named in-memory sources (the overviews). */
export function storeReader(store: ObjectStore): RunReader & { memory: Map<string, Uint8Array> } {
  const memory = new Map<string, Uint8Array>();
  return {
    memory,
    async read(source, offset, length) {
      const m = memory.get(source);
      if (m !== undefined) return m.subarray(offset, offset + length);
      return store.range(source, offset, length);
    },
    async *stream(source, offset, length) {
      const m = memory.get(source);
      if (m !== undefined) {
        yield m.subarray(offset, offset + length);
        return;
      }
      yield* store.rangeStream(source, offset, length);
    },
  };
}
