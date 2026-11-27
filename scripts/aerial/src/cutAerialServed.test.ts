/**
 * **The worker, whole, with real GDAL** (B05 §7.3): `cut-aerial.sh` itself, start to upload, with
 * only the network's edges stood in. A local server answers as Planetary Computer's SAS endpoint
 * and STAC API, and as the Azure blob store (byte ranges, over GDAL's own `/vsiaz/`, pointed at it by
 * a connection string); the frames it serves are synthetic GeoTIFFs. Everything else is real: bash,
 * curl, jq, `gdalwarp`, `gdal_translate`, `gdalbuildvrt`, `gdal raster tile`, the counts helper on
 * GDAL's Python bindings, the TypeScript packer — and `--local`, the upload's one stand-in for
 * rclone and R2. GDAL's Python bindings are on the Mac, not on CI: there this is skipped, like
 * `aerialCounts.test.ts`.
 *
 * Three shapes, each to the upload and exit 0: three single-frame cells (no strip check, so the
 * counts helper's stats files are empty — the shape PR #188's collector failed on); a pick that
 * doesn't cover its cell, over a fallback that shows; and a strip the counts' grid can't see,
 * which the helper checks at the deepest zoom. In each, the bytes the worker reports reading are
 * exactly the bytes the server sent from the blob store.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AerialWorkUnit,
  buildWorkUnit,
  MERCATOR_ORIGIN,
  type MercatorBounds,
  TILE_SETTINGS,
  tileBounds,
} from './tiles';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const PY = process.env.AERIAL_PYTHON ?? '/opt/homebrew/opt/python@3.14/bin/python3.14';
const TSX = `${process.execPath} ${createRequire(import.meta.url).resolve('tsx/cli')}`;
const IMAGE = `local/served-proof@sha256:${'0'.repeat(64)}`;

const hasGdal = (() => {
  try {
    execFileSync('gdalwarp', ['--version'], { stdio: 'ignore' });
    execFileSync('gdal', ['raster', 'tile', '--help'], { stdio: 'ignore' });
    const bash = spawnSync('bash', ['-c', '(( BASH_VERSINFO[0] >= 5 ))']);
    return (
      bash.status === 0 &&
      spawnSync(PY, ['-I', '-c', 'import numpy; from osgeo import gdal']).status === 0
    );
  } catch {
    return false;
  }
})();

const R = 6378137;
const lngOf = (x: number) => (x / R) * (180 / Math.PI);
const latOf = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
const outlineOf = (b: MercatorBounds) => ({
  minLng: lngOf(b[0]),
  minLat: latOf(b[1]),
  maxLng: lngOf(b[2]),
  maxLat: latOf(b[3]),
});

const dir = mkdtempSync(join(tmpdir(), 'aerial-served-'));
/** The server's log of blob bytes sent, emptied before each run (the runs are sequential). */
const SERVED = join(dir, 'served.txt');
const blobs = join(dir, 'blobs');
mkdirSync(join(blobs, 'naipeuwest', 'naip'), { recursive: true });

/**
 * Planetary Computer and Azure, on one port: the SAS endpoint (a token an hour from expiry), STAC
 * items (each frame's href a blob COG, as the worker requires), and the blobs, by byte range, the
 * query string (the SAS) ignored. It appends every blob byte it sends to `served`.
 */
