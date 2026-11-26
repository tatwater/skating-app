import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  NAIP_MAX_ZOOM,
  NAIP_MIN_ZOOM,
  NAIP_TILE_SIZE,
  NAIP_WORK_ZOOM,
  naipTileZoom,
  parseWorkTileKey,
  workTileKey,
} from './naipGrid';

const SPAN = 2 ** NAIP_WORK_ZOOM;

describe('the archive zooms', () => {
  test('pixel zooms 8–18 (D317) are tile zooms 7–17 at 512 px', () => {
    expect(NAIP_TILE_SIZE).toBe(512);
    expect(naipTileZoom(NAIP_MIN_ZOOM)).toBe(7);
    expect(naipTileZoom(NAIP_MAX_ZOOM)).toBe(17);
    // The work tile's own level is in its shard; the levels below it are the assembler's overviews.
    expect(naipTileZoom(NAIP_WORK_ZOOM + 1)).toBe(NAIP_WORK_ZOOM);
  });
});

describe('workTileKey', () => {
  test('names a z11 tile 11/x/y', () => {
    expect(workTileKey({ z: 11, x: 610, y: 742 })).toBe('11/610/742');
  });

  test('refuses a tile at another zoom', () => {
    expect(() => workTileKey({ z: 12, x: 1, y: 1 })).toThrow(/z11, not z12/);
  });

  test.each([
    [{ z: 11, x: -1, y: 0 }, /x -1/],
    [{ z: 11, x: SPAN, y: 0 }, /x 2048/],
    [{ z: 11, x: 0, y: 1.5 }, /y 1.5/],
    [{ z: 11, x: 0, y: SPAN }, /y 2048/],
  ])('refuses an index off the grid: %o', (tile, message) => {
    expect(() => workTileKey(tile)).toThrow(message);
  });

  test('round-trips through parseWorkTileKey for every tile on the grid', () => {
    fc.assert(
      fc.property(fc.nat(SPAN - 1), fc.nat(SPAN - 1), (x, y) => {
        const tile = { z: NAIP_WORK_ZOOM, x, y };
        expect(parseWorkTileKey(workTileKey(tile))).toEqual(tile);
      }),
    );
  });
});

describe('parseWorkTileKey', () => {
  test.each([
    '11/1',
    '11/1/2/3',
    'z11/1/2',
    '11/-1/2',
    '11/01/2', // workTileKey never pads, so a padded key is someone else's
    '12/1/2',
    '11/2048/0',
    '',
  ])('refuses %j', (key) => {
    expect(() => parseWorkTileKey(key)).toThrow();
  });
});
