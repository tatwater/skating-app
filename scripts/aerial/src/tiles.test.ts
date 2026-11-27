import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NaipManifest, NaipManifestCell } from '@skating/core';
import * as core from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ShardDone } from './shard';
import {
  type AerialWorkUnit,
  boxesOverlap,
  buildWorkUnit,
  type CellOutline,
  chunksOf,
  framesToCut,
  heartbeatDue,
  MERCATOR_ORIGIN,
  type MercatorBounds,
  pixelExtent,
  reconcileShards,
  runTileRounds,
  selectUploads,
  TILE_SETTINGS,
  tileBounds,
  tileResolution,
  tilesScope,
  toMercator,
  unitFileName,
  workUnitsFor,
} from './tiles';

/**
 * The warp proof's hand decode of a quarter-quad key (`proofs/windows.json` was written with it).
 * The units below use core's own grid, the one a build uses; this decode is kept to show the two
 * agree, so the proof's windows are the cells a build cuts.
 */
const handDecode: CellOutline = (key) => {
  const lat = Number(key.slice(0, 2));
  const lon = Number(key.slice(2, 5));
  const q = Number(key.slice(5, 7));
  const row = Math.floor((q - 1) / 8);
  const col = (q - 1) % 8;
  let n = lat + 1 - row * 0.125;
  let w = -(lon + 1) + col * 0.125;
  let s = n - 0.125;
  let e = w + 0.125;
  if (key[7] === 'n') s = n - 0.0625;
  else n -= 0.0625;
  if (key[8] === 'w') e = w + 0.0625;
  else w += 0.0625;
  return { minLat: s, minLng: w, maxLat: n, maxLng: e };
};

/** The units' outlines: core's grid, as `workUnitsFor` uses by default. */
const outline: CellOutline = core.quarterQuadCell;

test('core’s grid is the proof’s hand decode, cell for cell', () => {
  const windows = readFileSync(new URL('../proofs/windows.json', import.meta.url), 'utf8');
  const proofKeys = windows.match(/\d{7}[ns][ew]/g) ?? [];
  expect(proofKeys.length).toBeGreaterThan(0);
  const keys = ['4407305ne', '4407305nw', '4407305se', '4407305sw', '4507364sw', '4207101ne'];
  for (const key of [...keys, ...proofKeys]) {
    const a = handDecode(key);
    const b = core.quarterQuadCell(key);
    for (const side of ['minLat', 'minLng', 'maxLat', 'maxLng'] as const) {
      expect(b[side], `${key} ${side}`).toBeCloseTo(a[side], 9);
    }
  }
});

const CAMPAIGN = 'naip-20261212';

function cell(key: string, over: Partial<NaipManifestCell> = {}): NaipManifestCell {
  return {
    key,
    states: ['VT'],
    pick: `vt_m_${key}_pick`,
    step: 'leafOn',
    stack: [`vt_m_${key}_fb1`, `ny_m_${key}_fb2`],
    partial: false,
    cloudScore: 0,
    workTiles: [],
    ...over,
  };
}

function manifest(over: Partial<NaipManifest> = {}): NaipManifest {
  return {
    version: 2,
    campaign: CAMPAIGN,
    pilot: null,
    createdAt: '2026-12-12T00:00:00Z',
    ruleVersion: 1,
    catalog: { walkedOn: '2026-12-12', items: 3, perState: { VT: 2, NY: 1 }, archivedAt: null },
    exclusionsHash: 'e'.repeat(64),
    foliageStrikesHash: 'f'.repeat(64),
    offSeasonCells: [],
    basedOn: null,
    frames: {},
    cells: [
      cell('4407306nw', { states: ['NY', 'VT'] }),
      cell('4407305ne', { partial: true }),
      cell('4407306ne'),
    ],
    workTiles: [
      { key: '11/606/736', inputHash: 'h1', cells: ['4407305ne', '4407306nw'], retile: true },
      { key: '11/607/736', inputHash: 'h2', cells: ['4407306ne'], retile: true },
    ],
    ...over,
  };
}

