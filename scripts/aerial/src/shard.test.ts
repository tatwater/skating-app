import fc from 'fast-check';
import { zxyToTileId } from 'pmtiles';
import { describe, expect, test } from 'vitest';
import {
  checkShardIndex,
  parseShardDone,
  SHARD_TILE_ZOOMS,
  type ShardDone,
  shardLanded,
  tileInWorkTile,
} from './shard';

const TILE = { z: 11, x: 610, y: 742 };
const HASH = 'a'.repeat(64);

/** A valid index over the given (z, x, y) tiles, with lengths 1, 2, 3, … */
function indexOf(tiles: [number, number, number][]) {
  let offset = 0;
  const entries = tiles
    .map(([z, x, y]) => zxyToTileId(z, x, y))
    .sort((a, b) => a - b)
    .map((tileId, i) => {
      const entry = { tileId, offset, length: i + 1, sha256: HASH };
      offset += i + 1;
      return entry;
    });
  return { json: { version: 1, workTile: '11/610/742', entries }, bytes: offset };
}

const GOOD = indexOf([
  [11, 610, 742],
  [12, 1220, 1484],
  [12, 1221, 1485],
  [17, 610 * 64 + 63, 742 * 64],
]);

describe('the shard zooms', () => {
  test('a shard holds archive tile zooms 11–17', () => {
    expect(SHARD_TILE_ZOOMS).toEqual({ min: 11, max: 17 });
  });
});

describe('tileInWorkTile', () => {
  test('every descendant of the work tile at a shard zoom is in it, and no other tile', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 17 }),
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        (z, a, b, inside) => {
          const side = 2 ** (z - 11);
          const x = inside ? TILE.x * side + (a % side) : a % 2 ** z;
          const y = inside ? TILE.y * side + (b % side) : b % 2 ** z;
          const expected = Math.floor(x / side) === TILE.x && Math.floor(y / side) === TILE.y;
          expect(tileInWorkTile(zxyToTileId(z, x, y), TILE)).toBe(expected);
        },
      ),
    );
  });

  test('a tile above or below the shard zooms is never in it', () => {
    expect(tileInWorkTile(zxyToTileId(10, 305, 371), TILE)).toBe(false);
    expect(tileInWorkTile(zxyToTileId(18, 610 * 128, 742 * 128), TILE)).toBe(false);
  });
});

describe('checkShardIndex', () => {
  test('passes a valid index, and checks it against the pack length', () => {
    expect(checkShardIndex(GOOD.json, GOOD.bytes).entries).toHaveLength(4);
    expect(checkShardIndex(GOOD.json).workTile).toBe('11/610/742');
  });

  test('an empty work tile is a valid shard', () => {
    expect(checkShardIndex({ version: 1, workTile: '11/0/0', entries: [] }, 0).entries).toEqual([]);
  });

  const entries = GOOD.json.entries;
  const at = (i: number, patch: object) =>
    entries.map((e, j) => (j === i ? { ...e, ...patch } : e));

  test.each([
    ['not an object', null, /not an object/],
    ['an array', [], /not an object/],
    ['another version', { ...GOOD.json, version: 2 }, /version 2/],
    ['no work tile', { ...GOOD.json, workTile: undefined }, /no work tile/],
    ['a bad work tile', { ...GOOD.json, workTile: '12/1/1' }, /z11, not z12/],
    ['no entries', { ...GOOD.json, entries: undefined }, /no entries/],
    ['an entry not an object', { ...GOOD.json, entries: [7] }, /entry 0: not an object/],
    ['a negative id', { ...GOOD.json, entries: at(0, { tileId: -1 }) }, /tile id -1/],
    [
      'ids out of order',
      {
        ...GOOD.json,
        entries: [
          { ...entries[1], offset: 0 },
          { ...entries[0], offset: 2 },
        ],
      },
      /not ascending/,
    ],
    [
      'a duplicated id',
      { ...GOOD.json, entries: [entries[0], { ...entries[0], offset: 1 }] },
      /not ascending/,
    ],
    [
      "a neighbor's tile",
      { ...GOOD.json, entries: [{ ...entries[0], tileId: zxyToTileId(11, 611, 742) }] },
      /is not in 11\/610\/742/,
    ],
    [
      'a gap in the offsets',
      { ...GOOD.json, entries: at(1, { offset: 5 }) },
      /offset 5, expected 1/,
    ],
    ['a zero length', { ...GOOD.json, entries: at(3, { length: 0 }) }, /length 0/],
    ['a fractional length', { ...GOOD.json, entries: at(3, { length: 1.5 }) }, /length 1.5/],
    ['a short hash', { ...GOOD.json, entries: at(2, { sha256: 'abc' }) }, /not 64 hex/],
    ['an uppercase hash', { ...GOOD.json, entries: at(2, { sha256: 'A'.repeat(64) }) }, /64 hex/],
  ])('refuses %s', (_, json, message) => {
    expect(() => checkShardIndex(json)).toThrow(message);
  });

  test('refuses entries that end before or after the pack', () => {
    expect(() => checkShardIndex(GOOD.json, GOOD.bytes + 1)).toThrow(/entries end at 10/);
    expect(() => checkShardIndex(GOOD.json, GOOD.bytes - 1)).toThrow(/the pack is 9 bytes/);
  });
});

