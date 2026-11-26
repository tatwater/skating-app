/**
 * **The archive's layout, decided before a byte is written** (B05 §2.4 step 2).
 *
 * The directories come before the tile data in the file, so every tile's final offset must be known
 * first — and it can be, because every input says how long each tile is (a shard's index, the old
 * archive's directory, the overviews in memory). The layout walks the tiles once, **in tile-id
 * order** (zoom by zoom, work tiles in Hilbert order, tiles by id — `tileGrid.ts` says why that is
 * one order), and decides for each: a new blob at the end of the data (its bytes will be streamed),
 * or a repeat of one already placed (deduplicated: an entry pointing back, no bytes). A repeat of the
 * immediately preceding tile's content, at the next id, extends that entry's run instead.
 *
 * Inputs arrive as **segments**: one source object's tiles for one zoom of one work tile (or the
 * overviews of one zoom), columnar, so ~9 M tiles cost typed arrays rather than objects.
 */

import { ContentTable } from './contentTable';
import { type EntryColumns, entryColumns } from './pmtiles';

/** A run of tiles from one source object, in ascending tile id. */
export interface TileSegment {
  /** The source object the bytes are read from (a store key, or a `memory:` name). */
  source: string;
  tileId: Float64Array;
  /** Each tile's byte offset in `source`. */
  srcOffset: Float64Array;
  length: Uint32Array;
  /** Four words per tile: `contentKey` of its SHA-256 (or of a stand-in for a copied tile). */
  key: Uint32Array;
  /** Set by `layoutArchive`: 1 where the tile's bytes go into the data, 0 for a repeat. */
  emit?: Uint8Array;
}

/** The layout: the directory entries, and how much tile data they address. */
export interface Layout {
  segments: TileSegment[];
  entries: EntryColumns;
  /** Bytes of tile data: every emitted tile once. */
  dataLength: number;
  /** Tiles addressed, counting each id of a run. */
  addressed: number;
  /** Distinct blobs in the data. */
  contents: number;
  /** Tiles per zoom, by tile zoom (for the run row and verify). */
  perZoom: Map<number, number>;
  /** The dedupe table's slot count, for the memory account. */
  tableSlots: number;
}

/** A segment from plain arrays (tests, and the small inputs). */
export function segmentOf(
  source: string,
  tiles: readonly { tileId: number; srcOffset: number; length: number; key: Uint32Array }[],
): TileSegment {
  const n = tiles.length;
  const seg: TileSegment = {
    source,
    tileId: new Float64Array(n),
    srcOffset: new Float64Array(n),
    length: new Uint32Array(n),
    key: new Uint32Array(n * 4),
  };
  tiles.forEach((t, i) => {
    seg.tileId[i] = t.tileId;
    seg.srcOffset[i] = t.srcOffset;
    seg.length[i] = t.length;
    seg.key.set(t.key.subarray(0, 4), i * 4);
  });
  return seg;
}

/**
 * Lay the segments out, in the order given (which must be ascending tile id throughout: a tile id
 * that doesn't climb is refused, since the archive would no longer be clustered). Fills each
 * segment's `emit`. `zoomOf` names a tile's zoom for the per-zoom counts.
 */
export function layoutArchive(
  segments: TileSegment[],
  zoomOf: (tileId: number) => number,
  options: { releaseKeys?: boolean } = {},
): Layout {
  const total = segments.reduce((n, s) => n + s.tileId.length, 0);
  // At most one entry a tile, so the columns never grow.
  const entries = entryColumns(Math.max(16, total));
  const table = new ContentTable(total);
  const perZoom = new Map<number, number>();
  let dataLength = 0;
  let addressed = 0;
  let lastId = -1;
  // The content of the last entry, by its data offset: a repeat of it at the next id is a run.
  let lastOffset = -1;

  for (const seg of segments) {
    const n = seg.tileId.length;
    const emit = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const id = seg.tileId[i] as number;
      if (id <= lastId) {
        throw new Error(`tile ${id} from ${seg.source} after ${lastId}: not in tile-id order`);
      }
      const length = seg.length[i] as number;
      if (length === 0) throw new Error(`tile ${id} from ${seg.source} has length 0`);
      const z = zoomOf(id);
      perZoom.set(z, (perZoom.get(z) ?? 0) + 1);
      addressed++;
      const seen = table.get(seg.key, i * 4);
      if (seen === undefined) {
        table.set(seg.key, i * 4, dataLength);
        emit[i] = 1;
        const e = entries.count++;
        entries.tileId[e] = id;
        entries.offset[e] = dataLength;
        entries.length[e] = length;
        entries.runLength[e] = 1;
        lastOffset = dataLength;
        dataLength += length;
      } else {
        const last = entries.count - 1;
        if (
          seen === lastOffset &&
          id === (entries.tileId[last] as number) + (entries.runLength[last] as number)
        ) {
          entries.runLength[last] = (entries.runLength[last] as number) + 1;
        } else {
          const e = entries.count++;
          entries.tileId[e] = id;
          entries.offset[e] = seen;
          entries.length[e] = length;
          entries.runLength[e] = 1;
          lastOffset = seen;
        }
      }
      lastId = id;
    }
    seg.emit = emit;
    if (options.releaseKeys) seg.key = new Uint32Array(0);
  }

  return {
    segments,
    entries,
    dataLength,
    addressed,
    contents: table.size,
    perZoom,
    tableSlots: table.capacity,
  };
}

/** One contiguous read: bytes `[offset, offset + length)` of `source`, cut into tiles. */
export interface ReadRun {
  source: string;
  /** The first kept tile's id (its zoom is the run's: a segment never spans two). */
  tileId: number;
  offset: number;
  length: number;
  /** Per tile in the run, in order: its byte length and whether it is kept. */
  cuts: { length: number; keep: boolean }[];
}

/**
 * The reads the streaming pass makes, in output order: each segment split where its source bytes
 * stop being contiguous, a repeat inside a run kept as a cut that is dropped (one range read is
 * cheaper than two), and a repeat that starts or ends a run left unread.
 */
export function* readRuns(layout: Layout): Generator<ReadRun> {
  for (const seg of layout.segments) {
    const emit = seg.emit;
    if (emit === undefined) throw new Error(`segment ${seg.source} was never laid out`);
    let run: ReadRun | null = null;
    let next = -1;
    const flush = function* (): Generator<ReadRun> {
      if (run === null) return;
      // A run starts on a kept tile; trailing repeats needn't be read at all.
      while (!run.cuts[run.cuts.length - 1]?.keep) run.cuts.pop();
      run.length = run.cuts.reduce((n, c) => n + c.length, 0);
      yield run;
      run = null;
    };
    for (let i = 0; i < seg.tileId.length; i++) {
      const offset = seg.srcOffset[i] as number;
      const length = seg.length[i] as number;
      const keep = emit[i] === 1;
      if (run === null || offset !== next) {
        yield* flush();
        if (!keep) {
          // A repeat that doesn't continue a run is never read.
          next = -1;
          continue;
        }
        run = { source: seg.source, tileId: seg.tileId[i] as number, offset, length: 0, cuts: [] };
      }
      run.cuts.push({ length, keep });
      next = offset + length;
    }
    yield* flush();
  }
}
