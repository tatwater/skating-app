import fc from 'fast-check';
import { readVarint, tileIdToZxy, zxyToTileId } from 'pmtiles';
import { describe, expect, it } from 'vitest';
import { ContentTable, contentKey } from './contentTable';
import {
  ByteWriter,
  buildDirectories,
  entryColumns,
  type PmtilesHeader,
  serializeDirectory,
  serializeHeader,
} from './pmtiles';
import { prng } from './prng';
import {
  parentTileId,
  tileBox,
  workTileIdRange,
  workTileOf,
  workTilesBox,
  worldPixel,
  zoomBase,
} from './tileGrid';

describe('varints, against the reader’s own decoder', () => {
  it('round-trips any safe non-negative integer (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.maxSafeNat(), { minLength: 1, maxLength: 20 }), (values) => {
        const w = new ByteWriter(1);
        for (const v of values) w.varint(v);
        const p = { buf: w.bytes(), pos: 0 };
        for (const v of values) expect(readVarint(p)).toBe(v);
        expect(p.pos).toBe(w.length);
      }),
    );
  });

  it('writes the protobuf bytes at the boundaries', () => {
    const enc = (v: number) => {
      const w = new ByteWriter();
      w.varint(v);
      return [...w.bytes()];
    };
    expect(enc(0)).toEqual([0]);
    expect(enc(127)).toEqual([127]);
    expect(enc(128)).toEqual([0x80, 1]);
    expect(enc(300)).toEqual([0xac, 0x02]);
    expect(enc(2 ** 31)).toEqual([0x80, 0x80, 0x80, 0x80, 0x08]);
  });

  it('refuses what a varint can’t hold', () => {
    const w = new ByteWriter();
    expect(() => w.varint(-1)).toThrow('non-negative');
    expect(() => w.varint(1.5)).toThrow('non-negative');
    expect(() => w.varint(2 ** 53)).toThrow('non-negative');
  });
});

describe('the header', () => {
  const header: PmtilesHeader = {
    rootDirectoryOffset: 127,
    rootDirectoryLength: 10,
    jsonMetadataOffset: 137,
    jsonMetadataLength: 5,
    leafDirectoryOffset: 142,
    leafDirectoryLength: 0,
    tileDataOffset: 142,
    tileDataLength: 2 ** 40 + 3,
    numAddressedTiles: 1,
    numTileEntries: 1,
    numTileContents: 1,
    clustered: true,
    internalCompression: 2,
    tileCompression: 1,
    tileType: 4,
    minZoom: 7,
    maxZoom: 17,
    minLon: -79.7625,
    minLat: 40.4961,
    maxLon: -66.8854,
    maxLat: 47.4598,
    centerZoom: 9,
    centerLon: -73.3,
    centerLat: 44,
  };

  it('starts with the whole magic and version 3, and holds a uint64 past 2^32', () => {
    const bytes = serializeHeader(header);
    expect(bytes.length).toBe(127);
    expect(new TextDecoder().decode(bytes.slice(0, 7))).toBe('PMTiles');
    expect(bytes[7]).toBe(3);
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(64, true) + v.getUint32(68, true) * 2 ** 32).toBe(2 ** 40 + 3);
  });

  it('refuses fields it can’t encode', () => {
    expect(() => serializeHeader({ ...header, maxZoom: 6 })).toThrow('under min zoom');
    expect(() => serializeHeader({ ...header, tileDataLength: -1 })).toThrow('uint64');
    expect(() => serializeHeader({ ...header, tileType: 256 })).toThrow('not a byte');
    expect(() => serializeHeader({ ...header, minLon: 400 })).toThrow('out of range');
  });
});

describe('directories', () => {
  const cols = (rows: [number, number, number, number][]) => {
    const c = entryColumns(rows.length);
    rows.forEach(([id, offset, length, run], i) => {
      c.tileId[i] = id;
      c.offset[i] = offset;
      c.length[i] = length;
      c.runLength[i] = run;
    });
    c.count = rows.length;
    return c;
  };

  it('encodes the spec’s fields: deltas, runs, lengths, offset+1 or 0 for contiguous', () => {
    const bytes = serializeDirectory(
      cols([
        [5, 0, 10, 1],
        [42, 10, 4, 2],
        [69, 0, 10, 1],
      ]),
    );
    const p = { buf: bytes, pos: 0 };
    const read = () => readVarint(p);
    expect(Array.from({ length: 13 }, read)).toEqual([3, 5, 37, 27, 1, 2, 1, 10, 4, 10, 1, 0, 1]);
  });

  it('refuses an empty directory, ids that don’t climb, and an empty tile', () => {
    expect(() => serializeDirectory(cols([]))).toThrow('at least one entry');
    expect(() =>
      serializeDirectory(
        cols([
          [5, 0, 1, 1],
          [5, 1, 1, 1],
        ]),
      ),
    ).toThrow('ascending');
    expect(() => serializeDirectory(cols([[5, 0, 0, 1]]))).toThrow('length 0');
  });

  it('refuses a root no leaf split can fit, and an empty archive', () => {
    const many = cols(
      Array.from(
        { length: 50 },
        (_, i) => [i * 7, i * 3, 3, 1] as [number, number, number, number],
      ),
    );
    expect(() => buildDirectories(many, { maxRoot: 5, firstLeafSize: 10 })).toThrow(
      'no leaf size fits',
    );
    expect(() => buildDirectories(cols([]))).toThrow('at least one tile');
  });
});

