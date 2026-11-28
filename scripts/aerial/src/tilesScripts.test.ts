/**
 * The tiles stage's three shell scripts, run for real against stand-ins on `PATH` (the way
 * `runCorpus.test.ts` runs `run-corpus.sh`): a failed step must fail the script with its own
 * status, the done record goes up last, a SAS signature never reaches stderr, and every Fly flag
 * the imagery README calls non-optional is on every spawn.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { type AerialWorkUnit, buildWorkUnit } from './tiles';

const PKG = fileURLToPath(new URL('..', import.meta.url));
/** `tsx`, a devDependency of this package, run by the current Node. */
const TSX = `${process.execPath} ${createRequire(import.meta.url).resolve('tsx/cli')}`;
const IMAGE = `registry.fly.io/skating-imagery@sha256:${'d'.repeat(64)}`;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} /;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'aerial-sh-'));
  dirs.push(d);
  return d;
}
function bin(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}`);
  chmodSync(join(dir, name), 0o755);
}
const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    : [];

// ── cut-aerial.sh ────────────────────────────────────────────────────────────────────────────────

/** GDAL, curl, python and rclone stand-ins: each writes what the next step reads, and records. */
function workerTools(dir: string): string {
  const b = join(dir, 'bin');
  mkdirSync(b);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash, not a template.
  const last = 'out="${@: -1}"';
  // Like GDAL, a stand-in that reads the source prints what it fetched only when asked: a read the
  // worker doesn't route through `gdal_read` goes uncounted, as it would on a Machine.
  const fetched = (bytes: number) =>
    `if [ "\${CPL_VSIL_SHOW_NETWORK_STATS:-}" = YES ]; then printf 'Network statistics:\\n{"methods":{"GET":{"count":1,"downloaded_bytes":${bytes}}}}\\n'; fi\n`;
  bin(
    b,
    'curl',
    `url="\${@: -1}"
echo "curl $url" >> "$CALLS"
case "$url" in
  */token/naip) echo '{"msft:expiry":"2099-01-01T00:00:00Z","token":"st=1&sig=SECRETSIG"}' ;;
  */items/*) id="\${url##*/}"; echo "{\\"assets\\":{\\"image\\":{\\"href\\":\\"https://naipeuwest.blob.core.windows.net/naip/v002/x/m_\${id}.tif\\"}}}" ;;
  *) exit 22 ;;
esac
`,
  );
  bin(
    b,
    'gdalwarp',
    // Its open of the source: the COG's header (16 KB with real GDAL; 100 here).
    `echo "gdalwarp $*" >> "$CALLS"\n[ "\${FAIL_ON:-}" = gdalwarp ] && exit 4\n${fetched(100)}${last}; echo vrt > "$out"\n`,
  );
  // A counts alpha reads its warped VRT, so the source (20 here); an overview's reads local tiles.
  bin(
    b,
    'gdal_translate',
    `echo "gdal_translate $*" >> "$CALLS"\n${fetched(20)}${last}; echo tif > "$out"\n`,
  );
  // The mosaic opens its warped layers, and each its source's header (10 here).
  bin(
    b,
    'gdalbuildvrt',
    `echo "gdalbuildvrt $*" >> "$CALLS"\n${fetched(10)}${last}; echo vrt > "$out"\n`,
  );
  bin(
    b,
    'gdal',
    `echo "gdal $*" >> "$CALLS"
