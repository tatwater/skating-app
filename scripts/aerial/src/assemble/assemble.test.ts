import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { NaipCellIndex, NaipManifest } from '@skating/core';
import { PMTiles, tileIdToZxy } from 'pmtiles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveKey, indexKey, manifestKey, shardKeys } from '../keys';
import { readArchiveEntries, storeSource } from './archiveRead';
import {
  type AssembledManifest,
  type AssembleProgress,
  AssembleRefusal,
  archiveMetadata,
  assemble,
  assemblyKeys,
  planAssembly,
  storeReader,
} from './assemble';
import { fileStore, fileUploads } from './stores';
import { hashRenderer, syntheticTile, writeSyntheticBuild } from './synthetic';

const TILES = { meanBytes: 64, dupEvery: 13, density: (z: number) => (z <= 12 ? 1 : 0.02) };
const WORK = [
  { z: 11, x: 603, y: 731 },
  { z: 11, x: 604, y: 731 },
  { z: 11, x: 603, y: 732 },
];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'naip-assemble-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const depsFor = (events: AssembleProgress[] = []) => {
  const upload = fileUploads(root);
  const uploads: { key: string; contentEncoding?: string }[] = [];
  return {
    uploads,
    deps: {
      store: fileStore(root),
      upload: (key: string, o: { contentEncoding?: 'gzip' }) => {
        uploads.push({ key, contentEncoding: o.contentEncoding });
        return upload(key);
      },
      renderer: hashRenderer,
      progress: (e: AssembleProgress) => {
        events.push(e);
      },
      now: () => new Date('2026-12-12T00:00:00Z'),
      memory: () => ({ rss: 1, heap: 2 }),
    },
  };
};

const readJson = async <T>(key: string): Promise<T> =>
  JSON.parse(await readFile(join(root, key), 'utf8')) as T;

