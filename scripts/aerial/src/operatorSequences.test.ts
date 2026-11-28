/**
 * **The operator's sequences** (B05 §2.8, the eighth review): select, tiles, assemble, verify and
 * cleanup run in the orders an operator actually runs them — resumed, interrupted, with the picks
 * changed part way, from two terminals — against the recording world (`stageHarness.ts`), each
 * ending where §2.8's tables say it ends.
 *
 * The first is PR #188's seventh review: changed picks, `tiles` re-run while the campaign's
 * assembler is up. Before the fix the stage uploaded the new manifest over the build key and only
 * then reached `spawn.sh`'s refusal; the archive was then assembled from the old manifest while the
 * bucket named the new one, verify refused the mismatch, and restoring the old selection couldn't
 * repair it (the tiles stage saw the matching published manifest and uploaded nothing).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type NaipFoliageStrike,
  type NaipManifest,
  naipBuildInputsDiff,
  naipBuildInputsHash,
} from '@skating/core';
import { afterEach, describe, expect, test } from 'vitest';
import { assemblyKeys } from './assemble/assemble';
import { lockPath } from './campaignLock';
import { archiveKey, buildManifestKey, indexKey, manifestKey } from './keys';
import { StageRefusal } from './refusals';
import { runAssembleStage } from './stage/assembleStage';
import { runCleanupStage } from './stage/cleanupStage';
import { runSelectStage } from './stage/selectRun';
import { runTilesStage } from './stage/tilesStage';
import { doneRecord, FakeWorld, fixtureManifest, fixtureSources, LOCAL } from './stageHarness';

const CAMPAIGN = 'naip-pilot-20261212';
// A pilot names its area (`select.pilotUnbounded`): one state of the fixture.
const PILOT = ['--pilot', 'champlain', '--states', 'NY'];

const worlds: FakeWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

/** A pilot's world (its manifest archives nothing), whose Machines land what they're given. */
function world(): FakeWorld {
  const w = new FakeWorld();
  worlds.push(w);
  w.deployment = LOCAL;
  w.onTiles = (_c, unitsDir, list) => {
    for (const t of readFileSync(list, 'utf8').trim().split('\n')) {
      const unit = JSON.parse(
        readFileSync(join(unitsDir, `${t.replaceAll('/', '_')}.json`), 'utf8'),
      );
      w.put(unit.keys.done, doneRecord(CAMPAIGN, t, unit.inputHash));
    }
    return 0;
  };
  return w;
}

/** A frame strike, confirmed, on the first pick in the pilot's area that has a fallback: the picks change. */
async function strikeOne(): Promise<NaipFoliageStrike[]> {
  const m = await fixtureManifest(CAMPAIGN, ['--dry-run', ...PILOT]);
  const built = new Set(m.workTiles.map((w) => w.key));
  const cell = m.cells.find(
    (c) => c.stack.length > 0 && c.workTiles.some((t) => built.has(t)),
  ) as NaipManifest['cells'][number];
  return [{ itemId: cell.pick, reason: 'turned', reviewedBy: 'founder', reviewedOn: '2026-12-12' }];
}

const select = (w: FakeWorld, strikes: NaipFoliageStrike[] = []) =>
  runSelectStage([CAMPAIGN, ...PILOT], w.world(), () =>
    fixtureSources({ foliageStrikes: strikes }),
  );
const tiles = (w: FakeWorld) => runTilesStage([CAMPAIGN, ...PILOT], w.world());
const assemble = (w: FakeWorld) => runAssembleStage([CAMPAIGN, ...PILOT], w.world());

const P = 'champlain';
const buildKey = buildManifestKey(CAMPAIGN, P);

