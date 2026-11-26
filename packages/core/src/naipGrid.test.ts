import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  isQuarterQuadKey,
  NAIP_ENVELOPE_MARGIN,
  NAIP_MAX_ZOOM,
  NAIP_MIN_ZOOM,
  NAIP_REGION,
  NAIP_STATE_ENVELOPES,
  NAIP_TILE_SIZE,
  NAIP_WORK_ZOOM,
  naipTileZoom,
  parseWorkTileKey,
  quarterQuadAt,
  quarterQuadCell,
  quarterQuadInState,
  quarterQuadsIn,
  type WorkTile,
  workTileKey,
  workTilesOf,
} from './naipGrid';
import type { NaipState } from './naipSelection';

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

// ── The quarter-quad grid ─────────────────────────────────────────────────────────────────────────

const FIXTURE: NaipFixtureRow[] = readFileSync(
  new URL('./fixtures/naipInventory.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as NaipFixtureRow);

interface NaipFixtureRow {
  itemId: string;
  key: string;
  state: NaipState;
  acquired: string;
  gsd: number;
  year: number;
  bbox: [number, number, number, number];
}

/** A point anywhere in the grid's domain over the region, at full float resolution. */
const regionPoint = fc.record({
  lat: fc.double({ min: NAIP_REGION.minLat, max: NAIP_REGION.maxLat, noNaN: true }),
  lng: fc.double({ min: NAIP_REGION.minLng, max: NAIP_REGION.maxLng, noNaN: true }),
});

describe('quarterQuadCell', () => {
  test.each([
    // The scouts' first Vermont item: 4507264sw, centered 45.03125, -72.09373.
    ['4507264sw', { minLat: 45, minLng: -72.125, maxLat: 45.0625, maxLng: -72.0625 }],
    // Quad 1 is the block's north-west corner.
    ['4407301nw', { minLat: 44.9375, minLng: -74, maxLat: 45, maxLng: -73.9375 }],
    // Quad 36, quadrant SE: row 4, column 3.
    ['4407236se', { minLat: 44.375, minLng: -72.5625, maxLat: 44.4375, maxLng: -72.5 }],
    // A three-digit longitude.
    ['4207901ne', { minLat: 42.9375, minLng: -79.9375, maxLat: 43, maxLng: -79.875 }],
  ])('%s is exact from its key', (key, cell) => {
    expect(quarterQuadCell(key)).toEqual(cell);
  });

  test.each(['', '4407236', '4407236xx', '4407200se', '4407265se', '440723se', '4407236SE'])(
    'refuses %j',
    (key) => {
      expect(() => quarterQuadCell(key)).toThrow();
      expect(isQuarterQuadKey(key)).toBe(false);
    },
  );

  test("sits inside every catalog footprint of the fixture, never past it (the frame's overlap)", () => {
    for (const row of FIXTURE) {
      const cell = quarterQuadCell(row.key);
      const [w, s, e, n] = row.bbox;
      expect(cell.minLng).toBeGreaterThan(w);
      expect(cell.minLat).toBeGreaterThan(s);
      expect(cell.maxLng).toBeLessThan(e);
      expect(cell.maxLat).toBeLessThan(n);
    }
  });
});

describe('quarterQuadAt', () => {
  test('names the cell whose outline holds the point (a property over the region)', () => {
    fc.assert(
      fc.property(regionPoint, ({ lat, lng }) => {
        const cell = quarterQuadCell(quarterQuadAt(lat, lng));
        expect(lat).toBeGreaterThanOrEqual(cell.minLat);
        expect(lat).toBeLessThan(cell.maxLat);
        expect(lng).toBeGreaterThanOrEqual(cell.minLng);
        expect(lng).toBeLessThan(cell.maxLng);
      }),
    );
  });

  test('round-trips every cell through its middle and its south-west corner', () => {
    fc.assert(
      fc.property(regionPoint, ({ lat, lng }) => {
        const key = quarterQuadAt(lat, lng);
        const cell = quarterQuadCell(key);
        expect(quarterQuadAt(cell.minLat, cell.minLng)).toBe(key);
        expect(
          quarterQuadAt((cell.minLat + cell.maxLat) / 2, (cell.minLng + cell.maxLng) / 2),
        ).toBe(key);
      }),
    );
  });

  test('an edge belongs to the cell north and east of it, only', () => {
    expect(quarterQuadAt(45, -72.0625)).toBe('4507264se');
    expect(quarterQuadAt(44.9999999, -72.0625)).toBe('4407208ne');
    // The 1° block's own corner.
    expect(quarterQuadAt(45, -72)).toBe('4507157sw');
  });

  test.each([
    [-1, -72],
    [44, 1],
    [Number.NaN, -72],
    [44, Number.POSITIVE_INFINITY],
    [100.5, -72],
  ])('refuses %d, %d (no key there)', (lat, lng) => {
    expect(() => quarterQuadAt(lat, lng)).toThrow(/no quarter-quad/);
  });
});

describe('the states and the region', () => {
  test("every fixture frame lies in its labeled state's envelope, but the mislabeled Maine 2025", () => {
    let mislabeled = 0;
    for (const row of FIXTURE) {
      const isMislabeled = row.state === 'ME' && row.year === 2025;
      if (isMislabeled) mislabeled++;
      expect(quarterQuadInState(row.key, row.state)).toBe(!isMislabeled);
    }
    expect(mislabeled).toBe(744);
  });

  test("a cell short of a state's grown envelope is outside it; one reaching into it is in", () => {
    // Maine's envelope starts at 42°58′; grown by 1′ it starts at 42°57′ = 42.95. The row below,
    // 42.875–42.9375, is outside it; the row above, 42.9375–43, reaches in.
    expect(quarterQuadInState('4207003sw', 'ME')).toBe(false);
    expect(quarterQuadInState('4207003se', 'ME')).toBe(false);
    expect(quarterQuadInState('4207003nw', 'ME')).toBe(true);
    expect(quarterQuadInState('4207003nw', 'NH')).toBe(true);
    expect(quarterQuadInState('4207003nw', 'NY')).toBe(false);
  });

  test("a state's own flight just past its envelope is kept by the margin", () => {
    // Vermont flies 4407361sw on Champlain's New York shore, whose east edge is 0.25′ west of
    // Vermont's 73°26′W: the catalog's furthest real reach past an envelope.
    const cell = quarterQuadCell('4407361sw');
    expect(NAIP_STATE_ENVELOPES.VT.minLng - cell.maxLng).toBeCloseTo(0.25 / 60, 6);
    expect(quarterQuadInState('4407361sw', 'VT')).toBe(true);
  });

  test('the region holds every envelope, out to whole cells', () => {
    for (const env of Object.values(NAIP_STATE_ENVELOPES)) {
      expect(env.minLat - NAIP_ENVELOPE_MARGIN).toBeGreaterThanOrEqual(NAIP_REGION.minLat);
      expect(env.maxLat + NAIP_ENVELOPE_MARGIN).toBeLessThanOrEqual(NAIP_REGION.maxLat);
      expect(env.minLng - NAIP_ENVELOPE_MARGIN).toBeGreaterThanOrEqual(NAIP_REGION.minLng);
      expect(env.maxLng + NAIP_ENVELOPE_MARGIN).toBeLessThanOrEqual(NAIP_REGION.maxLng);
    }
    for (const v of Object.values(NAIP_REGION)) expect(Number.isInteger(v * 16)).toBe(true);
  });
});

describe('quarterQuadsIn', () => {
  /** Bounds anywhere over (and a little past) the region, from a point to ~2° on a side. */
  const bounds = fc
    .record({
      lat: fc.double({ min: NAIP_REGION.minLat - 1, max: NAIP_REGION.maxLat + 1, noNaN: true }),
      lng: fc.double({ min: NAIP_REGION.minLng - 1, max: NAIP_REGION.maxLng + 1, noNaN: true }),
      h: fc.double({ min: 0, max: 2, noNaN: true }),
      w: fc.double({ min: 0, max: 2, noNaN: true }),
    })
    .map(({ lat, lng, h, w }) => ({ minLat: lat, minLng: lng, maxLat: lat + h, maxLng: lng + w }));

  const inRegion = (lat: number, lng: number) =>
    lat >= NAIP_REGION.minLat &&
    lat < NAIP_REGION.maxLat &&
    lng >= NAIP_REGION.minLng &&
    lng < NAIP_REGION.maxLng;

  test('any point in the bounds and the region has its key in the set (a property)', () => {
    fc.assert(
      fc.property(
        bounds,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (b, u, v) => {
          const keys = new Set(quarterQuadsIn(b));
          // Corners and edges included: u and v reach 0 and 1.
          const lat = b.minLat + (b.maxLat - b.minLat) * u;
          const lng = b.minLng + (b.maxLng - b.minLng) * v;
          if (inRegion(lat, lng)) expect(keys.has(quarterQuadAt(lat, lng))).toBe(true);
          for (const [la, ln] of [
            [b.minLat, b.minLng],
            [b.maxLat, b.maxLng],
            [b.minLat, b.maxLng],
            [b.maxLat, b.minLng],
          ] as const) {
            if (inRegion(la, ln)) expect(keys.has(quarterQuadAt(la, ln))).toBe(true);
          }
        },
      ),
    );
  });

  test('lists no cell the bounds miss, once each, sorted (a property)', () => {
    fc.assert(
      fc.property(bounds, (b) => {
        const keys = quarterQuadsIn(b);
        expect(new Set(keys).size).toBe(keys.length);
        expect([...keys].sort()).toEqual(keys);
        for (const key of keys) {
          const cell = quarterQuadCell(key);
          // Closed bounds against a half-open cell: the bounds reach into it, or end on its south
          // or west edge (whose points are the cell's).
          expect(cell.minLat).toBeLessThanOrEqual(b.maxLat);
          expect(cell.maxLat).toBeGreaterThan(b.minLat);
          expect(cell.minLng).toBeLessThanOrEqual(b.maxLng);
          expect(cell.maxLng).toBeGreaterThan(b.minLng);
        }
      }),
    );
  });

  test('a view inside one cell is that cell; bounds on its north-east corner add the cells there', () => {
    expect(quarterQuadsIn({ minLat: 45.01, minLng: -72.1, maxLat: 45.02, maxLng: -72.09 })).toEqual(
      ['4507264sw'],
    );
    expect(
      quarterQuadsIn({ minLat: 45.01, minLng: -72.1, maxLat: 45.0625, maxLng: -72.0625 }),
    ).toEqual(['4507264ne', '4507264nw', '4507264se', '4507264sw']);
  });

  test('bounds past the region list nothing; bounds across its edge are clipped to it', () => {
    expect(quarterQuadsIn({ minLat: 10, minLng: -100, maxLat: 11, maxLng: -99 })).toEqual([]);
    expect(quarterQuadsIn({ minLat: 45, minLng: -72, maxLat: 44, maxLng: -71 })).toEqual([]);
    const whole = quarterQuadsIn({ minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 });
    const rows = (NAIP_REGION.maxLat - NAIP_REGION.minLat) * 16;
    const cols = (NAIP_REGION.maxLng - NAIP_REGION.minLng) * 16;
    expect(whole).toHaveLength(rows * cols);
  });
});

describe('workTilesOf', () => {
  const tileBounds = (t: WorkTile) => {
    const n = 2 ** t.z;
    const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    return {
      minLng: (t.x / n) * 360 - 180,
      maxLng: ((t.x + 1) / n) * 360 - 180,
      maxLat: lat(t.y),
      minLat: lat(t.y + 1),
    };
  };

  test('the tiles cover the cell, each sharing area with it, sorted (a property)', () => {
    fc.assert(
      fc.property(regionPoint, ({ lat, lng }) => {
        const key = quarterQuadAt(lat, lng);
        const cell = quarterQuadCell(key);
        const tiles = workTilesOf(key);
        expect(tiles.map(workTileKey)).toEqual(tiles.map(workTileKey).sort());
        for (const t of tiles) {
          expect(t.z).toBe(NAIP_WORK_ZOOM);
          const b = tileBounds(t);
          expect(b.minLng).toBeLessThan(cell.maxLng);
          expect(b.maxLng).toBeGreaterThan(cell.minLng);
          expect(b.minLat).toBeLessThan(cell.maxLat);
          expect(b.maxLat).toBeGreaterThan(cell.minLat);
        }
        // Every corner of the cell, nudged inside it, is on one of the tiles.
        const e = 1e-7;
        for (const [la, ln] of [
          [cell.minLat + e, cell.minLng + e],
          [cell.maxLat - e, cell.maxLng - e],
          [cell.minLat + e, cell.maxLng - e],
          [cell.maxLat - e, cell.minLng + e],
        ] as const) {
          expect(
            tiles.some((t) => {
              const b = tileBounds(t);
              return la >= b.minLat && la < b.maxLat && ln >= b.minLng && ln < b.maxLng;
            }),
          ).toBe(true);
        }
      }),
    );
  });

  test('sorts by key, not by number: x 999 before x 1000 would not be', () => {
    // A cell west of Greenwich straddling x = 1000 (the grid names it; the archive never holds it).
    const tiles = workTilesOf(quarterQuadAt(50.01, -4.2));
    expect(tiles.map((t) => t.x)).toEqual([1000, 999]);
  });

  test('a cell edge on a tile edge reaches only its own side (−73.125° is both)', () => {
    // x = (−73.125 + 180) / 360 · 2048 = 608 exactly.
    const west = workTilesOf(quarterQuadAt(44.01, -73.13)); // the cell ending at −73.125
    const east = workTilesOf(quarterQuadAt(44.01, -73.12)); // the cell starting there
    expect(west.map((t) => t.x)).not.toContain(608);
    expect(east.every((t) => t.x === 608)).toBe(true);
  });
});