describe('assemble, end to end on synthetic shards', () => {
  it('publishes an archive the web’s reader reads back byte-equal, with its index and manifest', async () => {
    const campaign = 'naip-pilot-20261212';
    const pilot = 'champlain-nhma-me-ny';
    const build = await writeSyntheticBuild(root, {
      campaign,
      pilot,
      workTiles: WORK,
      tiles: TILES,
    });
    const events: AssembleProgress[] = [];
    const { deps, uploads } = depsFor(events);
    const record = await assemble(build.manifest, deps);

    // Every shard tile reads back byte-equal through the library, by z/x/y.
    const archive = new PMTiles(storeSource(fileStore(root), archiveKey(campaign, pilot)));
    const header = await archive.getHeader();
    expect(header).toMatchObject({ minZoom: 7, maxZoom: 17, clustered: true, tileType: 4 });
    const entries = await readArchiveEntries(
      storeSource(fileStore(root), archiveKey(campaign, pilot)),
    );
    let shardTiles = 0;
    for (const wt of build.manifest.workTiles) {
      const idx = await readJson<{ entries: { tileId: number }[] }>(
        shardKeys(
          campaign,
          { z: 11, x: Number(wt.key.split('/')[1]), y: Number(wt.key.split('/')[2]) },
          pilot,
        ).index,
      );
      for (const e of idx.entries) {
        const [z, x, y] = tileIdToZxy(e.tileId);
        const got = await archive.getZxy(z, x, y);
        expect(new Uint8Array(got?.data as ArrayBuffer)).toEqual(syntheticTile(e.tileId, TILES));
        shardTiles++;
      }
    }
    expect(header.numAddressedTiles).toBe(shardTiles + record.overviews.length);
    expect(record.header.addressed).toBe(header.numAddressedTiles);
    // Dedupe found the water tiles: fewer blobs than tiles.
    expect(header.numTileContents).toBeLessThan(header.numAddressedTiles);
    // Overviews at 7–10, one per parent of the level below, matching the record's hashes.
    for (const o of record.overviews) {
      const [z, x, y] = tileIdToZxy(o.tileId);
      expect(z).toBeGreaterThanOrEqual(7);
      expect(z).toBeLessThanOrEqual(10);
      const got = await archive.getZxy(z, x, y);
      expect(got?.data.byteLength).toBe(o.length);
    }
    expect(entries.entries.count).toBe(header.numTileEntries);

    // The index: gzip-encoded upload, names this archive, dates every counted cell, pick first.
    expect(uploads.find((u) => u.key === indexKey(campaign, pilot))?.contentEncoding).toBe('gzip');
    const index = JSON.parse(
      gunzipSync(await readFile(join(root, indexKey(campaign, pilot)))).toString('utf8'),
    ) as NaipCellIndex;
    expect(index.archive).toBe('naip-summer-20261212.pmtiles');
    const counted = new Set([...build.counts.values()].flatMap((c) => Object.keys(c)));
    expect(Object.keys(index.cells).sort()).toEqual([...counted].sort());
    for (const cell of build.manifest.cells) {
      const flights = index.cells[cell.key]?.map((i) => index.flights[i]);
      expect(flights?.[0]).toEqual({ date: '2025-07-14', gsd: 0.3, state: 'VT' });
    }

    // The manifest: the select stage's, plus the two objects and every work tile's counts.
    const manifest = await readJson<AssembledManifest>(manifestKey(campaign, pilot));
    expect(manifest.archive).toEqual({
      name: 'naip-summer-20261212.pmtiles',
      bytes: record.archive.bytes,
      sha256: record.archive.sha256,
    });
    expect(manifest.cellIndex.sha256).toBe(record.cellIndex.sha256);
    for (const wt of manifest.workTiles) expect(wt.cellCounts).toEqual(build.counts.get(wt.key));
    const onDisk = await readFile(join(root, archiveKey(campaign, pilot)));
    expect(onDisk.length).toBe(record.archive.bytes);

    // The record, beside the shards, and a heartbeat per zoom.
    expect(await readJson(assemblyKeys(campaign, pilot).record)).toEqual(record);
    expect(record.workTiles).toEqual({ total: 3, cut: 3, copied: 0, empty: 0 });
    expect(
      events.filter((e) => e.step === 'zoom').map((e) => (e as { zoom: number }).zoom),
    ).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(events.at(-1)).toEqual({ step: 'published', archiveBytes: record.archive.bytes });
    // The order of the uploads: the archive, the index, the manifest, the record.
    expect(uploads.map((u) => u.key)).toEqual([
      archiveKey(campaign, pilot),
      indexKey(campaign, pilot),
      manifestKey(campaign, pilot),
      assemblyKeys(campaign, pilot).record,
    ]);
  });

  it('copies unchanged work tiles out of the current archive, and their counts out of its manifest', async () => {
    const first = await writeSyntheticBuild(root, {
      campaign: 'naip-20261212',
      workTiles: WORK,
      tiles: TILES,
    });
    await assemble(first.manifest, depsFor().deps);
    const firstArchive = new PMTiles(storeSource(fileStore(root), archiveKey('naip-20261212')));

    // The next build re-cuts one work tile (new content: a new campaign seeds new shard paths) and
    // copies the other two.
    const second = await writeSyntheticBuild(root, {
      campaign: 'naip-20270801',
      workTiles: WORK,
      tiles: { ...TILES, meanBytes: 90 },
      omit: new Set(['11/603/732', '11/604/731']),
    });
    const manifest: NaipManifest = {
      ...second.manifest,
      basedOn: {
        archive: 'naip-summer-20261212.pmtiles',
        manifest: 'naip-summer-20261212-manifest.json',
      },
      workTiles: second.manifest.workTiles.map((w) => {
        const prior = first.manifest.workTiles.find((p) => p.key === w.key);
        return w.key === '11/603/731'
          ? w
          : { ...w, inputHash: prior?.inputHash as string, retile: false };
      }),
    };
    const record = await assemble(manifest, depsFor().deps);
    expect(record.copiedFrom).toBe('dev/naip/naip-summer-20261212.pmtiles');
    expect(record.workTiles).toMatchObject({ cut: 1, copied: 2 });
    expect(record.copiedTiles).toBeGreaterThan(0);

    const next = new PMTiles(storeSource(fileStore(root), archiveKey('naip-20270801')));
    const old = await readArchiveEntries(storeSource(fileStore(root), archiveKey('naip-20261212')));
    // Every tile of the copied work tiles is the old archive's, byte for byte.
    for (const wt of ['11/603/732', '11/604/731']) {
      const [, xs, ys] = wt.split('/');
      const idx = await readJson<{ entries: { tileId: number }[] }>(
        shardKeys('naip-20261212', { z: 11, x: Number(xs), y: Number(ys) }).index,
      );
      for (const e of idx.entries) {
        const [z, x, y] = tileIdToZxy(e.tileId);
        const a = await firstArchive.getZxy(z, x, y);
        const b = await next.getZxy(z, x, y);
        expect(new Uint8Array(b?.data as ArrayBuffer)).toEqual(
          new Uint8Array(a?.data as ArrayBuffer),
        );
      }
    }
    // …and the re-cut one is the new cut's.
    const recut = await readJson<{ entries: { tileId: number }[] }>(
      shardKeys('naip-20270801', { z: 11, x: 603, y: 731 }).index,
    );
    for (const e of recut.entries.slice(0, 50)) {
      const [z, x, y] = tileIdToZxy(e.tileId);
      const got = await next.getZxy(z, x, y);
      expect(new Uint8Array(got?.data as ArrayBuffer)).toEqual(
        syntheticTile(e.tileId, { ...TILES, meanBytes: 90 }),
      );
    }
    expect(old.entries.count).toBeGreaterThan(0);
    const published = await readJson<AssembledManifest>(manifestKey('naip-20270801'));
    expect(published.workTiles.find((w) => w.key === '11/604/731')?.cellCounts).toEqual(
      first.counts.get('11/604/731'),
    );
  });
});