echo "HTTP response code on https://naipeuwest.blob.core.windows.net/naip/a.tif?st=1&sig=SECRETSIG: 403" >&2
[ "\${FAIL_ON:-}" = tile ] && exit 5
args=("$@"); out="\${args[-1]}"
get() { local i; for ((i=0;i<\${#args[@]};i++)); do [ "\${args[i]}" = "$1" ] && echo "\${args[i+1]}"; done; }
zmin=$(get --min-zoom); zmax=$(get --max-zoom); minx=$(get --min-x); miny=$(get --min-y)
x=$(( minx >> (zmax - zmin) )); y=$(( miny >> (zmax - zmin) ))
for z in $(seq "$zmin" "$zmax"); do
  s=$(( z - zmin )); mkdir -p "$out/$z/$(( x << s ))"; printf 'webp-%s' "$z" > "$out/$z/$(( x << s ))/$(( y << s )).webp"
done
echo "Network statistics:"
echo '{"methods":{"GET":{"count":1,"downloaded_bytes":1000}},"handlers":{"vsiaz":{"methods":{"GET":{"downloaded_bytes":1000}}}}}'
`,
  );
  bin(
    b,
    'python3',
    // The counts helper takes one job file; the stand-in counts 7 for the pick, 0 for the rest.
    `echo "python3 $*" >> "$CALLS"
job="$2"; jq -c '{ frames: [.frames[].id], extent, res, pad, warp }' "$job" >> "$CALLS"
jq '[.frames[].id] | to_entries | map({ (.value): (if .key == 0 then 7 else 0 end) }) | add' "$job" > "$(jq -r .counts "$job")"
# STRIP: the second frame fills a strip the counts' grid can't see, along the cell's west edge.
if [ -n "\${STRIP:-}" ] && [ "$(jq '.frames | length' "$job")" -gt 1 ]; then
  jq '[.frames[].id] | to_entries | map({ (.value): (if .key == 0 then 7 elif .key == 1 then 1 else 0 end) }) | add' "$job" > "$(jq -r .counts "$job")"
  jq -c '{ (.frames[1].id): [[.extent[0], .extent[1], (.extent[0] + 4 * .res), .extent[3]]] }' "$job" > "$(jq -r .windows "$job")"
  # The check read the strip's source at the deepest zoom.
  ${fetched(500)}fi
`,
  );
  // The TypeScript half, run for real (`PACK_REAL`) unless its `layers` is to fail.
  bin(
    b,
    'aerial-pack',
    `[ "\${FAIL_ON:-}" = layers ] && [ "$1" = layers ] && { echo "tilesPackMain: windows refused" >&2; exit 1; }
exec $PACK_REAL "$@"
`,
  );
  bin(
    b,
    'rclone',
    `echo "rclone $*" >> "$CALLS"
[ "\${FAIL_ON:-}" = rclone ] && exit 6
[ "\${FAIL_ON:-}" = copyto ] && [ "$3" = copyto ] && exit 6
[ "$3" = deletefile ] && [ -n "\${NO_DONE:-}" ] && exit 4
exit 0
`,
  );
  return b;
}

type Outline = { minLng: number; minLat: number; maxLng: number; maxLat: number };
/** Each test cell's outline: the two quarter quads either side of 73.375°W, and `stripCells`'. */
const CELL_OUTLINES: Record<string, Outline> = {
  '4407305ne': { minLng: -73.4375, minLat: 44.9375, maxLng: -73.375, maxLat: 45.0 },
  '4407306nw': { minLng: -73.375, minLat: 44.9375, maxLng: -73.3125, maxLat: 45.0 },
};
/**
 * `n` cells side by side across window 14/4852/5895 (about 1.7 km wide), each `frames` deep. A
 * single-frame cell is the common real shape: its counts helper runs no strip check, so GDAL prints
 * no statistics and its stats file is empty.
 */
function stripCells(n: number, frames = 1): { key: string; frames: string[] }[] {
  const [west, east] = [-73.3886, -73.3668];
  return Array.from({ length: n }, (_, i) => {
    // A quarter quad's shape (`shard.ts`' CELL_KEY), unique per `n` and `i`; never a real one.
    const key = `99${String(n).padStart(2, '0')}${String(i).padStart(3, '0')}sw`;
    const w = (east - west) / n;
    CELL_OUTLINES[key] = {
      minLng: west + i * w,
      minLat: 44.9375,
      maxLng: west + (i + 1) * w,
      maxLat: 45.0,
    };
    return { key, frames: Array.from({ length: frames }, (_, f) => `ny_m_${key}_f${f}`) };
  });
}

function cutAerial(
  opts: {
    failOn?: string;
    image?: string;
    local?: boolean;
    wholeWorkTile?: boolean;
    /** The bucket holds no done record for the work tile yet (rclone's deletefile answers 4). */
    noDone?: boolean;
    /** `--keep <dir>/kept`: the work directory stays. */
    keep?: boolean;
    /** The counts stand-in reports a strip only the second frame fills, with its window. */
    strip?: boolean;
    /** The unit as written, changed (a unit `tiles.ts` would never write). */
    editUnit?: (unit: AerialWorkUnit) => unknown;
    /** The unit's cells, in place of the two below (each in `CELL_OUTLINES`). */
    cells?: { key: string; frames: string[] }[];
  } = {},
) {
  const dir = tmp();
  const b = workerTools(dir);
  const unit = buildWorkUnit(
    {
      campaign: 'naip-pilot-20261125',
      pilot: 'warp-proof',
      workTile: '11/606/736',
      ...(opts.wholeWorkTile ? {} : { window: '14/4852/5895' }),
      inputHash: 'h1',
      cells: opts.cells ?? [
        { key: '4407305ne', frames: ['ny_m_4407305_ne_18_060_20240728'] },
        {
          key: '4407306nw',
          frames: ['vt_m_4407306_nw_18_030_20250811', 'ny_m_4407306_nw_18_060_20240702'],
        },
      ],
    },
    (key) => CELL_OUTLINES[key] as (typeof CELL_OUTLINES)[string],
  );
  writeFileSync(join(dir, 'unit.json'), JSON.stringify(opts.editUnit?.(unit) ?? unit));
  const calls = join(dir, 'calls.txt');
  writeFileSync(calls, '');
  const res = spawnSync(
    'bash',
    [
      join(PKG, 'cut-aerial.sh'),
      join(dir, 'unit.json'),
      ...(opts.local ? ['--local', join(dir, 'bucket')] : []),
      ...(opts.keep ? ['--keep', join(dir, 'kept')] : []),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${b}:${process.env.PATH ?? ''}`,
        CALLS: calls,
        AERIAL_IMAGE: opts.image ?? IMAGE,
        AERIAL_PACK: join(b, 'aerial-pack'),
        PACK_REAL: `${TSX} ${join(PKG, 'src', 'tilesPackMain.ts')}`,
        AERIAL_PYTHON: 'python3',
        AERIAL_WORKDIR: dir,
        AERIAL_SAS_MARGIN: '60',
        R2_ACCESS_KEY_ID: 'id',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'bucket',
        ...(opts.failOn !== undefined && { FAIL_ON: opts.failOn }),
        ...(opts.noDone && { NO_DONE: '1' }),
        ...(opts.strip && { STRIP: '1' }),
      },
    },
  );
  return { ...res, calls: lines(calls), dir, unit };
}

