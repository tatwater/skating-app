import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildOverviews,
  gdalRenderer,
  parentTranslateArgs,
  parentVrt,
  webpHasAlpha,
} from './overviews';
import { mustRun, runProcess } from './process';
import {
  fileSink,
  fileStore,
  HTTP_ATTEMPTS,
  hashingSink,
  httpStore,
  memorySink,
  sha256Hex,
} from './stores';

let dir: string;
let server: Server;
let base: string;
const OBJECT = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'naip-io-'));
  await writeFile(join(dir, 'obj.bin'), OBJECT);
  // A server shaped like R2 / `rclone serve http`: 206 for a range (clamped at the end), 404, HEAD.
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').slice(1));
    if (path === 'ignores-range') {
      res.writeHead(200, { 'content-length': OBJECT.length });
      res.end(Buffer.from(OBJECT));
      return;
    }
    if (path === 'broken') {
      res.writeHead(500);
      res.end();
      return;
    }
    if (path === 'no-length' && req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (path !== 'dir/o b.bin') {
      res.writeHead(404);
      res.end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), OBJECT.length - 1);
      res.writeHead(206, { 'content-length': end - start + 1 });
      res.end(Buffer.from(OBJECT.subarray(start, end + 1)));
      return;
    }
    res.writeHead(200, { 'content-length': OBJECT.length });
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(OBJECT));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const collect = async (it: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};

describe('the HTTP store (R2’s public URL, or rclone serve http)', () => {
  const waits: number[] = [];
  const store = () =>
    httpStore(base, fetch, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

  it('gets, ranges, streams, sizes, and escapes keys per segment', async () => {
    const s = store();
    expect(await s.get('dir/o b.bin')).toEqual(OBJECT);
    expect(await s.get('missing')).toBeNull();
    expect(await s.range('dir/o b.bin', 10, 5)).toEqual(OBJECT.subarray(10, 15));
    expect(await collect(s.rangeStream('dir/o b.bin', 990, 10))).toEqual(OBJECT.subarray(990));
    expect(await collect(s.rangeStream('dir/o b.bin', 0, 0))).toEqual(new Uint8Array(0));
    expect(await s.rangeUpTo('dir/o b.bin', 995, 100)).toEqual(OBJECT.subarray(995));
    expect(await s.size('dir/o b.bin')).toBe(1000);
    expect(await s.exists('missing')).toBe(false);
    expect(await s.exists('dir/o b.bin')).toBe(true);
    expect(httpStore(`${base}/`).name).toBe(`${base}/`);
  });

  it('refuses a server that ignores Range, a short range, an error, a HEAD with no length', async () => {
    const s = store();
    await expect(s.range('ignores-range', 0, 10)).rejects.toThrow('answered 200, not 206');
    await expect(s.range('dir/o b.bin', 995, 10)).rejects.toThrow('got 5');
    await expect(collect(s.rangeStream('dir/o b.bin', 995, 10))).rejects.toThrow('got 5');
    await expect(s.get('broken')).rejects.toThrow('answered 500');
    await expect(s.size('broken')).rejects.toThrow('answered 500');
    await expect(s.size('no-length')).rejects.toThrow('no content-length');
    // A 500 was retried, with backoff, before it failed; a 404, a 200 for a range and a short read
    // never were.
    expect(waits).toEqual([1000, 4000, 16000, 1000, 4000, 16000]);
  });

  it('waits out a transient failure — a network error, a 5xx, a 429 — and never retries a 4xx', async () => {
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 429 }),
      () => new Response(Uint8Array.of(1, 2, 3), { status: 206 }),
    ];
    let calls = 0;
    const slept: number[] = [];
    const flaky = httpStore(
      'http://r2.invalid',
      async () => (answers[calls++] as () => Response)(),
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(await flaky.range('k', 0, 3)).toEqual(Uint8Array.of(1, 2, 3));
    expect(calls).toBe(HTTP_ATTEMPTS);
    expect(slept).toEqual([1000, 4000, 16000]);

    let denied = 0;
    const forbidden = httpStore(
      'http://r2.invalid',
      async () => {
        denied++;
        return new Response(null, { status: 403 });
      },
      { sleep: async () => {} },
    );
    await expect(forbidden.get('k')).rejects.toThrow('answered 403');
    await expect(forbidden.size('k')).rejects.toThrow('answered 403');
    await expect(forbidden.range('k', 0, 1)).rejects.toThrow('answered 403, not 206');
    expect(denied).toBe(3);

    // A stream retries until its first byte, and a down server fails after its attempts.
    let tries = 0;
    const down = httpStore(
      'http://r2.invalid',
      async () => {
        tries++;
        return tries < 3
          ? new Response(null, { status: 502 })
          : new Response(Uint8Array.of(9, 9), { status: 206 });
      },
      { sleep: async () => {} },
    );
    expect(await collect(down.rangeStream('k', 0, 2))).toEqual(Uint8Array.of(9, 9));
    const dead = httpStore(
      'http://r2.invalid',
      async () => {
        throw new TypeError('fetch failed');
      },
      { sleep: async () => {}, attempts: 2 },
    );
    await expect(dead.rangeUpTo('k', 0, 2)).rejects.toThrow('fetch failed');
  });
});