const SERVE = `
const fs = require('node:fs'), path = require('node:path');
const [root, served] = process.argv.slice(1);
require('node:http').createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/api/sas/v1/token/naip') {
    const expiry = new Date(Date.now() + 3600e3).toISOString().replace(/\\.\\d+Z$/, 'Z');
    res.writeHead(200).end(JSON.stringify({ 'msft:expiry': expiry, token: 'st=1&sig=LOCALSIG' }));
    return;
  }
  const item = /^\\/api\\/stac\\/v1\\/collections\\/naip\\/items\\/([^/]+)$/.exec(url.pathname);
  if (item) {
    const href = 'https://naipeuwest.blob.core.windows.net/naip/' + item[1] + '.tif';
    res.writeHead(200).end(JSON.stringify({ assets: { image: { href } } }));
    return;
  }
  let body;
  try { body = fs.readFileSync(path.join(root, decodeURIComponent(url.pathname))); }
  catch { res.writeHead(404).end(); return; }
  const m = /bytes=(\\d+)-(\\d*)/.exec(req.headers.range || '');
  const a = m ? +m[1] : 0, b = m && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
  const head = { 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 };
  if (m) head['Content-Range'] = 'bytes ' + a + '-' + b + '/' + body.length;
  if (req.method === 'GET') fs.appendFileSync(served, (b - a + 1) + '\\n');
  res.writeHead(m ? 206 : 200, head).end(req.method === 'GET' ? body.subarray(a, b + 1) : undefined);
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;

/**
 * A tiled 4-band GeoTIFF over `box` at `res`, NAIP's 0,0,0 outside `[from, to)` in x — as a blob.
 */
function frame(id: string, box: MercatorBounds, res: number, from = -Infinity, to = Infinity) {
  const path = join(blobs, 'naipeuwest', 'naip', `${id}.tif`);
  const r = spawnSync(
    PY,
    [
      '-I',
      '-c',
      `
import numpy as np
from osgeo import gdal, osr
x0, y0, x1, y1, res = ${box.join(', ')}, ${res}
lo, hi = ${Number.isFinite(from) ? from : '-1e18'}, ${Number.isFinite(to) ? to : '1e18'}
w, h = round((x1 - x0) / res), round((y1 - y0) / res)
ds = gdal.GetDriverByName("GTiff").Create("${path}", w, h, 4, gdal.GDT_Byte,
    ["TILED=YES", "BLOCKXSIZE=256", "BLOCKYSIZE=256", "COMPRESS=DEFLATE"])
ds.SetGeoTransform((x0, res, 0, y1, 0, -res))
srs = osr.SpatialReference(); srs.ImportFromEPSG(3857); ds.SetProjection(srs.ExportToWkt())
xs = x0 + (np.arange(w) + 0.5) * res
on = np.broadcast_to((xs >= lo) & (xs < hi), (h, w))
for b, v in zip((1, 2, 3, 4), (90, 110, 70, 150)):
    ds.GetRasterBand(b).WriteArray(np.where(on, v, 0).astype(np.uint8))