describe('Web Mercator', () => {
  test('a tile’s bounds and resolution: z0 is the world, the deepest zoom is z18’s pixel', () => {
    expect(tileBounds(0, 0, 0)).toEqual([
      MERCATOR_ORIGIN,
      MERCATOR_ORIGIN,
      -MERCATOR_ORIGIN,
      -MERCATOR_ORIGIN,
    ]);
    expect(tileResolution(TILE_SETTINGS.maxTileZoom)).toBeCloseTo(0.5971642834779395, 12);
    expect(tileResolution(TILE_SETTINGS.countTileZoom)).toBeCloseTo(2.388657133911758, 12);
    expect(toMercator(0, 0)[0]).toBe(0);
    expect(toMercator(0, 0)[1]).toBeCloseTo(0, 6);
    expect(toMercator(180, 0)[0]).toBeCloseTo(-MERCATOR_ORIGIN, 6);
  });

  test('the counts are on the 256-px z16 grid (pixel zoom 16), the tiles z18’s', () => {
    expect(TILE_SETTINGS.countTileZoom).toBe(core.naipTileZoom(16));
    expect(TILE_SETTINGS.maxTileZoom).toBe(core.naipTileZoom(core.NAIP_MAX_ZOOM));
    expect(TILE_SETTINGS.tileSize).toBe(512);
  });
});

describe('pixelExtent', () => {
  const res = tileResolution(17);
  const world = tileBounds(0, 0, 0);

  test('two cells sharing an edge split its pixels: none in both, none in neither (a property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -8e6, max: -7e6, noNaN: true }),
        fc.double({ min: 10, max: 5000, noNaN: true }),
        fc.double({ min: 10, max: 5000, noNaN: true }),
        (west, a, b) => {
          const edge = west + a;
          const left = pixelExtent([west, 5e6, edge, 5.001e6], res, world) as MercatorBounds;
          const right = pixelExtent([edge, 5e6, edge + b, 5.001e6], res, world) as MercatorBounds;
          expect(left[2]).toBe(right[0]);
          // Every pixel center in [west, edge + b) is in exactly one.
          const centers = (e: MercatorBounds) => Math.round((e[2] - e[0]) / res);
          const whole = pixelExtent([west, 5e6, edge + b, 5.001e6], res, world) as MercatorBounds;
          expect(centers(left) + centers(right)).toBe(centers(whole));
        },
      ),
    );
  });

  test('a pixel is in when its center is: west and south edges in, east and north out', () => {
    // Pixel i spans [O + i·r, O + (i+1)·r); its center is at O + (i + ½)·r.
    const i = 1000;
    const center = MERCATOR_ORIGIN + (i + 0.5) * res;
    // Just west of pixel i's center (in), and just west of pixel i + 10's (out).
    const e = pixelExtent(
      [center - 0.01, 0, center + 10 * res - 0.01, res],
      res,
      world,
    ) as MercatorBounds;
    expect(e[0]).toBeCloseTo(MERCATOR_ORIGIN + i * res, 6);
    expect(e[2]).toBeCloseTo(MERCATOR_ORIGIN + (i + 10) * res, 6);
  });

  test('clipped to the window, and null when nothing is inside it', () => {
    const win = tileBounds(14, 4852, 5895);
    expect(pixelExtent([win[0] - 1e4, win[1] - 1e4, win[2] + 1e4, win[3] + 1e4], res, win)).toEqual(
      win,
    );
    expect(pixelExtent([win[2] + 10, win[1], win[2] + 100, win[3]], res, win)).toBeNull();
  });
});

