/**
 * **The local proofs of the streaming writer** — run by hand, never in CI (each is skipped unless its
 * variable is set):
 *
 * ```bash
 * # A multi-gigabyte archive, streamed through the real `rclone rcat` (128 MiB parts) into a local
 * # S3 server (`rclone serve s3`), its inputs read through the real `rclone serve http`:
 * AERIAL_STREAM_PROOF=<scratch dir> pnpm --filter @skating/aerial exec vitest run src/assemble/stream.proof.test.ts -t stream
 * # The assembler's memory at region scale: the layout and directories of ~9 M tiles, no bytes:
 * AERIAL_SCALE_PROOF=9000000 pnpm --filter @skating/aerial exec vitest run src/assemble/stream.proof.test.ts -t scale
 * # The date index of the real region (the scouts' picks, 9,168 cells):
 * AERIAL_INDEX_PROOF=<path to picks_T2.json> pnpm --filter @skating/aerial exec vitest run src/assemble/stream.proof.test.ts -t index
 * ```
 *
 * Each prints its measurements as one JSON line. The stream proof deletes everything it wrote.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { NaipManifest, NaipState } from '@skating/core';
import { PMTiles, tileIdToZxy } from 'pmtiles';
import { describe, expect, it } from 'vitest';
import { archiveKey } from '../keys';
import { readArchiveEntries, storeSource } from './archiveRead';
import { assemble } from './assemble';
import { buildCellIndex, encodeCellIndex } from './cellIndex';
import { contentKey } from './contentTable';
import { layoutArchive, type TileSegment } from './layout';
import { prng } from './prng';
import { fileStore, httpStore } from './stores';
import { hashRenderer, syntheticTile, writeSyntheticBuild } from './synthetic';
import { workTileIdRange } from './tileGrid';
import { rcatSink, serveHttp } from './upload';
import { planArchive } from './writer';

const STREAM = process.env.AERIAL_STREAM_PROOF;
const SCALE = process.env.AERIAL_SCALE_PROOF;
const INDEX = process.env.AERIAL_INDEX_PROOF;

const mb = (n: number) => Math.round(n / 2 ** 20);

describe.skipIf(!STREAM)('stream: a multi-part archive through real rclone', () => {
  it('streams ~2 GB of synthetic shards into 128 MiB parts, reads back byte-equal, pmtiles verify clean', async () => {
    const dir = STREAM as string;
    const bucketDir = join(dir, 'in');
    const s3Root = join(dir, 's3');
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(s3Root, 'bkt'), { recursive: true });
    const config = join(dir, 'rclone.conf');
    // A throwaway local S3 server's made-up keys: not a credential of anything.
    await writeFile(
      config,
      [
        '[loc]',
        'type = local',
        '',
        '[s3local]',
        'type = s3',
        'provider = Other',
        'access_key_id = proof',
        'secret_access_key = proofsecret',
        'endpoint = http://127.0.0.1:18791',
        'region = us-east-1',
        '',
      ].join('\n'),
    );
    const s3 = spawn(
      'rclone',
      [
        'serve',
        's3',
        '--config',
        config,
        '--auth-key',
        'proof,proofsecret',
        '--addr',
        '127.0.0.1:18791',
        s3Root,
      ],
      { stdio: 'ignore' },
    );
    try {
      // 120 work tiles; every tile to tile zoom 15, a quarter of 16, a tenth of 17; ~16 KB a tile.
      const workTiles = Array.from({ length: 120 }, (_, i) => ({
        z: 11,
        x: 600 + (i % 12),
        y: 728 + Math.floor(i / 12),
      }));
      const tiles = {
        meanBytes: 16_000,
        dupEvery: 41,
        density: (z: number) => (z <= 15 ? 1 : z === 16 ? 0.25 : 0.1),
      };
      const t0 = Date.now();
      const build = await writeSyntheticBuild(bucketDir, {
        campaign: 'naip-20261212',
        workTiles,
        tiles,
      });
      const tWrite = Date.now() - t0;
      const server = await serveHttp({ remote: 'loc', bucket: bucketDir, config }, 18792);
      const logFile = join(dir, 'rcat.log');
      process.env.RCLONE_LOG_FILE = logFile;
      process.env.RCLONE_VERBOSE = '2';
      const store = httpStore(server.baseUrl);
      const target = { remote: 's3local', bucket: 'bkt', config };
      let peakHeap = 0;
      const sampler = setInterval(() => {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }, 200);
      const t1 = Date.now();
      try {
        const record = await assemble(build.manifest, {
          store: {
            ...store,
            // Published keys are checked against the S3 side, where the uploads land.
            exists: async (key) =>
              (await stat(join(s3Root, 'bkt', key)).catch(() => null)) !== null,
          },
          upload: (key, o) => rcatSink(target, key, o),
          renderer: hashRenderer,
          memory: () => ({ rss: process.resourceUsage().maxRSS * 1024, heap: peakHeap }),
        });
        const tAssemble = Date.now() - t1;
        clearInterval(sampler);
        delete process.env.RCLONE_LOG_FILE;
        delete process.env.RCLONE_VERBOSE;

        const out = join(s3Root, 'bkt', archiveKey('naip-20261212'));
        const size = (await stat(out)).size;
        expect(size).toBe(record.archive.bytes);
        // The bytes that landed hash to what the assembler streamed.
        const h = createHash('sha256');
        for await (const c of createReadStream(out)) h.update(c as Buffer);
        expect(h.digest('hex')).toBe(record.archive.sha256);
        // Leaves, and every tile of three work tiles byte-equal through the web's reader.
        const entries = await readArchiveEntries(
          storeSource(fileStore(join(s3Root, 'bkt')), archiveKey('naip-20261212')),
        );
        expect(entries.leaves).toBeGreaterThan(1);
        const archive = new PMTiles(
          storeSource(fileStore(join(s3Root, 'bkt')), archiveKey('naip-20261212')),
        );
        let checked = 0;
        for (const wt of workTiles.slice(0, 3)) {
          for (let z = 11; z <= 17; z++) {
            const [first, count] = workTileIdRange(wt, z);
            for (let id = first; id < first + count; id += z >= 16 ? 7 : 1) {
              const [zz, x, y] = tileIdToZxy(id);
              const got = await archive.getZxy(zz, x, y);
              if (got === undefined) continue;
              expect(
                Buffer.compare(Buffer.from(got.data), Buffer.from(syntheticTile(id, tiles))),
              ).toBe(0);
              checked++;
            }
          }
        }
        const verify = execFileSync('pmtiles', ['verify', out], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const log = await readFile(logFile, 'utf8').catch(() => '');
        // rclone -vv logs each multipart chunk of the archive's upload ("… chunk N size 128Mi …").
        const archiveLines = log
          .split('\n')
          .filter((l) => l.includes('naip-summer-20261212.pmtiles'));
        const parts = new Set(
          archiveLines.flatMap((l) => [...l.matchAll(/chunk (\d+)/gi)].map((m) => m[1])),
        ).size;
        const partSizes = [
          ...new Set(archiveLines.flatMap((l) => [...l.matchAll(/size (\S+)/g)].map((m) => m[1]))),
        ];
        process.stdout.write(
          `${JSON.stringify({
            proof: 'stream',
            shardsMb: mb(build.bytes),
            archiveMb: mb(size),
            tiles: record.header.addressed,
            entries: record.header.entries,
            contents: record.header.contents,
            leaves: record.header.leaves,
            rootBytes: record.header.rootBytes,
            leafBytes: record.header.leafBytes,
            checkedTiles: checked,
            multipartChunks: parts,
            chunkSizes: partSizes.slice(0, 4),
            multipartSample: archiveLines.find((l) => /chunk/i.test(l))?.replace(/^.*?: /, ''),
            writeShardsSeconds: Math.round(tWrite / 1000),
            assembleSeconds: Math.round(tAssemble / 1000),
            throughputMbPerSecond: Math.round(mb(size) / (tAssemble / 1000)),
            peakRssMb: mb(process.resourceUsage().maxRSS * 1024),
            peakHeapMb: mb(peakHeap),
            timings: record.timings,
            pmtilesVerify: verify.trim().split('\n').pop(),
          })}\n`,
        );
      } finally {
        clearInterval(sampler);
        server.stop();
      }
    } finally {
      s3.kill('SIGTERM');
      await rm(dir, { recursive: true, force: true });
    }
  }, 3_600_000);
});

describe.skipIf(!SCALE)('scale: the assembler’s memory for a region of tiles', () => {
  it('lays out and builds the directories of N tiles, with the inputs held as the assembler holds them', async () => {
    const n = Number(SCALE);
    global.gc?.();
    const before = process.memoryUsage();
    // Inputs as `assemble` holds them per work tile: ids, offsets, lengths and four key words.
    const perWorkTile = Math.ceil(n / 1769);
    const segments: TileSegment[] = [];
    const rand = prng(1);
    let made = 0;
    const sizes: number[] = [];
    for (let z = 11; z <= 17 && made < n; z++) {
      const share = z === 17 ? 0.75 : z === 16 ? 0.1875 : 0.0625 / 5;
      for (let w = 0; w < 1769 && made < n; w++) {
        const [first, span] = workTileIdRange(
          { z: 11, x: 512 + (w % 64), y: 640 + Math.floor(w / 64) },
          z,
        );
        const count = Math.min(span, Math.max(1, Math.round(perWorkTile * share)));
        const seg: TileSegment = {
          source: `naip/build/naip-20261212/shards/11/${w}.pack`,
          tileId: new Float64Array(count),
          srcOffset: new Float64Array(count),
          length: new Uint32Array(count),
          key: new Uint32Array(count * 4),
        };
        let at = 0;
        for (let i = 0; i < count; i++) {
          seg.tileId[i] = first + i;
          const len = 20_000 + Math.floor(rand() * 40_000);
          seg.srcOffset[i] = at;
          seg.length[i] = len;
          at += len;
          // ~2% repeats (a water blob), the rest distinct.
          const water = rand() < 0.02;
          seg.key[i * 4] = water ? 7 : (rand() * 2 ** 32) >>> 0;
          seg.key[i * 4 + 1] = water ? 7 : (rand() * 2 ** 32) >>> 0;
          seg.key[i * 4 + 2] = water ? 7 : made + i;
          seg.key[i * 4 + 3] = water ? 7 : z;
        }
        sizes.push(count);
        made += count;
        segments.push(seg);
      }
    }
    // Segments must be in id order: sort by first id (zoom-major already; within a zoom by id).
    segments.sort((a, b) => (a.tileId[0] as number) - (b.tileId[0] as number));
    const inputs = process.memoryUsage();
    const t0 = Date.now();
    const layout = layoutArchive(segments, (id) => tileIdToZxy(id)[0], { releaseKeys: true });
    const tLayout = Date.now() - t0;
    const laid = process.memoryUsage();
    const t1 = Date.now();
    const plan = planArchive({
      layout,
      minZoom: 7,
      maxZoom: 17,
      bounds: { west: -80, south: 40, east: -66, north: 48 },
      centerZoom: 9,
      metadata: { name: 'scale' },
    });
    const tPlan = Date.now() - t1;
    const planned = process.memoryUsage();
    expect(plan.directories.root.length).toBeLessThanOrEqual(16_257);
    process.stdout.write(
      `${JSON.stringify({
        proof: 'scale',
        tiles: layout.addressed,
        entries: layout.entries.count,
        contents: layout.contents,
        archiveGb: Math.round(plan.bytes / 2 ** 30),
        leaves: plan.directories.leafCount,
        leafSize: plan.directories.leafSize,
        rootBytes: plan.directories.root.length,
        leafMb: mb(plan.directories.leaves.length),
        inputsMb: mb(inputs.heapUsed + inputs.arrayBuffers - before.heapUsed - before.arrayBuffers),
        afterLayoutMb: mb(
          laid.heapUsed + laid.arrayBuffers - before.heapUsed - before.arrayBuffers,
        ),
        afterPlanMb: mb(
          planned.heapUsed + planned.arrayBuffers - before.heapUsed - before.arrayBuffers,
        ),
        bytesPerTile: Math.round(
          (planned.heapUsed + planned.arrayBuffers - before.heapUsed - before.arrayBuffers) /
            layout.addressed,
        ),
        dedupeSlots: layout.tableSlots,
        layoutSeconds: Math.round(tLayout / 1000),
        planSeconds: Math.round(tPlan / 1000),
        peakRssMb: mb(process.resourceUsage().maxRSS * 1024),
      })}\n`,
    );
  }, 3_600_000);
});

describe.skipIf(!INDEX)('index: the date index of the real region', () => {
  it('builds the index from the scouts’ 9,168 picks and measures it', async () => {
    const picks = JSON.parse(await readFile(INDEX as string, 'utf8')) as Record<
      string,
      { id: string; gsd: number; dt: string; st: string; y: number }
    >;
    const frames: NaipManifest['frames'] = {};
    const cells: NaipManifest['cells'] = [];
    const counts = new Map<string, Map<string, number>>();
    const keys = Object.keys(picks).sort();
    const rand = prng(9);
    let twoFlight = 0;
    for (const key of keys) {
      const p = picks[key] as (typeof picks)[string];
      const state = p.st.toUpperCase() as NaipState;
      frames[p.id] = { acquired: p.dt, gsd: p.gsd, year: p.y, state };
      // A share of cells shows a second flight through a partial pick (the border, a flight's end):
      // the scouts counted 319 two-state cells and 134 partial Maine picks; ~6% here.
      const stack: string[] = [];
      const c = new Map([[p.id, 1000]]);
      if (rand() < 0.06) {
        const other = `${p.st}_m_${key.slice(0, 7)}_${key.slice(7)}_18_060_20210815`;
        frames[other] = { acquired: '2021-08-15', gsd: 0.6, year: 2021, state };
        stack.push(other);
        c.set(other, 50);
        twoFlight++;
      }
      cells.push({
        key,
        states: [state],
        pick: p.id,
        step: 'leafOn',
        stack,
        partial: stack.length > 0,
        cloudScore: null,
        workTiles: [],
      });
      counts.set(key, c);
    }
    const manifest = { frames, cells } as unknown as NaipManifest;
    const index = buildCellIndex(manifest, counts, 'naip-summer-20261212.pmtiles');
    const encoded = encodeCellIndex(index);
    process.stdout.write(
      `${JSON.stringify({
        proof: 'index',
        cells: Object.keys(index.cells).length,
        twoFlightCells: twoFlight,
        flights: index.flights.length,
        jsonBytes: encoded.json.length,
        gzipBytes: encoded.gzip.length,
        gzipLevel6Bytes: gzipSync(encoded.json).length,
        bytesPerCell: Math.round(encoded.json.length / keys.length),
      })}\n`,
    );
    expect(Object.keys(index.cells)).toHaveLength(keys.length);
    void contentKey;
  });
});