describe('the dedupe table', () => {
  it('answers like a Map over any keys, across growth (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[0-9a-f]{64}$/), { maxLength: 300 }),
        (hashes) => {
          const table = new ContentTable(4);
          hashes.forEach((h, i) => {
            expect(table.get(contentKey(h))).toBeUndefined();
            table.set(contentKey(h), 0, i * 10);
          });
          hashes.forEach((h, i) => {
            expect(table.get(contentKey(h))).toBe(i * 10);
          });
          expect(table.size).toBe(hashes.length);
          expect(table.size / table.capacity).toBeLessThanOrEqual(0.7);
        },
      ),
    );
  });

  it('grows past its first capacity and keeps every key', () => {
    const table = new ContentTable(1);
    // Keys differ in their first 128 bits, the part the table keys on.
    const hex = (i: number) => i.toString(16).padStart(8, '0').repeat(8);
    for (let i = 0; i < 5000; i++) table.set(contentKey(hex(i)), 0, i);
    for (let i = 0; i < 5000; i++) expect(table.get(contentKey(hex(i)))).toBe(i);
    expect(table.capacity).toBeGreaterThanOrEqual(5000 / 0.7);
  });

  it('keeps keys that share a first word apart (a probe collision)', () => {
    const a = `00000001${'a'.repeat(56)}`;
    const b = `00000001${'b'.repeat(56)}`;
    const table = new ContentTable();
    table.set(contentKey(a), 0, 1);
    table.set(contentKey(b), 0, 2);
    expect(table.get(contentKey(a))).toBe(1);
    expect(table.get(contentKey(b))).toBe(2);
  });

  it('refuses a key twice, a negative offset, and a malformed hash', () => {
    const table = new ContentTable();
    const k = contentKey('c'.repeat(64));
    table.set(k, 0, 0);
    expect(() => table.set(k, 0, 1)).toThrow('already present');
    expect(() => table.set(contentKey('d'.repeat(64)), 0, -1)).toThrow('negative');
    expect(() => contentKey('xyz')).toThrow('not a hex sha256');
  });
});

describe('the tile grid', () => {
  it('a work tile’s descendants at any zoom are one run of ids (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2047 }),
        fc.integer({ min: 0, max: 2047 }),
        fc.integer({ min: 0, max: 4 }),
        (x, y, k) => {
          const z = 11 + k;
          const [first, count] = workTileIdRange({ z: 11, x, y }, z);
          expect(count).toBe(4 ** k);
          const ids = [];
          for (let dx = 0; dx < 2 ** k; dx++) {
            for (let dy = 0; dy < 2 ** k; dy++)
              ids.push(zxyToTileId(z, (x << k) + dx, (y << k) + dy));
          }
          ids.sort((a, b) => a - b);
          expect(ids[0]).toBe(first);
          expect(ids[ids.length - 1]).toBe(first + count - 1);
          for (const id of ids) expect(workTileOf(id)).toEqual({ z: 11, x, y });
        },
      ),
      { numRuns: 60 },
    );
  });

  it('refuses zooms above the work tile, and the root’s parent', () => {
    expect(() => workTileIdRange({ z: 11, x: 0, y: 0 }, 10)).toThrow('above');
    expect(() => workTileOf(zxyToTileId(10, 0, 0))).toThrow('above the work zoom');
    expect(() => parentTileId(0)).toThrow('no parent');
  });

  it('finds parents, ground and pixels', () => {
    expect(tileIdToZxy(parentTileId(zxyToTileId(5, 9, 13)))).toEqual([4, 4, 6]);
    expect(zoomBase(2)).toBe(5);
    const box = tileBox(1, 0, 0);
    expect(box.west).toBe(-180);
    expect(box.east).toBe(0);
    expect(box.north).toBeCloseTo(85.0511, 3);
    expect(box.south).toBeCloseTo(0, 9);
    expect(worldPixel(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(workTilesBox([])).toBeNull();
    const union = workTilesBox([
      { z: 11, x: 603, y: 731 },
      { z: 11, x: 604, y: 732 },
    ]);
    expect(union?.west).toBeCloseTo(tileBox(11, 603, 731).west, 9);
    expect(union?.south).toBeCloseTo(tileBox(11, 604, 732).south, 9);
  });

  it('draws the same noise from the same seed', () => {
    const a = prng(42);
    const b = prng(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});
