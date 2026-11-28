/**
 * **An existing archive, read by the `pmtiles` JS library the web uses** — its header and every
 * directory entry. The assembler reads the current archive this way to copy an unchanged work tile's
 * tiles out of it (§2.4, Governor fork G-4); verify reads the new one this way to count it (§2.5), so
 * a directory the web's reader would misread fails here first.
 */

import { type Header, PMTiles, ResolvedValueCache, type Source } from 'pmtiles';
import { type EntryColumns, entryColumns } from './pmtiles';
import type { ObjectStore } from './stores';

/** A `pmtiles` `Source` over one store object. */
export function storeSource(store: ObjectStore, key: string): Source {
  return {
    getKey: () => `${store.name}${key}`,
    async getBytes(offset, length) {
      const bytes = await store.rangeUpTo(key, offset, length);
      // A fresh ArrayBuffer exactly the bytes' size: the library slices `data` by absolute offsets.
      return { data: bytes.slice().buffer as ArrayBuffer };
    },
  };
}

/** The header and the tile entries (run length > 0) of every directory, in tile-id order. */
export interface ArchiveEntries {
  header: Header;
  entries: EntryColumns;
  /** How many leaf directories the root points at. */
  leaves: number;
}

/** Walk an archive's directories with the library's own cache and decoder. */
export async function readArchiveEntries(source: Source): Promise<ArchiveEntries> {
  const cache = new ResolvedValueCache(4);
  const archive = new PMTiles(source, cache);
  const header = await archive.getHeader();
  // The header counts the tile entries; directories holding more are a broken archive, refused.
  const entries = entryColumns(header.numTileEntries);
  let leaves = 0;
  const push = (tileId: number, offset: number, length: number, runLength: number): void => {
    if (entries.count === entries.tileId.length) {
      throw new Error(
        `the directories hold more tile entries than the header's ${header.numTileEntries}`,
      );
    }
    const i = entries.count++;
    entries.tileId[i] = tileId;
    entries.offset[i] = offset;
    entries.length[i] = length;
    entries.runLength[i] = runLength;
  };
  const walk = async (offset: number, length: number, depth: number): Promise<void> => {
    const dir = await cache.getDirectory(source, offset, length, header);
    for (const e of dir) {
      if (e.runLength > 0) {
        push(e.tileId, e.offset, e.length, e.runLength);
      } else {
        if (depth >= 1) throw new Error('a leaf directory points at another: one level only');
        leaves++;
        await walk(header.leafDirectoryOffset + e.offset, e.length, depth + 1);
      }
    }
  };
  await walk(header.rootDirectoryOffset, header.rootDirectoryLength, 0);
  return { header, entries, leaves };
}

/** The index of the first entry whose tile id is ≥ `tileId` (entries ascending). */
export function lowerBound(cols: EntryColumns, tileId: number): number {
  let lo = 0;
  let hi = cols.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cols.tileId[mid] as number) < tileId) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every addressed tile in `[first, first + count)`, runs expanded: its id, and its blob's offset
 * (absolute in the archive) and length.
 */
export function* tilesInRange(
  archive: ArchiveEntries,
  first: number,
  count: number,
): Generator<{ tileId: number; offset: number; length: number }> {
  const end = first + count;
  const cols = archive.entries;
  // A run that starts before `first` can still cover it.
  let i = Math.max(0, lowerBound(cols, first) - 1);
  for (; i < cols.count; i++) {
    const start = cols.tileId[i] as number;
    if (start >= end) return;
    const run = cols.runLength[i] as number;
    const offset = archive.header.tileDataOffset + (cols.offset[i] as number);
    const length = cols.length[i] as number;
    for (let id = Math.max(start, first); id < Math.min(start + run, end); id++) {
      yield { tileId: id, offset, length };
    }
  }
}
