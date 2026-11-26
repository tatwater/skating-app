import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import { afterEach, describe, expect, test } from 'vitest';
import { buildWorkUnit } from './tiles';
import {
  buildDone,
  bytesByZoom,
  listTiles,
  mosaicLayers,
  readCellCounts,
  type TileFile,
  writeShard,
} from './tilesPack';
import { main } from './tilesPackMain';

const outline = (key: string) =>
  key === '4407305ne'
    ? { minLng: -73.4375, minLat: 44.9375, maxLng: -73.375, maxLat: 45.0 }
    : { minLng: -73.375, minLat: 44.9375, maxLng: -73.3125, maxLat: 45.0 };

const UNIT = buildWorkUnit(
  {
    campaign: 'naip-20261212',
    pilot: null,
    workTile: '11/606/736',
    inputHash: 'h1',
    cells: [
      { key: '4407306nw', frames: ['vt-pick', 'vt-old', 'ny-fb'] },
      { key: '4407305ne', frames: ['ny-pick'] },
    ],
  },
  outline,
);
const IMAGE = `registry.fly.io/skating-imagery@sha256:${'c'.repeat(64)}`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'aerial-pack-'));
  dirs.push(d);
  return d;
}

/** Write tiles `<dir>/<z>/<x>/<y>.webp` with distinct bytes; return them. */
function tiles(dir: string, zxys: [number, number, number][], body = (i: number) => `tile-${i}`) {
  return zxys.map(([z, x, y], i) => {
    mkdirSync(join(dir, String(z), String(x)), { recursive: true });
    const path = join(dir, String(z), String(x), `${y}.webp`);
    writeFileSync(path, body(i));
    return { z, x, y, path };
  });
}

const TOP: [number, number, number] = [11, 606, 736];
const SOME: [number, number, number][] = [
  [17, 606 * 64 + 5, 736 * 64 + 9],
  TOP,
  [12, 1212, 1472],
  [17, 606 * 64, 736 * 64],
];

describe('listTiles', () => {
  test('every z/x/y.webp, nothing else', () => {
    const d = tmp();
    tiles(d, SOME);
    writeFileSync(join(d, 'tilemapresource.xml'), '<x/>');
    mkdirSync(join(d, 'notes'));
    writeFileSync(join(d, '11', '606', 'readme.txt'), 'x');
    const found = listTiles(d).map((t) => [t.z, t.x, t.y]);
    expect(found.sort()).toEqual([...SOME].sort());
  });
});