describe('framesToCut', () => {
  test('the pick alone, unless the pick is partial or the cell sits on a state line', () => {
    expect(framesToCut(cell('4407305ne'))).toEqual(['vt_m_4407305ne_pick']);
    expect(framesToCut(cell('4407305ne', { partial: true }))).toHaveLength(3);
    expect(framesToCut(cell('4407305ne', { states: ['NY', 'VT'] }))).toEqual([
      'vt_m_4407305ne_pick',
      'vt_m_4407305ne_fb1',
      'ny_m_4407305ne_fb2',
    ]);
  });
});

describe('a unit’s chunks name the cells they overlap', () => {
  test('a cell is listed on exactly the chunks its pixels overlap; touching an edge is not overlapping', () => {
    const unit = buildWorkUnit(
      {
        campaign: CAMPAIGN,
        pilot: null,
        workTile: '11/606/736',
        inputHash: 'h',
        cells: [
          { key: '4407305ne', frames: ['a'] },
          { key: '4407306nw', frames: ['b'] },
        ],
      },
      outline,
    );
    expect(unit.chunks).toHaveLength(16);
    for (const chunk of unit.chunks) {
      const [z, x, y] = chunk.tile.split('/').map(Number) as [number, number, number];
      const b = tileBounds(z, x, y);
      expect(chunk.cells).toEqual(
        unit.cells.filter((c) => boxesOverlap(c.extent, b)).map((c) => c.key),
      );
    }
    // Every cell is on some chunk, and some chunk holds none (the cells sit in one corner).
    const listed = new Set(unit.chunks.flatMap((c) => c.cells));
    expect([...listed].sort()).toEqual(unit.cells.map((c) => c.key));
    expect(unit.chunks.some((c) => c.cells.length === 0)).toBe(true);
  });

  test('boxesOverlap: a shared edge or corner is not an overlap', () => {
    expect(boxesOverlap([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(boxesOverlap([0, 0, 1, 1], [1, 0, 2, 1])).toBe(false);
    expect(boxesOverlap([0, 0, 1, 1], [1, 1, 2, 2])).toBe(false);
    expect(boxesOverlap([0, 0, 1, 1], [0, 1, 1, 2])).toBe(false);
  });
});

describe('chunksOf', () => {
  test('a work tile is sixteen z13 chunks and an overview pass for z11–12', () => {
    const { chunks, overview } = chunksOf({ z: 11, x: 606, y: 736 });
    expect(chunks).toHaveLength(16);
    expect(chunks[0]).toEqual({
      tile: '13/2424/2944',
      zooms: { min: 13, max: 17 },
      range: { minX: 2424 * 16, maxX: 2424 * 16 + 15, minY: 2944 * 16, maxY: 2944 * 16 + 15 },
    });
    expect(overview?.zooms).toEqual({ min: 11, max: 12 });
    expect(overview?.from.map((f) => f.tile)).toEqual(chunks.map((c) => c.tile));
    expect(overview?.from[0]?.bounds).toEqual(tileBounds(13, 2424, 2944));
    // The chunks cover the work tile's deepest zoom exactly.
    const xs = new Set(chunks.flatMap((c) => [c.range.minX, c.range.maxX]));
    expect(Math.min(...xs)).toBe(606 * 64);
    expect(Math.max(...xs)).toBe(606 * 64 + 63);
  });

  test('a window at the chunk zoom or deeper is one chunk with no overview pass', () => {
    expect(chunksOf({ z: 14, x: 4852, y: 5895 })).toEqual({
      chunks: [
        {
          tile: '14/4852/5895',
          zooms: { min: 14, max: 17 },
          range: { minX: 4852 * 8, maxX: 4852 * 8 + 7, minY: 5895 * 8, maxY: 5895 * 8 + 7 },
        },
      ],
      overview: null,
    });
  });
});

describe('buildWorkUnit', () => {
  const spec = {
    campaign: CAMPAIGN,
    pilot: null,
    workTile: '11/606/736',
    inputHash: 'h1',
    cells: [
      { key: '4407306nw', frames: ['b', 'c'] },
      { key: '4407305ne', frames: ['a'] },
      // Far from the window: left out.
      { key: '4206801se', frames: ['z'] },
    ],
  };

  test('cells sorted, each with its pixel extents inside the window, the keys and zooms', () => {
    const unit = buildWorkUnit(spec, outline);
    expect(unit.cells.map((c) => c.key)).toEqual(['4407305ne', '4407306nw']);
    expect(unit.window).toBe('11/606/736');
    expect(unit.tileZooms).toEqual({ min: 11, max: 17 });
    expect(unit.keys.done).toBe(`naip/build/${CAMPAIGN}/shards/11/606/736.done.json`);
    expect(unit.chunks).toHaveLength(16);
    for (const c of unit.cells) {
      expect(c.extent[0]).toBeGreaterThanOrEqual(unit.bounds[0]);
      expect(c.extent[2]).toBeLessThanOrEqual(unit.bounds[2]);
    }
    // The two cells abut on 73.375°W with one shared pixel edge.
    const [ne, nw] = unit.cells as [AerialWorkUnit['cells'][0], AerialWorkUnit['cells'][0]];
    expect(ne.extent[2]).toBe(nw.extent[0]);
    expect(ne.countExtent[2]).toBe(nw.countExtent[0]);
  });

  test('a proof’s window inside the work tile; refused outside it or off the zooms', () => {
    const unit = buildWorkUnit({ ...spec, window: '14/4852/5895' }, outline);
    expect(unit.tileZooms).toEqual({ min: 14, max: 17 });
    expect(unit.overview).toBeNull();
    expect(() => buildWorkUnit({ ...spec, window: '14/4900/5895' }, outline)).toThrow(/not inside/);
    expect(() => buildWorkUnit({ ...spec, window: '10/303/368' }, outline)).toThrow(/z11–z17/);
    expect(() => buildWorkUnit({ ...spec, window: '14/99999/5895' }, outline)).toThrow(/not a z14/);
    expect(() => buildWorkUnit({ ...spec, window: 'x' }, outline)).toThrow(/not a tile/);
  });

  test('a cell with no frame is refused', () => {
    expect(() =>
      buildWorkUnit({ ...spec, cells: [{ key: '4407305ne', frames: [] }] }, outline),
    ).toThrow(/no frame/);
  });
});

describe('workUnitsFor', () => {
  test('one unit per work tile cut, its cells’ frames by framesToCut', () => {
    const units = workUnitsFor(manifest(), outline);
    expect(units.map((u) => u.workTile)).toEqual(['11/606/736', '11/607/736']);
    const first = units[0] as AerialWorkUnit;
    expect(first.inputHash).toBe('h1');
    // 4407305ne is partial and 4407306nw on a state line: both carry their stacks.
    expect(first.cells.map((c) => c.frames.length)).toEqual([3, 3]);
    expect(units[1]?.cells[0]?.frames).toEqual(['vt_m_4407306ne_pick']);
  });

  test('a work tile copied from the current build (retile false) is not cut', () => {
    const m = manifest();
    (m.workTiles[1] as { retile: boolean }).retile = false;
    expect(workUnitsFor(m, outline).map((u) => u.workTile)).toEqual(['11/606/736']);
  });

  test('cells no work tile lists are not an error (a narrowed pilot lists every cell)', () => {
    const m = manifest();
    m.cells.push(cell('4507264sw'));
    expect(workUnitsFor(m, outline)).toHaveLength(2);
  });

  test('a work tile naming a cell the manifest lacks is refused', () => {
    const m = manifest();
    m.workTiles[0]?.cells.push('4407399zz');
    expect(() => workUnitsFor(m, outline)).toThrow(/unknown cell/);
  });

  test('unit file names', () => {
    expect(unitFileName('11/606/736')).toBe('11_606_736.json');
    expect(() => unitFileName('12/1/1')).toThrow();
  });
});

const IMAGE = `registry.fly.io/skating-imagery@sha256:${'a'.repeat(64)}`;
function done(workTile: string, inputHash: string, campaign = CAMPAIGN): ShardDone {
  return {
    version: 1,
    campaign,
    workTile,
    inputHash,
    image: IMAGE,
    tiles: 1,
    bytes: 1,
    packSha256: 'b'.repeat(64),
    timings: {},
    cellCounts: {},
    finishedAt: '2026-12-12T00:00:00Z',
  };
}

describe('reconcileShards', () => {
  test('landed is a done record with the manifest’s hash, never presence (a property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            n: fc.integer({ min: 0, max: 2000 }),
            hash: fc.constantFrom('h1', 'h2'),
            present: fc.constantFrom('none', 'same', 'stale', 'other-campaign'),
          }),
          { maxLength: 30 },
        ),
        (rows) => {
          const seen = new Set<string>();
          const statuses = rows
            .filter((r) => !seen.has(String(r.n)) && seen.add(String(r.n)))
            .map((r) => {
              const workTile = `11/${r.n}/1`;
              const d =
                r.present === 'none'
                  ? null
                  : r.present === 'same'
                    ? done(workTile, r.hash)
                    : r.present === 'stale'
                      ? done(workTile, `${r.hash}-old`)
                      : done(workTile, r.hash, 'naip-20250101');
              return { workTile, inputHash: r.hash, done: d, landed: r.present === 'same' };
            });
          const out = reconcileShards(CAMPAIGN, statuses);
          expect(out.landed).toEqual(statuses.filter((s) => s.landed).map((s) => s.workTile));
          expect(out.outstanding).toEqual(statuses.filter((s) => !s.landed).map((s) => s.workTile));
        },
      ),
    );
  });

  test('another work tile’s record under this key is outstanding', () => {
    const out = reconcileShards(CAMPAIGN, [
      { workTile: '11/1/1', inputHash: 'h', done: done('11/2/2', 'h') },
    ]);
    expect(out.outstanding).toEqual(['11/1/1']);
  });
});

