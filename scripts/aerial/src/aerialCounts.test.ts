/**
 * **The strip the counts' grid can't see**, with real GDAL (B05 §2.2 step 4): `aerial-counts.py` on
 * synthetic frames, then the mosaic `cut-aerial.sh` would build from what it decided, read back at
 * the deepest zoom. GDAL's Python bindings are on the Mac (Homebrew's 3.14) and in the Machine's
 * image, not on CI: there this is skipped, like the other two GDAL tests.
 *
 * The case: a pick whose data stops ~1.1 m inside its cell's west edge, short of the cell's first
 * counted center (the counts' pixels are ~2.4 m), over a fallback that covers everything. On the
 * counts' grid the pick covers the cell and the fallback counts zero; at the deepest zoom (0.6 m) the
 * cell's first column is the fallback's or nothing.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type AerialWorkUnit,
  buildWorkUnit,
  MERCATOR_ORIGIN,
  type MercatorBounds,
  TILE_SETTINGS,
  tileBounds,
} from './tiles';
import { mosaicLayers, readCellCounts, readCellWindows } from './tilesPack';

const PY = process.env.AERIAL_PYTHON ?? '/opt/homebrew/opt/python@3.14/bin/python3.14';
const COUNTS = new URL('../aerial-counts.py', import.meta.url).pathname;

const hasGdalPython = (() => {
  try {
    execFileSync('gdalwarp', ['--version'], { stdio: 'ignore' });
    return spawnSync(PY, ['-I', '-c', 'import numpy; from osgeo import gdal']).status === 0;
  } catch {
    return false;
  }
})();

const R = 6378137;
const lngOf = (x: number) => (x / (Math.PI * R)) * 180;

const dir = mkdtempSync(join(tmpdir(), 'aerial-counts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** A z17 window inside work tile 11/606/736 whose cell's west edge sits 0.05 m past a z16 line. */
function setup(): { unit: AerialWorkUnit; edge: number } {
  const cres = (2 * Math.PI * R) / (512 * 2 ** TILE_SETTINGS.countTileZoom);
  const [wx0] = tileBounds(11, 606, 736);
  const line = MERCATOR_ORIGIN + Math.ceil((wx0 + 5000 - MERCATOR_ORIGIN) / cres) * cres;
  const edge = line + 0.05;
  const x17 = Math.floor((edge + 100 - MERCATOR_ORIGIN) / ((2 * Math.PI * R) / 2 ** 17));
  const y17 = 736 * 64 + 20;
  const unit = buildWorkUnit(
    {
      campaign: 'naip-pilot-20261125',
      pilot: 'strip',
      workTile: '11/606/736',
      window: `17/${x17}/${y17}`,
      inputHash: 'h',
      cells: [{ key: '4407306nw', frames: ['pick', 'fallback'] }],
    },
    () => ({ minLng: lngOf(edge), minLat: 44.0, maxLng: lngOf(edge + 50_000), maxLat: 46.0 }),
  );
  return { unit, edge };
}

/** A 0.3 m RGB GeoTIFF over `box`, data (90, 110, 70) east of `from`, NAIP's 0,0,0 west of it. */
function frame(path: string, box: MercatorBounds, from: number): void {
  run(PY, [
    '-I',
    '-c',
    `
import numpy as np
from osgeo import gdal, osr
x0, y0, x1, y1, start = ${box.join(', ')}, ${from}
res = 0.3
w, h = round((x1 - x0) / res), round((y1 - y0) / res)
ds = gdal.GetDriverByName("GTiff").Create("${path}", w, h, 3, gdal.GDT_Byte)
ds.SetGeoTransform((x0, res, 0, y1, 0, -res))
srs = osr.SpatialReference(); srs.ImportFromEPSG(3857); ds.SetProjection(srs.ExportToWkt())
xs = x0 + (np.arange(w) + 0.5) * res
on = np.broadcast_to(xs >= start, (h, w))
for b, v in zip((1, 2, 3), (90, 110, 70)):
    ds.GetRasterBand(b).WriteArray(np.where(on, v, 0).astype(np.uint8))
ds = None
`,
  ]);
}

/** `cut-aerial.sh`'s warp, to a VRT. */
function warp(src: string, box: MercatorBounds, res: number, r: string, out: string): void {
  run('gdalwarp', [
    '-q',
    '-overwrite',
    '-of',
    'VRT',
    '-t_srs',
    'EPSG:3857',
    '-te',
    ...box.map(String),
    '-tr',
    String(res),
    String(res),
    '-srcnodata',
    TILE_SETTINGS.srcNodata,
    '-wo',
    'UNIFIED_SRC_NODATA=YES',
    '-srcband',
    '1',
    '-srcband',
    '2',
    '-srcband',
    '3',
    '-dstalpha',
    '-r',
    r,
    src,
    out,
  ]);
}

