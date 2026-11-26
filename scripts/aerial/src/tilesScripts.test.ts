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
import { buildWorkUnit } from './tiles';

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
    `echo "gdalwarp $*" >> "$CALLS"\n[ "\${FAIL_ON:-}" = gdalwarp ] && exit 4\n${last}; echo vrt > "$out"\n`,
  );
  bin(b, 'gdal_translate', `echo "gdal_translate $*" >> "$CALLS"\n${last}; echo tif > "$out"\n`);
  bin(b, 'gdalbuildvrt', `echo "gdalbuildvrt $*" >> "$CALLS"\n${last}; echo vrt > "$out"\n`);
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
    `echo "python3 $*" >> "$CALLS"
out="$2"; shift 2; first=1; printf '{' > "$out"
for p in "$@"; do id="\${p%%=*}"; [ $first = 1 ] && n=7 || n=0; [ $first = 1 ] || printf ',' >> "$out"; printf '"%s": %s' "$id" "$n" >> "$out"; first=0; done
echo '}' >> "$out"
`,
  );
  bin(
    b,
    'rclone',
    `echo "rclone $*" >> "$CALLS"\n[ "\${FAIL_ON:-}" = rclone ] && exit 6\nexit 0\n`,
  );
  return b;
}

function cutAerial(
  opts: { failOn?: string; image?: string; local?: boolean; wholeWorkTile?: boolean } = {},
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
      cells: [
        { key: '4407305ne', frames: ['ny_m_4407305_ne_18_060_20240728'] },
        {
          key: '4407306nw',
          frames: ['vt_m_4407306_nw_18_030_20250811', 'ny_m_4407306_nw_18_060_20240702'],
        },
      ],
    },
    (key) =>
      key === '4407305ne'
        ? { minLng: -73.4375, minLat: 44.9375, maxLng: -73.375, maxLat: 45.0 }
        : { minLng: -73.375, minLat: 44.9375, maxLng: -73.3125, maxLat: 45.0 },
  );
  writeFileSync(join(dir, 'unit.json'), JSON.stringify(unit));
  const calls = join(dir, 'calls.txt');
  writeFileSync(calls, '');
  const res = spawnSync(
    'bash',
    [
      join(PKG, 'cut-aerial.sh'),
      join(dir, 'unit.json'),
      ...(opts.local ? ['--local', join(dir, 'bucket')] : []),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${b}:${process.env.PATH ?? ''}`,
        CALLS: calls,
        AERIAL_IMAGE: opts.image ?? IMAGE,
        AERIAL_PACK: `${TSX} ${join(PKG, 'src', 'tilesPackMain.ts')}`,
        AERIAL_PYTHON: 'python3',
        AERIAL_WORKDIR: dir,
        AERIAL_SAS_MARGIN: '60',
        R2_ACCESS_KEY_ID: 'id',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'bucket',
        ...(opts.failOn !== undefined && { FAIL_ON: opts.failOn }),
      },
    },
  );
  return { ...res, calls: lines(calls), dir, unit };
}

describe('cut-aerial.sh', () => {
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
    expect(uploads.map((u) => u.split(' ')[5])).toEqual([
      `r2:bucket/${run.unit.keys.pack}`,
      `r2:bucket/${run.unit.keys.index}`,
      `r2:bucket/${run.unit.keys.done}`,
    ]);
    expect(run.stderr).toMatch(/source bytes read: 1000/);
    expect(run.stderr).toMatch(/landed 11\/606\/736: 4 tiles/);
    // The scratch is gone, and the rclone config written into it with it.
    expect(readdirSync(run.dir).filter((n) => n.startsWith('aerial.'))).toEqual([]);
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

  test('a failed upload fails the run before the done record', () => {
    const run = cutAerial({ failOn: 'rclone' });
    expect(run.status).not.toBe(0);
    expect(run.calls.filter((c) => c.startsWith('rclone'))).toHaveLength(1);
    expect(run.stderr).toMatch(/uploading the pack failed/);
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
    expect(docker).toMatch(/^ARG RCLONE_VERSION=\d+\.\d+\.\d+$/m);
    expect(docker).toMatch(/^ARG RCLONE_SHA256_AMD64=[0-9a-f]{64}$/m);
    expect(docker).toContain('sha256sum -c -');
  });
});

// ── spawn.sh ─────────────────────────────────────────────────────────────────────────────────────

/** A `fly` that records each call and answers `machine list` from a queue of listings. */
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
  cat "$f"; exit 0
fi
if [ "$1 $2" = "machine run" ]; then [ -n "\${FLY_RUN_FAIL:-}" ] && exit 1; exit 0; fi
exit 0
`,
  );
  return b;
}

function spawnSh(args: string[], opts: { lists?: string[]; env?: Record<string, string> } = {}) {
  const dir = tmp();
  const b = flyTools(dir);
  const lists = join(dir, 'lists');
  mkdirSync(lists);
  const queue = opts.lists ?? [];
  for (const [i, l] of queue.entries()) writeFileSync(join(lists, `${i + 1}.json`), l);
  writeFileSync(join(lists, 'last.json'), '[]');
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
      expect(r).toContain('--vm-size shared-cpu-4x --vm-memory 2048 --detach --rm --restart no');
      expect(r).toContain('--metadata aerial=naip-20261212');
      expect(r).toContain(`--env AERIAL_IMAGE=${IMAGE}`);
      expect(r).toMatch(
        /--file-local \/data\/unit\.json=\S+\/units\/11_60[67]_736\.json -- cut-aerial \/data\/unit\.json$/,
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

  test('a failed list is read as the cap, so it waits rather than floods', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt'], {
      env: { FLY_LIST_FAIL: '1', CAPACITY_TRIES: '2' },
    });
    expect(run.stderr).toMatch(/still 25 Machines alive after waiting/);
  });

  test('--drain waits until the campaign’s Machines have gone, not the app’s', () => {
    const run = spawnSh(['tiles', 'naip-20261212', '$DIR/units', '$DIR/tiles.txt', '--drain'], {
      lists: [
        '[]',
        machine('aerial-20261212-606-736', 'started'),
        machine('aerial-20261212-606-736', 'stopping'),
        // The winter pump's Machine stays up; the drain doesn't wait for it.
        machine('granule-s2a-1', 'started'),
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/drained/);
    expect(run.calls.filter((c) => c.startsWith('fly machine list'))).toHaveLength(3);
  });
});

describe('spawn.sh assemble', () => {
  test('one Machine, 4 GB, the assembler’s entrypoint with the pilot; returns when it has gone', () => {
    const run = spawnSh(['assemble', 'naip-pilot-20261125', '--pilot', 'champlain-nhma-me-ny'], {
      lists: [machine('aerial-asm-p20261125', 'started'), '[]'],
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
    // Stands in for the bundled assembler: says what it was handed.
    bin(
      b,
      'node',
      'echo "node $*"; echo "config=$RCLONE_CONFIG"; stat -f %Lp "$RCLONE_CONFIG" 2>/dev/null || stat -c %a "$RCLONE_CONFIG"; head -1 "$RCLONE_CONFIG"\n',
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