describe('runTileRounds', () => {
  const units = [
    { workTile: '11/1/1', inputHash: 'h1' },
    { workTile: '11/2/2', inputHash: 'h2' },
    { workTile: '11/3/3', inputHash: 'h3' },
  ];

  /** A bucket where each spawn lands the tiles `lands(round)` allows. */
  function bucket(lands: (tile: string, round: number) => boolean) {
    const dones = new Map<string, ShardDone>();
    const spawned: string[][] = [];
    const reconciled: [number, number, number][] = [];
    return {
      spawned,
      reconciled,
      io: {
        readDone: async (keys: readonly string[]) =>
          new Map(keys.map((k) => [k, dones.get(k) ?? null] as const)),
        spawn: async (tiles: readonly string[], round: number) => {
          spawned.push([...tiles]);
          for (const t of tiles) {
            if (lands(t, round)) {
              dones.set(t, done(t, units.find((u) => u.workTile === t)?.inputHash as string));
            }
          }
        },
        onReconcile: (round: number, landed: number, outstanding: number) => {
          reconciled.push([round, landed, outstanding]);
        },
      },
    };
  }

  test('spawns what is outstanding until it lands, and stops', async () => {
    const b = bucket((t, round) => t !== '11/3/3' || round === 2);
    const out = await runTileRounds(CAMPAIGN, units, b.io);
    expect(b.spawned).toEqual([['11/1/1', '11/2/2', '11/3/3'], ['11/3/3']]);
    expect(out).toEqual({ landed: ['11/1/1', '11/2/2', '11/3/3'], failed: [], rounds: 2 });
    expect(b.reconciled).toEqual([
      [0, 0, 3],
      [1, 2, 1],
      [2, 3, 0],
    ]);
  });

  test('three rounds, then the failed list — a tile that never lands is never assumed done', async () => {
    const b = bucket((t) => t !== '11/2/2');
    const out = await runTileRounds(CAMPAIGN, units, b.io);
    expect(b.spawned).toEqual([['11/1/1', '11/2/2', '11/3/3'], ['11/2/2'], ['11/2/2']]);
    expect(out).toEqual({ landed: ['11/1/1', '11/3/3'], failed: ['11/2/2'], rounds: 3 });
  });

  test('a stale done record from an earlier build is re-cut', async () => {
    const b = bucket(() => true);
    const stale = new Map([['11/1/1', done('11/1/1', 'h0')]]);
    const io = {
      ...b.io,
      readDone: async (keys: readonly string[]) => {
        const fresh = await b.io.readDone(keys);
        for (const [k, v] of stale) if (fresh.get(k) === null) fresh.set(k, v);
        return fresh;
      },
    };
    const out = await runTileRounds(CAMPAIGN, units, io);
    expect(b.spawned[0]).toContain('11/1/1');
    expect(out.failed).toEqual([]);
  });

  test('nothing outstanding spawns nothing', async () => {
    const b = bucket(() => true);
    await runTileRounds(CAMPAIGN, units, b.io, 3);
    const again = await runTileRounds(CAMPAIGN, units, {
      ...b.io,
      spawn: async () => {
        throw new Error('spawned');
      },
    });
    expect(again).toEqual({ landed: units.map((u) => u.workTile), failed: [], rounds: 0 });
  });
});

