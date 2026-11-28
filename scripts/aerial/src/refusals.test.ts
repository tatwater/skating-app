/**
 * **Decide before you write, for every refusal the pipeline can issue** (B05 §2.8, the eighth
 * review). Two halves:
 *
 * 1. **The inventory is the source.** Every refusal constructed under `src/` (a `new …Refusal(` or
 *    `new StageArgsError(`, a `refuse(`) carries a literal id from `refusals.ts`' catalog; every id
 *    in the catalog is thrown somewhere. A refusal added without an id, an id no source throws, or a
 *    construction whose id isn't literal fails here.
 * 2. **Every id has a case.** `CASES` is typed `Record<RefusalId, …>`, so a new id without a case
 *    fails `check-types` before it fails here. Each case arranges a world in which that refusal
 *    fires, runs the stage, and asserts: the refusal is the one named; nothing was written beyond the
 *    run row's open and its failed close (no upload, no delete, no Machine, no beat, no success); and
 *    the bucket and the scratch are byte-identical to before. A refusal that only the Machine can
 *    decide runs the assembler itself against a bucket on disk, and asserts no upload and no
 *    progress write.
 */

import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NaipManifest, naipBuildInputsHash } from '@skating/core';
import fc from 'fast-check';
import { afterEach, describe, expect, test } from 'vitest';
import { type AssembleDeps, assemble, assemblyKeys, readBuildManifest } from './assemble/assemble';
import { fileStore, fileUploads } from './assemble/stores';
import { hashRenderer, writeSyntheticBuild } from './assemble/synthetic';
import { lockPath } from './campaignLock';
import { planCleanup } from './cleanup';
import {
  archiveKey,
  buildManifestKey,
  indexKey,
  manifestKey,
  scratchPaths,
  shardKeys,
} from './keys';
import { REFUSAL_IDS, type RefusalId, StageRefusal } from './refusals';
import { runAssembleStage } from './stage/assembleStage';
import { runCleanupStage } from './stage/cleanupStage';
import { type FoliageSources, runFoliageStage } from './stage/foliageRun';
import { runSelectStage, type SelectSources } from './stage/selectRun';
import { runTilesStage } from './stage/tilesStage';
import { runVerifyStage } from './stage/verifyStage';
import {
  DEV,
  doneRecord,
  FakeWorld,
  FIXTURE_ITEMS,
  fixtureManifest,
  fixtureSources,
  LOCAL,
  PROD,
  type Write,
} from './stageHarness';

const SRC = dirname(fileURLToPath(import.meta.url));
const CAMPAIGN = 'naip-20261212';

// ── 1. The inventory is the source ──────────────────────────────────────────────────────────────

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'stageHarness.ts') {
      out.push(path);
    }
  }
  return out;
}

