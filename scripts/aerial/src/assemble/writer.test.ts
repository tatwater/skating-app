import fc from 'fast-check';
import { bytesToHeader, PMTiles, tileIdToZxy, zxyToTileId } from 'pmtiles';
import { describe, expect, it } from 'vitest';
import { readArchiveEntries } from './archiveRead';
import { layoutArchive, readRuns } from './layout';
import { HEADER_BYTES, ROOT_FETCH_BYTES } from './pmtiles';
import { bytesSource, packSegments, writeToMemory, zoomOf } from './testArchive';
import { planArchive, tileData } from './writer';

const tileBytes = (seed: number, length: number): Uint8Array => {
  const b = new Uint8Array(length);
  for (let i = 0; i < length; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
};

/** Distinct tile ids, ascending, from a few zooms; each with a content drawn from a small pool. */
const arbTiles = fc
  .uniqueArray(
    fc
      .integer({ min: 0, max: 7 })
      .chain((z) =>
        fc.tuple(
          fc.constant(z),
          fc.integer({ min: 0, max: 2 ** z - 1 }),
          fc.integer({ min: 0, max: 2 ** z - 1 }),
        ),
      )
      .map(([z, x, y]) => zxyToTileId(z, x, y)),
    { minLength: 1, maxLength: 120 },
  )
  .chain((ids) =>
    fc.tuple(
      fc.constant([...ids].sort((a, b) => a - b)),
      fc.array(fc.integer({ min: 0, max: 6 }), { minLength: ids.length, maxLength: ids.length }),
      fc.integer({ min: 1, max: 4 }),
    ),
  )
  .map(([ids, pool, groups]) =>
    ids.map((tileId, i) => ({
      tileId,
      bytes: tileBytes(pool[i] as number, 1 + (((pool[i] as number) * 13) % 40)),
      group: Math.min(groups - 1, Math.floor((i * groups) / ids.length)),
    })),
  );

const asGroups = (tiles: { tileId: number; bytes: Uint8Array; group: number }[]) => {
  const groups = new Map<number, { tileId: number; bytes: Uint8Array }[]>();
  for (const t of tiles) {
    const g = groups.get(t.group) ?? [];
    g.push(t);
    groups.set(t.group, g);
  }
  return [...groups].map(([g, list]) => ({ source: `src-${g}`, tiles: list }));
};

describe('the round trip through the web’s reader', () => {
  it('reads back every tile byte-equal, and nothing else, for any archive (property)', async () => {
    await fc.assert(
      fc.asyncProperty(arbTiles, fc.boolean(), async (tiles, forceLeaves) => {
        const { bytes } = await writeToMemory(
          asGroups(tiles),
          forceLeaves ? { directories: { maxRoot: 40, firstLeafSize: 3 } } : {},
        );
        const archive = new PMTiles(bytesSource(bytes));
        const header = await archive.getHeader();
        expect(header.specVersion).toBe(3);
        expect(header.clustered).toBe(true);
        expect(header.numAddressedTiles).toBe(tiles.length);
        for (const t of tiles) {
          const [z, x, y] = tileIdToZxy(t.tileId);
          const got = await archive.getZxy(z, x, y);
          expect(got && new Uint8Array(got.data)).toEqual(t.bytes);
        }
        // A tile that isn't in the archive reads as absent, not as a neighbor's bytes.
        const present = new Set(tiles.map((t) => t.tileId));
        for (let id = 0; id < 40; id++) {
          if (present.has(id)) continue;
          const [z, x, y] = tileIdToZxy(id);
          if (z < header.minZoom || z > header.maxZoom) continue;
          expect(await archive.getZxy(z, x, y)).toBeUndefined();
        }
      }),
      { numRuns: 60 },
    );
  });

  it('is clustered: blobs in tile-id order, each new one right after the last, repeats pointing back', async () => {
    await fc.assert(
      fc.asyncProperty(arbTiles, async (tiles) => {
        const { bytes } = await writeToMemory(asGroups(tiles));
        const { entries, header } = await readArchiveEntries(bytesSource(bytes));
        let next = 0;
        expect(entries.offset[0]).toBe(0);
        for (let i = 0; i < entries.count; i++) {
          const offset = entries.offset[i] as number;
          if (offset === next) next += entries.length[i] as number;
          else expect(offset).toBeLessThan(next);
        }
        expect(next).toBe(header.tileDataLength);
      }),
      { numRuns: 40 },
    );
  });

  it('refuses directories holding more entries than the header counts', async () => {
    const tiles = [1, 2, 3].map((tileId) => ({ tileId, bytes: tileBytes(tileId, 5) }));
    const { bytes } = await writeToMemory([{ source: 's', tiles }]);
    new DataView(bytes.buffer).setUint32(80, 2, true);
    await expect(readArchiveEntries(bytesSource(bytes))).rejects.toThrow("than the header's 2");
  });

  it('stores a repeated tile once and addresses it twice', async () => {
    const same = tileBytes(9, 30);
    const tiles = [
      { tileId: zxyToTileId(3, 1, 1), bytes: same },
      { tileId: zxyToTileId(3, 6, 6), bytes: tileBytes(2, 10) },
      { tileId: zxyToTileId(4, 0, 0), bytes: same },
    ].sort((a, b) => a.tileId - b.tileId);
    const { bytes } = await writeToMemory([{ source: 's', tiles }]);
    const header = bytesToHeader(bytes.slice(0, HEADER_BYTES).buffer as ArrayBuffer);
    expect(header.numAddressedTiles).toBe(3);
    expect(header.numTileEntries).toBe(3);
    expect(header.numTileContents).toBe(2);
    expect(header.tileDataLength).toBe(40);
    const archive = new PMTiles(bytesSource(bytes));
    expect(new Uint8Array((await archive.getZxy(4, 0, 0))?.data as ArrayBuffer)).toEqual(same);
  });

  it('runs a repeat at the next id into its entry', async () => {
    const same = tileBytes(4, 12);
    const tiles = [0, 1, 2, 3].map((i) => ({ tileId: 5 + i, bytes: same }));
    const { bytes } = await writeToMemory([{ source: 's', tiles }]);
    const { entries, header } = await readArchiveEntries(bytesSource(bytes));
    expect(entries.count).toBe(1);
    expect(entries.runLength[0]).toBe(4);
    expect(header.numAddressedTiles).toBe(4);
    expect(header.numTileEntries).toBe(1);
  });

  it('keeps the header and root inside the reader’s first 16 KiB, splitting into leaves when it must', async () => {
    // Irregular gaps and lengths, so gzip can't fold 40,000 entries into one root.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return 1 + (seed % n);
    };
    let id = zoomBaseOf(12);
    const tiles = Array.from({ length: 40_000 }, (_, i) => {
      id += rand(300);
      return { tileId: id, bytes: tileBytes(i, rand(200)) };
    });
    const { bytes } = await writeToMemory([{ source: 's', tiles }]);
    const header = bytesToHeader(bytes.slice(0, HEADER_BYTES).buffer as ArrayBuffer);
    expect(header.rootDirectoryOffset + header.rootDirectoryLength).toBeLessThanOrEqual(
      ROOT_FETCH_BYTES,
    );
    const read = await readArchiveEntries(bytesSource(bytes));
    expect(read.leaves).toBeGreaterThan(1);
    expect(read.entries.count).toBe(40_000);
    const archive = new PMTiles(bytesSource(bytes));
    for (const i of [0, 1, 4097, 39_999]) {
      const t = tiles[i] as (typeof tiles)[number];
      const [z, x, y] = tileIdToZxy(t.tileId);
      expect(new Uint8Array((await archive.getZxy(z, x, y))?.data as ArrayBuffer)).toEqual(t.bytes);
    }
  });

  it('writes the metadata the reader returns, and the header fields it reads', async () => {
    const tiles = [{ tileId: zxyToTileId(7, 37, 46), bytes: tileBytes(1, 9) }];
    const { bytes } = await writeToMemory([{ source: 's', tiles }], {
      metadata: { name: 'naip-summer-20261212', type: 'overlay' },
      bounds: { west: -79.76, south: 40.49, east: -66.88, north: 47.46 },
      centerZoom: 9,
    });
    const archive = new PMTiles(bytesSource(bytes));
    expect(await archive.getMetadata()).toEqual({ name: 'naip-summer-20261212', type: 'overlay' });
    const h = await archive.getHeader();
    expect(h).toMatchObject({
      minZoom: 7,
      maxZoom: 7,
      tileType: 4,
      tileCompression: 1,
      internalCompression: 2,
      minLon: -79.76,
      minLat: 40.49,
      maxLon: -66.88,
      maxLat: 47.46,
      centerZoom: 9,
    });
    expect(h.centerLon).toBeCloseTo(-73.32, 6);
    expect(h.centerLat).toBeCloseTo(43.975, 6);
  });
});

