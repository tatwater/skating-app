import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { NaipCellIndex } from '@skating/core';
import { PMTiles, tileIdToZxy } from 'pmtiles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeSource } from './assemble/archiveRead';
import { type AssembledManifest, assemble, assemblyKeys } from './assemble/assemble';
import { fileStore, fileUploads, type ObjectStore, sha256Hex } from './assemble/stores';
import { hashRenderer, writeSyntheticBuild } from './assemble/synthetic';
import { tileBox, worldPixel } from './assemble/tileGrid';
import { archiveKey, indexKey, manifestKey, shardKeys } from './keys';
import { pmtilesCliCheck, publicUrl, sampleIds, verifyBuild } from './verify';
import { boxPixelsAtZ16, coverage, seams, tileAt, writeReport } from './verifyReport';

const CAMPAIGN = 'naip-pilot-20261212';
const PILOT = 'champlain';
const TILES = { meanBytes: 48, dupEvery: 17, density: (z: number) => (z <= 12 ? 1 : 0.01) };
const WORK = [
  { z: 11, x: 603, y: 731 },
  { z: 11, x: 604, y: 731 },
];

let root: string;
let manifest: AssembledManifest;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'naip-verify-'));
  const build = await writeSyntheticBuild(root, {
    campaign: CAMPAIGN,
    pilot: PILOT,
    workTiles: WORK,
    tiles: TILES,
  });
  const upload = fileUploads(root);
  await assemble(build.manifest, {
    store: fileStore(root),
    upload: (k) => upload(k),
    renderer: hashRenderer,
  });
  manifest = JSON.parse(await readFile(join(root, manifestKey(CAMPAIGN, PILOT)), 'utf8'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The public URL as a browser's fetch sees it: a gzip-encoded object arrives decoded. */
function decoding(store: ObjectStore): ObjectStore {
  return {
    ...store,
    async get(key) {
      const bytes = await store.get(key);
      return bytes !== null && bytes[0] === 0x1f && bytes[1] === 0x8b
        ? new Uint8Array(gunzipSync(bytes))
        : bytes;
    },
  };
}

/** Synthetic cells aren't on the real grid: a box's cells are those of the work tile at its middle. */
const cellsIn = (box: { minLat: number; minLng: number; maxLat: number; maxLng: number }) => {
  const p = worldPixel((box.minLng + box.maxLng) / 2, (box.minLat + box.maxLat) / 2, 11);
  const key = `11/${Math.floor(p.x / 256)}/${Math.floor(p.y / 256)}`;
  return manifest.workTiles.find((w) => w.key === key)?.cells ?? [];
};

const deps = (patch: object = {}) => ({
  published: decoding(fileStore(root)),
  build: fileStore(root),
  cellsIn,
  parseIndex: (json: unknown) => json as NaipCellIndex,
  spotReads: 10_000,
  ...patch,
});

const problemsOf = async (patch: object = {}) => {
  const out = await verifyBuild(CAMPAIGN, PILOT, deps(patch));
  return { out, all: out.checks.flatMap((c) => c.problems).join('\n') };
};

const rewriteJson = async (
  key: string,
  edit: (v: Record<string, unknown>) => unknown,
  gz = false,
) => {
  const raw = await readFile(join(root, key));
  const json = JSON.parse((gz ? gunzipSync(raw) : raw).toString('utf8'));
  const next = Buffer.from(JSON.stringify(edit(json)));
  await writeFile(join(root, key), gz ? gzipSync(next) : next);
  return next;
};

describe('verify passes a good build', () => {
  it('every check, every tile compared, the client’s parse run on the published index', async () => {
    let parsed = 0;
    const heard: string[] = [];
    const { out, all } = await problemsOf({
      parseIndex: (json: unknown, name: string) => {
        parsed++;
        expect(name).toBe('naip-summer-20261212.pmtiles');
        return json as NaipCellIndex;
      },
      indexHeaders: async () => ({ 'content-encoding': 'gzip', 'content-length': '123' }),
      onCheck: (c: { name: string }) => heard.push(c.name),
    });
    expect(all).toBe('');
    expect(out.ok).toBe(true);
    expect(parsed).toBe(1);
    expect(heard).toEqual(['archive', 'counts', 'spot reads', 'dates']);
    const counts = out.checks.find((c) => c.name === 'counts')?.counts;
    expect(counts?.missing).toBe(0);
    expect(counts?.addressed).toBe(counts?.expected);
    expect(out.checks.find((c) => c.name === 'spot reads')?.counts.compared).toBe(
      counts?.addressed,
    );
    expect(out.checks.find((c) => c.name === 'dates')?.notes[0]).toBe(
      'index served with content-encoding gzip, content-length 123',
    );
  });
});

describe('verify refuses', () => {
  it('a missing work tile (its done record gone)', async () => {
    const keys = shardKeys(CAMPAIGN, WORK[1] as (typeof WORK)[number], PILOT);
    await rm(join(root, keys.done));
    const { out, all } = await problemsOf();
    expect(out.ok).toBe(false);
    expect(all).toContain('work tile 11/604/731 has not landed');
    expect(all).toContain('is in the archive but in no source');
  });

  it('a zoom gap, and tiles the archive has that no source explains', async () => {
    // Replace the published archive with the same one minus zoom 15 (re-assembled from a doctored
    // index is the assembler's refusal; here the archive itself is wrong).
    const first = shardKeys(CAMPAIGN, WORK[0] as (typeof WORK)[number], PILOT);
    await rewriteJson(first.index, (idx) => idx);
    const archive = new PMTiles(storeSource(fileStore(root), archiveKey(CAMPAIGN, PILOT)));
    const header = await archive.getHeader();
    const { writeToMemory } = await import('./assemble/testArchive');
    const tiles: { tileId: number; bytes: Uint8Array }[] = [];
    const { readArchiveEntries } = await import('./assemble/archiveRead');
    const entries = await readArchiveEntries(
      storeSource(fileStore(root), archiveKey(CAMPAIGN, PILOT)),
    );
    const raw = await readFile(join(root, archiveKey(CAMPAIGN, PILOT)));
    for (let i = 0; i < entries.entries.count; i++) {
      const id = entries.entries.tileId[i] as number;
      if (tileIdToZxy(id)[0] === 15) continue;
      const o = header.tileDataOffset + (entries.entries.offset[i] as number);
      tiles.push({
        tileId: id,
        bytes: new Uint8Array(raw.subarray(o, o + (entries.entries.length[i] as number))),
      });
    }
    const { bytes } = await writeToMemory([{ source: 's', tiles }], { minZoom: 7, maxZoom: 17 });
    await writeFile(join(root, archiveKey(CAMPAIGN, PILOT)), bytes);
    const { all } = await problemsOf();
    expect(all).toContain('zoom 15 has no tile');
    expect(all).toContain('is in its source but not in the archive');
    expect(all).toContain(`the archive is ${bytes.length} bytes, the manifest says`);
  });

  it('a byte mismatch between a tile and its shard', async () => {
    const pack = shardKeys(CAMPAIGN, WORK[0] as (typeof WORK)[number], PILOT).pack;
    const bytes = await readFile(join(root, pack));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    await writeFile(join(root, pack), bytes);
    const { all } = await problemsOf();
    expect(all).toMatch(/tile \d+\/\d+\/\d+ differs from its shard source/);
    expect(all).toContain("its shard bytes don't match the shard's own index");
  });

  it('an undated cell, and tiles that would draw undated', async () => {
    const victim = manifest.cells[0]?.key as string;
    const dropped = new Set(manifest.workTiles[0]?.cells);
    const next = await rewriteJson(
      indexKey(CAMPAIGN, PILOT),
      (index) => ({
        ...index,
        cells: Object.fromEntries(
          Object.entries(index.cells as Record<string, number[]>).filter(([k]) => !dropped.has(k)),
        ),
      }),
      true,
    );
    // Keep the manifest's hash in step, so the refusal is the date, not the hash.
    await rewriteJson(manifestKey(CAMPAIGN, PILOT), (m) => ({
      ...m,
      cellIndex: { ...(m.cellIndex as object), sha256: sha256Hex(next) },
    }));
    const { out, all } = await problemsOf();
    expect(out.ok).toBe(false);
    expect(all).toContain(`cell ${victim} has pixels and no date: an undated cell`);
    expect(all).toMatch(/\d+ tiles draw where no cell they touch is dated/);
  });

  it('an index naming another archive, as the client would too', async () => {
    const next = await rewriteJson(
      indexKey(CAMPAIGN, PILOT),
      (i) => ({ ...i, archive: 'naip-summer-20250101.pmtiles' }),
      true,
    );
    await rewriteJson(manifestKey(CAMPAIGN, PILOT), (m) => ({
      ...m,
      cellIndex: { ...(m.cellIndex as object), sha256: sha256Hex(next) },
    }));
    const { all } = await problemsOf({
      parseIndex: (json: { archive: string }, name: string) => {
        if (json.archive !== name) throw new Error(`names ${json.archive}`);
        return json;
      },
    });
    expect(all).toContain(
      'the index names "naip-summer-20250101.pmtiles", not naip-summer-20261212.pmtiles',
    );
    expect(all).toContain('the client refuses the index: names naip-summer-20250101.pmtiles');
  });

  it('an index whose hash is not the manifest’s, or not published, or served undecoded', async () => {
    await rewriteJson(manifestKey(CAMPAIGN, PILOT), (m) => ({
      ...m,
      cellIndex: { ...(m.cellIndex as object), sha256: '0'.repeat(64) },
    }));
    expect((await problemsOf()).all).toContain("the published index's hash is not the manifest's");
    expect((await problemsOf({ published: fileStore(root) })).all).toContain(
      'is not JSON (served still gzipped?)',
    );
    await rm(join(root, indexKey(CAMPAIGN, PILOT)));
    expect((await problemsOf()).all).toContain('is not published: every cell would be undated');
  });

  it('counts in the manifest that are not the cut’s', async () => {
    await rewriteJson(manifestKey(CAMPAIGN, PILOT), (m) => ({
      ...m,
      workTiles: (m.workTiles as { cellCounts: object }[]).map((w, i) =>
        i === 0 ? { ...w, cellCounts: {} } : w,
      ),
    }));
    expect((await problemsOf()).all).toContain("the manifest's counts are not its done record's");
  });

  it('a header the web would misread, a manifest naming another archive or hash', async () => {
    await rewriteJson(manifestKey(CAMPAIGN, PILOT), (m) => ({
      ...m,
      archive: { ...(m.archive as object), name: 'x.pmtiles', sha256: 'f'.repeat(64) },
    }));
    const { all } = await problemsOf();
    expect(all).toContain('the manifest names x.pmtiles');
    expect(all).toContain("the manifest's archive hash is not the one the assembler streamed");
  });

  it('nothing published, no record, or an unreadable archive — and stops there', async () => {
    await rm(join(root, assemblyKeys(CAMPAIGN, PILOT).record));
    const a = await problemsOf();
    expect(a.all).toContain('the assembly record is missing');
    expect(a.out.context).toBeNull();
    await rm(join(root, manifestKey(CAMPAIGN, PILOT)));
    expect((await problemsOf()).all).toContain('is not published');
  });

  it('an archive that can’t be read at all', async () => {
    await writeFile(join(root, archiveKey(CAMPAIGN, PILOT)), 'not an archive');
    const { out, all } = await problemsOf();
    expect(all).toContain("the archive can't be read from the public URL");
    expect(out.checks).toHaveLength(1);
  });
  it('a header the web would misread: a wrong type and zoom floor, counts that disagree', async () => {
    const path = join(root, archiveKey(CAMPAIGN, PILOT));
    const bytes = await readFile(path);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    v.setUint8(99, 2); // PNG
    v.setUint8(100, 8); // min zoom 8: the zoom-7 overviews no longer read
    v.setUint32(72, v.getUint32(72, true) + 1, true); // one more addressed tile than there is
    v.setUint32(80, v.getUint32(80, true) + 1, true); // one more entry than the directories hold
    await writeFile(path, bytes);
    const { all } = await problemsOf();
    expect(all).toContain("the header's tile type is 2, not 4");
    expect(all).toContain("the header's min zoom is 8, not 7");
    expect(all).toMatch(/the header addresses \d+, the directories \d+/);
    expect(all).toMatch(/the directories hold \d+ tile entries, the header says \d+/);
    expect(all).toMatch(/tile 7\/\d+\/\d+ reads as absent/);
  });
});

describe('verify, on a build that copied work tiles from the current archive', () => {
  it('passes, comparing copied tiles to the current archive — and refuses when it is gone', async () => {
    const { manifestKey: mk } = await import('./keys');
    const second = await writeSyntheticBuild(root, {
      campaign: 'naip-pilot-20270801',
      pilot: PILOT,
      workTiles: WORK,
      tiles: TILES,
      omit: new Set(['11/604/731']),
    });
    const next = {
      ...second.manifest,
      basedOn: {
        archive: 'naip-summer-20261212.pmtiles',
        manifest: 'naip-summer-20261212-manifest.json',
      },
      workTiles: second.manifest.workTiles.map((w) => {
        const prior = manifest.workTiles.find((p) => p.key === w.key);
        return w.key === '11/604/731'
          ? { ...w, inputHash: prior?.inputHash as string, retile: false }
          : w;
      }),
    };
    const upload = fileUploads(root);
    await assemble(next, {
      store: fileStore(root),
      upload: (k) => upload(k),
      renderer: hashRenderer,
    });
    manifest = JSON.parse(await readFile(join(root, mk('naip-pilot-20270801', PILOT)), 'utf8'));
    const out = await verifyBuild('naip-pilot-20270801', PILOT, deps());
    expect(out.checks.flatMap((c) => c.problems)).toEqual([]);
    expect(out.checks.find((c) => c.name === 'counts')?.counts).toMatchObject({
      workTilesCut: 1,
      workTilesCopied: 1,
    });
    await rm(join(root, archiveKey(CAMPAIGN, PILOT)));
    const gone = (await verifyBuild('naip-pilot-20270801', PILOT, deps())).checks
      .flatMap((c) => c.problems)
      .join('\n');
    expect(gone).toContain(
      "the current archive dev/naip/pilot/champlain/naip-summer-20261212.pmtiles can't be read",
    );
    expect(gone).toContain('is copied, but there is no current archive to copy from');
  });
});

describe('the report', () => {
  it('samples spread over zooms, deterministically', () => {
    const ids = Float64Array.from({ length: 2000 }, (_, i) => 1_000_000 + i * 7);
    const a = sampleIds(ids, 50);
    expect(a).toEqual(sampleIds(ids, 50));
    expect(a.length).toBeLessThanOrEqual(50);
    expect(sampleIds(Float64Array.of(3, 1), 5)).toEqual([3, 1]);
  });

  it('writes the checks, coverage, seams and quilt, and names public URLs', async () => {
    const out = await verifyBuild(CAMPAIGN, PILOT, deps());
    // A synthetic grid: the cells side by side in strips across the first work tile's ground.
    const ground = tileBox(11, 603, 731);
    const keys = manifest.cells.map((c) => c.key);
    const w = (ground.east - ground.west) / keys.length;
    const boxes = new Map(
      keys.map((k, i) => [
        k,
        {
          minLat: ground.south,
          maxLat: ground.north,
          minLng: ground.west + i * w,
          maxLng: ground.west + (i + 1) * w,
        },
      ]),
    );
    const grid = {
      cellBox: (k: string) =>
        boxes.get(k) as { minLat: number; minLng: number; maxLat: number; maxLng: number },
      cellAt: (lat: number, lng: number) =>
        lat > ground.north || lat < ground.south
          ? 'none'
          : (keys[Math.floor((lng - ground.west) / w)] ?? 'none'),
    };
    const report = join(root, 'report');
    const archive = new PMTiles(storeSource(fileStore(root), archiveKey(CAMPAIGN, PILOT)));
    // Make a seam: date one cell by another flight in the context's index.
    const index = out.context?.index as NaipCellIndex;
    index.flights.push({ date: '2019-06-01', gsd: 0.6, state: 'NY' });
    index.cells[keys[1] as string] = [index.flights.length - 1];
    const sheets = await writeReport(report, out, {
      archive,
      grid,
      title: 'Summer aerial test',
      seamZoom: 12,
    });
    expect(sheets.seams).toBeGreaterThan(0);
    expect(sheets.lowCoverage).toBeGreaterThan(0);
    expect(sheets.quilt).toBeGreaterThan(0);
    const html = await readFile(join(report, 'index.html'), 'utf8');
    expect(html).toContain('Summer aerial test: passed');
    expect(html).toContain('dates: passed');
    const json = JSON.parse(await readFile(join(report, 'report.json'), 'utf8'));
    expect(json.ok).toBe(true);
    expect(publicUrl('https://x.example/', CAMPAIGN, PILOT, 'a.pmtiles')).toBe(
      'https://x.example/dev/naip/pilot/champlain/a.pmtiles',
    );
    // With nothing to read, the report still says why.
    const bare = await writeReport(
      join(root, 'bare'),
      { ok: false, checks: [], context: null },
      { archive: null, grid: null, title: 't' },
    );
    expect(bare).toEqual({ seams: 0, quilt: 0, lowCoverage: 0 });
  });

  it('measures coverage on the z16 grid, finds seams between differing flights, and the tile over a point', () => {
    const box = { minLat: 44, minLng: -72.0625, maxLat: 44.0625, maxLng: -72 };
    const px = boxPixelsAtZ16(box);
    // 1/16° at 44°N on the z16 grid: ~2,913 px wide, ~4,050 tall (Mercator's 1/cos 44°).
    expect(px).toBeGreaterThan(11.7e6);
    expect(px).toBeLessThan(11.9e6);
    // `c` is a cell the archive holds no work tile of (a pilot's manifest records the region):
    // never listed, where `b`, cut but supplied nothing, is.
    const m = {
      cells: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      workTiles: [{ cells: ['a', 'b'], cellCounts: { a: { f: px } } }],
    } as unknown as AssembledManifest;
    expect(coverage(m, { cellBox: () => box })).toEqual([{ key: 'b', share: 0 }]);
    const index: NaipCellIndex = {
      version: 1,
      archive: 'x',
      flights: [
        { date: '2025-07-01', gsd: 0.3, state: 'VT' },
        { date: '2024-07-01', gsd: 0.6, state: 'NY' },
        { date: '2025-08-01', gsd: 0.3, state: 'VT' },
      ],
      cells: { a: [0], b: [1], c: [2] },
    };
    const grid = {
      cellBox: (k: string) => ({
        minLat: 44,
        maxLat: 45,
        minLng: k.charCodeAt(0) - 97,
        maxLng: k.charCodeAt(0) - 96,
      }),
      cellAt: (_lat: number, lng: number) => String.fromCharCode(97 + Math.floor(lng)),
    };
    const s = seams(index, grid);
    expect(s.map((x) => [x.a, x.b, x.side])).toEqual([
      ['a', 'b', 'east'],
      ['b', 'c', 'east'],
    ]);
    const [z, x, y] = tileAt(44.5, -72.5, 14);
    const b = tileBox(z, x, y);
    expect(b.west).toBeLessThanOrEqual(-72.5);
    expect(b.east).toBeGreaterThan(-72.5);
    expect(b.south).toBeLessThanOrEqual(44.5);
    expect(b.north).toBeGreaterThan(44.5);
  });
});

describe('the pmtiles CLI as a second reader', () => {
  const url = 'https://tiles.example/dev/naip/naip-summer-20261212.pmtiles';
  it('reads the header over the URL with show, never verify (which takes a local file only)', async () => {
    const calls: string[][] = [];
    const ok = await pmtilesCliCheck(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: 'pmtiles spec version: 3\ntile type: webp\n', stderr: '' };
    }, url);
    expect(calls).toEqual([['pmtiles', 'show', url]]);
    expect(ok?.problems).toEqual([]);
  });

  it('refuses on a failing exit or a header that isn’t spec 3', async () => {
    const failed = await pmtilesCliCheck(
      async () => ({ code: 1, stdout: '', stderr: 'error: 404\n' }),
      url,
    );
    expect(failed?.problems[0]).toMatch(/exited 1: error: 404/);
    const odd = await pmtilesCliCheck(
      async () => ({ code: 0, stdout: 'pmtiles spec version: 2\n', stderr: '' }),
      url,
    );
    expect(odd?.problems[0]).toMatch(/no spec-3 header/);
  });

  it('is skipped, not failed, when the CLI isn’t installed', async () => {
    expect(
      await pmtilesCliCheck(async () => {
        throw new Error('spawn pmtiles ENOENT');
      }, url),
    ).toBeNull();
  });
});
