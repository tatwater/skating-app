/**
 * **The streaming writer** (B05 §2.4 steps 3–4): header, root, metadata, leaves, then the tile data,
 * in that order, into one sink — no step holds the archive, on disk or in memory.
 *
 * The tile data is read run by run (`readRuns`) from wherever each tile lives. Small runs are
 * fetched ahead, a bounded number of bytes at a time, so ~12,000 range reads overlap their latency;
 * a large run (a work tile's deepest zoom, up to a few hundred MB) is streamed chunk by chunk when its
 * turn comes, with the sink's backpressure, so memory never scales with a run.
 */

import { type Layout, type ReadRun, readRuns } from './layout';
import {
  buildDirectories,
  Compression,
  type Directories,
  gzipBytes,
  HEADER_BYTES,
  type PmtilesHeader,
  serializeHeader,
  TileType,
} from './pmtiles';
import type { ByteSink } from './stores';
import type { LonLatBox } from './tileGrid';

/** Reads source bytes for the writer: a store, or the overviews in memory. */
export interface RunReader {
  read(source: string, offset: number, length: number): Promise<Uint8Array>;
  stream(source: string, offset: number, length: number): AsyncIterable<Uint8Array>;
}

export interface ArchiveSpec {
  layout: Layout;
  minZoom: number;
  maxZoom: number;
  bounds: LonLatBox;
  centerZoom: number;
  /** The JSON metadata object (§5). */
  metadata: Record<string, unknown>;
  /** The root/leaf split's knobs; the defaults are the spec's (tests force leaves with them). */
  directories?: { maxRoot?: number; firstLeafSize?: number };
}

/** Everything about the archive known before its data is written. */
export interface ArchivePlan {
  header: PmtilesHeader;
  headerBytes: Uint8Array;
  directories: Directories;
  metadataBytes: Uint8Array;
  /** The archive's whole length. */
  bytes: number;
}

/** Directories, metadata and header for a layout; throws on an empty one. */
export function planArchive(spec: ArchiveSpec): ArchivePlan {
  const { layout } = spec;
  const directories = buildDirectories(layout.entries, spec.directories);
  const metadataBytes = gzipBytes(new TextEncoder().encode(JSON.stringify(spec.metadata)));
  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + directories.root.length;
  const leafOffset = metadataOffset + metadataBytes.length;
  const dataOffset = leafOffset + directories.leaves.length;
  const header: PmtilesHeader = {
    rootDirectoryOffset: rootOffset,
    rootDirectoryLength: directories.root.length,
    jsonMetadataOffset: metadataOffset,
    jsonMetadataLength: metadataBytes.length,
    leafDirectoryOffset: leafOffset,
    leafDirectoryLength: directories.leaves.length,
    tileDataOffset: dataOffset,
    tileDataLength: layout.dataLength,
    numAddressedTiles: layout.addressed,
    numTileEntries: layout.entries.count,
    numTileContents: layout.contents,
    clustered: true,
    internalCompression: Compression.gzip,
    tileCompression: Compression.none,
    tileType: TileType.webp,
    minZoom: spec.minZoom,
    maxZoom: spec.maxZoom,
    minLon: spec.bounds.west,
    minLat: spec.bounds.south,
    maxLon: spec.bounds.east,
    maxLat: spec.bounds.north,
    centerZoom: spec.centerZoom,
    centerLon: (spec.bounds.west + spec.bounds.east) / 2,
    centerLat: (spec.bounds.south + spec.bounds.north) / 2,
  };
  return {
    header,
    headerBytes: serializeHeader(header),
    directories,
    metadataBytes,
    bytes: dataOffset + layout.dataLength,
  };
}

/** Progress, per run written: how many tile-data bytes so far. */
export type WriteProgress = (dataBytes: number, run: ReadRun) => void | Promise<void>;

export interface WriteOptions {
  /** Runs at most this long are fetched ahead whole (default 8 MiB). */
  prefetchRunBytes?: number;
  /** At most this many bytes of runs in flight ahead (default 128 MiB). */
  prefetchBytes?: number;
  /** At most this many runs in flight ahead (default 16). */
  prefetchRuns?: number;
  onRun?: WriteProgress;
  /**
   * Asked once every byte has been read and written, before the sink is ended: a throw abandons the
   * sink (`ByteSink.abort`) and is rethrown — the last chance to refuse what the reads produced. (Any
   * other failure before the end abandons it too.)
   */
  beforeEnd?: () => Promise<void>;
}