function zoomBaseOf(z: number): number {
  return (4 ** z - 1) / 3;
}

describe('the read runs', () => {
  it('reads each source contiguously, never a repeat’s bytes at a run’s ends', () => {
    const same = tileBytes(1, 5);
    const { segments } = packSegments([
      {
        source: 'a',
        tiles: [
          { tileId: 1, bytes: same },
          { tileId: 2, bytes: tileBytes(2, 4) },
          { tileId: 3, bytes: same },
          { tileId: 4, bytes: tileBytes(3, 6) },
          { tileId: 5, bytes: same },
        ],
      },
      { source: 'b', tiles: [{ tileId: 6, bytes: same }] },
    ]);
    const layout = layoutArchive(segments, zoomOf);
    const runs = [...readRuns(layout)];
    expect(runs).toEqual([
      {
        source: 'a',
        tileId: 1,
        offset: 0,
        length: 20,
        cuts: [
          { length: 5, keep: true },
          { length: 4, keep: true },
          { length: 5, keep: false },
          { length: 6, keep: true },
        ],
      },
    ]);
  });

  it('starts a new run where a source’s offsets jump', () => {
    const layout = layoutArchive(
      [
        {
          source: 'old',
          tileId: Float64Array.of(1, 2),
          srcOffset: Float64Array.of(100, 50),
          length: Uint32Array.of(3, 3),
          key: Uint32Array.of(1, 1, 1, 1, 2, 2, 2, 2),
        },
      ],
      zoomOf,
    );
    expect([...readRuns(layout)].map((r) => [r.offset, r.length])).toEqual([
      [100, 3],
      [50, 3],
    ]);
  });

  it('refuses a segment that was never laid out', () => {
    const layout = layoutArchive([], zoomOf);
    layout.segments.push({
      source: 'x',
      tileId: new Float64Array(0),
      srcOffset: new Float64Array(0),
      length: new Uint32Array(0),
      key: new Uint32Array(0),
    });
    expect(() => [...readRuns(layout)]).toThrow('never laid out');
  });
});

