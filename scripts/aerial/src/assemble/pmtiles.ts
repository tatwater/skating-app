/**
 * **PMTiles v3, written against the spec itself** (B05 §2.4): the header, the varint directories and
 * the root/leaf split. Read back in the tests by the `pmtiles` JS reader the web uses, so a field we
 * got wrong fails CI rather than a browser.
 *
 * Checked against `protomaps/PMTiles` `spec/v3/spec.md` and the reader's own source
 * (`pmtiles@4.5.0` `src/index.ts`), not memory:
 *
 * - **Header**: 127 bytes, little-endian. Magic `PMTiles` (7 bytes) then version `3`; the reader
 *   checks only the first two bytes (`0x4d50`, "PM") and the version byte, so the magic is written
 *   whole for every other reader. Offsets and lengths are uint64 (the reader composes two uint32s,
 *   so anything under 2^53 is exact). Positions are int32 × 10⁷, longitude first.
 * - **Directories**: a varint count, then the tile ids **delta-encoded**, the run lengths, the
 *   lengths, and the offsets — each offset written as `offset + 1`, or `0` when it continues the
 *   previous entry (`offset === previous.offset + previous.length`, never for the first entry).
 *   The count must be > 0 (the reader throws *"Empty directory is invalid"*). Each directory is
 *   compressed on its own (leaves individually, not as a section).
 * - **The root and the header together fit in the first 16,384 bytes** (the reader slices its first
 *   16 KiB fetch for the root, so a longer root decodes truncated): the root's compressed length is at
 *   most 16,257 bytes. Leaf entries have run length `0` and an offset into the leaf section; a leaf's
 *   own entries point into the tile data. One level of leaves only (the spec discourages more; the
 *   reader follows at most three).
 * - **Clustered** means tile data in tile-id order: each entry's offset continues the previous one, or
 *   points back to an earlier blob (a deduplicated tile), and the first entry's offset is 0.
 */

import { gzipSync } from 'node:zlib';

/** `PMTiles` in UTF-8. */
export const PMTILES_MAGIC = Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
export const PMTILES_VERSION = 3;
export const HEADER_BYTES = 127;
/** The header plus the root directory must fit in the reader's first fetch. */
export const ROOT_FETCH_BYTES = 16_384;
export const MAX_ROOT_BYTES = ROOT_FETCH_BYTES - HEADER_BYTES;

/** The spec's compression enum (§3.3). */
export const Compression = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 } as const;
/** The spec's tile type enum (§3.2). */
export const TileType = { unknown: 0, mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5, mlt: 6 } as const;

/** Every header field, in the spec's order. */
export interface PmtilesHeader {
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  jsonMetadataOffset: number;
  jsonMetadataLength: number;
  leafDirectoryOffset: number;
  leafDirectoryLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
}

function setUint64(view: DataView, at: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`header field at ${at}: ${value} is not a uint64 this writer can hold`);
  }
  view.setUint32(at, value % 2 ** 32, true);
  view.setUint32(at + 4, Math.floor(value / 2 ** 32), true);
}

function setPosition(view: DataView, at: number, value: number, what: string): void {
  const fixed = Math.round(value * 10_000_000);
  if (fixed < -(2 ** 31) || fixed >= 2 ** 31) throw new Error(`${what} ${value} is out of range`);
  view.setInt32(at, fixed, true);
}