describe('assemble refuses, and publishes nothing, when', () => {
  const setup = async (omit?: Set<string>) => {
    const build = await writeSyntheticBuild(root, {
      campaign: 'naip-20261212',
      workTiles: WORK,
      tiles: TILES,
      omit,
    });
    return build;
  };
  const nothingPublished = async () => {
    const store = fileStore(root);
    expect(await store.exists(archiveKey('naip-20261212'))).toBe(false);
    expect(await store.exists(manifestKey('naip-20261212'))).toBe(false);
  };

  it('a work tile has not landed (no done record)', async () => {
    const build = await setup(new Set(['11/604/731']));
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow(
      'work tile 11/604/731 has not landed: no done record',
    );
    await nothingPublished();
  });

  it('a done record carries another input hash (a stale cut — presence is not landing)', async () => {
    const build = await setup();
    const manifest = {
      ...build.manifest,
      workTiles: build.manifest.workTiles.map((w, i) =>
        i === 0 ? { ...w, inputHash: 'f'.repeat(64) } : w,
      ),
    };
    await expect(assemble(manifest, depsFor().deps)).rejects.toThrow(
      /has not landed: its done record is for/,
    );
    await nothingPublished();
  });

  it('an index is missing or disagrees with its record', async () => {
    const build = await setup();
    const keys = shardKeys('naip-20261212', WORK[0] as (typeof WORK)[number]);
    const index = await readJson<{ entries: unknown[] }>(keys.index);
    await writeFile(join(root, keys.index), JSON.stringify({ ...index, workTile: '11/604/731' }));
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow();
    await rm(join(root, keys.index));
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow('no index beside it');
    await nothingPublished();
  });

  it('a count names a frame outside its cell’s stack (a pixel that can’t be dated)', async () => {
    const build = await setup();
    const keys = shardKeys('naip-20261212', WORK[0] as (typeof WORK)[number]);
    const done = await readJson<{ cellCounts: Record<string, Record<string, number>> }>(keys.done);
    const cell = Object.keys(done.cellCounts)[0] as string;
    done.cellCounts[cell] = { vt_m_4407001_ne_18_030_20190101: 5 };
    await writeFile(join(root, keys.done), JSON.stringify(done));
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow(
      'neither its pick nor its stack',
    );
    await nothingPublished();
  });

  it('a work tile counts a cell it doesn’t touch', async () => {
    const build = await setup();
    const manifest = {
      ...build.manifest,
      workTiles: build.manifest.workTiles.map((w, i) =>
        i === 0 ? { ...w, cells: w.cells.slice(1) } : w,
      ),
    };
    await expect(assemble(manifest, depsFor().deps)).rejects.toThrow("which it doesn't touch");
  });

  it('a frame’s acquisition day disagrees with its item id', async () => {
    const build = await setup();
    const [item] = Object.keys(build.manifest.frames);
    const manifest = {
      ...build.manifest,
      frames: {
        ...build.manifest.frames,
        [item as string]: { ...build.manifest.frames[item as string], acquired: '2025-07-15' },
      },
    } as NaipManifest;
    await expect(assemble(manifest, depsFor().deps)).rejects.toThrow('fails its own check');
  });

  it('a published key already exists (keys are immutable)', async () => {
    const build = await setup();
    await assemble(build.manifest, depsFor().deps);
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow('already exists');
  });

  it('the manifest is inconsistent with itself', async () => {
    const build = await setup();
    await expect(assemble({ ...build.manifest, pilot: 'x' }, depsFor().deps)).rejects.toThrow(
      'disagree',
    );
    await expect(assemble({ ...build.manifest, workTiles: [] }, depsFor().deps)).rejects.toThrow(
      'no work tiles',
    );
    await expect(
      assemble(
        {
          ...build.manifest,
          workTiles: build.manifest.workTiles.map((w) => ({ ...w, retile: false })),
        },
        depsFor().deps,
      ),
    ).rejects.toThrow('based on no build');
  });

  it('a zoom would be empty', async () => {
    const build = await writeSyntheticBuild(root, {
      campaign: 'naip-20261212',
      workTiles: WORK.slice(0, 1),
      tiles: { ...TILES, density: (z) => (z === 15 ? 0 : 0.01) },
    });
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow(
      new AssembleRefusal('the archive would have no tile at zoom 15'),
    );
    await nothingPublished();
  });

  it('the current build can’t be read for an unchanged work tile', async () => {
    const build = await setup();
    const based = {
      ...build.manifest,
      basedOn: {
        archive: 'naip-summer-20260101.pmtiles',
        manifest: 'naip-summer-20260101-manifest.json',
      },
      workTiles: build.manifest.workTiles.map((w, i) => (i === 0 ? { ...w, retile: false } : w)),
    };
    await expect(assemble(based, depsFor().deps)).rejects.toThrow('is not in the bucket');
  });
});