/** The assembler, run to its end: it publishes the build manifest it read and records its inputs. */
function finishAssembly(w: FakeWorld): NaipManifest {
  const read = w.json<NaipManifest>(buildKey) as NaipManifest;
  w.put(archiveKey(CAMPAIGN, P), 'pmtiles');
  w.put(indexKey(CAMPAIGN, P), '{}');
  w.put(manifestKey(CAMPAIGN, P), {
    ...read,
    archive: { name: 'naip-summer-20261212.pmtiles', bytes: 7, sha256: '0'.repeat(64) },
  });
  w.put(assemblyKeys(CAMPAIGN, P).record, {
    version: 2,
    campaign: CAMPAIGN,
    pilot: P,
    inputs: naipBuildInputsHash(read),
    finishedAt: '2026-12-12T13:00:00Z',
    archive: { key: archiveKey(CAMPAIGN, P), bytes: 7 },
    cellIndex: { key: indexKey(CAMPAIGN, P), bytes: 2, gzipBytes: 1 },
    manifest: { bytes: 1 },
    header: {},
    workTiles: {},
    overviews: [],
    cells: {},
    timings: {},
    memory: { peakRssBytes: 0 },
    perZoom: {},
  });
  w.machines = { assembler: false, workTiles: [] };
  return read;
}

/** What verify holds to one value (`verify.ts`): the record's inputs, the published and the build manifest's. */
function consistent(w: FakeWorld): boolean {
  const published = w.json<NaipManifest>(manifestKey(CAMPAIGN, P)) as NaipManifest;
  const build = w.json<NaipManifest>(buildKey) as NaipManifest;
  const record = w.json<{ inputs: string }>(assemblyKeys(CAMPAIGN, P).record) as { inputs: string };
  return (
    record.inputs === naipBuildInputsHash(published) &&
    naipBuildInputsDiff(published, build).length === 0
  );
}

async function refusal(p: Promise<unknown>): Promise<StageRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StageRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('the seventh review: changed picks under a live assembler', () => {
  test('the refused re-run leaves the build manifest byte-identical; restoring the selection assembles and verifies', async () => {
    const w = world();
    await select(w);
    expect(await tiles(w)).toBe(0);
    const before = w.objects.get(buildKey)?.text as string;
    // The assembler starts, reading this build manifest.
    w.machines = { assembler: true, workTiles: [] };

    // The founder strikes a frame; select and tiles are re-run while the assembly streams.
    await select(w, await strikeOne());
    const writes = w.writes.length;
    const refused = await refusal(tiles(w));
    expect(refused.id).toBe('tiles.assembling');
    expect(w.objects.get(buildKey)?.text).toBe(before);
    expect(w.writes.slice(writes)).toEqual([]);

    // Restoring the selection: the same inputs, a new `createdAt`. With the assembler still up, the
    // stage uploads nothing and has nothing to cut.
    await select(w);
    expect(await tiles(w)).toBe(0);
    expect(w.objects.get(buildKey)?.text).toBe(before);
    // Only the first run's upload and round, ever.
    expect(
      w.writes.filter((x) => x.kind === 'r2.upload' || x.kind === 'fly.tiles').map((x) => x.kind),
    ).toEqual(['r2.upload', 'fly.tiles']);

    // The assembly finishes from what it read; everything names one build.
    finishAssembly(w);
    expect(consistent(w)).toBe(true);
    await assemble(w);
    expect(w.writes.at(-1)).toMatchObject({
      kind: 'row.succeed',
      what: expect.stringMatching(/^already assembled/),
    });
    // And a re-run of tiles after publication finds nothing to do.
    expect(await tiles(w)).toBe(0);
    expect(w.objects.get(buildKey)?.text).toBe(before);
  });
});

