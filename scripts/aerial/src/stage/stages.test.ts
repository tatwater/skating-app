/**
 * The stage bodies' own paths (B05 §2.8): what each writes on the way to success or a failure that
 * isn't a refusal — the rounds that never land, a Machine that exits badly, a dry run, the lock's
 * release — against the recording world. The refusals are `refusals.test.ts`'; the operator's
 * sequences `operatorSequences.test.ts`'.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NaipManifest } from '@skating/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assemblyKeys } from '../assemble/assemble';
import {
  acquireCampaignLock,
  type LockPlace,
  lockDir,
  lockPath,
  withCampaignLock,
} from '../campaignLock';
import { buildManifestKey, scratchPaths } from '../keys';
import { webDir } from '../preflight';
import { outcomeWord, StageRefusal } from '../refusals';
import { doneRecord, FakeWorld, fixtureManifest, fixtureSources } from '../stageHarness';
import { ROUND_BEAT_MS } from '../tiles';
import { runAssembleStage } from './assembleStage';
import { runCleanupStage } from './cleanupStage';
import { runFoliageStage } from './foliageRun';
import { runTilesStage } from './tilesStage';
import { runVerifyStage } from './verifyStage';

const CAMPAIGN = 'naip-20261212';
const worlds: FakeWorld[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of worlds.splice(0)) w.dispose();
});
function fresh(): FakeWorld {
  const w = new FakeWorld();
  worlds.push(w);
  return w;
}
function scratchManifest(w: FakeWorld, m: NaipManifest): void {
  const paths = scratchPaths(m.campaign, w.scratch);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.manifest, `${JSON.stringify(m)}\n`);
}

describe('the tiles stage', () => {
  test('a dry run writes the units and nothing else', async () => {
    const w = fresh();
    scratchManifest(w, await fixtureManifest());
    expect(await runTilesStage([CAMPAIGN, '--dry-run'], w.world())).toBe(0);
    expect(w.writes).toEqual([]);
    expect(existsSync(join(w.scratch, CAMPAIGN, 'units'))).toBe(true);
    expect(w.out.join('')).toMatch(/work tiles to cut \(0 copied\)/);
  });

  test('Fly unlisted is refused as something to retry, never as a verdict on the campaign', async () => {
    // Before the eighth review it surfaced as `failed: spawn.sh exited 1`; as a refusal it must
    // still say that running the stage again is the answer, and nothing else is.
    const w = fresh();
    scratchManifest(w, await fixtureManifest());
    w.machines = new Error('spawn.sh status exited 1: [spawn] can’t list the app’s Machines');
    const e = (await runTilesStage([CAMPAIGN], w.world()).catch((x) => x)) as StageRefusal;
    expect(e.id).toBe('tiles.flyUnlisted');
    expect(e.message).toMatch(/nothing was started or uploaded; run the stage again once/);
  });

  test('work tiles that never land fail the row, naming them; an unreadable done record is said', async () => {
    const w = fresh();
    const m = await fixtureManifest();
    scratchManifest(w, m);
    const [first] = m.workTiles;
    w.put(`naip/build/${CAMPAIGN}/shards/${first?.key}.done.json`, 'not json');
    w.onTiles = () => 0;
    expect(await runTilesStage([CAMPAIGN], w.world())).toBe(1);
    expect(w.rowCalls().at(-1)).toBe('row.failed');
    expect(w.writes.filter((x) => x.kind === 'fly.tiles')).toHaveLength(3);
    expect(w.writes.filter((x) => x.kind === 'row.fail')).toHaveLength(m.workTiles.length);
    expect(w.err.join('')).toMatch(new RegExp(`${first?.key}: unreadable done record`));
    expect(w.err.join('')).toMatch(/work tiles never landed/);
  });

  test('a round whose spawn.sh fails fails the stage and its row', async () => {
    const w = fresh();
    scratchManifest(w, await fixtureManifest());
    w.onTiles = () => 1;
    await expect(runTilesStage([CAMPAIGN], w.world())).rejects.toThrow('spawn.sh exited 1');
    expect(w.rowCalls().at(-1)).toBe('row.failed');
  });

  test('a round beats while its Machines run', async () => {
    vi.useFakeTimers();
    const w = fresh();
    const m = await fixtureManifest();
    scratchManifest(w, m);
    const world = w.world();
    const done = runTilesStage([CAMPAIGN], {
      ...world,
      launch: {
        ...world.launch,
        tiles: async (c, u, l) => {
          await new Promise((r) => setTimeout(r, ROUND_BEAT_MS * 2 + 1));
          for (const t of readFileSync(l, 'utf8').trim().split('\n')) {
            const unit = JSON.parse(
              readFileSync(join(u, `${t.replaceAll('/', '_')}.json`), 'utf8'),
            );
            w.put(unit.keys.done, doneRecord(c, t, unit.inputHash));
          }
          return 0;
        },
      },
    });
    await vi.advanceTimersByTimeAsync(ROUND_BEAT_MS * 2 + 10);
    expect(await done).toBe(0);
    expect(w.out.join('')).toMatch(/during round 1: 0 landed/);
    expect(w.rowCalls().at(-1)).toBe('row.succeed');
  });

  test('a drifted build manifest under a live assembler is left until it has gone', async () => {
    const w = fresh();
    const m = await fixtureManifest();
    scratchManifest(w, m);
    w.put(`dev/naip/naip-summer-20261212-manifest.json`, m);
    w.put(buildManifestKey(CAMPAIGN), { ...m, ruleVersion: 99 });
    w.machines = { assembler: true, workTiles: [] };
    expect(await runTilesStage([CAMPAIGN], w.world())).toBe(0);
    expect(w.writes).toEqual([]);
    expect(w.out.join('')).toMatch(
      /assembler is still up: run the tiles stage again once it has gone/,
    );
  });
});

describe('the assemble stage, on the laptop', () => {
  async function landed(w: FakeWorld): Promise<NaipManifest> {
    const m = await fixtureManifest();
    w.put(buildManifestKey(CAMPAIGN), m);
    for (const wt of m.workTiles) {
      w.put(
        `naip/build/${CAMPAIGN}/shards/${wt.key}.done.json`,
        doneRecord(CAMPAIGN, wt.key, wt.inputHash),
      );
    }
    return m;
  }

  test('a spawn.sh that fails is said, and the row fails', async () => {
    const w = fresh();
    await landed(w);
    w.onAssemble = () => 3;
    await expect(runAssembleStage([CAMPAIGN], w.world())).rejects.toThrow(
      /stopped waiting for the assembler/,
    );
    expect(w.rowCalls()).toEqual(['row.start', 'row.failed']);
  });

  test("the Machine's failure (not a refusal) is relayed as a failure", async () => {
    const w = fresh();
    await landed(w);
    w.onAssemble = () => {
      w.put(assemblyKeys(CAMPAIGN).progress.replace(/progress\.json$/, 'error.json'), {
        at: 'now',
        refused: false,
        message: 'the assembler made no progress for 20 minutes',
      });
      return 0;
    };
    const e = await runAssembleStage([CAMPAIGN], w.world()).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(StageRefusal);
    expect((e as Error).message).toMatch(/no progress for 20 minutes/);
  });

  test('an attached assembler is followed to its record', async () => {
    const w = fresh();
    const m = await landed(w);
    w.machines = { assembler: true, workTiles: [] };
    const { naipBuildInputsHash } = await import('@skating/core');
    w.onAssemble = () => {
      w.put(assemblyKeys(CAMPAIGN).record, {
        version: 2,
        campaign: CAMPAIGN,
        inputs: naipBuildInputsHash(m),
        archive: { key: 'a', bytes: 1 },
        cellIndex: { key: 'i', bytes: 1, gzipBytes: 1 },
        manifest: { bytes: 1 },
        header: {},
        workTiles: {},
        overviews: [],
        cells: {},
        timings: {},
        memory: { peakRssBytes: 0 },
        perZoom: {},
      });
      return 0;
    };
    await runAssembleStage([CAMPAIGN], w.world());
    expect(w.writes.map((x) => x.kind)).toEqual(['row.start', 'fly.assemble', 'row.succeed']);
  });
});

describe('the assemble stage, when the follow ends badly', () => {
  test('a record of other inputs lands (the race after the spawn): the wait is stopped, the refusal kept', async () => {
    const w = fresh();
    const m = await fixtureManifest();
    w.put(buildManifestKey(CAMPAIGN), m);
    for (const wt of m.workTiles) {
      w.put(
        `naip/build/${CAMPAIGN}/shards/${wt.key}.done.json`,
        doneRecord(CAMPAIGN, wt.key, wt.inputHash),
      );
    }
    const world = w.world();
    const stop = vi.fn();
    const e = await runAssembleStage([CAMPAIGN], {
      ...world,
      launch: {
        ...world.launch,
        assemble: () => {
          w.put(assemblyKeys(CAMPAIGN).record, {
            version: 2,
            campaign: CAMPAIGN,
            inputs: 'f'.repeat(64),
          });
          return { exit: () => undefined, stop };
        },
      },
    }).catch((x: unknown) => x);
    expect((e as StageRefusal).id).toBe('assemble.recordOtherInputs');
    expect(stop).toHaveBeenCalledOnce();
  });

  test('a bucket that goes away after the spawn: the Machine’s exit is said, not an unreadable error object', async () => {
    const w = fresh();
    const m = await fixtureManifest();
    w.put(buildManifestKey(CAMPAIGN), m);
    for (const wt of m.workTiles) {
      w.put(
        `naip/build/${CAMPAIGN}/shards/${wt.key}.done.json`,
        doneRecord(CAMPAIGN, wt.key, wt.inputHash),
      );
    }
    w.onAssemble = () => {
      w.bucketDown = true;
      return 1;
    };
    await expect(runAssembleStage([CAMPAIGN], w.world())).rejects.toThrow(/spawn.sh exited 1/);
  });

  test('an unreadable done record is said, and reads as not landed', async () => {
    const w = fresh();
    const m = await fixtureManifest();
    w.put(buildManifestKey(CAMPAIGN), m);
    w.put(`naip/build/${CAMPAIGN}/shards/${m.workTiles[0]?.key}.done.json`, '{');
    const e = await runAssembleStage([CAMPAIGN], w.world()).catch((x: unknown) => x);
    expect((e as StageRefusal).id).toBe('assemble.notLanded');
    expect(w.err.join('')).toMatch(/unreadable done record/);
  });
});

describe('verify, cleanup and the foliage review', () => {
  test("verify's checks run inside the row; one that throws fails it", async () => {
    const w = fresh();
    const boom = runVerifyStage([CAMPAIGN], w.world(), async () => {
      throw new Error('rclone serve http never answered');
    });
    await expect(boom).rejects.toThrow('never answered');
    expect(w.rowCalls()).toEqual(['row.start', 'row.failed']);
    const pilot = fresh();
    pilot.deployment = { label: 'local:x', isDev: false, isProd: false } as never;
    expect(
      await runVerifyStage(
        ['naip-pilot-20261212', '--pilot', 'champlain'],
        pilot.world(),
        async () => 0,
      ),
    ).toBe(0);
    expect(pilot.rowCalls()).toEqual(['row.start']);
    const dry = fresh();
    expect(
      await runVerifyStage([CAMPAIGN, '--dry-run'], dry.world(), async (_a, _p, row) =>
        row === null ? 0 : 1,
      ),
    ).toBe(0);
    expect(dry.writes).toEqual([]);
  });

  test('a dry cleanup prints its plan and deletes nothing', async () => {
    const w = fresh();
    w.clockNow = new Date('2027-08-20T00:00:00Z');
    const old = 'dev/naip/naip-summer-20261212.pmtiles';
    w.put(old, 'x', new Date('2026-12-12T00:00:00Z'));
    w.put('dev/naip/naip-summer-20270801.pmtiles', 'x', new Date('2027-08-10T00:00:00Z'));
    const web = {
      '.env': 'VITE_NAIP_PMTILES_URL=https://t.example/dev/naip/naip-summer-20270801.pmtiles\n',
    };
    await runCleanupStage(
      ['naip-20270801', '--old', old, '--live-since', '2027-08-11', '--dry-run'],
      w.world(),
      (f) => (web as Record<string, string>)[f] ?? null,
    );
    expect(w.writes).toEqual([]);
    expect(w.out.join('')).toMatch(/would delete: naip\/build\/naip-20261212\/\* and /);
    expect(webDir('/repo/scripts/aerial')).toBe('/repo/apps/web');
  });

  test('the foliage review writes its four outputs, and refuses a campaign that is no campaign', async () => {
    const w = fresh();
    const src = fixtureSources();
    const out = await runFoliageStage([CAMPAIGN, '--threshold=0.6'], w.world(), {
      walk: async () => src.walk(() => {}),
      scoreFoliage: async (targets) => new Map(targets.map((t) => [t.itemId, null])),
      scoreCloud: src.score,
      thumbsDir: src.thumbsDir,
      log: () => {},
      review: { exclusions: [], reviewed: [], kept: [] },
    });
    for (const f of [
      out.proposalPath,
      out.sheetPath,
      out.applied.manifestPath,
      out.applied.sheetPath,
    ]) {
      expect(existsSync(f)).toBe(true);
    }
    await expect(runFoliageStage(['naip-2026'], w.world(), {} as never)).rejects.toMatchObject({
      id: 'foliage.usage',
    });
  });
});

describe('the campaign lock', () => {
  const proc = { pid: 1, host: 'h', alive: () => true };
  const at = (w: FakeWorld, over: Partial<LockPlace> = {}): LockPlace => ({
    locks: w.locks,
    scratch: w.scratch,
    process: proc,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  test('is released however the stage ends, and only while it is still this holder’s', async () => {
    const w = fresh();
    await expect(
      withCampaignLock(at(w), CAMPAIGN, 'tiles', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath(w.locks, CAMPAIGN))).toBe(false);
    const release = acquireCampaignLock(at(w), CAMPAIGN, 'tiles');
    // Cleared by hand, then taken by another run: this release leaves the other's lock alone.
    writeFileSync(
      lockPath(w.locks, CAMPAIGN),
      JSON.stringify({ pid: 2, host: 'h', stage: 'x', startedAt: 'y' }),
    );
    release();
    release();
    expect(existsSync(lockPath(w.locks, CAMPAIGN))).toBe(true);
  });

  test('is one for every checkout on the machine: a second worktree’s stage of the campaign refuses, naming the first’s log', async () => {
    // The governor's ruling (the eighth review's independent pass): the lock sat in each checkout's
    // own scratch, so two worktrees ran one campaign's stages at once — both took "the" lock.
    const first = fresh();
    const second = fresh();
    const release = acquireCampaignLock(at(first), CAMPAIGN, 'tiles');
    expect(existsSync(join(first.scratch, `${CAMPAIGN}.lock`))).toBe(false);
    const held = (() => {
      try {
        acquireCampaignLock(at(second, { locks: first.locks }), CAMPAIGN, 'assemble');
      } catch (e) {
        return e as StageRefusal;
      }
      throw new Error('the second checkout took the lock');
    })();
    expect(held.id).toBe('lock.held');
    expect(held.message).toContain(`from ${first.scratch}`);
    expect(held.message).toContain(lockPath(first.locks, CAMPAIGN));
    release();
    // Gone (a crash): stale, naming the full lock path and the holder's own log.
    acquireCampaignLock(at(first, { process: { ...proc, pid: 9 } }), CAMPAIGN, 'tiles');
    const stale = (() => {
      try {
        acquireCampaignLock(
          at(second, { locks: first.locks, process: { ...proc, alive: (p) => p !== 9 } }),
          CAMPAIGN,
          'verify',
        );
      } catch (e) {
        return e as StageRefusal;
      }
      throw new Error('a stale lock was taken');
    })();
    expect(stale.id).toBe('lock.stale');
    expect(stale.message).toContain(`remove ${lockPath(first.locks, CAMPAIGN)} and run again`);
    expect(stale.message).toContain(join(first.scratch, `run-${CAMPAIGN}.log`));
  });

  test('lives in one per-user directory: AERIAL_LOCK_DIR, else XDG_CACHE_HOME, else ~/.cache', () => {
    const env =
      (vars: Record<string, string>) =>
      (name: string): string | undefined =>
        vars[name];
    expect(lockDir(env({ AERIAL_LOCK_DIR: '/tmp/x', HOME: '/home/a' }), '/os')).toBe('/tmp/x');
    expect(lockDir(env({ XDG_CACHE_HOME: '/c', HOME: '/home/a' }), '/os')).toBe(
      '/c/skating-aerial/locks',
    );
    // A relative XDG_CACHE_HOME is ignored (the XDG spec), as is an empty override.
    expect(lockDir(env({ XDG_CACHE_HOME: 'c', HOME: '/home/a', AERIAL_LOCK_DIR: '' }), '/os')).toBe(
      '/home/a/.cache/skating-aerial/locks',
    );
    expect(lockDir(env({}), '/os')).toBe('/os/.cache/skating-aerial/locks');
  });

  test('an interrupt releases it, and a lock it can’t create for another reason is not a refusal', async () => {
    const w = fresh();
    let interrupt: () => void = () => {};
    const unregister = vi.fn();
    await withCampaignLock(
      at(w, {
        process: {
          ...proc,
          onInterrupt: (release) => {
            interrupt = release;
            return unregister;
          },
        },
      }),
      CAMPAIGN,
      'tiles',
      async () => {
        interrupt();
        expect(existsSync(lockPath(w.locks, CAMPAIGN))).toBe(false);
      },
    );
    expect(unregister).toHaveBeenCalledOnce();
    writeFileSync(join(w.scratch, 'file'), '');
    expect(() =>
      acquireCampaignLock(at(w, { locks: join(w.scratch, 'file') }), CAMPAIGN, 'x'),
    ).toThrow();
    expect(outcomeWord(new StageRefusal('lock.held', 'x'))).toBe('refused');
    expect(outcomeWord(new Error('x'))).toBe('failed');
  });
});