ds.BuildOverviews("AVERAGE", [2, 4])
ds = None
`,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`frame ${id}: ${r.stderr}`);
}

let server: ReturnType<typeof spawn> | undefined;
let port = '';
beforeAll(async () => {
  if (!hasGdal) return;
  server = spawn(process.execPath, ['-e', SERVE, blobs, SERVED], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const out = server.stdout;
  if (out === null) throw new Error('the server has no stdout');
  port = await new Promise<string>((ok) => out.once('data', (d) => ok(String(d).trim())));
});
afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** The worker on `unit`, reading the served frames; the bytes the server sent it, by its log. */
function cut(name: string, unit: AerialWorkUnit, script = join(PKG, 'cut-aerial.sh')) {
  const run = join(dir, name);
  mkdirSync(run);
  writeFileSync(join(run, 'unit.json'), JSON.stringify(unit));
  writeFileSync(SERVED, '');
  const base = `http://127.0.0.1:${port}`;
  const res = spawnSync(
    'bash',
    [script, join(run, 'unit.json'), '--local', join(run, 'bucket'), '--keep', join(run, 'work')],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PC_STAC: `${base}/api/stac/v1`,
        PC_SAS: `${base}/api/sas/v1/token/naip`,
        // GDAL's `/vsiaz/` reads the blobs from the local server; the key is never checked.
        AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=naipeuwest;AccountKey=${Buffer.from('k'.repeat(32)).toString('base64')};BlobEndpoint=${base}/naipeuwest`,
        AERIAL_IMAGE: IMAGE,
        AERIAL_PACK: `${TSX} ${join(PKG, 'src', 'tilesPackMain.ts')}`,
        AERIAL_PYTHON: PY,
        AERIAL_WORKDIR: run,
      },
    },
  );
  const sent = readFileSync(SERVED, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .reduce((a, l) => a + Number(l), 0);
  const work = join(run, 'work');
  const bucket = join(run, 'bucket');
  const done = existsSync(join(bucket, unit.keys.done))
    ? JSON.parse(readFileSync(join(bucket, unit.keys.done), 'utf8'))
    : null;
  const reported = /source bytes read: (\d+)\n/.exec(res.stderr)?.[1];
  return {
    ...res,
    sent,
    reported: reported === undefined ? null : Number(reported),
    done,
    work,
    landed: [unit.keys.pack, unit.keys.index, unit.keys.done].every((k) =>
      existsSync(join(bucket, k)),
    ),
    mosaic: existsSync(join(work, 'mosaic.txt'))
      ? readFileSync(join(work, 'mosaic.txt'), 'utf8')
          .trim()
          .split('\n')
          .map((p) => p.slice(p.lastIndexOf('/') + 1))
      : [],
    stats: (n: number) => readFileSync(join(work, 'stats', `${n}.txt`), 'utf8'),
  };
}

/** Every run: to the upload, exit 0, nothing fatal, and every byte sent counted exactly. */
function expectLanded(run: ReturnType<typeof cut>) {
  expect(run.stderr).not.toMatch(/FATAL/);
  expect(run.status).toBe(0);
  expect(run.landed).toBe(true);
  expect(run.done.tiles).toBeGreaterThan(0);
  expect(run.reported).toBeGreaterThan(0);
  expect(run.reported).toBe(run.sent);
  expect(run.stderr).not.toContain('LOCALSIG');
}

// Each run is a few seconds alone and over 20 under a whole-repo `pnpm test` (measured): real GDAL.
describe.skipIf(!hasGdal)(
  'cut-aerial.sh, whole, with real GDAL and served frames',
  { timeout: 120_000 },
  () => {
    it('three single-frame cells: no strip check, empty counts stats, and it lands', () => {
      // A z16 window, three cells side by side across it, each frame its cell and 50 m more.
      const window = { x: 606 * 32 + 10, y: 736 * 32 + 10 };
      const b = tileBounds(16, window.x, window.y);
      const third = (b[2] - b[0]) / 3;
      const keys = ['4407305ne', '4407306nw', '4407306ne'];
      const boxes = keys.map(
        (_, i): MercatorBounds => [
          b[0] + i * third,
          b[1] - 100,
          b[0] + (i + 1) * third,
          b[3] + 100,
        ],
      );
      for (const [i, key] of keys.entries()) {
        const box = boxes[i] as MercatorBounds;
        frame(`single-${key}`, [box[0] - 50, box[1] - 50, box[2] + 50, box[3] + 50], 0.6);
      }
      const unit = buildWorkUnit(
        {
          campaign: 'naip-pilot-20261125',
          pilot: 'served',
          workTile: '11/606/736',
          window: `16/${window.x}/${window.y}`,
          inputHash: 'h',
          cells: keys.map((key) => ({ key, frames: [`single-${key}`] })),
        },
        (key) => outlineOf(boxes[keys.indexOf(key)] as MercatorBounds),
      );
      expect(unit.cells.map((c) => c.key)).toEqual([...keys].sort());
      const run = cut('singles', unit);
      expectLanded(run);
      // Each cell's helper ran no check, so its stats file is empty: 3, 6 and 9, and 9 sorts last.
      for (const n of [3, 6, 9]) expect(run.stats(n)).toBe('');
      for (const n of [1, 2, 4, 5, 7, 8]) expect(run.stats(n)).toMatch(/^Network statistics:/m);
      expect(run.mosaic).toHaveLength(3);
      expect(Object.keys(run.done.cellCounts).sort()).toEqual([...keys].sort());
    });

    it('a pick that misses half its cell, over a fallback that shows there', () => {
      const window = { x: 606 * 32 + 12, y: 736 * 32 + 12 };
      const b = tileBounds(16, window.x, window.y);
      const mid = (b[0] + b[2]) / 2;
      const around: MercatorBounds = [b[0] - 60, b[1] - 60, b[2] + 60, b[3] + 60];
      frame('partial-pick', around, 0.6, mid);
      frame('partial-fallback', around, 0.6);
      const unit = buildWorkUnit(
        {
          campaign: 'naip-pilot-20261125',
          pilot: 'served',
          workTile: '11/606/736',
          window: `16/${window.x}/${window.y}`,
          inputHash: 'h',
          cells: [{ key: '4407305ne', frames: ['partial-pick', 'partial-fallback'] }],
        },
        () => outlineOf([b[0] - 40, b[1] - 40, b[2] + 40, b[3] + 40]),
      );
      const run = cut('partial', unit);
      expectLanded(run);
      const counts = run.done.cellCounts['4407305ne'];
      expect(counts['partial-pick']).toBeGreaterThan(0);
      expect(counts['partial-fallback']).toBeGreaterThan(0);
      // The fallback is drawn over the whole cell, under the pick.
      expect(run.mosaic).toEqual(['4407305ne-1.vrt', '4407305ne-0.vrt']);
      expect(existsSync(join(run.work, 'counts', '4407305ne.windows.json'))).toBe(false);
    });

    it('a strip the counts’ grid can’t see: the check fires, reads, and the fallback is drawn there', () => {
      // `aerialCounts.test.ts`' case: the cell's west edge 0.05 m past a z16 line, the pick's data
      // from 1.1 m inside it, short of the first counted center; the fallback everywhere.
      const cres = (2 * Math.PI * R) / (512 * 2 ** TILE_SETTINGS.countTileZoom);
      const [wx0] = tileBounds(11, 606, 736);
      const line = MERCATOR_ORIGIN + Math.ceil((wx0 + 5000 - MERCATOR_ORIGIN) / cres) * cres;
      const edge = line + 0.05;
      const x17 = Math.floor((edge + 100 - MERCATOR_ORIGIN) / ((2 * Math.PI * R) / 2 ** 17));
      const y17 = 736 * 64 + 20;
      const b = tileBounds(17, x17, y17);
      const around: MercatorBounds = [b[0] - 30, b[1] - 30, b[2] + 30, b[3] + 30];
      frame('strip-pick', around, 0.3, edge + 1.1);
      frame('strip-fallback', around, 0.3);
      const unit = buildWorkUnit(
        {
          campaign: 'naip-pilot-20261125',
          pilot: 'served',
          workTile: '11/606/736',
          window: `17/${x17}/${y17}`,
          inputHash: 'h',
          cells: [{ key: '4407306nw', frames: ['strip-pick', 'strip-fallback'] }],
        },
        () => ({ minLng: lngOf(edge), minLat: 44.0, maxLng: lngOf(edge + 50_000), maxLat: 46.0 }),
      );
      const run = cut('strip', unit);
      expectLanded(run);
      const counts = run.done.cellCounts['4407306nw'];
      expect(counts['strip-fallback']).toBeGreaterThanOrEqual(1);
      const windows = JSON.parse(
        readFileSync(join(run.work, 'counts', '4407306nw.windows.json'), 'utf8'),
      );
      expect(windows['strip-fallback'].length).toBeGreaterThan(0);
      // The check read the source, and that read is counted with the rest.
      expect(run.stats(5)).toMatch(/^Network statistics:/m);
      expect(run.mosaic).toEqual(['4407306nw-1-w1.vrt', '4407306nw-0.vrt']);
    });
  },
);