describe('the ninth review: an earlier selection’s workers still running', () => {
  /**
   * Cut selection A; start re-cutting selection B; lose the laptop with B's Machines up; put A back.
   * A worker drops its done record only at the end of its cut, so A's records stand while B's
   * workers run — and then they replace the packs, the indexes and the records with B's.
   */
  async function bWorkersLive(w: FakeWorld): Promise<string[]> {
    await select(w);
    expect(await tiles(w)).toBe(0);
    await select(w, await strikeOne());
    const land = w.onTiles;
    let live: string[] = [];
    w.onTiles = (_c, unitsDir, list) => {
      // B's round: its Machines start, and the laptop loses the stage before any lands.
      live = readFileSync(list, 'utf8').trim().split('\n');
      w.machines = { assembler: false, workTiles: live };
      // What each will land: B's unit, B's input hash.
      bUnits = live.map((t) =>
        JSON.parse(readFileSync(join(unitsDir, `${t.replaceAll('/', '_')}.json`), 'utf8')),
      );
      throw new Error('the laptop slept');
    };
    await expect(tiles(w)).rejects.toThrow('the laptop slept');
    w.onTiles = land;
    await select(w); // A, put back
    return live;
  }
  let bUnits: { workTile: string; inputHash: string; keys: { done: string } }[] = [];
  /** B's workers finish (once): each lands B's shard over A's. */
  const bLands = (w: FakeWorld) => {
    for (const u of bUnits) w.put(u.keys.done, doneRecord(CAMPAIGN, u.workTile, u.inputHash));
    bUnits = [];
    w.machines = { assembler: false, workTiles: [] };
  };
  const aHashes = (w: FakeWorld) => {
    const m = JSON.parse(readFileSync(join(w.scratch, CAMPAIGN, 'manifest.json'), 'utf8'));
    return new Map(
      (m as NaipManifest).workTiles.map((x) => [x.key, x.inputHash] as [string, string]),
    );
  };

  test('tiles waits for them, then re-cuts what they replaced; nothing is called landed while one runs', async () => {
    const w = world();
    const live = await bWorkersLive(w);
    expect(live.length).toBeGreaterThan(0);
    w.onDrain = () => {
      bLands(w);
      return 0;
    };
    expect(await tiles(w)).toBe(0);
    expect(w.drains).toBeGreaterThan(0);
    expect(w.machines).toEqual({ assembler: false, workTiles: [] });
    // Every done record is A's again: B's workers landed, and the stage re-cut those work tiles.
    const want = aHashes(w);
    for (const [key, hash] of want) {
      const [, x, y] = key.split('/');
      const done = w.json<{ inputHash: string }>(
        `naip/build/pilot/champlain/${CAMPAIGN}/shards/11/${x}/${y}.done.json`,
      );
      expect(done?.inputHash, key).toBe(hash);
    }
    expect(
      w.writes
        .filter((x) => x.kind === 'fly.tiles')
        .at(-1)
        ?.what.split(' ')
        .sort(),
    ).toEqual([...live].sort());
  });

  test('assemble refuses while any of them is up; once they have gone, tiles and assemble carry on', async () => {
    const w = world();
    await bWorkersLive(w);
    // The wait gives up (a slow worker): tiles never reports success over a live worker.
    w.onDrain = () => 3;
    const mark = w.writes.length;
    await expect(tiles(w)).rejects.toThrow(/work-tile Machines are still up/);
    expect(w.writes.slice(mark).map((x) => x.kind)).not.toContain('row.succeed');
    expect(w.writes.slice(mark).map((x) => x.kind)).toContain('row.failed');
    const writes = w.writes.length;
    const refused = await refusal(assemble(w));
    expect(refused.id).toBe('assemble.workTilesRunning');
    expect(w.writes.slice(writes)).toEqual([]);
    // They finish; the stage re-cuts what they replaced, and the assembly starts.
    w.onDrain = () => {
      bLands(w);
      return 0;
    };
    expect(await tiles(w)).toBe(0);
    w.onAssemble = () => {
      finishAssembly(w);
      return 0;
    };
    await assemble(w);
    expect(consistent(w)).toBe(true);
  });
});