/** Every refusal construction in `src/`, with its literal id (`null`: none). */
function constructions(): { file: string; line: number; id: string | null; text: string }[] {
  const out: { file: string; line: number; id: string | null; text: string }[] = [];
  // A construction, a `refuse(` helper's call, or the facts' Fly read (`CampaignFacts.machines`),
  // which throws the id its caller names.
  const site = /\bnew (?:[A-Z]\w*Refusal|StageArgsError)\(|(?<![\w.])refuse\(|\.machines\(/g;
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(site)) {
      const before = text.slice(0, m.index);
      const line = before.split('\n').length;
      const lineText = text.split('\n')[line - 1] as string;
      // A definition (`const refuse = (id…`, `function refuse(id…`, `machines(id: …`), not a call.
      if (/(?:function refuse|const refuse = |^\s*machines)\(/.test(lineText)) continue;
      const after = text.slice((m.index as number) + m[0].length);
      // A helper forwarding the id it was handed, typed `RefusalId`: its callers are the sites.
      if (/^\s*id,/.test(after) || /^\s*\n\s*id,/.test(after)) continue;
      const id = /^\s*'([a-zA-Z]+\.[a-zA-Z]+)'/.exec(after)?.[1] ?? null;
      out.push({ file: relative(SRC, path), line, id, text: lineText.trim() });
    }
  }
  return out;
}

describe('the refusal inventory', () => {
  const found = constructions();

  test('every refusal constructed in src/ names a literal id from the catalog', () => {
    expect(found.length).toBeGreaterThan(80);
    const unnamed = found.filter((c) => c.id === null).map((c) => `${c.file}:${c.line} ${c.text}`);
    expect(unnamed).toEqual([]);
    const unknown = found
      .filter((c) => c.id !== null && !(REFUSAL_IDS as string[]).includes(c.id))
      .map((c) => `${c.file}:${c.line} ${c.id}`);
    expect(unknown).toEqual([]);
  });

  test('every id in the catalog is thrown somewhere', () => {
    const thrown = new Set(found.map((c) => c.id));
    expect(REFUSAL_IDS.filter((id) => !thrown.has(id))).toEqual([]);
  });

  test('every id has a case, and every case an id', () => {
    expect(Object.keys(CASES).sort()).toEqual([...REFUSAL_IDS].sort());
    for (const id of REFUSAL_IDS) expect(CASES[id].length, id).toBeGreaterThan(0);
  });
});

// ── 2. The cases ────────────────────────────────────────────────────────────────────────────────

const worlds: FakeWorld[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) w.dispose();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
function fresh(): FakeWorld {
  const w = new FakeWorld();
  worlds.push(w);
  return w;
}

/** The select stage's manifest written into the campaign's scratch, as a select would. */
function writeScratchManifest(w: FakeWorld, manifest: NaipManifest): void {
  const paths = scratchPaths(manifest.campaign, w.scratch);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
}

/** Every retile work tile landed, as the Machines would leave them. */
function landAll(w: FakeWorld, m: NaipManifest): void {
  for (const wt of m.workTiles.filter((x) => x.retile)) {
    const [, x, y] = wt.key.split('/').map(Number) as [number, number, number];
    w.put(
      shardKeys(m.campaign, { z: 11, x, y }, m.pilot ?? undefined).done,
      doneRecord(m.campaign, wt.key, wt.inputHash),
    );
  }
}

/** Other inputs than `m`, by core's identity (another rule's stamp). */
const otherInputs = (m: NaipManifest): NaipManifest => ({ ...m, ruleVersion: m.ruleVersion + 1 });

const tiles = (w: FakeWorld, ...argv: string[]) =>
  runTilesStage(argv.length ? argv : [CAMPAIGN], w.world());
const assembleLaptop = (w: FakeWorld, ...argv: string[]) =>
  runAssembleStage(argv.length ? argv : [CAMPAIGN], w.world());
const verify = (w: FakeWorld, ...argv: string[]) =>
  runVerifyStage(argv.length ? argv : [CAMPAIGN], w.world(), async () => {
    w.writes.push({ kind: 'verify.checks', what: 'ran' });
    return 0;
  });
const select = (w: FakeWorld, argv: string[], over: Partial<SelectSources> = {}) =>
  runSelectStage(argv, w.world(), () => fixtureSources(over));

/** The web's env files for cleanup, by name (absent: unreadable). */
type Web = Partial<Record<string, string>>;
const OLD = 'dev/naip/naip-summer-20261212.pmtiles';
const NEW = 'dev/naip/naip-summer-20270801.pmtiles';
const CLEAN_NOW = new Date('2027-08-20T00:00:00Z');
const daysAgo = (n: number) => new Date(CLEAN_NOW.getTime() - n * 86_400_000);
/** The bucket cleanup reads: the old build's three and its build prefix, the replacement's two. */
function arrangeCleanup(w: FakeWorld): void {
  w.clockNow = CLEAN_NOW;
  for (const [key, age] of [
    [OLD, 250],
    ['dev/naip/naip-summer-20261212-cells.json', 250],
    ['dev/naip/naip-summer-20261212-manifest.json', 250],
    [NEW, 10],
    ['dev/naip/naip-summer-20270801-cells.json', 10],
  ] as const) {
    w.put(key, 'x', daysAgo(age));
  }
  w.put('naip/build/naip-20261212/shards/11/1/1.done.json', '{}', daysAgo(250));
}
const LIVE_NEW: Web = { '.env.local': `VITE_NAIP_PMTILES_URL=https://tiles.example/${NEW}\n` };
const cleanup = (w: FakeWorld, web: Web, ...argv: string[]) =>
  runCleanupStage(argv, w.world(), (f) => web[f] ?? null);
const cleanupArgs = (...extra: string[]) => ['naip-20270801', '--old', OLD, ...extra];
function clean(
  name: string,
  web: Web,
  argv: string[],
  extra: (w: FakeWorld) => void = () => {},
): StageCase {
  return stage(
    name,
    (w) => {
      arrangeCleanup(w);
      extra(w);
    },
    (w) => cleanup(w, web, ...argv),
  );
}

/** A stage case: arrange the world, run the stage; it must refuse with the id and write nothing. */
interface StageCase {
  kind: 'stage';
  name: string;
  arrange: (w: FakeWorld) => Promise<void> | void;
  run: (w: FakeWorld) => Promise<unknown>;
  /**
   * The documented exception (`assemble.machine`, the one refusal after a write): what it may write,
   * and which bucket keys the Machine it started may have changed.
   */
  allow?: { writes: Write['kind'][]; keys: string[] };
}
/** A refusal only the Machine's assembler can decide: run it against a bucket on disk. */
interface MachineCase {
  kind: 'machine';
  name: string;
  /** Lays the bucket out under `root`; returns the manifest to assemble. */
  arrange: (root: string) => Promise<NaipManifest>;
  /** The store as the assembler sees it, if not the plain one (a race). */
  store?: (root: string) => AssembleDeps['store'];
  /** What the Machine runs, if not `assemble` on the manifest. */
  run?: (store: AssembleDeps['store']) => Promise<unknown>;
}
/** A refusal a stage's arguments refuse first, so only its pure function can show it. */
interface PureCase {
  kind: 'pure';
  name: string;
  run: () => unknown;
}
type Case = StageCase | MachineCase | PureCase;

const stage = (name: string, arrange: StageCase['arrange'], run: StageCase['run']): StageCase => ({
  kind: 'stage',
  name,
  arrange,
  run,
});
const args = (argv: string[], run: (w: FakeWorld, ...a: string[]) => Promise<unknown> = tiles) =>
  stage(
    `refused: ${argv.join(' ')}`,
    () => {},
    (w) => run(w, ...argv),
  );

// The Machine's bucket: a synthetic build of three work tiles (`assemble.test.ts`'s).
const WORK = [
  { z: 11, x: 603, y: 731 },
  { z: 11, x: 604, y: 731 },
  { z: 11, x: 603, y: 732 },
];
const TILES = { meanBytes: 64, dupEvery: 13, density: (z: number) => (z <= 12 ? 1 : 0.02) };
const synthetic = (root: string, campaign = CAMPAIGN, over: object = {}) =>
  writeSyntheticBuild(root, { campaign, workTiles: WORK, tiles: TILES, ...over });
async function assembled(root: string): Promise<NaipManifest> {
  const build = await synthetic(root);
  await assemble(build.manifest, {
    store: fileStore(root),
    upload: fileUploads(root),
    renderer: hashRenderer,
  });
  return build.manifest;
}
const readJsonAt = async <T>(root: string, key: string): Promise<T> =>
  JSON.parse(await readFile(join(root, key), 'utf8')) as T;

/** A build based on `root`'s assembled `naip-20261212`, its first work tile copied (with `patch`). */
async function copiedFrom(
  root: string,
  patch: object,
  oldPatch?: (old: Record<string, unknown>) => object,
) {
  const first = await assembled(root);
  const second = await synthetic(root, 'naip-20270801');
  if (oldPatch) {
    const key = manifestKey(CAMPAIGN);
    const old = await readJsonAt<Record<string, unknown>>(root, key);
    await writeFile(join(root, key), JSON.stringify(oldPatch(old)));
  }
  return {
    ...second.manifest,
    basedOn: {
      archive: 'naip-summer-20261212.pmtiles',
      manifest: 'naip-summer-20261212-manifest.json',
    },
    workTiles: second.manifest.workTiles.map((w, i) =>
      i === 0
        ? { ...w, inputHash: first.workTiles[0]?.inputHash as string, retile: false, ...patch }
        : w,
    ),
  } as NaipManifest;
}

/** The laptop's assemble world: the fixture's manifest at the build key, every work tile landed. */
async function assembleWorld(
  w: FakeWorld,
  edit: (m: NaipManifest) => NaipManifest = (m) => m,
): Promise<NaipManifest> {
  const original = await fixtureManifest();
  const m = edit(original);
  w.put(buildManifestKey(CAMPAIGN), m);
  landAll(w, original);
  return m;
}

const PROPOSED = {
  itemId: 'x',
  reason: 'turned',
  reviewedBy: 'proposed',
  reviewedOn: '2026-11-27',
} as const;

const CASES: Record<RefusalId, Case[]> = {
  // ── Arguments: every stage reads them first, before its lock ──────────────────────────────────
  'args.campaignFirst': [args(['--dry-run'])],
  'args.campaign': [args(['naip-2026'])],
  'args.unexpected': [args([CAMPAIGN, 'stray'])],
  'args.switchValue': [args([CAMPAIGN, '--dry-run=yes'])],
  'args.twice': [
    args([CAMPAIGN, '--dry-run', '--dry-run']),
    args([CAMPAIGN, '--pilot', 'a', '--pilot', 'b']),
  ],
  'args.unknownFlag': [args([CAMPAIGN, '--nope'])],
  'args.needsValue': [args([CAMPAIGN, '--pilot']), args([CAMPAIGN, '--pilot='])],
  'args.unknownStage': [args([CAMPAIGN, '--stage', 'nope'])],
  'args.otherStage': [args([CAMPAIGN, '--stage', 'select'])],
  'args.stateUnknown': [args([CAMPAIGN, '--states', 'XX'])],
  'args.statesAndCells': [args([CAMPAIGN, '--states', 'NH', '--cells', 'c.txt'])],
  'args.pilotName': [args(['naip-pilot-20261212', '--pilot', 'Not A Name'])],
  'args.pilotMissing': [args(['naip-pilot-20261212'])],
  'args.pilotNotPilotCampaign': [args([CAMPAIGN, '--pilot', 'champlain'])],
  'args.cleanupOld': [args(['naip-20270801'], (w, ...a) => cleanup(w, {}, ...a))],
  'args.oldKey': [args(['naip-20270801', '--old', 'nope'], (w, ...a) => cleanup(w, {}, ...a))],
  'args.cleanupFlags': [
    args([...cleanupArgs(), '--states', 'NH'], (w, ...a) => cleanup(w, {}, ...a)),
  ],
  'args.liveSincePilot': [
    args(
      [
        'naip-pilot-20270801',
        '--pilot',
        'x',
        '--old',
        'dev/naip/pilot/x/naip-summer-20261212.pmtiles',
        '--live-since',
        '2027-08-11',
      ],
      (w, ...a) => cleanup(w, {}, ...a),
    ),
  ],
  'args.oldOutsideCleanup': [args([CAMPAIGN, '--old', OLD])],
  'args.liveSinceOutsideCleanup': [args([CAMPAIGN, '--live-since', '2027-08-11'])],
  'args.cellsLine': [
    stage(
      'a --cells line that is no key',
      () => {},
      (w) =>
        select(w, [CAMPAIGN, '--dry-run', '--cells', 'c.txt'], { readCellList: () => 'garbage\n' }),
    ),
  ],
  'args.cellsEmpty': [
    stage(
      'a --cells file of comments',
      () => {},
      (w) =>
        select(w, [CAMPAIGN, '--dry-run', '--cells', 'c.txt'], { readCellList: () => '# none\n' }),
    ),
  ],

  // ── Where the rows go ─────────────────────────────────────────────────────────────────────────
  'target.pilotNotLocal': [
    stage(
      'a pilot against dev',
      (w) => {
        w.deployment = DEV;
      },
      (w) => assembleLaptop(w, 'naip-pilot-20261212', '--pilot', 'champlain'),
    ),
  ],
  'target.prod': [
    stage(
      'assemble against prod',
      (w) => {
        w.deployment = PROD;
      },
      (w) => assembleLaptop(w),
    ),
    stage(
      'select against prod',
      (w) => {
        w.deployment = PROD;
      },
      (w) => select(w, [CAMPAIGN]),
    ),
  ],
  'target.notDev': [
    stage(
      'a build against a local backend',
      (w) => {
        w.deployment = LOCAL;
      },
      (w) => verify(w),
    ),
  ],

  // ── The environment and the lock ──────────────────────────────────────────────────────────────
  'env.missing': [
    stage(
      'tiles without R2_BUCKET',
      async (w) => {
        writeScratchManifest(w, await fixtureManifest());
        w.env.R2_BUCKET = undefined;
      },
      (w) => tiles(w),
    ),
    stage(
      'tiles without AERIAL_IMAGE',
      async (w) => {
        writeScratchManifest(w, await fixtureManifest());
        w.env.AERIAL_IMAGE = undefined;
      },
      (w) => tiles(w),
    ),
    stage(
      'verify without its public origin',
      (w) => {
        w.env.R2_PUBLIC_BASE_URL = undefined;
      },
      (w) => verify(w),
    ),
    stage(
      'cleanup without R2_BUCKET',
      (w) => {
        w.env.R2_BUCKET = undefined;
      },
      (w) => cleanup(w, LIVE_NEW, ...cleanupArgs('--live-since', '2027-08-11')),
    ),
  ],
  'lock.held': [
    stage(
      'another stage of the campaign runs',
      (w) => {
        w.alive.add(777);
        writeFileSync(
          lockPath(w.locks, CAMPAIGN),
          JSON.stringify({ pid: 777, host: 'laptop', stage: 'select', startedAt: 'x' }),
        );
      },
      (w) => tiles(w),
    ),
    stage(
      'a lock naming no holder',
      (w) => {
        writeFileSync(lockPath(w.locks, CAMPAIGN), 'garbage');
      },
      (w) => assembleLaptop(w),
    ),
  ],
  'lock.stale': [
    stage(
      'a lock whose process has gone',
      (w) => {
        writeFileSync(
          lockPath(w.locks, CAMPAIGN),
          JSON.stringify({ pid: 778, host: 'laptop', stage: 'tiles', startedAt: 'x' }),
        );
      },
      (w) => verify(w),
    ),
  ],

  // ── A published campaign ──────────────────────────────────────────────────────────────────────
  'published.otherInputs': [
    stage(
      'tiles over a campaign published from other inputs',
      async (w) => {
        const m = await fixtureManifest();
        writeScratchManifest(w, m);
        w.put(manifestKey(CAMPAIGN), otherInputs(m));
      },
      (w) => tiles(w),
    ),
    stage(
      'select over it',
      async (w) => {
        w.put(manifestKey(CAMPAIGN), otherInputs(await fixtureManifest(CAMPAIGN, [])));
      },
      (w) => select(w, [CAMPAIGN]),
    ),
    stage(
      'assemble over it, with no record',
      async (w) => {
        const m = await assembleWorld(w);
        w.put(manifestKey(CAMPAIGN), otherInputs(m));
      },
      (w) => assembleLaptop(w),
    ),
    stage(
      'assemble over it, with a record of those other inputs',
      async (w) => {
        const m = await assembleWorld(w);
        w.put(manifestKey(CAMPAIGN), otherInputs(m));
        w.put(assemblyKeys(CAMPAIGN).record, {
          version: 2,
          campaign: CAMPAIGN,
          inputs: naipBuildInputsHash(otherInputs(m)),
        });
      },
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine over it',
      arrange: async (root) => otherInputs(await assembled(root)),
    },
  ],

  // ── Select ────────────────────────────────────────────────────────────────────────────────────
  'select.unconfirmedStrikes': [
    stage(
      'a proposed strike, not a dry run',
      () => {},
      (w) => select(w, [CAMPAIGN], { foliageStrikes: [PROPOSED] }),
    ),
  ],
  'select.cellsNotQuarterQuads': [
    stage(
      'a key off the grid',
      () => {},
      (w) =>
        select(w, [CAMPAIGN, '--dry-run', '--cells', 'c.txt'], {
          readCellList: () => '4407099ne\n',
        }),
    ),
  ],
  'select.holes': [
    stage(
      'the exclusions leave a hole',
      () => {},
      (w) =>
        select(w, [CAMPAIGN], {
          check: () => ({ holes: ['4407028ne'], noCandidate: [], violations: [] }),
        }),
    ),
  ],
  'select.invariants': [
    stage(
      'an invariant fails',
      () => {},
      (w) =>
        select(w, [CAMPAIGN], {
          check: () => ({ holes: [], noCandidate: [], violations: ['x: broken'] }),
        }),
    ),
  ],
  'select.cellsUncovered': [
    stage(
      'a cell no frame covers',
      () => {},
      (w) =>
        select(w, [CAMPAIGN, '--dry-run', '--cells', 'c.txt'], {
          readCellList: () => '4407001nw\n',
        }),
    ),
  ],
  'select.unreadablePicks': [
    stage(
      "every pick's thumbnail unread this time",
      () => {},
      (w) => select(w, [CAMPAIGN], { unreadable: new Set(FIXTURE_ITEMS.map((i) => i.itemId)) }),
    ),
  ],
  'select.undatable': [
    stage(
      "a pick whose row disagrees with its id's day",
      () => {},
      async (w) => {
        const m = await fixtureManifest();
        const victim = m.cells[0]?.pick as string;
        const day = m.frames[victim]?.acquired as string;
        const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10);
        const items = FIXTURE_ITEMS.map((i) =>
          i.itemId === victim ? { ...i, acquired: next } : i,
        );
        return select(w, [CAMPAIGN], {
          walk: async () => ({
            walkedOn: '2026-11-25',
            perState: {},
            pages: {},
            items,
            walked: false,
          }),
        });
      },
    ),
  ],
  'select.fromCurrentUrl': [
    stage(
      '--from-current with no URL',
      () => {},
      (w) => select(w, [CAMPAIGN, '--from-current']),
    ),
  ],
  'select.fromCurrentRead': [
    stage(
      'the current manifest answers 404',
      (w) => {
        w.env.NAIP_MANIFEST_URL = 'https://pub.example/dev/naip/naip-summer-20261201-manifest.json';
      },
      (w) =>
        select(w, [CAMPAIGN, '--from-current'], {
          fetchCurrent: async () => {
            throw new StageRefusal('select.fromCurrentRead', 'the live manifest answered 404');
          },
        }),
    ),
  ],
  'select.fromCurrentFormat': [
    fromCurrent('a version-1 manifest', (m) => ({ ...m, version: 1 }) as unknown as NaipManifest),
  ],
  'select.fromCurrentUnpublished': [
    // `--from-current` while its base campaign is still assembling: its manifest names no archive yet.
    fromCurrent('a base still assembling (no archive yet)', (m) => ({ ...m, archive: undefined })),
  ],
  'select.fromCurrentRule': [
    fromCurrent('a narrowed build on another rule', (m) => ({ ...published(m), ruleVersion: 1 }), [
      '--states',
      'NH',
    ]),
  ],
  'select.fromCurrentKind': [
    fromCurrent("a pilot's manifest under a build", (m) => ({
      ...published(m),
      pilot: 'champlain',
    })),
  ],

  // ── Tiles ─────────────────────────────────────────────────────────────────────────────────────
  'tiles.noManifest': [
    stage(
      'no select yet',
      () => {},
      (w) => tiles(w),
    ),
  ],
  'tiles.otherCampaign': [
    stage(
      "another campaign's manifest in the scratch",
      async (w) => {
        const m = await fixtureManifest('naip-20261213');
        writeScratchManifest(w, m);
        fsSync.renameSync(
          scratchPaths('naip-20261213', w.scratch).dir,
          scratchPaths(CAMPAIGN, w.scratch).dir,
        );
      },
      (w) => tiles(w),
    ),
  ],
  'tiles.flyUnlisted': [
    stage(
      "Fly's listing fails",
      async (w) => {
        writeScratchManifest(w, await fixtureManifest());
        w.machines = new Error('spawn.sh status exited 1');
      },
      (w) => tiles(w),
    ),
  ],
  'tiles.assembling': [
    // **The seventh review's finding**: changed picks, the tiles stage re-run while the campaign's
    // assembler is up. The bucket's build manifest must be byte-identical afterwards.
    stage(
      'changed picks under a live assembler',
      async (w) => {
        const m = await fixtureManifest();
        w.put(buildManifestKey(CAMPAIGN), m);
        landAll(w, m);
        writeScratchManifest(w, otherInputs(m));
        w.machines = { assembler: true, workTiles: [] };
      },
      (w) => tiles(w),
    ),
    stage(
      'a live assembler with no build manifest',
      async (w) => {
        writeScratchManifest(w, await fixtureManifest());
        w.machines = { assembler: true, workTiles: [] };
      },
      (w) => tiles(w),
    ),
  ],
  'tiles.recutUnderAssembler': [
    stage(
      'the same picks, a work tile not landed, a live assembler',
      async (w) => {
        const m = await fixtureManifest();
        w.put(buildManifestKey(CAMPAIGN), m);
        writeScratchManifest(w, m);
        w.machines = { assembler: true, workTiles: [] };
      },
      (w) => tiles(w),
    ),
  ],
  'tiles.pilotArchive': [
    archived(
      'a pilot asking to archive the catalog',
      async () => {
        const m = await fixtureManifest('naip-pilot-20261212', [
          '--dry-run',
          '--pilot',
          'champlain',
        ]);
        return { ...m, catalog: { ...m.catalog, archivedAt: 'naip/inventory/2026-11-25/' } };
      },
      ['naip-pilot-20261212', '--pilot', 'champlain'],
      LOCAL,
    ),
  ],
  'tiles.archiveEmpty': [
    archived('an archive of no state', async () => {
      const m = await fixtureManifest();
      return {
        ...m,
        catalog: { ...m.catalog, perState: {}, archivedAt: 'naip/inventory/2026-11-25/' },
      };
    }),
  ],
  'tiles.archiveDay': [
    archived("an archive under another day's prefix", async () => {
      const m = await fixtureManifest();
      return { ...m, catalog: { ...m.catalog, archivedAt: 'naip/inventory/2026-01-01/' } };
    }),
  ],

  // ── Assemble: the laptop's preflight ──────────────────────────────────────────────────────────
  'assemble.noManifest': [
    stage(
      'no build manifest in the bucket',
      () => {},
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine finds none',
      arrange: async () => ({}) as NaipManifest,
      run: (store) => readBuildManifest(store, CAMPAIGN),
    },
  ],
  'assemble.flyUnlisted': [
    stage(
      "Fly's listing fails",
      async (w) => {
        await assembleWorld(w);
        w.machines = new Error('spawn.sh status exited 1');
      },
      (w) => assembleLaptop(w),
    ),
  ],
  'assemble.recordNoInputs': [
    stage(
      "the pilot's version-1 record",
      async (w) => {
        await assembleWorld(w);
        w.put(assemblyKeys(CAMPAIGN).record, { version: 1, campaign: CAMPAIGN });
      },
      (w) => assembleLaptop(w),
    ),
  ],
  'assemble.recordOtherInputs': [
    stage(
      'a record of other inputs, nothing published',
      async (w) => {
        await assembleWorld(w);
        w.put(assemblyKeys(CAMPAIGN).record, {
          version: 2,
          campaign: CAMPAIGN,
          inputs: 'f'.repeat(64),
        });
      },
      (w) => assembleLaptop(w),
    ),
  ],
  'assemble.publishedNoRecord': [
    stage(
      'published from these inputs, no record',
      async (w) => {
        const m = await assembleWorld(w);
        w.put(manifestKey(CAMPAIGN), m);
      },
      (w) => assembleLaptop(w),
    ),
  ],
  'assemble.alreadyAssembled': [
    {
      kind: 'machine',
      name: 'the Machine, published from these inputs',
      arrange: (root) => assembled(root),
    },
  ],
  'assemble.pilotMismatch': [
    stage(
      "a production campaign's manifest naming a pilot",
      (w) => assembleWorld(w, (m) => ({ ...m, pilot: 'champlain' })).then(() => {}),
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine',
      arrange: async (root) => ({ ...(await synthetic(root)).manifest, pilot: 'x' }),
    },
  ],
  'assemble.noWorkTiles': [
    stage(
      'a manifest with no work tiles',
      (w) => assembleWorld(w, (m) => ({ ...m, workTiles: [] })).then(() => {}),
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine',
      arrange: async (root) => ({ ...(await synthetic(root)).manifest, workTiles: [] }),
    },
  ],
  'assemble.noBase': [
    stage(
      'unchanged work tiles, based on nothing',
      (w) =>
        assembleWorld(w, (m) => ({
          ...m,
          workTiles: m.workTiles.map((x, i) => (i === 0 ? { ...x, retile: false } : x)),
        })).then(() => {}),
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine',
      arrange: async (root) => {
        const m = (await synthetic(root)).manifest;
        return { ...m, workTiles: m.workTiles.map((w) => ({ ...w, retile: false })) };
      },
    },
  ],
  'assemble.baseMissing': [
    stage(
      'based on a manifest not in the bucket',
      (w) =>
        assembleWorld(w, (m) => ({
          ...m,
          basedOn: {
            archive: 'naip-summer-20260101.pmtiles',
            manifest: 'naip-summer-20260101-manifest.json',
          },
          workTiles: m.workTiles.map((x, i) => (i === 0 ? { ...x, retile: false } : x)),
        })).then(() => {}),
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine',
      arrange: async (root) => {
        const m = (await synthetic(root)).manifest;
        return {
          ...m,
          basedOn: {
            archive: 'naip-summer-20260101.pmtiles',
            manifest: 'naip-summer-20260101-manifest.json',
          },
          workTiles: m.workTiles.map((w, i) => (i === 0 ? { ...w, retile: false } : w)),
        };
      },
    },
  ],
  'assemble.baseArchive': [
    stage(
      'based on a manifest naming another archive',
      async (w) => {
        await assembleWorld(w, (m) => ({
          ...m,
          basedOn: {
            archive: 'naip-summer-20260101.pmtiles',
            manifest: 'naip-summer-20260101-manifest.json',
          },
          workTiles: m.workTiles.map((x, i) => (i === 0 ? { ...x, retile: false } : x)),
        }));
        w.put('dev/naip/naip-summer-20260101-manifest.json', {
          archive: { name: 'other.pmtiles' },
        });
      },
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine',
      arrange: (root) =>
        copiedFrom(root, {}, (old) => ({
          ...old,
          archive: { ...(old.archive as object), name: 'other.pmtiles' },
        })),
    },
  ],
  'assemble.notLanded': [
    stage(
      'a work tile with no done record',
      async (w) => {
        const m = await fixtureManifest();
        w.put(buildManifestKey(CAMPAIGN), m);
      },
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine, a stale done record',
      arrange: async (root) => {
        const m = (await synthetic(root)).manifest;
        return {
          ...m,
          workTiles: m.workTiles.map((w, i) => (i === 0 ? { ...w, inputHash: 'f'.repeat(64) } : w)),
        };
      },
    },
  ],
  'assemble.orphans': [
    stage(
      'an archive left without its manifest',
      async (w) => {
        await assembleWorld(w);
        w.put(archiveKey(CAMPAIGN), 'pmtiles');
      },
      (w) => assembleLaptop(w),
    ),
    {
      kind: 'machine',
      name: 'the Machine',
      arrange: async (root) => {
        const m = await assembled(root);
        await rm(join(root, manifestKey(CAMPAIGN)));
        return m;
      },
    },
  ],
  'assemble.machine': [
    {
      ...stage(
        'the Machine refuses what only it can decide',
        async (w) => {
          await assembleWorld(w);
          w.onAssemble = () => {
            w.put(assemblyKeys(CAMPAIGN).progress.replace(/progress\.json$/, 'error.json'), {
              at: '2026-12-12T12:01:00Z',
              refused: true,
              message: 'work tile 11/603/770: its index is 11/604/770’s',
            });
            return 0;
          };
        },
        (w) => assembleLaptop(w),
      ),
      // The documented exception: the Machine was started, and it wrote its error object.
      allow: {
        writes: ['fly.assemble'],
        keys: [assemblyKeys(CAMPAIGN).progress.replace(/progress\.json$/, 'error.json')],
      },
    },
  ],

  // ── Assemble: what only the Machine can decide ────────────────────────────────────────────────
  'assemble.noIndex': [
    {
      kind: 'machine',
      name: 'a done record with no index',
      arrange: async (root) => {
        const build = await synthetic(root);
        await rm(join(root, shardKeys(CAMPAIGN, WORK[0] as (typeof WORK)[number]).index));
        return build.manifest;
      },
    },
  ],
  'assemble.indexOtherTile': [
    {
      kind: 'machine',
      name: "another work tile's index",
      arrange: async (root) => {
        const build = await synthetic(root);
        const a = shardKeys(CAMPAIGN, WORK[0] as (typeof WORK)[number]);
        const b = shardKeys(CAMPAIGN, WORK[1] as (typeof WORK)[number]);
        const doneA = await readJsonAt<Record<string, unknown>>(root, a.done);
        const doneB = await readJsonAt<Record<string, unknown>>(root, b.done);
        await writeFile(
          join(root, a.done),
          JSON.stringify({ ...doneA, bytes: doneB.bytes, tiles: doneB.tiles }),
        );
        await writeFile(join(root, a.index), await readFile(join(root, b.index)));
        return build.manifest;
      },
    },
  ],
  'assemble.indexCount': [
    {
      kind: 'machine',
      name: 'an index holding another count than its record',
      arrange: async (root) => {
        const build = await synthetic(root);
        const a = shardKeys(CAMPAIGN, WORK[0] as (typeof WORK)[number]);
        const done = await readJsonAt<Record<string, unknown>>(root, a.done);
        await writeFile(
          join(root, a.done),
          JSON.stringify({ ...done, tiles: (done.tiles as number) + 1 }),
        );
        return build.manifest;
      },
    },
  ],
  'assemble.copiedMissing': [
    {
      kind: 'machine',
      name: 'an unchanged work tile the current lacks',
      arrange: (root) => copiedFrom(root, { key: '11/1/1', cells: [] }),
    },
  ],
  'assemble.copiedHash': [
    {
      kind: 'machine',
      name: 'an unchanged work tile of another hash',
      arrange: (root) => copiedFrom(root, { inputHash: 'f'.repeat(64) }),
    },
  ],
  'assemble.copiedNoCounts': [
    {
      kind: 'machine',
      name: 'an unchanged work tile with no counts in the current',
      arrange: (root) =>
        copiedFrom(root, {}, (old) => ({
          ...old,
          workTiles: (old.workTiles as Record<string, unknown>[]).map(
            ({ cellCounts: _, ...w }) => w,
          ),
        })),
    },
  ],
  'assemble.countsCell': [
    {
      kind: 'machine',
      name: "a count of a cell the work tile doesn't touch",
      arrange: async (root) => {
        const m = (await synthetic(root)).manifest;
        return {
          ...m,
          workTiles: m.workTiles.map((w, i) => (i === 0 ? { ...w, cells: w.cells.slice(1) } : w)),
        };
      },
    },
  ],
  'assemble.dateIndex': [
    {
      kind: 'machine',
      name: "a frame's day against its id",
      arrange: async (root) => {
        const m = (await synthetic(root)).manifest;
        const [item] = Object.keys(m.frames);
        return {
          ...m,
          frames: {
            ...m.frames,
            [item as string]: { ...m.frames[item as string], acquired: '2025-07-15' },
          },
        } as NaipManifest;
      },
    },
  ],
  'assemble.empty': [
    {
      kind: 'machine',
      name: 'every work tile empty',
      arrange: async (root) =>
        (
          await writeSyntheticBuild(root, {
            campaign: CAMPAIGN,
            workTiles: WORK.slice(0, 1),
            tiles: { ...TILES, density: () => 0 },
          })
        ).manifest,
    },
  ],
  'assemble.zoomEmpty': [
    {
      kind: 'machine',
      name: 'a zoom with no tile',
      arrange: async (root) =>
        (
          await writeSyntheticBuild(root, {
            campaign: CAMPAIGN,
            workTiles: WORK.slice(0, 1),
            tiles: { ...TILES, density: (z) => (z === 15 ? 0 : 0.01) },
          })
        ).manifest,
    },
  ],
  'assemble.keyExists': [
    {
      kind: 'machine',
      name: 'a manifest landing while this one reads its inputs (another assembler, racing)',
      arrange: (root) => assembled(root),
      store: (root) => {
        const plain = fileStore(root);
        let first = true;
        // The published manifest is unseen at step 0 and present by step 5; the existence checks
        // ask `exists`, which sees it — at step 0 too, as a race seen early.
        return {
          ...plain,
          get: async (key: string) => {
            if (key === manifestKey(CAMPAIGN) && first) {
              first = false;
              return null;
            }
            return plain.get(key);
          },
        };
      },
    },
  ],

  // ── Cleanup ───────────────────────────────────────────────────────────────────────────────────
  'cleanup.liveSinceDay': [
    clean('a day the calendar lacks', LIVE_NEW, cleanupArgs('--live-since', '2027-02-30')),
  ],
  'cleanup.liveSinceFormat': [
    clean('not a day', LIVE_NEW, cleanupArgs('--live-since', 'yesterday')),
  ],
  'cleanup.otherKind': [
    clean("a pilot's key from a build", LIVE_NEW, [
      'naip-20270801',
      '--old',
      'dev/naip/pilot/x/naip-summer-20261212.pmtiles',
      '--live-since',
      '2027-08-11',
    ]),
  ],
  'cleanup.own': [
    clean("this build's own archive", LIVE_NEW, [
      'naip-20270801',
      '--old',
      NEW,
      '--live-since',
      '2027-08-11',
    ]),
  ],
  'cleanup.notOlder': [
    clean('a newer archive', LIVE_NEW, [
      'naip-20261212',
      '--old',
      NEW,
      '--live-since',
      '2027-08-11',
    ]),
  ],
  'cleanup.absent': [
    clean('an archive not in the bucket', LIVE_NEW, [
      'naip-20270801',
      '--old',
      'dev/naip/naip-summer-20260101.pmtiles',
      '--live-since',
      '2027-08-11',
    ]),
  ],
  'cleanup.newest': [
    clean('the newest archive', LIVE_NEW, cleanupArgs('--live-since', '2027-08-11'), (w) => {
      w.objects.delete(NEW);
    }),
  ],
  'cleanup.noReplacement': [
    clean(
      "the replacement isn't there",
      LIVE_NEW,
      cleanupArgs('--live-since', '2027-08-11'),
      (w) => {
        w.objects.delete(NEW);
        w.put('dev/naip/naip-summer-20280101.pmtiles', 'x', daysAgo(1));
      },
    ),
  ],
  'cleanup.webUnreadable': [
    clean('no web env file', {}, cleanupArgs('--live-since', '2027-08-11')),
  ],
  'cleanup.webPointsAtOld': [
    clean(
      'the web points at the old archive',
      { '.env': `VITE_NAIP_PMTILES_URL=https://tiles.example/${OLD}\n` },
      cleanupArgs('--live-since', '2027-08-11'),
    ),
  ],
  'cleanup.pilotLiveSince': [
    {
      kind: 'pure',
      name: "planCleanup, which a pilot's --live-since never reaches through the stage (args.liveSincePilot)",
      run: () =>
        planCleanup({
          campaign: 'naip-pilot-20270801',
          pilot: 'x',
          old: 'dev/naip/pilot/x/naip-summer-20261212.pmtiles',
          listing: [
            { key: 'dev/naip/pilot/x/naip-summer-20261212.pmtiles', modified: daysAgo(250) },
            { key: 'dev/naip/pilot/x/naip-summer-20270801.pmtiles', modified: daysAgo(10) },
          ],
          liveArchiveUrls: [],
          liveSince: { from: daysAgo(9), to: daysAgo(8) },
          now: CLEAN_NOW,
        }),
    },
  ],
  'cleanup.replacementNotLive': [
    clean('the web names no archive', { '.env': '' }, cleanupArgs('--live-since', '2027-08-11')),
  ],
  'cleanup.needsLiveSince': [clean('no --live-since', LIVE_NEW, cleanupArgs())],
  'cleanup.liveSinceFuture': [
    clean('a day to come', LIVE_NEW, cleanupArgs('--live-since', '2027-09-01')),
  ],
  'cleanup.liveSinceBeforeUpload': [
    clean('before the upload', LIVE_NEW, cleanupArgs('--live-since', '2027-08-01')),
  ],
  'cleanup.underAWeek': [
    clean('live three days', LIVE_NEW, cleanupArgs('--live-since', '2027-08-17')),
  ],

  // ── The foliage review ────────────────────────────────────────────────────────────────────────
  'foliage.usage': [
    stage(
      'no campaign',
      () => {},
      (w) => runFoliageStage([], w.world(), foliageSources()),
    ),
    stage(
      'a bad threshold',
      () => {},
      (w) => runFoliageStage([CAMPAIGN, '--threshold', '2'], w.world(), foliageSources()),
    ),
  ],
  'foliage.pilot': [
    stage(
      'a pilot campaign',
      () => {},
      (w) => runFoliageStage(['naip-pilot-20261212'], w.world(), foliageSources()),
    ),
  ],
  'foliage.breaksRule': [
    stage(
      'the proposal leaves a hole',
      () => {},
      (w) =>
        runFoliageStage(
          [CAMPAIGN],
          w.world(),
          foliageSources({ check: () => ({ holes: ['x'], noCandidate: [], violations: [] }) }),
        ),
    ),
  ],
  'foliage.movesKept': [
    stage(
      'the reviewed list moves a kept pick',
      () => {},
      async (w) => {
        const m = await fixtureManifest();
        const cell = m.cells.find((c) => c.stack.length > 0) as NaipManifest['cells'][number];
        return runFoliageStage(
          [CAMPAIGN],
          w.world(),
          foliageSources({
            kept: [cell.pick],
            reviewed: [
              {
                itemId: cell.pick,
                reason: 'turned',
                reviewedBy: 'founder',
                reviewedOn: '2026-11-28',
              },
            ],
          }),
        );
      },
    ),
  ],
};

function fromCurrent(
  name: string,
  edit: (m: NaipManifest) => NaipManifest,
  extra: string[] = [],
): StageCase {
  return stage(
    name,
    (w) => {
      w.env.NAIP_MANIFEST_URL = '/a/local/copy.json';
    },
    async (w) => {
      const base = await fixtureManifest('naip-20261201');
      return select(w, [CAMPAIGN, '--from-current', ...extra], {
        fetchCurrent: async () => edit(base),
      });
    },
  );
}
function published(m: NaipManifest): NaipManifest {
  return {
    ...m,
    archive: { name: 'naip-summer-20261201.pmtiles', bytes: 1, sha256: '0'.repeat(64) },
  };
}
function archived(
  name: string,
  make: () => Promise<NaipManifest>,
  argv = [CAMPAIGN],
  deployment = DEV,
): StageCase {
  return stage(
    name,
    async (w) => {
      w.deployment = deployment;
      writeScratchManifest(w, await make());
    },
    (w) => tiles(w, ...argv),
  );
}
function foliageSources(review: FoliageSources['review'] = {}): FoliageSources {
  const src = fixtureSources();
  return {
    walk: async () => src.walk(() => {}),
    // Unscored: the screen proposes nothing, so what moves is the reviewed list's.
    scoreFoliage: async (targets) => new Map(targets.map((t) => [t.itemId, null])),
    scoreCloud: src.score,
    thumbsDir: src.thumbsDir,
    log: () => {},
    review: { exclusions: [], reviewed: [], kept: [], ...review },
  };
}

/** A sha of every file under `root`: the Machine's bucket, byte for byte. */
function diskSnapshot(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...diskSnapshot(root, path));
    else
      out.push(
        `${relative(root, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      );
  }
  return out;
}

describe('every refusal writes nothing', () => {
  const all = REFUSAL_IDS.flatMap((id) => CASES[id].map((c) => ({ id, c })));
  test.each(all.map(({ id, c }) => [id, c.name, c] as const))('%s — %s', async (id, _name, c) => {
    if (c.kind === 'pure') {
      let caught: unknown;
      try {
        c.run();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StageRefusal);
      expect((caught as StageRefusal).id).toBe(id);
      return;
    }
    if (c.kind === 'machine') {
      const root = await mkdtemp(join(tmpdir(), 'aerial-machine-'));
      roots.push(root);
      const manifest = await c.arrange(root);
      const before = diskSnapshot(root);
      const uploads: string[] = [];
      const progress: unknown[] = [];
      const plain = fileStore(root);
      const store = c.store?.(root) ?? plain;
      let caught: unknown;
      try {
        if (c.run !== undefined) {
          await c.run(store);
        } else {
          await assemble(manifest, {
            store,
            upload: (key) => {
              uploads.push(key);
              return fileUploads(root)(key);
            },
            renderer: hashRenderer,
            progress: (e) => {
              progress.push(e);
            },
          });
        }
      } catch (e) {
        caught = e;
      }
      expect(caught, `${id} did not refuse`).toBeInstanceOf(StageRefusal);
      expect((caught as StageRefusal).id).toBe(id);
      expect(uploads).toEqual([]);
      expect(progress).toEqual([]);
      expect(diskSnapshot(root)).toEqual(before);
      return;
    }
    const w = fresh();
    await c.arrange(w);
    const before = w.snapshot();
    let caught: unknown;
    try {
      await c.run(w);
    } catch (e) {
      caught = e;
    }
    expect(caught, `${id} did not refuse`).toBeInstanceOf(StageRefusal);
    expect((caught as StageRefusal).id, (caught as Error).message).toBe(id);
    const allowed = c.allow?.writes ?? [];
    expect(w.writesBeyondRefusal().filter((x) => !allowed.includes(x.kind))).toEqual([]);
    // The row, if it opened at all, opened and closed failed — nothing between.
    const row = w.rowCalls();
    expect([[], ['row.start', 'row.failed']]).toContainEqual(row);
    if (c.allow === undefined) {
      expect(w.snapshot()).toBe(before);
    } else {
      // Only the keys the exception names may have changed; the scratch not at all.
      const changed = new Set(c.allow.keys);
      const strip = (s: string) =>
        s
          .split('\n')
          .filter((l) => !changed.has(l.split(' ')[0] as string))
          .join('\n');
      expect(strip(w.snapshot())).toBe(strip(before));
    }
  });
});

// ── 3. Any facts that refuse, in any order: nothing written ─────────────────────────────────────

describe('any world the tiles and assemble stages refuse in, they leave as they found it', () => {
  const facts = fc.record({
    scratch: fc.constantFrom('none', 'same', 'other'),
    published: fc.constantFrom('none', 'same', 'other'),
    build: fc.constantFrom('none', 'same', 'other'),
    record: fc.constantFrom('none', 'same', 'other', 'v1'),
    assembler: fc.constantFrom('down', 'up', 'unlisted'),
    landed: fc.constantFrom('none', 'all'),
    orphan: fc.boolean(),
    bucketDown: fc.boolean(),
    r2Bucket: fc.boolean(),
    image: fc.boolean(),
    deployment: fc.constantFrom('dev', 'prod', 'local'),
    lock: fc.constantFrom('free', 'held', 'stale'),
    stage: fc.constantFrom('tiles', 'assemble'),
  });

  test('a refusal writes nothing; and under a live assembler the build manifest never moves', async () => {
    const base = await fixtureManifest();
    const other = otherInputs(base);
    const pick = (k: string) => (k === 'same' ? base : k === 'other' ? other : null);
    await fc.assert(
      fc.asyncProperty(facts, async (f) => {
        const w = new FakeWorld();
        try {
          const scratchM = pick(f.scratch);
          if (scratchM !== null) writeScratchManifest(w, scratchM);
          const pub = pick(f.published);
          if (pub !== null) w.put(manifestKey(CAMPAIGN), pub);
          const build = pick(f.build);
          if (build !== null) w.put(buildManifestKey(CAMPAIGN), build);
          if (f.record === 'v1')
            w.put(assemblyKeys(CAMPAIGN).record, { version: 1, campaign: CAMPAIGN });
          else if (f.record !== 'none') {
            w.put(assemblyKeys(CAMPAIGN).record, {
              version: 2,
              campaign: CAMPAIGN,
              inputs: naipBuildInputsHash(f.record === 'same' ? base : other),
              finishedAt: 'x',
              archive: { key: archiveKey(CAMPAIGN), bytes: 1 },
              cellIndex: { key: indexKey(CAMPAIGN), bytes: 1, gzipBytes: 1 },
              manifest: { bytes: 1 },
              header: {},
              workTiles: {},
              overviews: [],
              cells: {},
              timings: {},
              memory: { peakRssBytes: 0 },
              perZoom: {},
            });
          }
          if (f.landed === 'all') landAll(w, base);
          if (f.orphan) w.put(archiveKey(CAMPAIGN), 'pmtiles');
          w.machines =
            f.assembler === 'unlisted'
              ? new Error('no list')
              : { assembler: f.assembler === 'up', workTiles: [] };
          if (!f.r2Bucket) w.env.R2_BUCKET = undefined;
          if (!f.image) w.env.AERIAL_IMAGE = undefined;
          w.deployment = f.deployment === 'dev' ? DEV : f.deployment === 'prod' ? PROD : LOCAL;
          if (f.lock !== 'free') {
            if (f.lock === 'held') w.alive.add(777);
            writeFileSync(
              lockPath(w.locks, CAMPAIGN),
              JSON.stringify({ pid: 777, host: 'laptop', stage: 'x', startedAt: 'x' }),
            );
          }
          w.bucketDown = f.bucketDown;
          // A round's Machines land what they were given; the assembler leaves a record of what it read.
          w.onTiles = (_c, unitsDir, list) => {
            for (const t of readFileSync(list, 'utf8').trim().split('\n')) {
              const unit = JSON.parse(
                readFileSync(join(unitsDir, `${t.replaceAll('/', '_')}.json`), 'utf8'),
              );
              w.put(unit.keys.done, doneRecord(CAMPAIGN, t, unit.inputHash));
            }
            return 0;
          };
          w.onAssemble = () => 1;
          const before = w.snapshot();
          const buildBefore = w.objects.get(buildManifestKey(CAMPAIGN))?.text;
          let refused: StageRefusal | null = null;
          try {
            if (f.stage === 'tiles') await tiles(w);
            else await assembleLaptop(w);
          } catch (e) {
            if (e instanceof StageRefusal) refused = e;
          }
          if (refused !== null && refused.id !== 'assemble.machine') {
            expect(w.writesBeyondRefusal()).toEqual([]);
            expect(w.snapshot()).toBe(before);
          }
          if (f.assembler === 'up') {
            expect(w.objects.get(buildManifestKey(CAMPAIGN))?.text).toBe(buildBefore);
            expect(w.writes.filter((x) => x.kind === 'fly.tiles')).toEqual([]);
          }
          // Never a lock left behind.
          if (f.lock === 'free') expect(fsSync.existsSync(lockPath(w.locks, CAMPAIGN))).toBe(false);
        } finally {
          w.dispose();
        }
      }),
      { numRuns: 300 },
    );
  });
});