describe('heartbeatDue', () => {
  test('every 25 work tiles landed', () => {
    expect(heartbeatDue(0, 24)).toBe(false);
    expect(heartbeatDue(24, 25)).toBe(true);
    expect(heartbeatDue(10, 60)).toBe(true);
    expect(heartbeatDue(50, 74)).toBe(false);
  });
});

describe('tilesScope', () => {
  test('archive, the states its cut cells list, complete only for a full production build', () => {
    const m = manifest();
    const units = workUnitsFor(m, outline);
    expect(tilesScope(m, units)).toEqual({ pass: 'archive', states: ['NY', 'VT'], complete: true });
    expect(tilesScope(m, units.slice(1)).complete).toBe(false);
    expect(tilesScope({ ...m, pilot: 'p', campaign: 'naip-pilot-20261212' }, units).complete).toBe(
      false,
    );
    expect(tilesScope({ ...m, basedOn: { archive: 'a', manifest: 'b' } }, units).complete).toBe(
      false,
    );
    // A unit naming a cell the manifest doesn't hold adds no state.
    const first = units[0]?.cells[0] as AerialWorkUnit['cells'][number];
    expect(tilesScope(m, [{ cells: [{ ...first, key: '4507264sw' }] }]).states).toEqual([]);
  });
});