describe('the other sequences', () => {
  test('select → tiles → interrupted → select with changed picks → tiles: the new picks are cut, and assembled', async () => {
    const w = world();
    await select(w);
    // The round's Machines land one work tile, then the laptop loses the stage.
    let first = true;
    const land = w.onTiles;
    w.onTiles = (c, u, list) => {
      if (!first) return land(c, u, list);
      first = false;
      const one = readFileSync(list, 'utf8').trim().split('\n')[0] as string;
      const unit = JSON.parse(readFileSync(join(u, `${one.replaceAll('/', '_')}.json`), 'utf8'));
      w.put(unit.keys.done, doneRecord(CAMPAIGN, one, unit.inputHash));
      throw new Error('the laptop slept');
    };
    await expect(tiles(w)).rejects.toThrow('the laptop slept');
    await select(w, await strikeOne());
    expect(await tiles(w)).toBe(0);
    const build = w.json<NaipManifest>(buildKey) as NaipManifest;
    const scratch = JSON.parse(readFileSync(join(w.scratch, CAMPAIGN, 'manifest.json'), 'utf8'));
    expect(naipBuildInputsHash(build)).toBe(naipBuildInputsHash(scratch));
    // Every work tile of the new selection landed under its own input hash.
    w.onAssemble = () => {
      finishAssembly(w);
      return 0;
    };
    await assemble(w);
    expect(consistent(w)).toBe(true);
  });

  test('after publication, changed picks are refused by select and tiles alike, and nothing moves', async () => {
    const w = world();
    await select(w);
    await tiles(w);
    finishAssembly(w);
    const snap = w.snapshot();
    const writes = w.writes.length;
    expect((await refusal(select(w, await strikeOne()))).id).toBe('published.otherInputs');
    expect(w.snapshot()).toBe(snap);
    expect(w.writes.slice(writes).map((x) => x.kind)).toEqual(['row.start', 'row.failed']);
  });

  test('a build manifest that drifted under a published campaign is put back by the next tiles', async () => {
    // The race the preflight can't close across two machines (or this bug's leftovers, from before
    // the fix): the bucket names other picks than the archive was built from. Re-running tiles with
    // the published selection restores it, so verify passes again.
    const w = world();
    await select(w);
    await tiles(w);
    finishAssembly(w);
    const drifted = { ...(w.json<NaipManifest>(buildKey) as NaipManifest), ruleVersion: 99 };
    w.put(buildKey, drifted);
    expect(consistent(w)).toBe(false);
    expect(await tiles(w)).toBe(0);
    expect(w.writes.filter((x) => x.kind === 'r2.upload').at(-1)?.what).toBe(buildKey);
    expect(consistent(w)).toBe(true);
  });

  test('two terminals, one campaign: the second stage refuses on the lock, and the first finishes and frees it', async () => {
    const w = world();
    await select(w);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const land = w.onTiles;
    w.onTiles = (c, u, l) => land(c, u, l);
    // The first terminal's round is in flight (its Machines draining) when the second starts.
    const firstRound = w.world();
    const slow = runTilesStage([CAMPAIGN, ...PILOT], {
      ...firstRound,
      launch: {
        ...firstRound.launch,
        tiles: async (c, u, l) => {
          await held;
          return firstRound.launch.tiles(c, u, l);
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const second = await refusal(tiles(w));
    expect(second.id).toBe('lock.held');
    expect(second.message).toMatch(/held by tiles \(pid 4242 on laptop/);
    release();
    expect(await slow).toBe(0);
    expect(() => readFileSync(lockPath(w.locks, CAMPAIGN))).toThrow();
  });

  test('an interrupted cleanup finishes on its re-run: the archive, which its refusals read, goes last', async () => {
    const w = new FakeWorld();
    worlds.push(w);
    const now = new Date('2027-08-20T00:00:00Z');
    w.clockNow = now;
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const old = [
      'dev/naip/naip-summer-20261212.pmtiles',
      'dev/naip/naip-summer-20261212-cells.json',
      'dev/naip/naip-summer-20261212-manifest.json',
    ];
    for (const k of old) w.put(k, 'x', ago(250));
    w.put('naip/build/naip-20261212/shards/11/1/1.pack', 'x', ago(250));
    w.put('dev/naip/naip-summer-20270801.pmtiles', 'x', ago(10));
    const web = {
      '.env.local':
        'VITE_NAIP_PMTILES_URL=https://t.example/dev/naip/naip-summer-20270801.pmtiles\n',
    };
    const argv = ['naip-20270801', '--old', old[0] as string, '--live-since', '2027-08-11'];
    // The laptop dies after its first file delete.
    const real = w.world();
    let deletes = 0;
    const dying = {
      ...real,
      bucket: (t: Parameters<typeof real.bucket>[0]) => {
        const b = real.bucket(t);
        return {
          ...b,
          deleteFile: async (key: string) => {
            if (deletes++ === 1) throw new Error('the network went');
            return b.deleteFile(key);
          },
        };
      },
    };
    await expect(
      runCleanupStage(argv, dying, (f) => (web as Record<string, string>)[f] ?? null),
    ).rejects.toThrow('the network went');
    // The archive is still there, so the re-run plans again and finishes.
    expect(w.objects.has(old[0] as string)).toBe(true);
    await runCleanupStage(argv, w.world(), (f) => (web as Record<string, string>)[f] ?? null);
    expect([...w.objects.keys()]).toEqual(['dev/naip/naip-summer-20270801.pmtiles']);
  });
});