describe('the file store and sinks', () => {
  it('reads like the HTTP store, and refuses a key that escapes it', async () => {
    const s = fileStore(dir);
    expect(await s.get('obj.bin')).toEqual(OBJECT);
    expect(await s.get('nope')).toBeNull();
    expect(await s.range('obj.bin', 3, 4)).toEqual(OBJECT.subarray(3, 7));
    await expect(s.range('obj.bin', 998, 4)).rejects.toThrow('the object ends 2 in');
    expect(await collect(s.rangeStream('obj.bin', 100, 900))).toEqual(OBJECT.subarray(100));
    expect(await collect(s.rangeStream('obj.bin', 0, 0))).toEqual(new Uint8Array(0));
    await expect(collect(s.rangeStream('obj.bin', 990, 20))).rejects.toThrow('got 10');
    expect(await s.rangeUpTo('obj.bin', 990, 20)).toEqual(OBJECT.subarray(990));
    expect(await s.size('obj.bin')).toBe(1000);
    expect(await s.exists('nope')).toBe(false);
    await expect(s.get('../escape')).rejects.toThrow('escapes the store');
    await expect(s.size('obj.bin/inside-a-file')).rejects.toThrow();
    await expect(s.get('obj.bin/inside-a-file')).rejects.toThrow();
  });

  it('hashes and counts what passes, and writes files with their directories', async () => {
    const inner = memorySink();
    const sink = hashingSink(inner);
    expect(() => sink.sha256()).toThrow('has not ended');
    await sink.write(OBJECT.subarray(0, 600));
    await sink.write(OBJECT.subarray(600));
    await sink.end();
    expect(sink.bytes).toBe(1000);
    expect(sink.sha256()).toBe(sha256Hex(OBJECT));
    expect(inner.bytes()).toEqual(OBJECT);

    const f = await fileSink(join(dir, 'deep', 'er', 'out.bin'));
    await f.write(Uint8Array.of(1, 2));
    await f.end();
    expect(new Uint8Array(await readFile(join(dir, 'deep', 'er', 'out.bin')))).toEqual(
      Uint8Array.of(1, 2),
    );
    const broken = await fileSink(join(dir, 'deep'));
    await expect(broken.write(Uint8Array.of(1))).rejects.toThrow();
    await expect(broken.end()).rejects.toThrow();
  });
});

describe('processes', () => {
  it('captures output and exit codes, and mustRun throws with the stderr tail', async () => {
    const ok = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write("hi"); process.stderr.write("e")',
    ]);
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: 'e' });
    expect(await mustRun(runProcess, process.execPath, ['-e', 'process.stdout.write("x")'])).toBe(
      'x',
    );
    await expect(
      mustRun(runProcess, process.execPath, ['-e', 'console.error("boom"); process.exit(3)']),
    ).rejects.toThrow('exited 3: boom');
    await expect(mustRun(runProcess, process.execPath, ['-e', 'process.exit(4)'])).rejects.toThrow(
      /exited 4$/,
    );
    await expect(runProcess('definitely-not-a-command-here', [])).rejects.toThrow();
  });
});

