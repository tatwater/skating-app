/**
 * **The assembler** (B05 §2.3–§2.4, §2.7): every landed shard (and, for a partial rebuild, every
 * unchanged work tile out of the current archive) into one PMTiles archive, streamed to its dated
 * key, with its date index and the completed manifest beside it.
 *
 * The order of work, so nothing is written that a later step could refuse:
 *
 * 0. **A published campaign is never assembled again** (`publishedBuild.ts`): its manifest names
 *    what its archive was built from (core's `naipBuildInputsHash`), so the same inputs are refused
 *    as already done and other inputs as a new campaign's, before anything is read.
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
 *    existing one stops the build — asked at step 0 as well, so it is decided before any read, and
 *    here again, nearest the first byte. Until here **nothing is written**, not even progress
 *    (`AssembleDeps.progress`): a refused assembly leaves only its error object.
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
  naipBuildInputsHash,
  naipTileZoom,
  parseWorkTileKey,
  type WorkTile,
} from '@skating/core';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import {
  archiveKey,
  archiveName,
  buildManifestKey,
  buildPrefix,
  indexKey,
  indexName,
  manifestKey,
  parseArchiveKey,
  parseCampaign,
  publishPrefix,
  shardKeys,
} from '../keys';
import { publishedConflict } from '../publishedBuild';
import { type RefusalId, StageRefusal } from '../refusals';
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
  version: typeof ASSEMBLY_RECORD_VERSION;
  campaign: string;
  pilot: string | null;
  startedAt: string;
  finishedAt: string;
  /**
   * What the archive was built from: core's `naipBuildInputsHash` of the manifest assembled — the
   * one identity a re-run (`orchestrate.ts`' `finishedAssembly`) and verify compare (§2.4).
   */
  inputs: string;
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

/** 2 (PR #188's review, 2026-11-27): `inputs`. The pilot's record is version 1 and has none. */
export const ASSEMBLY_RECORD_VERSION = 2;

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
  /**
   * Progress for the run row — a write on a Machine — called only once every refusal is behind the
   * assembler (the latest event before then is held, and handed over at that point).
   */
  progress?(event: AssembleProgress): void | Promise<void>;
  /** Every event as it happens, held or not: what the Machine's watchdog is fed. */
  alive?(): void;
  /** The Machine's clock: the record's times, and when a zoom's next heartbeat is due. */
  now?(): Date;
  /** The longest a zoom being written goes without a progress event (default {@link HEARTBEAT_MS}). */
  heartbeatMs?: number;
  /** Peak memory so far (`process.resourceUsage().maxRSS` on a Machine). */
  memory?(): { rss: number; heap: number };
  write?: WriteOptions;
  /** Concurrent reads of the indexes and the top tiles (default 16). */
  concurrency?: number;
}

/**
 * **A heartbeat inside a zoom**, five minutes at most between progress events while the archive is
 * written. Zoom by zoom alone was a beat per level, and the deepest level is most of the archive: at
 * the pilot's per-zoom tile sizes tile zoom 17 is ~59% of the bytes, ~154 GB of a ~260 GB region,
 * ~54 minutes at the pilot's 47.5 MB/s (46–62 over 220–300 GB, longer on a slower link) — against the
 * laptop's hour of quiet before it called the assembly dead (PR #188's review). The beat rides the
 * runs, which are one work tile's zoom each (at most a few hundred MB, seconds at that rate), so a
 * stalled read or upload stops it — which is how the laptop and the Machine's own watchdog
 * (`orchestrate.ts`) tell a stuck assembly from a long one.
 */
export const HEARTBEAT_MS = 5 * 60_000;

/** Public, immutable, and cached for a year: the keys are never overwritten. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A refusal: the build is incomplete or inconsistent, and nothing was published. */
export class AssembleRefusal extends StageRefusal {
  override name = 'AssembleRefusal';
}

const refuse = (id: RefusalId, message: string): never => {
  throw new AssembleRefusal(id, message);
};

/**
 * The refusals the laptop's preflight (`stage/assembleStage.ts`) also decides, before it spawns a
 * Machine, in the Machine's own words — so a refusal reads the same wherever it is caught.
 */