describe('selectUploads', () => {
  test('the manifest to the build prefix, and the snapshot per state when it is archived', () => {
    const m = manifest({
      catalog: {
        walkedOn: '2026-12-12',
        items: 3,
        perState: { VT: 2, NY: 1 },
        archivedAt: 'naip/inventory/2026-12-12/',
      },
    });
    expect(selectUploads(m, '/s')).toEqual([
      { local: `/s/${CAMPAIGN}/manifest.json`, key: `naip/build/${CAMPAIGN}/manifest.json` },
      {
        local: `/s/${CAMPAIGN}/inventory/ny.jsonl.gz`,
        key: 'naip/inventory/2026-12-12/ny.jsonl.gz',
      },
      {
        local: `/s/${CAMPAIGN}/inventory/vt.jsonl.gz`,
        key: 'naip/inventory/2026-12-12/vt.jsonl.gz',
      },
    ]);
  });

  test('a pilot’s manifest under its pilot prefix; an unarchived snapshot stays home', () => {
    const m = manifest({ campaign: 'naip-pilot-20261212', pilot: 'champlain' });
    expect(selectUploads(m, '/s')).toEqual([
      {
        local: '/s/naip-pilot-20261212/manifest.json',
        key: 'naip/build/pilot/champlain/naip-pilot-20261212/manifest.json',
      },
    ]);
  });

  test('refuses a pilot’s manifest that would archive the catalog outside its prefixes', () => {
    const m = manifest({
      campaign: 'naip-pilot-20261212',
      pilot: 'champlain',
      catalog: {
        walkedOn: '2026-12-12',
        items: 1,
        perState: { VT: 1 },
        archivedAt: 'naip/inventory/2026-12-12/',
      },
    });
    expect(() => selectUploads(m, '/s')).toThrow(/outside its prefixes/);
  });

  test('refuses an archive that names another day, or no state', () => {
    const at = (archivedAt: string, perState: NaipManifest['catalog']['perState'] = { VT: 1 }) =>
      manifest({ catalog: { walkedOn: '2026-12-12', items: 1, perState, archivedAt } });
    expect(() => selectUploads(at('naip/inventory/2026-12-11/'), '/s')).toThrow(/2026-12-11/);
    expect(() => selectUploads(at('naip/inventory/2026-12-12/', {}), '/s')).toThrow(/no state/);
  });
});