describe('the layout’s refusals', () => {
  const one = (tileId: number, length = 1) => ({
    source: 's',
    tileId: Float64Array.of(tileId),
    srcOffset: Float64Array.of(0),
    length: Uint32Array.of(length),
    key: Uint32Array.of(tileId, 0, 0, 0),
  });

  it('refuses tiles out of tile-id order, across segments too', () => {
    expect(() => layoutArchive([one(5), one(5)], zoomOf)).toThrow('not in tile-id order');
    expect(() => layoutArchive([one(6), one(5)], zoomOf)).toThrow('not in tile-id order');
  });

  it('refuses an empty tile', () => {
    expect(() => layoutArchive([one(5, 0)], zoomOf)).toThrow('length 0');
  });

  it('counts per zoom and can release the keys once laid out', () => {
    const layout = layoutArchive([one(0), one(1), one(2)], zoomOf, { releaseKeys: true });
    expect([...layout.perZoom]).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(layout.segments[0]?.key.length).toBe(0);
  });

  it('refuses to plan an empty archive', () => {
    expect(() =>
      planArchive({
        layout: layoutArchive([], zoomOf),
        minZoom: 7,
        maxZoom: 17,
        bounds: { west: 0, south: 0, east: 1, north: 1 },
        centerZoom: 7,
        metadata: {},
      }),
    ).toThrow('at least one tile');
  });
});

describe('the tile data stream', () => {
  it('fetches small runs ahead and streams a large one, in order, with the same bytes', async () => {
    const tiles = Array.from({ length: 30 }, (_, i) => ({
      tileId: 100 + i,
      bytes: tileBytes(i, i === 10 ? 500 : 20),
    }));
    const groups = tiles.map((t, i) => ({ source: `s${i}`, tiles: [t] }));
    const { segments, sources } = packSegments(groups);
    const layout = layoutArchive(segments, zoomOf);
    let streamed = 0;
    const reader = {
      read: async (s: string, o: number, l: number) =>
        (sources.get(s) as Uint8Array).slice(o, o + l),
      async *stream(s: string, o: number, l: number) {
        streamed++;
        const buf = sources.get(s) as Uint8Array;
        for (let at = o; at < o + l; at += 64) yield buf.slice(at, Math.min(at + 64, o + l));
      },
    };
    const out: Uint8Array[] = [];
    for await (const { chunk } of tileData(layout, reader, {
      prefetchRunBytes: 100,
      prefetchBytes: 60,
      prefetchRuns: 4,
    })) {
      out.push(chunk);
    }
    expect(streamed).toBe(1);
    expect(Buffer.concat(out)).toEqual(Buffer.concat(tiles.map((t) => t.bytes)));
  });

  it('throws when a source answers short or long', async () => {
    const { segments } = packSegments([
      { source: 's', tiles: [{ tileId: 1, bytes: tileBytes(1, 10) }] },
    ]);
    const layout = layoutArchive(segments, zoomOf);
    const drain = async (bytes: Uint8Array) => {
      const reader = { read: async () => bytes, async *stream() {} };
      for await (const _ of tileData(layout, reader)) {
        // drained
      }
    };
    await expect(drain(new Uint8Array(4))).rejects.toThrow('ended short');
    await expect(drain(new Uint8Array(14))).rejects.toThrow('more bytes than');
  });

  it('surfaces a failed prefetch when its turn comes', async () => {
    const { segments } = packSegments([
      { source: 'a', tiles: [{ tileId: 1, bytes: tileBytes(1, 3) }] },
      { source: 'b', tiles: [{ tileId: 2, bytes: tileBytes(2, 3) }] },
    ]);
    const layout = layoutArchive(segments, zoomOf);
    const reader = {
      read: async (s: string) => {
        if (s === 'b') throw new Error('gone');
        return tileBytes(1, 3);
      },
      async *stream() {},
    };
    const got: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const { chunk } of tileData(layout, reader)) got.push(chunk);
      })(),
    ).rejects.toThrow('gone');
    expect(got).toHaveLength(1);
  });
});