describe('writeShard', () => {
  test('the pack in ascending tile id, each tile hashed, the index the checker accepts', () => {
    const d = tmp();
    const files = tiles(d, SOME);
    const shard = writeShard(UNIT, files, join(d, 'pack'));
    const pack = readFileSync(join(d, 'pack'));
    const ids = shard.index.entries.map((e) => e.tileId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(zxyToTileId(...TOP));
    for (const e of shard.index.entries) {
      const bytes = pack.subarray(e.offset, e.offset + e.length);
      const [z, x, y] = tileIdToZxy(e.tileId);
      const file = files.find((f) => f.z === z && f.x === x && f.y === y) as TileFile;
      expect(bytes.equals(readFileSync(file.path))).toBe(true);
      expect(e.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(shard.bytes).toBe(pack.length);
    expect(shard.packSha256).toBe(createHash('sha256').update(pack).digest('hex'));
  });

  test('an empty shard is honest: no tiles, an empty pack', () => {
    const d = tmp();
    const shard = writeShard(UNIT, [], join(d, 'pack'));
    expect(shard).toMatchObject({ bytes: 0, index: { entries: [] } });
  });

  test('a shard with tiles must hold its own top tile — the assembler builds from it', () => {
    const d = tmp();
    const files = tiles(
      d,
      SOME.filter((t) => t !== TOP),
    );
    expect(() => writeShard(UNIT, files, join(d, 'pack'))).toThrow(/own top tile 11\/606\/736/);
  });

  test('refuses a tile outside the window or the zooms, an empty tile, or one tile twice', () => {
    const d = tmp();
    const outside = tiles(d, [TOP, [17, 0, 0]]);
    expect(() => writeShard(UNIT, outside, join(d, 'p'))).toThrow(/not in work tile/);
    const deep = tiles(tmp(), [TOP, [18, 606 * 128, 736 * 128]]);
    expect(() => writeShard(UNIT, deep, join(d, 'p'))).toThrow(/outside zooms/);
    const empty = tiles(tmp(), [TOP, [12, 1212, 1472]], (i) => (i === 1 ? '' : 'x'));
    expect(() => writeShard(UNIT, empty, join(d, 'p'))).toThrow(/is empty/);
    const [one] = tiles(tmp(), [TOP]);
    expect(() => writeShard(UNIT, [one as TileFile, one as TileFile], join(d, 'p'))).toThrow(
      /two files/,
    );
  });
});

describe('readCellCounts and mosaicLayers', () => {
  function counts(byCell: Record<string, unknown>): string {
    const d = tmp();
    for (const [cell, c] of Object.entries(byCell)) {
      writeFileSync(join(d, `${cell}.json`), JSON.stringify(c));
    }
    return d;
  }

  test('zeros dropped; a cell supplying nothing left out', () => {
    const d = counts({
      '4407306nw': { 'vt-pick': 90, 'vt-old': 0, 'ny-fb': 10 },
      '4407305ne': { 'ny-pick': 0 },
    });
    expect(readCellCounts(d, UNIT)).toEqual({ '4407306nw': { 'vt-pick': 90, 'ny-fb': 10 } });
  });

  test('refuses a frame not in the cell’s stack, a bad count, or a non-object', () => {
    expect(() =>
      readCellCounts(counts({ '4407306nw': { other: 1 }, '4407305ne': {} }), UNIT),
    ).toThrow(/not one of its frames/);
    expect(() =>
      readCellCounts(counts({ '4407306nw': { 'vt-pick': -1 }, '4407305ne': {} }), UNIT),
    ).toThrow(/-1/);
    expect(() =>
      readCellCounts(counts({ '4407306nw': { 'vt-pick': 1.5 }, '4407305ne': {} }), UNIT),
    ).toThrow(/1.5/);
    expect(() => readCellCounts(counts({ '4407306nw': [1], '4407305ne': {} }), UNIT)).toThrow(
      /not an object/,
    );
  });

  test('the mosaic: per cell the frames that supply any pixel, lowest fallback first, pick last', () => {
    const layers = mosaicLayers(UNIT, {
      '4407306nw': { 'vt-pick': 90, 'ny-fb': 10 },
      '4407305ne': { 'ny-pick': 100 },
    });
    expect(layers).toEqual([
      { cell: '4407305ne', itemId: 'ny-pick', rank: 0 },
      { cell: '4407306nw', itemId: 'ny-fb', rank: 2 },
      { cell: '4407306nw', itemId: 'vt-pick', rank: 0 },
    ]);
    expect(mosaicLayers(UNIT, {})).toEqual([]);
  });
});

describe('buildDone and bytesByZoom', () => {
  test('the done record names the unit’s campaign, work tile and hash; checked', () => {
    const d = tmp();
    const shard = writeShard(UNIT, tiles(d, SOME), join(d, 'pack'));
    const done = buildDone(UNIT, shard, {
      image: IMAGE,
      timings: { count: 1, tile: 2 },
      cellCounts: { '4407305ne': { 'ny-pick': 3 } },
      finishedAt: '2026-12-12T01:02:03.000Z',
    });
    expect(done).toMatchObject({
      campaign: 'naip-20261212',
      workTile: '11/606/736',
      inputHash: 'h1',
      tiles: 4,
      bytes: shard.bytes,
    });
    expect(() =>
      buildDone(UNIT, shard, { image: 'latest', timings: {}, cellCounts: {}, finishedAt: 'x' }),
    ).toThrow(/digest/);
    const zooms = bytesByZoom(shard.index, (id) => tileIdToZxy(id)[0]);
    expect(zooms[17]?.tiles).toBe(2);
    expect(zooms[11]).toEqual({ tiles: 1, bytes: 'tile-1'.length });
  });
});

describe('tilesPackMain', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        now: () => new Date('2026-12-12T00:00:00Z'),
      },
    };
  }
  function setup() {
    const d = tmp();
    const unitPath = join(d, 'unit.json');
    writeFileSync(unitPath, JSON.stringify(UNIT));
    const countsDir = join(d, 'counts');
    mkdirSync(countsDir);
    writeFileSync(join(countsDir, '4407306nw.json'), JSON.stringify({ 'vt-pick': 5, 'ny-fb': 1 }));
    writeFileSync(join(countsDir, '4407305ne.json'), JSON.stringify({ 'ny-pick': 7 }));
    const tilesDir = join(d, 'tiles');
    tiles(tilesDir, SOME);
    writeFileSync(join(d, 'timings.json'), JSON.stringify({ count: 10 }));
    mkdirSync(join(d, 'out'));
    return { d, unitPath, countsDir, tilesDir };
  }

  test('layers prints the mosaic, a tab-separated line each', () => {
    const s = setup();
    const r = io();
    expect(main(['layers', '--unit', s.unitPath, '--counts', s.countsDir], r.io)).toBe(0);
    expect(r.out).toEqual([
      '4407305ne\tny-pick\t0',
      '4407306nw\tny-fb\t2',
      '4407306nw\tvt-pick\t0',
    ]);
  });

  test('pack writes the pack, the index and the done record, and says what it packed', () => {
    const s = setup();
    const r = io();
    const args = ['pack', '--unit', s.unitPath, '--tiles', s.tilesDir, '--counts', s.countsDir];
    const rest = ['--timings', join(s.d, 'timings.json'), '--out', join(s.d, 'out')];
    expect(main([...args, ...rest, '--image', IMAGE], r.io)).toBe(0);
    const done = JSON.parse(readFileSync(join(s.d, 'out', 'shard.done.json'), 'utf8'));
    expect(done).toMatchObject({
      tiles: 4,
      image: IMAGE,
      timings: { count: 10 },
      cellCounts: { '4407305ne': { 'ny-pick': 7 }, '4407306nw': { 'vt-pick': 5, 'ny-fb': 1 } },
      finishedAt: '2026-12-12T00:00:00.000Z',
    });
    expect(
      JSON.parse(readFileSync(join(s.d, 'out', 'shard.idx.json'), 'utf8')).entries,
    ).toHaveLength(4);
    expect(r.out[0]).toMatch(/^packed 4 tiles, \d+ bytes$/);
    expect(r.out.some((l) => l.startsWith('  z17: 2 tiles'))).toBe(true);
  });

  test('pack refuses without --image (64), an unpinned image or a bad shard (1)', () => {
    const s = setup();
    const args = ['pack', '--unit', s.unitPath, '--tiles', s.tilesDir, '--counts', s.countsDir];
    const full = [...args, '--timings', join(s.d, 'timings.json'), '--out', join(s.d, 'out')];
    const r = io();
    expect(main(full, r.io)).toBe(64);
    expect(r.err[0]).toMatch(/--image is required/);
    const r1 = io();
    expect(main([...full, '--image', 'registry.fly.io/x:latest'], r1.io)).toBe(1);
    expect(r1.err[0]).toMatch(/digest/);
    rmSync(join(s.tilesDir, '11'), { recursive: true });
    const r2 = io();
    expect(main([...full, '--image', IMAGE], r2.io)).toBe(1);
    expect(r2.err[0]).toMatch(/own top tile/);
  });

  test('unit builds a work unit from explicit outlines; a stable hash when none is given', () => {
    const d = tmp();
    const spec = {
      campaign: 'naip-pilot-20261125',
      pilot: 'warp-proof',
      workTile: '11/606/736',
      window: '14/4852/5895',
      cells: [{ key: '4407305ne', outline: [-73.4375, 44.9375, -73.375, 45.0], frames: ['a'] }],
    };
    writeFileSync(join(d, 'spec.json'), JSON.stringify(spec));
    const r = io();
    expect(main(['unit', '--spec', join(d, 'spec.json')], r.io)).toBe(0);
    const unit = JSON.parse(r.out[0] as string);
    expect(unit).toMatchObject({
      window: '14/4852/5895',
      pilot: 'warp-proof',
      cells: [{ key: '4407305ne' }],
    });
    expect(unit.inputHash).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(d, 'spec2.json'), JSON.stringify({ ...spec, inputHash: 'given' }));
    const r2 = io();
    main(['unit', '--spec', join(d, 'spec2.json')], r2.io);
    expect(JSON.parse(r2.out[0] as string).inputHash).toBe('given');
  });

  test('usage: an unknown command, a missing or unknown flag, a flag with no value; a wrong unit version', () => {
    for (const argv of [
      ['nope'],
      [],
      ['layers', '--unit', 'u'],
      ['layers', '--unit', 'u', '--counts', 'c', '--extra', 'x'],
      ['layers', '--unit', '--counts', 'c'],
    ]) {
      const r = io();
      expect(main(argv, r.io)).toBe(64);
    }
    const d = tmp();
    writeFileSync(join(d, 'u.json'), JSON.stringify({ ...UNIT, version: 2 }));
    const r = io();
    expect(main(['layers', '--unit', join(d, 'u.json'), '--counts', d], r.io)).toBe(1);
    expect(r.err[0]).toMatch(/version 2/);
  });
});