/**
 * **Changing how a pixel is drawn means bumping `NAIP_TILING_VERSION`.** The input hash (core's
 * `naipWorkTileInputHash`) sees the stacks and that version, not the worker's GDAL arguments or
 * `TILE_SETTINGS`; a change to them that isn't paired with a bump leaves a rebuild copying stale
 * tiles as unchanged. So the two are fingerprinted here, per tiling version: change either, and this
 * fails until the version is bumped (if the same stack now draws different pixels) and the new
 * fingerprint is recorded under it — or, for a change that draws nothing differently, recorded under
 * the same version, deliberately.
 */
describe('the tiling fingerprint', () => {
  const FINGERPRINTS: Record<number, string> = {
    // Re-recorded under 1 at integration (2026-11-26), deliberately: the overview zooms and the
    // work tile's own tile gained the window's bounds, which stops a tile outside the work tile being
    // written (the packer refused it) and changes no pixel inside it; and no archive had been built.
    // Re-recorded under 1 at the pilot (2026-11-26), deliberately: every tiler run gained
    // `--parallel-method spawn` (the thread pool can't clone the mosaic), which draws tiles
    // byte-identical to a single-threaded run (measured on 89 real tiles); no archive had been built.
    1: 'd6b25433e0b8fd5f5225740004750f94d7052a041ec20f7653e7e2c371a42139',
  };

  /** The worker's GDAL invocations (with their continuation lines) and the counts helper's code. */
  function drawing(): string {
    const worker = readFileSync(new URL('../cut-aerial.sh', import.meta.url), 'utf8').split('\n');
    const lines: string[] = [];
    let continuing = false;
    for (const raw of worker) {
      const line = raw.trim();
      if (line.startsWith('#')) continue;
      if (continuing || /\b(gdalwarp|gdal_translate|gdalbuildvrt|gdal raster)\b/.test(line)) {
        lines.push(line);
        continuing = line.endsWith('\\');
      }
    }
    const counts = readFileSync(new URL('../aerial-counts.py', import.meta.url), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    return JSON.stringify({ settings: TILE_SETTINGS, worker: lines, counts });
  }

  test('the worker’s drawing is the one recorded for this NAIP_TILING_VERSION', () => {
    const version = core.NAIP_TILING_VERSION;
    const print = createHash('sha256').update(drawing()).digest('hex');
    expect(
      print,
      `the summer aerial's drawing changed. If the same stack now draws different pixels, bump ` +
        `NAIP_TILING_VERSION in core; then record ${print} under it in FINGERPRINTS.`,
    ).toBe(FINGERPRINTS[version]);
  });
});