export const assembleMessages = {
  notLanded: (
    workTile: string,
    done: { campaign: string; workTile: string; inputHash: string } | null,
    inputHash: string,
  ): string =>
    done === null
      ? `work tile ${workTile} has not landed: no done record`
      : `work tile ${workTile} has not landed: its done record is for ${done.campaign} ${done.workTile} at input ${done.inputHash}, the manifest wants ${inputHash}`,
  alreadyAssembled: (campaign: string, publishedKey: string): string =>
    `${campaign} is already assembled from these inputs (${publishedKey}): nothing to assemble`,
  orphans: (left: readonly string[]): string =>
    `an earlier assembly stopped before its manifest: nothing names ${left.join(' or ')} — delete ${left.length === 1 ? 'it' : 'them'} by hand and assemble again`,
  keyExists: (key: string): string => `${key} already exists: a published key is never overwritten`,
  pilotMismatch: (campaign: string, pilot: string | null): string =>
    `manifest ${campaign} and its pilot ${String(pilot)} disagree`,
  noWorkTiles: 'the manifest has no work tiles',
  noBase: 'work tiles are marked unchanged, but the manifest is based on no build',
  baseMissing: (manifest: string): string =>
    `the current manifest ${manifest} is not in the bucket`,
  baseArchive: (named: string | undefined, archive: string): string =>
    `the current manifest names ${String(named)}, not ${archive}`,
};

/**
 * Refuses when an earlier assembly's archive or index stands without its manifest (an assembly that
 * stopped part way), or when any of the three published keys exists. `present` answers for each key.
 */