/** Counts and windows for the cell, as `count_cell` would have them; then the mosaic, read back. */
function cut(name: string, pickFrom: number, unit: AerialWorkUnit) {
  const work = mkdtempSync(join(dir, `${name}-`));
  const cell = unit.cells[0] as AerialWorkUnit['cells'][number];
  const b = unit.bounds;
  const around: MercatorBounds = [b[0] - 30, b[1] - 30, b[2] + 30, b[3] + 30];
  const src = { pick: join(work, 'pick.tif'), fallback: join(work, 'fallback.tif') };
  frame(src.pick, around, pickFrom);
  frame(src.fallback, around, around[0]);
  const frames = cell.frames.map((id, i) => {
    warp(
      src[id as 'pick' | 'fallback'],
      cell.countWindow,
      unit.countResolution,
      'near',
      join(work, `${i}.vrt`),
    );
    run('gdal_translate', ['-q', '-b', '4', join(work, `${i}.vrt`), join(work, `${i}-alpha.tif`)]);
    return { id, alpha: join(work, `${i}-alpha.tif`), src: src[id as 'pick' | 'fallback'] };
  });
  const job = join(work, 'job.json');
  writeFileSync(
    job,
    JSON.stringify({
      counts: join(work, `${cell.key}.json`),
      windows: join(work, `${cell.key}.windows.json`),
      extent: cell.extent,
      res: unit.resolution,
      pad: 1,
      warp: {
        bands: TILE_SETTINGS.bands,
        srcNodata: TILE_SETTINGS.srcNodata,
        resampling: TILE_SETTINGS.resampling,
      },
      frames,
    }),
  );
  run(PY, ['-I', COUNTS, job]);
  const counts = readCellCounts(work, unit);
  const windows = readCellWindows(work, unit, counts);
  const layers = mosaicLayers(unit, counts, windows);
  const list = layers.map((l, i) => {
    const out = join(work, `layer-${i}.vrt`);
    warp(
      src[l.itemId as 'pick' | 'fallback'],
      l.window ?? cell.extent,
      unit.resolution,
      'cubic',
      out,
    );
    return out;
  });
  writeFileSync(join(work, 'mosaic.txt'), `${list.join('\n')}\n`);
  run('gdalbuildvrt', [
    '-q',
    '-input_file_list',
    join(work, 'mosaic.txt'),
    join(work, 'mosaic.vrt'),
  ]);
  // Transparent pixels of the mosaic inside the cell's extent, and the columns they're in.
  const holes = JSON.parse(
    run(PY, [
      '-I',
      '-c',
      `
import json, numpy as np
from osgeo import gdal
ds = gdal.Warp("", "${join(work, 'mosaic.vrt')}", options=["-of", "MEM", "-te", ${cell.extent
        .map(String)
        .join(', ')
        .replace(
          /([^,\s]+)/g,
          '"$1"',
        )}, "-tr", "${unit.resolution}", "${unit.resolution}", "-r", "near"])
a = ds.GetRasterBand(ds.RasterCount).ReadAsArray()
cols = sorted(set(np.nonzero(a == 0)[1].tolist()))
print(json.dumps({"count": int((a == 0).sum()), "cols": cols[:10]}))
`,
    ]),
  ) as { count: number; cols: number[] };
  return {
    counts,
    windows,
    layers,
    holes,
    raw: readFileSync(job.replace('job.json', `${cell.key}.json`), 'utf8'),
  };
}

describe.skipIf(!hasGdalPython)('aerial-counts.py, with real GDAL', () => {
  const { unit, edge } = setup();
  const cell = unit.cells[0] as AerialWorkUnit['cells'][number];

  it('the case is the one that bit: the pick covers every counted center, not the first column', () => {
    // The cell's first deepest-zoom pixel starts at the z16 line, its center inside the cell; the
    // first counted center is ~1.19 m in. The pick's data starts 1.15 m in.
    expect(cell.extent[0]).toBeCloseTo(edge - 0.05, 6);
    expect(cell.countExtent[0]).toBeCloseTo(edge - 0.05, 6);
  });

  it('fills a strip the counts miss, from the fallback, drawn and dated only there', () => {
    const { counts, windows, layers, holes } = cut('strip', edge + 1.1, unit);
    // On the counts' grid the fallback supplies nothing: before, it was never drawn.
    expect(counts[cell.key]?.pick).toBeGreaterThan(0);
    expect(counts[cell.key]?.fallback).toBeGreaterThanOrEqual(1);
    const boxes = windows[cell.key]?.fallback as MercatorBounds[];
    expect(boxes.length).toBeGreaterThan(0);
    // Its windows hug the west edge: a strip a few counts' pixels wide, never the whole cell.
    for (const w of boxes) {
      expect(w[0]).toBeCloseTo(cell.extent[0], 6);
      expect(w[2] - w[0]).toBeLessThanOrEqual(4 * unit.countResolution + 1e-6);
    }
    expect(layers.filter((l) => l.itemId === 'fallback').every((l) => l.window !== undefined)).toBe(
      true,
    );
    expect(holes.count).toBe(0);
  });

  it('without the strip check — counts alone — the first column stays empty', () => {
    const { counts, holes } = cut('before', edge + 1.1, unit);
    // The same counts, minus what the check added: what the worker drew before.
    const before = { [cell.key]: { pick: counts[cell.key]?.pick as number } };
    expect(mosaicLayers(unit, before).map((l) => l.itemId)).toEqual(['pick']);
    expect(holes.count).toBe(0);
    // Drawn from the pick alone — what the counts alone chose — the strip is a hole: the cell's first
    // two deepest-zoom columns (1.2 m), the whole height of the window.
    const pickOnly = cut('pick-only', edge + 1.1, {
      ...unit,
      cells: [{ ...cell, frames: ['pick'] }],
    });
    expect(pickOnly.holes.count).toBeGreaterThan(0);
    expect(pickOnly.holes.cols).toEqual([0, 1]);
  });

  it('a pick that runs past its cell leaves no band: no check, no extra warp', () => {
    const { counts, windows, layers, holes } = cut('covered', edge - 300, unit);
    expect(counts[cell.key]).toEqual({ pick: expect.any(Number) });
    expect(windows).toEqual({});
    expect(layers.map((l) => l.itemId)).toEqual(['pick']);
    expect(holes.count).toBe(0);
  });
});