describe('overviews', () => {
  const top = new Map<number, Uint8Array>([
    [zxyToTileId(11, 1206, 1462), Uint8Array.of(1)],
    [zxyToTileId(11, 1207, 1462), Uint8Array.of(2)],
    [zxyToTileId(11, 1206, 1464), Uint8Array.of(3)],
  ]);

  it('builds each level from the one below, shallowest first, a parent per child group', async () => {
    const calls: number[] = [];
    const levels = await buildOverviews(
      top,
      {
        async render(children) {
          calls.push(children.length);
          return Uint8Array.of(children.length, ...children.map((c) => c.dx * 2 + c.dy));
        },
      },
      { fromZoom: 11, minZoom: 7, concurrency: 2 },
    );
    expect(levels.map((l) => l.zoom)).toEqual([7, 8, 9, 10]);
    const z10 = levels[3]?.tiles.map((t) => tileIdToZxy(t.tileId));
    // Ascending tile id: Hilbert order, which here visits y 732 first.
    expect(z10).toEqual([
      [10, 603, 732],
      [10, 603, 731],
    ]);
    expect(levels[3]?.tiles[1]?.bytes).toEqual(Uint8Array.of(2, 0, 2));
    // Children rendered: z10 3 (into 2 parents), z9 2, z8 2, z7 2 (one parent, both halves).
    expect(calls.reduce((a, b) => a + b, 0)).toBe(3 + 2 + 2 + 2);
    await expect(
      buildOverviews(
        new Map([[zxyToTileId(9, 0, 0), Uint8Array.of(1)]]),
        { render: async () => Uint8Array.of() },
        {
          fromZoom: 11,
          minZoom: 10,
        },
      ),
    ).rejects.toThrow('not 11');
  });

  it('places each child in its quadrant of a 1024-px VRT and halves it by average', () => {
    const vrt = parentVrt([{ dx: 1, dy: 0 }]);
    expect(vrt).toContain('rasterXSize="1024"');
    expect(vrt).toContain('child-10.webp');
    expect(vrt).toContain('<DstRect xOff="512" yOff="0" xSize="512" ySize="512"/>');
    expect(vrt.match(/<ColorInterp>Alpha<\/ColorInterp>/g)).toHaveLength(1);
    expect(parentTranslateArgs(80)).toEqual([
      '-q',
      '-of',
      'WEBP',
      '-co',
      'QUALITY=80',
      '-outsize',
      '512',
      '512',
      '-r',
      'average',
      'parent.vrt',
      'parent.webp',
    ]);
  });

  /** A WebP's first 30 bytes: RIFF, WEBP, the first chunk's fourcc, and the header bits read. */
  const webp = (chunk: string, byte20 = 0, byte24 = 0): Uint8Array => {
    const b = new Uint8Array(30);
    b.set(new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`), 0);
    b[20] = byte20;
    b[24] = byte24;
    return b;
  };

  it('reads whether a WebP has alpha from its header, as libwebp does', () => {
    expect(webpHasAlpha(webp('VP8X', 0x10))).toBe(true);
    expect(webpHasAlpha(webp('VP8X', 0x20))).toBe(false);
    expect(webpHasAlpha(webp('VP8L', 0, 0x10))).toBe(true);
    expect(webpHasAlpha(webp('VP8L', 0, 0xef))).toBe(false);
    expect(webpHasAlpha(webp('VP8 ', 0xff, 0xff))).toBe(false);
    expect(() => webpHasAlpha(webp('ALPH'))).toThrow('"ALPH"');
    expect(() => webpHasAlpha(Uint8Array.of(9))).toThrow('not a WebP');
  });

  it('gives an opaque child a constant alpha rather than a band it hasn’t got', () => {
    const vrt = parentVrt([
      { dx: 0, dy: 0, alpha: true },
      { dx: 1, dy: 1, alpha: false },
    ]);
    const alpha = vrt.slice(vrt.indexOf('<ColorInterp>Alpha</ColorInterp>'));
    expect(alpha).toContain('child-00.webp</SourceFilename><SourceBand>4</SourceBand>');
    expect(alpha).toContain(
      '<ComplexSource><SourceFilename relativeToVRT="1">child-11.webp</SourceFilename><SourceBand>1</SourceBand>',
    );
    expect(alpha).toContain('<ScaleOffset>255</ScaleOffset><ScaleRatio>0</ScaleRatio>');
    expect(vrt.match(/<SourceBand>4<\/SourceBand>/g)).toHaveLength(1);
  });

  it('runs gdal_translate in a scratch directory it removes, and refuses an empty parent', async () => {
    const seen: string[] = [];
    const renderer = gdalRenderer({
      scratch: dir,
      run: async (cmd, args, o) => {
        seen.push(cmd, ...args);
        await writeFile(join(o?.cwd as string, 'parent.webp'), Uint8Array.of(7, 7));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await renderer.render([{ dx: 0, dy: 1, bytes: webp('VP8 ') }])).toEqual(
      Uint8Array.of(7, 7),
    );
    expect(seen[0]).toBe('gdal_translate');
    await expect(renderer.render([])).rejects.toThrow('at least one child');
  });

  const hasGdal = (() => {
    try {
      execFileSync('gdal_translate', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  // GDAL is on the Mac (3.13.2) and in the Machine's image, not on CI: there this is skipped.
  it.skipIf(!hasGdal)('with real GDAL: an alpha-aware halving to a 512-px RGBA WebP', async () => {
    const work = await mkdtemp(join(dir, 'gdal-'));
    // One child: opaque columns alternating with empty ones.
    const raw = Buffer.alloc(512 * 512 * 4);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x += 2) raw.set([200, 50, 20, 255], (y * 512 + x) * 4);
    }
    await writeFile(join(work, 'c.raw'), raw);
    await writeFile(
      join(work, 'c.hdr'),
      'ENVI\nsamples = 512\nlines = 512\nbands = 4\nheader offset = 0\nfile type = ENVI Standard\ndata type = 1\ninterleave = bip\nbyte order = 0\n',
    );
    await mustRun(
      runProcess,
      'gdal_translate',
      ['-q', '-of', 'WEBP', '-co', 'QUALITY=90', 'c.raw', 'c.webp'],
      { cwd: work },
    );
    const child = new Uint8Array(await readFile(join(work, 'c.webp')));
    const parent = await gdalRenderer({ scratch: work }).render([{ dx: 0, dy: 0, bytes: child }]);
    await writeFile(join(work, 'p.webp'), parent);
    await mustRun(
      runProcess,
      'gdal_translate',
      ['-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BIP', 'p.webp', 'p.raw'],
      { cwd: work },
    );
    const px = await readFile(join(work, 'p.raw'));
    expect(px.length).toBe(512 * 512 * 4);
    const at = (x: number, y: number) => [...px.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)];
    const [r, g, b, a] = at(10, 10) as number[];
    // Half covered: alpha ~128, and the color its own, not darkened toward black.
    expect(a).toBeGreaterThan(110);
    expect(a).toBeLessThan(146);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeGreaterThan(35);
    expect(b).toBeLessThan(45);
    // The missing quadrants are transparent.
    expect(at(400, 400)[3]).toBe(0);

    // An opaque child: GDAL writes it with no alpha band, and the parent still renders (the pilot).
    const solid = Buffer.alloc(512 * 512 * 4);
    for (let i = 0; i < 512 * 512; i++) solid.set([30, 120, 60, 255], i * 4);
    await writeFile(join(work, 'c.raw'), solid);
    await mustRun(
      runProcess,
      'gdal_translate',
      ['-q', '-of', 'WEBP', '-co', 'QUALITY=90', 'c.raw', 's.webp'],
      { cwd: work },
    );
    const opaque = new Uint8Array(await readFile(join(work, 's.webp')));
    expect(webpHasAlpha(opaque)).toBe(false);
    const mixed = await gdalRenderer({ scratch: work }).render([
      { dx: 0, dy: 0, bytes: child },
      { dx: 1, dy: 1, bytes: opaque },
    ]);
    await writeFile(join(work, 'm.webp'), mixed);
    await mustRun(
      runProcess,
      'gdal_translate',
      ['-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BIP', 'm.webp', 'm.raw'],
      { cwd: work },
    );
    const mx = await readFile(join(work, 'm.raw'));
    const [mr, mg, mb, ma] = [...mx.subarray((400 * 512 + 400) * 4, (400 * 512 + 400) * 4 + 4)];
    expect(ma).toBe(255);
    expect(Math.abs((mr as number) - 30)).toBeLessThan(12);
    expect(Math.abs((mg as number) - 120)).toBeLessThan(12);
    expect(Math.abs((mb as number) - 60)).toBeLessThan(12);
  });
});