export function refuseExisting(
  keys: { archive: string; index: string; manifest: string },
  present: (key: string) => boolean,
): void {
  // The manifest is written last and is the only thing that names the other two, so an archive or
  // an index without it is an assembly that stopped part way (an upload failed, the Machine died):
  // never verified, never handed to the web. Still never overwritten here — the operator removes
  // what it left, having looked, and assembles again.
  if (!present(keys.manifest)) {
    const left = [keys.archive, keys.index].filter((k) => present(k));
    if (left.length > 0) refuse('assemble.orphans', assembleMessages.orphans(left));
  }
  for (const key of [keys.archive, keys.index, keys.manifest]) {
    if (present(key)) refuse('assemble.keyExists', assembleMessages.keyExists(key));
  }
}

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
  /** The SHA-256 of the done record this work tile was read under (a cut one's), or `null` (copied). */
  doneSha: string | null;
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
    refuse('assemble.notLanded', assembleMessages.notLanded(wt.key, done, wt.inputHash));
  }
  const record = done as NonNullable<typeof done>;
  const indexBytes = await deps.store.get(keys.index);
  if (indexBytes === null)
    refuse('assemble.noIndex', `work tile ${wt.key}: its done record has no index beside it`);
  const index = checkShardIndex(
    JSON.parse(new TextDecoder().decode(indexBytes as Uint8Array)),
    record.bytes,
  );
  if (index.workTile !== wt.key)
    refuse('assemble.indexOtherTile', `work tile ${wt.key}: its index is ${index.workTile}'s`);
  if (index.entries.length !== record.tiles) {
    refuse(
      'assemble.indexCount',
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
    doneSha: sha256Hex(doneBytes as Uint8Array),
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
    refuse(
      'assemble.copiedMissing',
      `work tile ${wt.key} is unchanged, but ${old.key}'s manifest lacks it`,
    );
  const prior = before as NaipManifestWorkTile;
  if (prior.inputHash !== wt.inputHash) {
    refuse(
      'assemble.copiedHash',
      `work tile ${wt.key} is marked unchanged, but its input hash differs from ${old.key}'s`,
    );
  }
  if (prior.cellCounts === undefined)
    refuse(
      'assemble.copiedNoCounts',
      `work tile ${wt.key}: ${old.key}'s manifest has no counts for it`,
    );
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
    doneSha: null,
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

/** The Machine's first read: the build manifest the tiles stage uploaded, or a refusal. */
export async function readBuildManifest(
  store: ObjectStore,
  campaign: string,
  pilot?: string,
): Promise<NaipManifest> {
  const bytes = await store.get(buildManifestKey(campaign, pilot));
  if (bytes === null) {
    refuse(
      'assemble.noManifest',
      `no manifest at ${buildManifestKey(campaign, pilot)}: run the tiles stage`,
    );
  }
  return JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as NaipManifest;
}

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
  // **No progress is written until every refusal is behind us** (the eighth review's rule: decide
  // before you write). An event before then only feeds the Machine's watchdog (`alive`) and is held;
  // the latest held one is written once the assembler has decided, so a refused assembly leaves no
  // progress object behind — only its error object, the refusal's own record (`cli/assemble.ts`).
  let decided = false;
  let held: AssembleProgress | null = null;
  const report = async (event: AssembleProgress): Promise<void> => {
    deps.alive?.();
    if (!decided) {
      held = event;
      return;
    }
    await deps.progress?.(event);
  };
  const decide = async (): Promise<void> => {
    decided = true;
    const last = held;
    held = null;
    if (last !== null) await deps.progress?.(last);
  };
  const { campaign } = manifest;
  const pilot = manifest.pilot ?? undefined;
  const read = parseCampaign(campaign);
  if (read.pilot !== (manifest.pilot !== null)) {
    refuse('assemble.pilotMismatch', assembleMessages.pilotMismatch(campaign, manifest.pilot));
  }
  if (manifest.workTiles.length === 0) refuse('assemble.noWorkTiles', assembleMessages.noWorkTiles);

  // ── 0. A campaign already published is never assembled again ────────────────────────────────
  // Its manifest names what its archive was built from (`publishedBuild.ts`): the same inputs are
  // done, other inputs a new campaign's — said here, before a shard is read, never at step 5 as a
  // bare "already exists" (PR #188's review).
  const publishedKey = manifestKey(campaign, pilot);
  const publishedBytes = await deps.store.get(publishedKey);
  if (publishedBytes !== null) {
    const published = JSON.parse(new TextDecoder().decode(publishedBytes)) as NaipManifest;
    const conflict = publishedConflict(published, manifest);
    if (conflict !== null) refuse('published.otherInputs', conflict);
    refuse('assemble.alreadyAssembled', assembleMessages.alreadyAssembled(campaign, publishedKey));
  }
  // An earlier assembly's leftovers, or a published key: decided here, before anything is read
  // (and asked again at step 5, just before the first byte, for an assembler racing this one).
  const keys = {
    archive: archiveKey(campaign, pilot),
    index: indexKey(campaign, pilot),
    manifest: manifestKey(campaign, pilot),
  };
  const presentKeys = async (): Promise<(key: string) => boolean> => {
    const present = new Map<string, boolean>();
    for (const key of Object.values(keys)) present.set(key, await deps.store.exists(key));
    return (key) => present.get(key) === true;
  };
  refuseExisting(keys, await presentKeys());
  const builtFrom = naipBuildInputsHash(manifest);

  // ── 1. Inputs ───────────────────────────────────────────────────────────────────────────────
  const copiedTiles = manifest.workTiles.filter((w) => !w.retile);
  let old: { key: string; archive: ArchiveEntries; manifest: NaipManifest } | null = null;
  if (copiedTiles.length > 0) {
    if (manifest.basedOn === null) refuse('assemble.noBase', assembleMessages.noBase);
    const basedOn = manifest.basedOn as NonNullable<NaipManifest['basedOn']>;
    const prefix = publishPrefix(campaign, pilot);
    const key = `${prefix}${basedOn.archive}`;
    parseArchiveKey(key);
    const oldManifestBytes = await deps.store.get(`${prefix}${basedOn.manifest}`);
    if (oldManifestBytes === null)
      refuse('assemble.baseMissing', assembleMessages.baseMissing(basedOn.manifest));
    old = {
      key,
      archive: await readArchiveEntries(storeSource(deps.store, key)),
      manifest: JSON.parse(
        new TextDecoder().decode(oldManifestBytes as Uint8Array),
      ) as NaipManifest,
    };
    if (old.manifest.archive?.name !== basedOn.archive) {
      refuse(
        'assemble.baseArchive',
        assembleMessages.baseArchive(old.manifest.archive?.name, basedOn.archive),
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
        refuse(
          'assemble.countsCell',
          `work tile ${wt.key} counts cell ${cell}, which it doesn't touch`,
        );
    }
    doneCount++;
    if (doneCount % 25 === 0 || doneCount === manifest.workTiles.length) {
      await report({ step: 'indexes', done: doneCount, total: manifest.workTiles.length });
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
      'assemble.dateIndex',
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
  await report({ step: 'overviews', tiles: overviewTiles.length });
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
    refuse('assemble.empty', 'no work tile has any tile: nothing to assemble');
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
    if (!zooms.includes(z))
      refuse('assemble.zoomEmpty', `the archive would have no tile at zoom ${z}`);
  }
  await report({ step: 'layout', tiles: layout.addressed, bytes: plan.bytes });
  lap('layout');

  // ── 5. Never overwrite a published key ──────────────────────────────────────────────────────
  // Asked at step 0 too; again here, just before the first byte, for an assembler that raced this
  // one past step 0 (two Machines never start for one campaign — `spawn.sh` — but nothing in R2
  // makes a write conditional, so the last check is the one nearest the write).
  refuseExisting(keys, await presentKeys());
  // **Decided.** Every refusal is behind this line; the progress held since the start is written now.
  await decide();
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
  // **A pack replaced while it was read is never published** (PR #188's ninth review). This Machine
  // can't see Fly: what keeps a worker from re-cutting a work tile under it is the laptop's
  // preflight (no assembler starts while any of the campaign's work-tile Machines is up) and, after
  // it, `spawn.sh tiles`' refusal under a live assembler — neither reaches a worker started from
  // another machine, or one Fly's listing missed. So the reads themselves are checked: a worker
  // drops its done record before it overwrites the pack and uploads its new record last
  // (`cut-aerial.sh`), so a pack that changed at any time after step 1 read its record leaves that
  // record gone or different. Every cut work tile's record is read again once the last pack byte
  // has been read — before the archive's upload is completed — and any change abandons the upload
  // (nothing is published) and refuses.
  const recheck = async (): Promise<void> => {
    const cut = inputs.filter((i) => i.doneSha !== null);
    const changed: string[] = [];
    await mapLimit(cut, concurrency, async (input) => {
      const now = await deps.store.get(shardKeys(campaign, input.tile, pilot).done);
      deps.alive?.();
      if (now === null || sha256Hex(now) !== input.doneSha) changed.push(input.key);
    });
    if (changed.length > 0) {
      changed.sort();
      refuse(
        'assemble.shardReplaced',
        `${changed.length} work tile${changed.length === 1 ? ' was' : 's were'} re-cut while this assembly read ${changed.length === 1 ? 'it' : 'them'} (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}: the done record changed under it), so the archive streamed could hold a new pack's bytes at the old offsets — its upload was abandoned and nothing was published. Let the campaign's work tiles finish (run the tiles stage: it waits for them and re-cuts what no longer matches), then assemble again`,
      );
    }
  };
  const sink = hashingSink(
    deps.upload(keys.archive, { contentType: 'application/vnd.pmtiles', cacheControl: IMMUTABLE }),
  );
  let zoom = -1;
  let beatAt = 0;
  const heartbeat = deps.heartbeatMs ?? HEARTBEAT_MS;
  await writeArchive(plan, layout, reader, sink, {
    ...deps.write,
    onRun: async (data, run) => {
      const reached = zoomOf(run.tileId);
      const at = now().getTime();
      if (reached !== zoom || at - beatAt >= heartbeat) {
        zoom = reached;
        beatAt = at;
        await report({ step: 'zoom', zoom, dataBytes: data, totalBytes: plan.bytes });
      }
      await deps.write?.onRun?.(data, run);
    },
    beforeEnd: recheck,
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
  await report({ step: 'published', archiveBytes: archive.bytes });
  lap('publish');

  const memory = deps.memory?.() ?? { rss: 0, heap: 0 };
  const record: AssemblyRecord = {
    version: ASSEMBLY_RECORD_VERSION,
    campaign,
    pilot: manifest.pilot,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    inputs: builtFrom,
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