function setUint8(view: DataView, at: number, value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${what} ${value} is not a byte`);
  }
  view.setUint8(at, value);
}

/** The 127-byte header (§3). */
export function serializeHeader(h: PmtilesHeader): Uint8Array {
  if (h.maxZoom < h.minZoom)
    throw new Error(`max zoom ${h.maxZoom} is under min zoom ${h.minZoom}`);
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(PMTILES_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint8(7, PMTILES_VERSION);
  setUint64(view, 8, h.rootDirectoryOffset);
  setUint64(view, 16, h.rootDirectoryLength);
  setUint64(view, 24, h.jsonMetadataOffset);
  setUint64(view, 32, h.jsonMetadataLength);
  setUint64(view, 40, h.leafDirectoryOffset);
  setUint64(view, 48, h.leafDirectoryLength);
  setUint64(view, 56, h.tileDataOffset);
  setUint64(view, 64, h.tileDataLength);
  setUint64(view, 72, h.numAddressedTiles);
  setUint64(view, 80, h.numTileEntries);
  setUint64(view, 88, h.numTileContents);
  view.setUint8(96, h.clustered ? 1 : 0);
  setUint8(view, 97, h.internalCompression, 'internal compression');
  setUint8(view, 98, h.tileCompression, 'tile compression');
  setUint8(view, 99, h.tileType, 'tile type');
  setUint8(view, 100, h.minZoom, 'min zoom');
  setUint8(view, 101, h.maxZoom, 'max zoom');
  setPosition(view, 102, h.minLon, 'min lon');
  setPosition(view, 106, h.minLat, 'min lat');
  setPosition(view, 110, h.maxLon, 'max lon');
  setPosition(view, 114, h.maxLat, 'max lat');
  setUint8(view, 118, h.centerZoom, 'center zoom');
  setPosition(view, 119, h.centerLon, 'center lon');
  setPosition(view, 123, h.centerLat, 'center lat');
  return bytes;
}

// ── Varints ──────────────────────────────────────────────────────────────────────────────────────

/** A growable byte buffer for directory encoding. */
export class ByteWriter {
  private buf: Uint8Array;
  length = 0;

  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
  }

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  /** An unsigned LEB128 varint (protobuf's), for any safe non-negative integer. */
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${value} is not a non-negative safe integer`);
    }
    this.reserve(10);
    let v = value;
    // Above 2^31 the bitwise operators would truncate, so the high part is peeled arithmetically.
    while (v >= 0x80) {
      this.buf[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.length++] = v;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

// ── Directories ──────────────────────────────────────────────────────────────────────────────────

/**
 * Directory entries, columnar: a region archive addresses ~9 M tiles, and an object per entry would
 * cost several times these 24 bytes.
 */
export interface EntryColumns {
  count: number;
  tileId: Float64Array;
  offset: Float64Array;
  length: Uint32Array;
  runLength: Uint32Array;
}

/** Room for `capacity` entries. */
export function entryColumns(capacity: number): EntryColumns {
  return {
    count: 0,
    tileId: new Float64Array(capacity),
    offset: new Float64Array(capacity),
    length: new Uint32Array(capacity),
    runLength: new Uint32Array(capacity),
  };
}

/** Entries `[from, to)` of `cols`, encoded per §4.2 (uncompressed). */
export function serializeDirectory(cols: EntryColumns, from = 0, to = cols.count): Uint8Array {
  const n = to - from;
  if (n <= 0) throw new Error('a directory needs at least one entry');
  const w = new ByteWriter(n * 6 + 16);
  w.varint(n);
  let lastId = 0;
  for (let i = from; i < to; i++) {
    const id = cols.tileId[i] as number;
    if (id < lastId || (i > from && id === lastId)) {
      throw new Error(`tile id ${id} after ${lastId}: a directory is ascending`);
    }
    w.varint(id - lastId);
    lastId = id;
  }
  for (let i = from; i < to; i++) w.varint(cols.runLength[i] as number);
  for (let i = from; i < to; i++) {
    const length = cols.length[i] as number;
    if (length === 0) throw new Error(`entry for tile ${cols.tileId[i]} has length 0`);
    w.varint(length);
  }
  let next = 0;
  for (let i = from; i < to; i++) {
    const offset = cols.offset[i] as number;
    if (i > from && offset === next) w.varint(0);
    else w.varint(offset + 1);
    next = offset + (cols.length[i] as number);
  }
  return w.bytes();
}

/** gzip, as the archive's internal compression: deterministic (no name, mtime 0). */
export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(bytes, { level: 9 }));
}

/** The root directory and the leaves behind it, compressed, ready to write. */
export interface Directories {
  root: Uint8Array;
  /** The leaf directories concatenated, each compressed on its own; empty when the root holds all. */
  leaves: Uint8Array;
  /** How many leaves, and how many tile entries each holds at most (0: no leaves). */
  leafCount: number;
  leafSize: number;
}

/** The smallest leaf the splitter tries (go-pmtiles' starting size). */
export const FIRST_LEAF_SIZE = 4096;

/**
 * The root and leaves for `cols` (§4): everything in the root when it fits under `maxRoot`
 * compressed bytes; otherwise leaves of `leafSize` entries, growing the size by a fifth until the
 * root of leaf pointers fits. Throws if even one leaf's pointer can't (a `maxRoot` no real archive
 * has: a one-entry root is a few bytes).
 */
export function buildDirectories(
  cols: EntryColumns,
  options: {
    compress?: (bytes: Uint8Array) => Uint8Array;
    maxRoot?: number;
    firstLeafSize?: number;
  } = {},
): Directories {
  const compress = options.compress ?? gzipBytes;
  const maxRoot = options.maxRoot ?? MAX_ROOT_BYTES;
  if (cols.count === 0) throw new Error('an archive needs at least one tile');
  const whole = compress(serializeDirectory(cols));
  if (whole.length <= maxRoot) {
    return { root: whole, leaves: new Uint8Array(0), leafCount: 0, leafSize: 0 };
  }
  for (let leafSize = options.firstLeafSize ?? FIRST_LEAF_SIZE; ; ) {
    const leafCount = Math.ceil(cols.count / leafSize);
    const pointers = entryColumns(leafCount);
    const parts: Uint8Array[] = [];
    let at = 0;
    for (let i = 0; i < leafCount; i++) {
      const from = i * leafSize;
      const to = Math.min(cols.count, from + leafSize);
      const leaf = compress(serializeDirectory(cols, from, to));
      pointers.tileId[i] = cols.tileId[from] as number;
      pointers.offset[i] = at;
      pointers.length[i] = leaf.length;
      pointers.runLength[i] = 0;
      parts.push(leaf);
      at += leaf.length;
    }
    pointers.count = leafCount;
    const root = compress(serializeDirectory(pointers));
    if (root.length <= maxRoot) {
      const leaves = new Uint8Array(at);
      let o = 0;
      for (const p of parts) {
        leaves.set(p, o);
        o += p.length;
      }
      return { root, leaves, leafCount, leafSize };
    }
    if (leafCount === 1) {
      throw new Error(`no leaf size fits ${cols.count} entries under a ${maxRoot}-byte root`);
    }
    leafSize = Math.ceil(leafSize * 1.2);
  }
}
