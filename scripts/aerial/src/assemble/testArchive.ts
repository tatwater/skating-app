/**
 * Test support: an in-memory source of tiles, laid out and written the way the assembler does, and
 * a `pmtiles` `Source` over the bytes. Not a test file itself (imported by several), and not part of
 * the stage: nothing under `src/` but tests imports it.
 */

import { tileIdToZxy } from 'pmtiles';
import { contentKey } from './contentTable';
import { layoutArchive, segmentOf, type TileSegment } from './layout';
import { memorySink, sha256Hex } from './stores';
import { type ArchiveSpec, planArchive, type RunReader, writeArchive } from './writer';

/** Sources by name, each a byte buffer; reads are exact slices. */
export function memoryReader(sources: Map<string, Uint8Array>): RunReader & { reads: number } {
  const reader = {
    reads: 0,
    async read(source: string, offset: number, length: number) {
      reader.reads++;
      const buf = sources.get(source);
      if (buf === undefined) throw new Error(`no source ${source}`);
      if (offset + length > buf.length) throw new Error(`${source}: read past the end`);
      return buf.slice(offset, offset + length);
    },
    async *stream(source: string, offset: number, length: number) {
      reader.reads++;
      const buf = sources.get(source);
      if (buf === undefined) throw new Error(`no source ${source}`);
      // Odd-sized chunks, so a cut that only works on tile boundaries fails.
      for (let at = offset; at < offset + length; at += 7) {
        yield buf.slice(at, Math.min(at + 7, offset + length));
      }
    },
  };
  return reader;
}

/** Tiles packed into one source per group, in the order given (which must be tile-id order). */
export function packSegments(
  groups: readonly { source: string; tiles: readonly { tileId: number; bytes: Uint8Array }[] }[],
): { segments: TileSegment[]; sources: Map<string, Uint8Array> } {
  const sources = new Map<string, Uint8Array>();
  const segments = groups.map((g) => {
    let at = 0;
    const tiles = g.tiles.map((t) => {
      const tile = {
        tileId: t.tileId,
        srcOffset: at,
        length: t.bytes.length,
        key: contentKey(sha256Hex(t.bytes)),
      };
      at += t.bytes.length;
      return tile;
    });
    sources.set(g.source, Buffer.concat(g.tiles.map((t) => t.bytes)));
    return segmentOf(g.source, tiles);
  });
  return { segments, sources };
}

export const zoomOf = (tileId: number): number => tileIdToZxy(tileId)[0];

/** Lay out and write an archive of `groups` into memory. */
export async function writeToMemory(
  groups: readonly { source: string; tiles: readonly { tileId: number; bytes: Uint8Array }[] }[],
  spec: Partial<Omit<ArchiveSpec, 'layout'>> = {},
): Promise<{ bytes: Uint8Array; reads: number }> {
  const { segments, sources } = packSegments(groups);
  const layout = layoutArchive(segments, zoomOf);
  const zooms = [...layout.perZoom.keys()];
  const plan = planArchive({
    layout,
    minZoom: Math.min(...zooms),
    maxZoom: Math.max(...zooms),
    bounds: { west: -80, south: 40, east: -66, north: 48 },
    centerZoom: 10,
    metadata: { name: 'test' },
    ...spec,
  });
  const sink = memorySink();
  const reader = memoryReader(sources);
  await writeArchive(plan, layout, reader, sink, { prefetchRunBytes: 64, prefetchBytes: 256 });
  return { bytes: sink.bytes(), reads: reader.reads };
}

/** A `pmtiles` source over bytes in memory, clamping reads at the end as a server does. */
export function bytesSource(bytes: Uint8Array) {
  return {
    getKey: () => 'memory',
    async getBytes(offset: number, length: number) {
      return { data: bytes.slice(offset, offset + length).buffer as ArrayBuffer };
    },
  };
}