/** Drop the repeats a run carries, keeping its tiles in order. */
async function* cut(chunks: AsyncIterable<Uint8Array>, run: ReadRun): AsyncGenerator<Uint8Array> {
  let ci = 0;
  let left = run.cuts[0]?.length ?? 0;
  for await (const chunk of chunks) {
    let at = 0;
    while (at < chunk.length) {
      const c = run.cuts[ci];
      if (c === undefined)
        throw new Error(`${run.source}: more bytes than the run's ${run.length}`);
      const take = Math.min(left, chunk.length - at);
      if (c.keep) yield chunk.subarray(at, at + take);
      at += take;
      left -= take;
      if (left === 0) {
        ci++;
        left = run.cuts[ci]?.length ?? 0;
      }
    }
  }
  if (ci !== run.cuts.length) throw new Error(`${run.source}: the run ended short`);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * The tile data, in layout order, fetched ahead where runs are small. Every byte yielded is a kept
 * tile's; the total is `layout.dataLength` or this throws.
 */
export async function* tileData(
  layout: Layout,
  reader: RunReader,
  options: WriteOptions = {},
): AsyncGenerator<{ chunk: Uint8Array; run: ReadRun; last: boolean }> {
  const small = options.prefetchRunBytes ?? 8 << 20;
  const budget = options.prefetchBytes ?? 128 << 20;
  const maxAhead = options.prefetchRuns ?? 16;
  const runs = readRuns(layout);
  type Pending = { run: ReadRun; bytes: Promise<Uint8Array> | null };
  const ahead: Pending[] = [];
  let inFlight = 0;
  let exhausted = false;

  const start = (p: Pending): void => {
    inFlight += p.run.length;
    p.bytes = reader.read(p.run.source, p.run.offset, p.run.length);
    // Surfaced when awaited; until then a rejection must not count as unhandled.
    p.bytes.catch(() => {});
  };

  // Fetch ahead, in order: a small run whenever the byte budget has room (or nothing else is in
  // flight), and stop at the first that can't start yet — a large run (it streams on its turn) or a
  // small one waiting for budget — so reads stay in output order.
  const fill = (): void => {
    for (const p of ahead) {
      if (p.bytes !== null) continue;
      if (p.run.length > small || (inFlight + p.run.length > budget && inFlight > 0)) return;
      start(p);
    }
    while (!exhausted && ahead.length < maxAhead) {
      const next = runs.next();
      if (next.done) {
        exhausted = true;
        return;
      }
      const p: Pending = { run: next.value, bytes: null };
      ahead.push(p);
      if (p.run.length > small || (inFlight + p.run.length > budget && inFlight > 0)) return;
      start(p);
    }
  };

  let written = 0;
  fill();
  for (;;) {
    const p = ahead.shift();
    if (p === undefined) break;
    // A small run that never got budget is fetched now; a large one streams.
    if (p.bytes === null && p.run.length <= small) start(p);
    const source =
      p.bytes === null
        ? reader.stream(p.run.source, p.run.offset, p.run.length)
        : once(await p.bytes);
    if (p.bytes !== null) inFlight -= p.run.length;
    fill();
    const pieces = cut(source, p.run);
    let piece = await pieces.next();
    while (!piece.done) {
      const following = await pieces.next();
      written += piece.value.length;
      yield { chunk: piece.value, run: p.run, last: following.done === true };
      piece = following;
    }
    fill();
  }
  if (written !== layout.dataLength) {
    throw new Error(
      `wrote ${written} bytes of tile data, the layout addresses ${layout.dataLength}`,
    );
  }
}

/** Write the whole archive into `sink` (and end it). Returns the bytes written. */
export async function writeArchive(
  plan: ArchivePlan,
  layout: Layout,
  reader: RunReader,
  sink: ByteSink,
  options: WriteOptions = {},
): Promise<number> {
  let bytes = 0;
  const put = async (chunk: Uint8Array): Promise<void> => {
    if (chunk.length === 0) return;
    bytes += chunk.length;
    await sink.write(chunk);
  };
  // **Nothing that failed is ever ended** (PR #188's tenth review): ending is what completes the
  // upload — `rclone rcat` completes it on the end of its input, whatever it holds — so a read that
  // failed mid-stream, a count that came out wrong or a refusal at the last check abandons the sink
  // instead (`ByteSink.abort`), and the byte count is checked before the end, not after it. Before,
  // only `beforeEnd`'s refusal abandoned it: any other failure left the upload open for the
  // process's exit to end, which published the bytes so far at a key never overwritten.
  try {
    await put(plan.headerBytes);
    await put(plan.directories.root);
    await put(plan.metadataBytes);
    await put(plan.directories.leaves);
    let data = 0;
    for await (const { chunk, run, last } of tileData(layout, reader, options)) {
      await put(chunk);
      data += chunk.length;
      if (last) await options.onRun?.(data, run);
    }
    if (bytes !== plan.bytes) throw new Error(`wrote ${bytes} bytes, the plan says ${plan.bytes}`);
    await options.beforeEnd?.();
  } catch (e) {
    // The failure is what is reported; an abandon that fails too (a temp file gone) adds nothing.
    await sink.abort?.()?.catch(() => {});
    throw e;
  }
  await sink.end();
  return bytes;
}