const DONE: ShardDone = {
  version: 1,
  campaign: 'naip-20261212',
  workTile: '11/610/742',
  inputHash: 'h1',
  image: `registry.fly.io/skating-imagery:aerial@sha256:${'b'.repeat(64)}`,
  tiles: 4,
  bytes: 10,
  packSha256: HASH,
  timings: { warp: 1200, tile: 300_000, count: 900, pack: 50, upload: 4000 },
  cellCounts: {
    '4507264sw': { vt_m_4507264_sw_18_030_20250920: 9000 },
    '4507264se': { vt_m_4507264_se_18_030_20250920: 100, ny_m_4507264_se_18_060_20240702: 7 },
  },
  finishedAt: '2026-12-12T15:04:05.000Z',
};

describe('parseShardDone', () => {
  test('reads a valid record back unchanged', () => {
    expect(parseShardDone(JSON.parse(JSON.stringify(DONE)))).toEqual(DONE);
  });

  test('a work tile with no cells pixels is a valid record', () => {
    expect(parseShardDone({ ...DONE, tiles: 0, bytes: 0, cellCounts: {} }).tiles).toBe(0);
  });

  test.each([
    ['not an object', 'x', /not an object/],
    ['another version', { ...DONE, version: 0 }, /version 0/],
    ['no campaign', { ...DONE, campaign: 1 }, /no campaign/],
    ['a bad campaign', { ...DONE, campaign: 'naip-1' }, /is not naip-/],
    ['no work tile', { ...DONE, workTile: undefined }, /no work tile/],
    ['a bad work tile', { ...DONE, workTile: '11/x/1' }, /not a work tile key/],
    ['no input hash', { ...DONE, inputHash: '' }, /no input hash/],
    [
      'a floating image tag',
      { ...DONE, image: 'registry.fly.io/skating-imagery:aerial' },
      /digest/,
    ],
    ['negative tiles', { ...DONE, tiles: -1 }, /tiles -1/],
    ['fractional bytes', { ...DONE, bytes: 0.5 }, /bytes 0.5/],
    ['a bad pack hash', { ...DONE, packSha256: 'x' }, /pack sha256/],
    ['no timings', { ...DONE, timings: [] }, /no timings/],
    ['a negative timing', { ...DONE, timings: { warp: -1 } }, /timing warp/],
    ['a non-finite timing', { ...DONE, timings: { warp: null } }, /timing warp/],
    ['no cell counts', { ...DONE, cellCounts: null }, /no cell counts/],
    ['a bad cell key', { ...DONE, cellCounts: { '11/1/1': { a: 1 } } }, /is not a cell key/],
    ['a cell naming no frame', { ...DONE, cellCounts: { '4507264sw': {} } }, /names no frame/],
    ['an empty item id', { ...DONE, cellCounts: { '4507264sw': { '': 1 } } }, /empty item id/],
    ['a zero count', { ...DONE, cellCounts: { '4507264sw': { a: 0 } } }, /count 0/],
    ['a fractional count', { ...DONE, cellCounts: { '4507264sw': { a: 1.5 } } }, /count 1.5/],
    ['no finish', { ...DONE, finishedAt: 'later' }, /not an instant/],
  ])('refuses %s', (_, json, message) => {
    expect(() => parseShardDone(json)).toThrow(message);
  });
});

describe('shardLanded', () => {
  const expected = { campaign: DONE.campaign, workTile: DONE.workTile, inputHash: 'h1' };

  test("a done record carrying the manifest's input hash has landed", () => {
    expect(shardLanded(DONE, expected)).toBe(true);
  });

  test('presence is never landed: no record, a stale hash, another tile or campaign', () => {
    expect(shardLanded(null, expected)).toBe(false);
    expect(shardLanded(DONE, { ...expected, inputHash: 'h2' })).toBe(false);
    expect(shardLanded(DONE, { ...expected, workTile: '11/610/743' })).toBe(false);
    expect(shardLanded(DONE, { ...expected, campaign: 'naip-20261213' })).toBe(false);
  });

  test('landed exactly when every field the manifest names matches (a property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (cut, want) => {
        const done = { ...DONE, inputHash: cut };
        expect(shardLanded(done, { ...expected, inputHash: want })).toBe(cut === want);
      }),
    );
  });
});