// Each test runs the worker once or more, each run a bash, jq and two `tsx` processes: seconds alone,
// past vitest's 20 s under a whole-repo `pnpm test` beside the real-GDAL proofs (measured).
describe('cut-aerial.sh', { timeout: 60_000 }, () => {
  test('counts, warps only what shows, tiles, packs, and uploads the done record last', () => {
    const run = cutAerial();
    expect(run.stderr).not.toContain('SECRETSIG');
    expect(run.status).toBe(0);
    // Every frame warped on the counts' grid; only the frames that supplied a pixel (each cell's
    // first, per the stand-in counts) on the deepest zoom's — with the cut, no cutline.
    const warps = run.calls.filter((c) => c.startsWith('gdalwarp'));
    expect(warps.filter((w) => w.includes(' near '))).toHaveLength(3);
    const deep = warps.filter((w) => w.includes(' cubic '));
    expect(deep).toHaveLength(2);
    for (const w of warps) {
      expect(w).toContain('-srcnodata 0 0 0 -wo UNIFIED_SRC_NODATA=YES');
      expect(w).not.toContain('-cutline');
      expect(w).toContain('-srcband 1 -srcband 2 -srcband 3 -dstalpha');
    }
    expect(deep.join('\n')).not.toContain('m_ny_m_4407306_nw_18_060_20240702');
    const tile = run.calls.find((c) => c.startsWith('gdal raster tile')) as string;
    expect(tile).toContain(
      '--format WEBP --co QUALITY=80 --tile-size 512 --min-zoom 14 --max-zoom 17',
    );
    expect(tile).toContain('--overview-resampling average');
    const uploads = run.calls.filter((c) => c.startsWith('rclone'));
    // The old done record goes first: nothing may vouch for a pack while it is being replaced.
    expect(uploads.map((u) => u.split(' ')[3])).toEqual([
      'deletefile',
      'copyto',
      'copyto',
      'copyto',
    ]);
    expect(uploads[0]?.split(' ')[4]).toBe(`r2:bucket/${run.unit.keys.done}`);
    expect(uploads.slice(1).map((u) => u.split(' ')[5])).toEqual([
      `r2:bucket/${run.unit.keys.pack}`,
      `r2:bucket/${run.unit.keys.index}`,
      `r2:bucket/${run.unit.keys.done}`,
    ]);
    // Every read of the source: the tiler's 1,000, five warps' opens at 100, three counts' alphas'
    // reads at 20, the mosaic's 10.
    expect(run.stderr).toMatch(/source bytes read: 1570\n/);
    expect(run.stderr).toMatch(/landed 11\/606\/736: 4 tiles/);
    // The scratch is gone, and the rclone config written into it with it.
    expect(readdirSync(run.dir).filter((n) => n.startsWith('aerial.'))).toEqual([]);
  });

  test('three single-frame cells: no strip check, empty stats files, and still it uploads', () => {
    // Stats files 3, 6 and 9 are the counts helper's, empty (no check ran); with fewer than 90 the
    // glob's order ends at `9.txt`. The collector once ended its loop on `[[ -s 9.txt ]] && …`,
    // whose 1 under `pipefail` and `set -e` stopped the worker after the pack, before the upload —
    // and again on every retry of the work tile.
    const run = cutAerial({ cells: stripCells(3), keep: true });
    expect(run.stderr).not.toMatch(/FATAL/);
    expect(run.status).toBe(0);
    const stats = join(run.dir, 'kept', 'stats');
    const empty = readdirSync(stats).filter((f) => readFileSync(join(stats, f), 'utf8') === '');
    expect(empty.sort()).toEqual(['3.txt', '6.txt', '9.txt']);
    expect(readdirSync(stats).sort().at(-1)).toBe('9.txt');
    expect(run.calls.filter((c) => c.startsWith('rclone')).map((u) => u.split(' ')[3])).toEqual([
      'deletefile',
      'copyto',
      'copyto',
      'copyto',
    ]);
    // Three counts' warps and alphas, three deepest-zoom warps, the mosaic, the tiler.
    expect(run.stderr).toMatch(/source bytes read: 1670\n/);
    expect(run.stderr).toMatch(/landed 11\/606\/736/);
  });

  test('any number of cells, any depth: the worker always reaches the upload', () => {
    // The stats files' glob order turns on how many there are (`9.txt` sorts last from 10 to 89,
    // `99.txt` from 99 on), so a collector that trips on an empty one fails only some work tiles.
    for (const [n, frames] of [
      [1, 1],
      [4, 1],
      [1, 4],
      // 138 stats files: `99.txt`, the 33rd cell's counts and empty, sorts last.
      [34, 1],
    ] as const) {
      const run = cutAerial({ cells: stripCells(n, frames) });
      expect({ n, frames, status: run.status, fatal: /FATAL/.test(run.stderr) }).toEqual({
        n,
        frames,
        status: 0,
        fatal: false,
      });
      expect(run.calls.filter((c) => c.startsWith('rclone'))).toHaveLength(4);
      expect(run.stderr).toMatch(/source bytes read: [1-9]\d*\n/);
    }
    // Four runs, the last of 34 cells: seconds here, and CI runs ~8× slower.
  }, 180_000);

  /** A warp call's `-te` box, as numbers (jq and JavaScript may print a float differently). */
  const teOf = (call: string) =>
    (/-te (\S+) (\S+) (\S+) (\S+) /.exec(call)?.slice(1) ?? []).map(Number);
  const sameBox = (a: number[], b: readonly number[]) =>
    a.length === 4 && a.every((v, i) => Math.abs(v - (b[i] as number)) < 1e-6);

  test('counts on the padded counts window and hands the helper the deepest zoom’s warp', () => {
    const run = cutAerial();
    expect(run.status).toBe(0);
    const near = run.calls.filter((c) => c.startsWith('gdalwarp') && c.includes(' near '));
    for (const cell of run.unit.cells) {
      const mine = near.filter((w) => sameBox(teOf(w), cell.countWindow));
      expect(mine).toHaveLength(cell.frames.length);
    }
    const jobs = run.calls.filter((c) => c.startsWith('{"frames"')).map((j) => JSON.parse(j));
    expect(jobs.map((j) => j.frames)).toEqual(run.unit.cells.map((c) => c.frames));
    for (const [i, j] of jobs.entries()) {
      expect(j).toMatchObject({
        extent: run.unit.cells[i]?.extent,
        res: run.unit.resolution,
        pad: 1,
        warp: { bands: [1, 2, 3], srcNodata: '0 0 0', resampling: 'cubic' },
      });
    }
  });

  test('a frame that fills only a strip is warped on its window alone, under the pick', () => {
    const run = cutAerial({ strip: true, keep: true });
    expect(run.status).toBe(0);
    const cell = run.unit.cells.find((c) => c.key === '4407306nw') as (typeof run.unit.cells)[0];
    const deep = run.calls.filter((c) => c.startsWith('gdalwarp') && c.includes(' cubic '));
    const strip = [
      cell.extent[0],
      cell.extent[1],
      cell.extent[0] + 4 * run.unit.resolution,
      cell.extent[3],
    ];
    // The fallback once, on its window; the two picks on their cells.
    expect(deep).toHaveLength(3);
    expect(deep.filter((w) => sameBox(teOf(w), strip))).toHaveLength(1);
    expect(deep.filter((w) => sameBox(teOf(w), cell.extent))).toHaveLength(1);
    const mosaic = readFileSync(join(run.dir, 'kept', 'mosaic.txt'), 'utf8')
      .trim()
      .split('\n');
    expect(mosaic.map((p) => p.slice(p.lastIndexOf('/') + 1))).toEqual([
      '4407305ne-0.vrt',
      '4407306nw-1-w1.vrt',
      '4407306nw-0.vrt',
    ]);
    // The check's 500 bytes count with every other read: the tiler's 1,000, six warps' 600, three
    // alphas' 60, the mosaic's 10 — in the log and in the figure the warp proof's measurements read.
    expect(run.stderr).toMatch(/source bytes read: 2170\n/);
    expect(readFileSync(join(run.dir, 'kept', 'source-bytes'), 'utf8')).toBe('2170\n');
  });

  test('--local writes the shard under its keys; its done record is checked and dated', () => {
    const run = cutAerial({ local: true });
    expect(run.status).toBe(0);
    const done = JSON.parse(readFileSync(join(run.dir, 'bucket', run.unit.keys.done), 'utf8'));
    expect(done).toMatchObject({
      campaign: 'naip-pilot-20261125',
      workTile: '11/606/736',
      inputHash: 'h1',
      image: IMAGE,
      tiles: 4,
      cellCounts: {
        '4407305ne': { ny_m_4407305_ne_18_060_20240728: 7 },
        '4407306nw': { vt_m_4407306_nw_18_030_20250811: 7 },
      },
    });
    expect(Object.keys(done.timings).sort()).toEqual([
      'count',
      'mosaic',
      'resolve',
      'sas',
      'tile',
      'warp',
    ]);
    expect(run.calls.some((c) => c.startsWith('rclone'))).toBe(false);
  });

  test('a failed step fails the run with nothing uploaded, its last words kept', () => {
    for (const step of ['gdalwarp', 'tile']) {
      const run = cutAerial({ failOn: step });
      expect(run.status).not.toBe(0);
      expect(run.calls.some((c) => c.startsWith('rclone'))).toBe(false);
      expect(run.stderr).toMatch(/FATAL/);
      expect(run.stderr).not.toContain('SECRETSIG');
    }
  });

  test('a failed `layers` fails the run: never read as nothing showing, an empty shard landed', () => {
    const run = cutAerial({ failOn: 'layers' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/FATAL: the mosaic's layers failed/);
    expect(run.stderr).not.toMatch(/an empty shard/);
    expect(run.calls.filter((c) => c.includes(' cubic '))).toEqual([]);
    expect(run.calls.some((c) => c.startsWith('rclone'))).toBe(false);
  });

  test('a unit this worker can’t read is refused before anything is read', () => {
    // Each field is read where `set -e` can't see jq fail, so each would have read as nothing.
    const edits: ((u: AerialWorkUnit) => unknown)[] = [
      // Every band warped, the red taken for the alpha.
      ({ settings, ...u }) => ({ ...u, settings: { ...settings, bands: undefined } }),
      ({ settings, ...u }) => ({ ...u, settings: { ...settings, bands: [] } }),
      // The chunk skipped as holding no cell that shows.
      (u) => ({ ...u, chunks: u.chunks.map(({ cells: _, ...c }) => c) }),
      (u) => ({ ...u, cells: u.cells.map(({ frames: _, ...c }) => c) }),
      (u) => ({ ...u, cells: u.cells.map((c) => ({ ...c, extent: c.extent.slice(1) })) }),
      (u) => ({ ...u, overview: { zooms: { min: 11, max: 12 } } }),
      (u) => ({ ...u, keys: { ...u.keys, done: undefined } }),
    ];
    for (const edit of edits) {
      const run = cutAerial({ editUnit: edit });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/is not a work unit this worker can read/);
      expect(run.calls).toEqual([]);
    }
    // A unit `tiles.ts` writes passes: every other test here, windows and whole work tiles alike.
  });

  test('--keep keeps the work, never the rclone config the secrets were written into', () => {
    const run = cutAerial({ keep: true });
    expect(run.status).toBe(0);
    const kept = readdirSync(join(run.dir, 'kept'));
    expect(kept).toContain('shard');
    expect(kept).not.toContain('rclone.conf');
  });

  test('a failed upload fails the run before the done record', () => {
    const run = cutAerial({ failOn: 'copyto' });
    expect(run.status).not.toBe(0);
    expect(run.calls.filter((c) => c.startsWith('rclone'))).toHaveLength(2);
    expect(run.stderr).toMatch(/uploading the pack failed/);
  });

  test('a re-cut drops the old done record before it overwrites the pack, or uploads nothing', () => {
    // A done record left from an earlier cut — whose input hash a later manifest may ask for again —
    // must never vouch for a pack this cut is replacing (a death between the pack and the index
    // would leave the old index over the new pack, and the assembler would copy garbage).
    const failed = cutAerial({ failOn: 'rclone' });
    expect(failed.status).not.toBe(0);
    expect(failed.calls.filter((c) => c.startsWith('rclone'))).toHaveLength(1);
    expect(failed.calls.find((c) => c.startsWith('rclone'))).toContain('deletefile');
    expect(failed.stderr).toMatch(/the old done record could not be dropped/);
    // None there yet (rclone answers 4, "not found"): the cut goes on.
    const first = cutAerial({ noDone: true });
    expect(first.status).toBe(0);
    expect(first.calls.filter((c) => c.startsWith('rclone'))).toHaveLength(4);
  });

  test('refuses an image not pinned by digest before reading anything', () => {
    const run = cutAerial({ image: 'registry.fly.io/skating-imagery:latest' });
    expect(run.status).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toMatch(/by digest/);
  });

  test('a whole work tile: only the chunks a showing cell overlaps are tiled; the overviews stay inside it', () => {
    // The two cells sit in one corner of 11/606/736: most of its sixteen z13 chunks hold no cell,
    // and `gdal raster tile` refuses a range outside its mosaic rather than writing nothing.
    const run = cutAerial({ wholeWorkTile: true, local: true });
    expect(run.status).toBe(0);
    const wanted = run.unit.chunks.filter((c) => c.cells.length > 0);
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.length).toBeLessThan(16);
    const tiles = run.calls.filter((c) => c.startsWith('gdal raster tile'));
    const chunkRuns = tiles.filter((c) => c.includes('--min-zoom 13 --max-zoom 17'));
    expect(chunkRuns.map((c) => /--min-x (\d+)/.exec(c)?.[1])).toEqual(
      wanted.map((c) => String(c.range.minX)),
    );
    expect(run.stderr).toMatch(new RegExp(`tiled ${wanted.length} of 16 chunks`));
    // The zooms above the chunks, and the work tile's own tile: bounded to the work tile.
    const above = tiles.find((c) => c.includes('--min-zoom 12 --max-zoom 12')) as string;
    expect(above).toContain('--min-x 1212 --max-x 1213 --min-y 1472 --max-y 1473');
    const top = tiles.find((c) => c.includes('--min-zoom 11 --max-zoom 11')) as string;
    expect(top).toContain('--min-x 606 --max-x 606 --min-y 736 --max-y 736');
    // Every tiler run spawns: under 8 threads the tiler's own choice is a thread pool, which can't
    // clone the mosaic of warped VRTs and failed every chunk on a 4-CPU Machine (the pilot).
    expect(tiles.length).toBeGreaterThan(2);
    for (const t of tiles) expect(t).toContain('--parallel-method spawn');
  });

  test('set -euo pipefail', () => {
    const flags = readFileSync(join(PKG, 'cut-aerial.sh'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('set '));
    expect(flags).toEqual(['set -euo pipefail']);
  });
});

// ── The image ────────────────────────────────────────────────────────────────────────────────────

describe('the Dockerfile', () => {
  test('rclone is a pinned, checksummed release, never Ubuntu’s', () => {
    // Ubuntu 24.04's rclone 1.60.1 answers 501 on every upload's first attempt to R2, and `rcat`
    // can't retry: the pilot's assembler failed on its first write (2026-11-26).
    const docker = readFileSync(join(PKG, 'Dockerfile'), 'utf8');
    const apt = /apt-get install[^\n]*(?:\\\n[^\n]*)*/.exec(docker)?.[0] ?? '';
    expect(apt).not.toMatch(/\brclone\b/);
    expect(docker).toMatch(/^ARG DEB_RCLONE_RELEASE=\d+\.\d+\.\d+$/m);
    expect(docker).toMatch(/^ARG DEB_RCLONE_SHA256_AMD64=[0-9a-f]{64}$/m);
    expect(docker).toContain('sha256sum -c -');
    // rclone reads any RCLONE_* environment variable as a flag, a build argument's included.
    expect(docker).not.toMatch(/^ARG RCLONE_/m);
  });
});

// ── spawn.sh ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A `fly` that records each call and answers `machine list` from a queue of listings — a listing
 * that reads `FAIL` is an API error, as the real one's exit 1 with nothing on stdout.
 */
function flyTools(dir: string): string {
  const b = join(dir, 'bin');
  mkdirSync(b);
  bin(
    b,
    'fly',
    `echo "fly $*" >> "$CALLS"
if [ "$1 $2" = "machine list" ]; then
  [ -n "\${FLY_LIST_FAIL:-}" ] && exit 1
  n=$(cat "$LISTS/next" 2>/dev/null || echo 1)
  f="$LISTS/$n.json"; [ -f "$f" ] || f="$LISTS/last.json"
  echo $((n + 1)) > "$LISTS/next"
  [ "$(cat "$f")" = FAIL ] && { echo "Error: failed to list machines" >&2; exit 1; }
  cat "$f"; exit 0
fi
if [ "$1 $2" = "machine run" ]; then [ -n "\${FLY_RUN_FAIL:-}" ] && exit 1; exit 0; fi
exit 0
`,
  );
  return b;
}

function spawnSh(
  args: string[],
  opts: { lists?: string[]; last?: string; env?: Record<string, string> } = {},
) {
  const dir = tmp();
  const b = flyTools(dir);
  const lists = join(dir, 'lists');
  mkdirSync(lists);
  const queue = opts.lists ?? [];
  for (const [i, l] of queue.entries()) writeFileSync(join(lists, `${i + 1}.json`), l);
  writeFileSync(join(lists, 'last.json'), opts.last ?? '[]');
  const units = join(dir, 'units');
  mkdirSync(units);
  for (const t of ['11_606_736', '11_607_736']) writeFileSync(join(units, `${t}.json`), '{}');
  writeFileSync(join(dir, 'tiles.txt'), '11/606/736  # a comment\n\n11/607/736\r\n');
  const calls = join(dir, 'calls.txt');
  writeFileSync(calls, '');
  const res = spawnSync(
    'bash',
    [join(PKG, 'spawn.sh'), ...args.map((a) => a.replace('$DIR', dir))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${b}:${process.env.PATH ?? ''}`,
        CALLS: calls,
        LISTS: lists,
        AERIAL_IMAGE: IMAGE,
        POLL_SECONDS: '0',
        // Never the operator's real scripts/aerial/.env.local (which would win over these).
        AERIAL_ENV_FILE: join(dir, 'no-env-file'),
        ...opts.env,
      },
    },
  );
  return {
    ...res,
    calls: lines(calls),
    runs: lines(calls).filter((c) => c.startsWith('fly machine run')),
  };
}

const machine = (name: string, state: string) => JSON.stringify([{ name, state }]);

describe('spawn.sh tiles', () => {
  test('one Machine per work tile, each with every flag that makes it a batch job', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt']);
    expect(run.status).toBe(0);
    expect(run.runs).toHaveLength(2);
    for (const r of run.runs) {
      expect(r).toContain(`fly machine run ${IMAGE} --app skating-imagery --region ams`);
      // performance-4x by default: the pilot's shared-cpu-4x throttled to under half a core.
      expect(r).toContain('--vm-size performance-4x --vm-memory 8192 --detach --rm --restart no');
      expect(r).toContain('--metadata aerial=naip-20261212');
      expect(r).toContain(`--env AERIAL_IMAGE=${IMAGE}`);
      // Under a deadline: a hung worker is killed (the next round re-cuts it), never left billing.
      expect(r).toMatch(
        /--file-local \/data\/unit\.json=\S+\/units\/11_60[67]_736\.json -- timeout --kill-after=60 3600 cut-aerial \/data\/unit\.json$/,
      );
    }
    expect(run.runs.map((r) => r.match(/--name (\S+)/)?.[1]).sort()).toEqual([
      'aerial-20261212-606-736',
      'aerial-20261212-607-736',
    ]);
  });

  test('refuses an image not pinned by digest, a missing unit, or a bad line — before any spawn', () => {
    const image = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      env: { AERIAL_IMAGE: 'registry.fly.io/skating-imagery:deployment-1' },
    });
    expect(image.status).toBe(1);
    expect(image.stderr).toMatch(/pinned by digest/);
    const dir = tmp();
    writeFileSync(join(dir, 'list.txt'), '11/606/736\n11/9/9\n');
    const missing = spawnSh(['tiles', 'naip-20261212', '$DIR/units', join(dir, 'list.txt')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no unit for 11\/9\/9/);
    expect(missing.runs).toEqual([]);
    writeFileSync(join(dir, 'bad.txt'), '12/1/1\n');
    expect(spawnSh(['tiles', 'naip-20261212', '$DIR/units', join(dir, 'bad.txt')]).stderr).toMatch(
      /not a work tile/,
    );
    for (const args of [['tiles'], ['nope', 'naip-20261212'], ['tiles', 'naip-2026', 'u', 'l']]) {
      expect(spawnSh(args).status).toBe(64);
    }
  });

  test('a failed list is read as the cap, so it waits rather than floods — and never spawns past it', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      lists: ['[]'],
      last: 'FAIL',
      env: { CAPACITY_TRIES: '2' },
    });
    expect(run.stderr).toMatch(/still 25 Machines alive after waiting/);
    // Waiting out the cap is not room under it: the round fails, and the next one resumes.
    expect(run.status).toBe(1);
    expect(run.runs).toEqual([]);
  });

  test('a full app stays full: no spawn while the winter pump holds the cap', () => {
    const full = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => ({ name: `granule-s2a-${i}`, state: 'started' })),
    );
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      last: full,
      env: { CAPACITY_TRIES: '3' },
    });
    expect(run.status).toBe(1);
    expect(run.runs).toEqual([]);
  });

  test('a work tile whose Machine is still up is waited for, never spawned a second time', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      lists: [
        JSON.stringify([
          { name: 'aerial-20261212-606-736', state: 'started' },
          // Gone, or another campaign's: neither is this round's.
          { name: 'aerial-20261212-607-736', state: 'stopped' },
          { name: 'aerial-20261213-607-736', state: 'started' },
        ]),
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/11\/606\/736 is still running/);
    expect(run.runs).toHaveLength(1);
    expect(run.runs[0]).toContain('--name aerial-20261212-607-736');
  });

  test('can’t tell is never none: a listing that keeps failing spawns nothing', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      env: { FLY_LIST_FAIL: '1', LIST_TRIES: '3' },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/which work tiles are still running can't be told/);
    expect(run.calls.filter((c) => c.startsWith('fly machine list'))).toHaveLength(3);
    expect(run.runs).toEqual([]);
    // A listing that fails once and then answers is a listing.
    const blip = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      lists: ['FAIL', '[]'],
    });
    expect(blip.status).toBe(0);
    expect(blip.runs).toHaveLength(2);
  });

  test('the deadline is whole seconds, or nothing starts', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      env: { AERIAL_TILE_DEADLINE: '1h' },
    });
    expect(run.status).toBe(64);
    expect(run.runs).toEqual([]);
    const short = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      env: { AERIAL_TILE_DEADLINE: '900' },
    });
    expect(short.runs[0]).toContain('-- timeout --kill-after=60 900 cut-aerial');
  });

  // The real coreutils `timeout` (the image's Ubuntu has it; CI's Linux too), never a stand-in: the
  // flags spawn.sh passes must parse, and a worker's children — GDAL under cut-aerial — must die with it.
  const hasTimeout = spawnSync('timeout', ['--version'], { encoding: 'utf8' }).stdout?.includes(
    'coreutils',
  );
  test.skipIf(!hasTimeout)('the deadline kills a hung worker and its children, with 124', () => {
    const dir = tmp();
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();
    const res = spawnSync(
      'timeout',
      ['--kill-after=60', '1', 'bash', '-c', `sleep 30 & echo $! > ${pidFile}; wait`],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(124);
    expect(Date.now() - started).toBeLessThan(15_000);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    expect(spawnSync('kill', ['-0', String(child)]).status).not.toBe(0);
  });

  test('--drain waits until the campaign’s Machines have gone, not the app’s', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt', '--drain'], {
      lists: [
        // What is still running, then the room under the cap, then the drain.
        '[]',
        '[]',
        machine('aerial-20261212-606-736', 'started'),
        machine('aerial-20261212-606-736', 'stopping'),
        // The winter pump's Machine stays up; the drain doesn't wait for it.
        machine('granule-s2a-1', 'started'),
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/drained/);
    expect(run.calls.filter((c) => c.startsWith('fly machine list'))).toHaveLength(4);
  });
});

describe('spawn.sh assemble', () => {
  test('one Machine, 4 GB, the assembler’s entrypoint with the pilot; returns when it has gone', () => {
    const run = spawnSh(['assemble', 'naip-pilot-20261125', '--pilot', 'champlain-nhma-me-ny'], {
      // Not already running; room under the cap; up, then gone.
      lists: ['[]', '[]', machine('aerial-asm-p20261125', 'started'), '[]'],
    });
    expect(run.status).toBe(0);
    expect(run.runs).toHaveLength(1);
    expect(run.runs[0]).toContain(
      '--region iad --vm-size shared-cpu-4x --vm-memory 4096 --detach --rm --restart no',
    );
    expect(run.runs[0]).toContain('--name aerial-asm-p20261125');
    expect(run.runs[0]).toMatch(
      /-- assemble-aerial naip-pilot-20261125 --pilot champlain-nhma-me-ny$/,
    );
  });

  test('the assembler waits for room under the cap too, and never spawns past it', () => {
    const full = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => ({ name: `granule-s2a-${i}`, state: 'started' })),
    );
    const run = spawnSh(['assemble', 'naip-20261212'], {
      last: full,
      env: { CAPACITY_TRIES: '2' },
    });
    expect(run.status).toBe(1);
    expect(run.runs).toEqual([]);
  });

  test('a re-run attaches to the assembler already running, and starts no second one', () => {
    const up = machine('aerial-asm-20261212', 'started');
    const run = spawnSh(['assemble', 'naip-20261212'], { lists: [up, up, up, '[]'] });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/aerial-asm-20261212 is already running: following it/);
    expect(run.runs).toEqual([]);
    expect(run.stdout).toMatch(/has gone/);
  });

  test('starts nothing when whether one is running can’t be told; says 3 when it gives up on a live one', () => {
    const blind = spawnSh(['assemble', 'naip-20261212'], {
      env: { FLY_LIST_FAIL: '1', LIST_TRIES: '2' },
    });
    expect(blind.status).toBe(1);
    expect(blind.stderr).toMatch(/whether aerial-asm-20261212 is already running can't be told/);
    expect(blind.runs).toEqual([]);
    const slow = spawnSh(['assemble', 'naip-20261212'], {
      lists: ['[]', '[]'],
      last: machine('aerial-asm-20261212', 'started'),
      env: { ASSEMBLE_TRIES: '3' },
    });
    expect(slow.runs).toHaveLength(1);
    expect(slow.status).toBe(3);
    expect(slow.stderr).toMatch(/still alive — gave up waiting/);
  });

  test('a failed spawn fails; a stray argument is refused', () => {
    expect(spawnSh(['assemble', 'naip-20261212'], { env: { FLY_RUN_FAIL: '1' } }).status).toBe(1);
    expect(spawnSh(['assemble', 'naip-20261212', '--old', 'x']).status).toBe(64);
  });
});

// ── run-aerial.sh ────────────────────────────────────────────────────────────────────────────────

function runAerial(
  args: string[],
  opts: { failOn?: string; deployment?: string; pipe?: boolean; envFile?: string } = {},
) {
  const dir = tmp();
  const b = join(dir, 'bin');
  mkdirSync(b);
  // Stands in for `pnpm`: the stage CLIs are recorded (and one fails); `exec tsx` runs for real.
  bin(
    b,
    'pnpm',
    `if [ "$1" = "--silent" ] && [ "$2" = "exec" ]; then shift 2; exec $TSX_REAL "\${@:2}"; fi
echo "$*" >> "$CALLS"
echo "ran $3"
if [ -n "\${FAIL_ON:-}" ] && [ "$3" = "$FAIL_ON" ]; then echo "boom: $3 failed" >&2; printf 'last words' >&2; exit 3; fi
`,
  );
  const calls = join(dir, 'calls.txt');
  writeFileSync(calls, '');
  const outPath = join(dir, 'stdout.txt');
  const out = openSync(outPath, 'w');
  const res = spawnSync('bash', [join(PKG, 'run-aerial.sh'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: opts.pipe ? 'pipe' : ['ignore', out, out],
    env: {
      ...process.env,
      PATH: `${b}:${process.env.PATH ?? ''}`,
      CALLS: calls,
      TSX_REAL: TSX,
      PWD: dir,
      AERIAL_SCRATCH_DIR: join(dir, 'scratch'),
      // Never the operator's real scripts/aerial/.env.local: a test reads only what it writes.
      AERIAL_ENV_FILE: opts.envFile ?? join(dir, 'no-env-file'),
      CONVEX_DEPLOYMENT: opts.deployment ?? 'dev:quick-fox-123',
      ...(opts.failOn !== undefined && { FAIL_ON: opts.failOn }),
    },
  });
  closeSync(out);
  const log = join(dir, 'scratch', `run-${args[0]}.log`);
  return {
    status: res.status,
    dir,
    out: readFileSync(outPath, 'utf8') + (res.stderr ?? ''),
    log: lines(log),
    calls: lines(calls),
  };
}

describe('run-aerial.sh', () => {
  test('all: the four stages in order, the flags forwarded but --stage, every line stamped', () => {
    const run = runAerial(['naip-20261212', '--stage', 'all', '--dry-run', '--cells', 'cells.txt']);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(
      ['select', 'tiles', 'assemble', 'verify'].map(
        (s) => `--filter @skating/aerial ${s} naip-20261212 --dry-run --cells ${run.dir}/cells.txt`,
      ),
    );
    expect(run.log.length).toBeGreaterThan(5);
    for (const l of run.log) expect(l).toMatch(STAMP);
    expect(run.log.join('\n')).toMatch(/ran tiles/);
  });

  test('a failing stage’s own status, nothing after it, its last words logged', () => {
    const run = runAerial(['naip-20261212'], { failOn: 'tiles' });
    expect(run.status).toBe(3);
    expect(run.calls.map((c) => c.split(' ')[2])).toEqual(['select', 'tiles']);
    expect(run.log.at(-1)).toMatch(STAMP);
    expect(run.log.at(-1)).toContain('last words');
    expect(run.log.join('\n')).not.toMatch(/done —/);
  });

  test('refuses to be piped', () => {
    const run = runAerial(['naip-20261212'], { pipe: true });
    expect(run.status).toBe(64);
    expect(run.out).toMatch(/refuses to be piped/);
    expect(run.calls).toEqual([]);
  });

  test('a pilot against dev is refused before anything runs or logs; against a local backend it runs', () => {
    const pilot = ['naip-pilot-20261125', '--pilot', 'champlain-nhma-me-ny', '--stage=tiles'];
    const refused = runAerial(pilot);
    expect(refused.status).toBe(64);
    expect(refused.out).toMatch(/local deployment only/);
    expect(refused.calls).toEqual([]);
    expect(refused.log).toEqual([]);
    const ok = runAerial(pilot, { deployment: 'local:local-skating' });
    expect(ok.status).toBe(0);
    expect(ok.calls).toEqual([
      '--filter @skating/aerial tiles naip-pilot-20261125 --pilot champlain-nhma-me-ny',
    ]);
  });

  test('no campaign is a usage error', () => {
    expect(runAerial([]).status).toBe(64);
  });

  test('loads scripts/aerial/.env.local before the target check, and never prints it', () => {
    const env = join(tmp(), 'env.local');
    writeFileSync(env, 'CONVEX_DEPLOYMENT=local:local-skating\nR2_BUCKET=bucket-from-file\n');
    const pilot = ['naip-pilot-20261125', '--pilot', 'champlain-nhma-me-ny', '--stage=tiles'];
    const run = runAerial(pilot, { envFile: env });
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(`${run.out}\n${run.log.join('\n')}`).not.toContain('bucket-from-file');
  });
});

// ── assemble-aerial.sh ───────────────────────────────────────────────────────────────────────────

describe('assemble-aerial.sh', () => {
  function assembleAerial(env: Record<string, string>) {
    const dir = tmp();
    const b = join(dir, 'bin');
    mkdirSync(b);
    bin(b, 'rclone', 'exit 0\n');
    bin(b, 'gdal_translate', 'exit 0\n');
    // Stands in for the bundled assembler: says what it was handed. GNU `stat -c` first: on Linux
    // `stat -f` is the filesystem's status, which it prints to stdout before failing on `%Lp`
    // (CI's red on #188); BSD's `stat -c` fails with nothing on stdout.
    bin(
      b,
      'node',
      'echo "node $*"; echo "config=$RCLONE_CONFIG"; stat -c %a "$RCLONE_CONFIG" 2>/dev/null || stat -f %Lp "$RCLONE_CONFIG"; head -1 "$RCLONE_CONFIG"\n',
    );
    const res = spawnSync(
      'bash',
      [join(PKG, 'assemble-aerial.sh'), 'naip-pilot-20261125', '--pilot', 'champlain-nhma-me-ny'],
      {
        encoding: 'utf8',
        env: { PATH: `${b}:/usr/bin:/bin`, AERIAL_WORKDIR: join(dir, 'data'), ...env },
      },
    );
    return { ...res, dir };
  }
  const SECRETS = {
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_ENDPOINT: 'https://r2.example',
    R2_BUCKET: 'bucket',
  };

  test('writes the r2 remote (owner-only), exports it, and hands the arguments to the assembler', () => {
    const run = assembleAerial(SECRETS);
    expect(run.status).toBe(0);
    expect(run.stdout.split('\n')).toEqual([
      'node /app/dist/assemble.mjs naip-pilot-20261125 --pilot champlain-nhma-me-ny',
      `config=${join(run.dir, 'data', 'rclone.conf')}`,
      '600',
      '[r2]',
      '',
    ]);
    expect(run.stdout + run.stderr).not.toContain('secret');
  });

  test('refuses a missing secret by name, before anything runs', () => {
    for (const name of Object.keys(SECRETS)) {
      const env: Record<string, string> = { ...SECRETS };
      delete env[name];
      const run = assembleAerial(env);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`missing required secret: ${name}`);
      expect(run.stdout).toBe('');
    }
  });
});