describe('assemble, the rest of its refusals and the dry run', () => {
  const base = async () =>
    writeSyntheticBuild(root, { campaign: 'naip-20261212', workTiles: WORK, tiles: TILES });

  it('plans without uploading: the layout’s numbers, nothing written', async () => {
    const build = await base();
    const { deps } = depsFor();
    const { upload: _, ...rest } = deps;
    const plan = await planAssembly(build.manifest, rest);
    expect(plan).toMatchObject({
      planned: true,
      cellsDated: build.manifest.cells.length,
      flights: 2,
    });
    expect(plan.archiveBytes).toBeGreaterThan(plan.addressed);
    expect(plan.perZoom['17']).toBeGreaterThan(0);
    expect(await fileStore(root).exists(archiveKey('naip-20261212'))).toBe(false);
  });

  it('an index that is another work tile’s, or holds another count than its record', async () => {
    const build = await base();
    const a = shardKeys('naip-20261212', WORK[0] as (typeof WORK)[number]);
    const b = shardKeys('naip-20261212', WORK[1] as (typeof WORK)[number]);
    const doneA = await readJson<Record<string, unknown>>(a.done);
    const doneB = await readJson<Record<string, unknown>>(b.done);
    await writeFile(
      join(root, a.done),
      JSON.stringify({ ...doneA, tiles: (doneA.tiles as number) + 1 }),
    );
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow(
      /the index holds \d+ tiles, the record \d+/,
    );
    await writeFile(
      join(root, a.done),
      JSON.stringify({ ...doneA, bytes: doneB.bytes, tiles: doneB.tiles }),
    );
    await writeFile(join(root, a.index), await readFile(join(root, b.index)));
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow(
      "its index is 11/604/731's",
    );
  });

  it('nothing to assemble: every work tile empty', async () => {
    const build = await writeSyntheticBuild(root, {
      campaign: 'naip-20261212',
      workTiles: WORK.slice(0, 1),
      tiles: { ...TILES, density: () => 0 },
    });
    await expect(assemble(build.manifest, depsFor().deps)).rejects.toThrow('nothing to assemble');
  });

  it('an unchanged work tile the current build can’t vouch for', async () => {
    const first = await base();
    await assemble(first.manifest, depsFor().deps);
    const second = await writeSyntheticBuild(root, {
      campaign: 'naip-20270801',
      workTiles: WORK,
      tiles: TILES,
    });
    const basedOn = {
      archive: 'naip-summer-20261212.pmtiles',
      manifest: 'naip-summer-20261212-manifest.json',
    };
    const copyFirst = (patch: object) => ({
      ...second.manifest,
      basedOn,
      workTiles: second.manifest.workTiles.map((w, i) =>
        i === 0
          ? {
              ...w,
              inputHash: first.manifest.workTiles[0]?.inputHash as string,
              retile: false,
              ...patch,
            }
          : w,
      ),
    });
    await expect(
      assemble(copyFirst({ inputHash: 'f'.repeat(64) }), depsFor().deps),
    ).rejects.toThrow('its input hash differs');
    await expect(assemble(copyFirst({ key: '11/1/1', cells: [] }), depsFor().deps)).rejects.toThrow(
      'manifest lacks it',
    );
    const oldKey = manifestKey('naip-20261212');
    const old = await readJson<AssembledManifest>(oldKey);
    await writeFile(
      join(root, oldKey),
      JSON.stringify({ ...old, workTiles: old.workTiles.map(({ cellCounts: _, ...w }) => w) }),
    );
    await expect(assemble(copyFirst({}), depsFor().deps)).rejects.toThrow('has no counts for it');
    await writeFile(
      join(root, oldKey),
      JSON.stringify({ ...old, archive: { ...old.archive, name: 'other.pmtiles' } }),
    );
    await expect(assemble(copyFirst({}), depsFor().deps)).rejects.toThrow(
      'the current manifest names other.pmtiles',
    );
  });
});

describe('the pieces', () => {
  it('names no attribution in the metadata: the console draws its own dated credit', async () => {
    const build = await writeSyntheticBuild(root, {
      campaign: 'naip-20261212',
      workTiles: WORK.slice(0, 1),
      tiles: TILES,
    });
    const meta = archiveMetadata(build.manifest);
    expect(meta).not.toHaveProperty('attribution');
    expect(meta).toMatchObject({ name: 'naip-summer-20261212', type: 'overlay', tileSize: 512 });
  });

  it('reads memory sources and store sources alike', async () => {
    await writeFile(join(root, 'obj'), Uint8Array.of(1, 2, 3, 4, 5));
    const reader = storeReader(fileStore(root));
    reader.memory.set('memory:x', Uint8Array.of(9, 8, 7));
    expect(await reader.read('memory:x', 1, 2)).toEqual(Uint8Array.of(8, 7));
    expect(await reader.read('obj', 1, 3)).toEqual(Uint8Array.of(2, 3, 4));
    const chunks: Uint8Array[] = [];
    for await (const c of reader.stream('memory:x', 0, 3)) chunks.push(c);
    for await (const c of reader.stream('obj', 3, 2)) chunks.push(c);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([9, 8, 7, 4, 5]));
  });
});
