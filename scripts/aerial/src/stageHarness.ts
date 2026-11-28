/**
 * **A world that records every write** (B05 §2.8), for the stage tests: a bucket in memory, Fly's
 * listing as a value, the Machines as callbacks, a real scratch directory under the system's temp
 * directory, a run row that logs its calls, and the lock's process and directory (its own temporary
 * one, never the machine's). Every write of every kind lands in `writes`; `snapshot()` is the
 * bucket, the scratch and the locks, byte for byte, so a test can say "nothing changed" exactly.
 *
 * It behaves like the real ports where the stages depend on it (`cli/world.ts`): a read of a missing
 * key is `null` (rclone's `cat` of one exits 0 with nothing, measured), a listing or read that fails
 * throws, a delete of what isn't there is not an error, a done-record copy of an empty prefix is
 * empty, and Fly's listing of an empty app is no Machine.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  NAIP_EXCLUSIONS,
  NAIP_FOLIAGE_STRIKES,
  NAIP_STATES,
  type NaipCatalogItem,
  type NaipManifest,
  type NaipState,
  selectNaipPicks,
} from '@skating/core';
import type { CatalogSnapshot } from './catalog';
import type { DeploymentTarget } from './runTarget';
import type { ScoreTarget, ThumbnailScore } from './score';
import { runSelect } from './selectStage';
import { SHARD_DONE_VERSION, type ShardDone } from './shard';
import type { SelectSources } from './stage/selectRun';
import { parseStageArgs } from './stages';
import type { AssemblerWait, Bucket, RunRow, StageWorld } from './world';

export const IMAGE = `registry.fly.io/skating-imagery@sha256:${'ab'.repeat(32)}`;
export const DEV: DeploymentTarget = {
  label: 'dev:quick-fox-123',
  isDev: true,
  isProd: false,
} as DeploymentTarget;
export const PROD: DeploymentTarget = {
  label: 'prod:big-owl-1',
  isDev: false,
  isProd: true,
} as DeploymentTarget;
export const LOCAL: DeploymentTarget = {
  label: 'local:local-skating',
  isDev: false,
  isProd: false,
} as DeploymentTarget;

/** Every kind of write a stage can make. */
export type WriteKind =
  | 'r2.upload'
  | 'r2.delete'
  | 'r2.deletePrefix'
  | 'fly.tiles'
  | 'fly.assemble'
  | 'row.start'
  | 'row.flush'
  | 'row.fail'
  | 'row.succeed'
  | 'row.failed'
  /** Verify's checks ran (the report and the viewer are written there). */
  | 'verify.checks';

export interface Write {
  kind: WriteKind;
  what: string;
}

/** The writes a refusal may make: the run row's open and its failed close (§2.8). */
export const REFUSAL_ROW: readonly WriteKind[] = ['row.start', 'row.failed'];

/** Every file and directory under `root`, each file with its content's hash. */
function tree(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(`${relative(root, path)}/`, ...tree(root, path));
    else
      out.push(
        `${relative(root, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      );
  }
  return out;
}

export class FakeWorld {
  readonly scratch = mkdtempSync(join(tmpdir(), 'aerial-world-'));
  /** The campaign locks' directory: this world's own, as `AERIAL_LOCK_DIR` points a real run's. */
  readonly locks = mkdtempSync(join(tmpdir(), 'aerial-locks-'));
  readonly objects = new Map<string, { text: string; modified: Date }>();
  env: Record<string, string | undefined> = {
    R2_BUCKET: 'skating-imagery',
    AERIAL_IMAGE: IMAGE,
    R2_PUBLIC_BASE_URL: 'https://pub.example',
  };
  deployment: DeploymentTarget = DEV;
  /** Fly's listing of the campaign's Machines, or the error its listing throws. */
  machines: { assembler: boolean; workTiles: string[] } | Error = {
    assembler: false,
    workTiles: [],
  };
  /** Every bucket call throws (an unreachable bucket, a missing rclone config). */
  bucketDown = false;
  clockNow = new Date('2026-12-12T12:00:00Z');
  readonly pid = 4242;
  readonly host = 'laptop';
  readonly alive = new Set<number>([4242]);
  readonly writes: Write[] = [];
  /** The row's counts, which ride its next flush or its close. */
  readonly counts: string[] = [];
  readonly out: string[] = [];
  readonly err: string[] = [];
  /** What a round's Machines do (land done records, say); its exit status. */
  onTiles: (campaign: string, unitsDir: string, list: string) => number = () => 0;
  /**
   * What happens while the stage waits for the campaign's work-tile Machines to go (`spawn.sh
   * drain`); its exit status. By default they finish: the listing then names none.
   */
  onDrain: (campaign: string) => number = () => {
    if (!(this.machines instanceof Error)) this.machines = { ...this.machines, workTiles: [] };
    return 0;
  };
  /** How many times a stage waited for the work tiles to drain. */
  drains = 0;
  /** What the assembler's Machine does before it goes; `spawn.sh assemble`'s exit status. */
  onAssemble: (campaign: string, pilot: string | null) => number = () => 0;
  /** A hook run before each bucket read (a race, in a test). */
  beforeRead: (key: string) => void = () => {};

  /** Put an object in the bucket without recording it (the world as a test arranges it). */
  put(key: string, value: unknown, modified = new Date('2026-12-01T00:00:00Z')): void {
    this.objects.set(key, {
      text: typeof value === 'string' ? value : JSON.stringify(value),
      modified,
    });
  }

  json<T>(key: string): T | null {
    const o = this.objects.get(key);
    return o === undefined ? null : (JSON.parse(o.text) as T);
  }

  /** The bucket, the scratch and the locks, byte for byte. */
  snapshot(): string {
    const bucket = [...this.objects.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([k, o]) =>
          `${k} ${createHash('sha256').update(o.text).digest('hex')} ${o.modified.toISOString()}`,
      );
    return [...bucket, '--', ...tree(this.scratch), '-- locks', ...tree(this.locks)].join('\n');
  }

  /** The writes beyond what a refusal may make. */
  writesBeyondRefusal(): Write[] {
    return this.writes.filter((w) => !REFUSAL_ROW.includes(w.kind));
  }

  /** The row's calls, in order. */
  rowCalls(): WriteKind[] {
    return this.writes.filter((w) => w.kind.startsWith('row.')).map((w) => w.kind);
  }

  dispose(): void {
    rmSync(this.scratch, { recursive: true, force: true });
    rmSync(this.locks, { recursive: true, force: true });
  }

  private bucket(): Bucket {
    const guard = () => {
      if (this.bucketDown)
        throw new Error('rclone cat exited 1: didn\'t find section in config file ("r2")');
    };
    const record = (kind: WriteKind, what: string) => this.writes.push({ kind, what });
    return {
      read: async (key) => {
        guard();
        this.beforeRead(key);
        return this.objects.get(key)?.text ?? null;
      },
      list: async (prefix) => {
        guard();
        return [...this.objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, o]) => ({ key, modified: o.modified }));
      },
      doneRecords: async (prefix) => {
        guard();
        const out = new Map<string, string>();
        for (const [k, o] of this.objects) {
          if (k.startsWith(prefix) && k.endsWith('.done.json')) {
            out.set(k.slice(prefix.length, -'.done.json'.length), o.text);
          }
        }
        return out;
      },
      upload: async (local, key) => {
        guard();
        record('r2.upload', key);
        this.objects.set(key, { text: readFileSync(local, 'utf8'), modified: this.clockNow });
      },
      deleteFile: async (key) => {
        guard();
        record('r2.delete', key);
        this.objects.delete(key);
      },
      deletePrefix: async (prefix) => {
        guard();
        record('r2.deletePrefix', prefix);
        for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
      },
    };
  }

  world(): StageWorld {
    const record = (kind: WriteKind, what = '') => this.writes.push({ kind, what });
    const row = (): RunRow =>
      ({
        start: () => record('row.start'),
        // Held in memory until a flush or the close (`RunLogger.count`): not a write of its own.
        count: (name: string, value: number) => this.counts.push(`${name}=${value}`),
        flush: () => record('row.flush'),
        fail: (f: { key?: string }) => record('row.fail', String(f.key ?? '')),
        succeed: (notes?: string[]) => record('row.succeed', (notes ?? []).join('; ')),
        failed: (e: unknown) => record('row.failed', e instanceof Error ? e.message : String(e)),
      }) as RunRow;
    return {
      env: (name) => this.env[name],
      deployment: () => this.deployment,
      scratch: this.scratch,
      locks: this.locks,
      bucket: () => this.bucket(),
      fly: {
        live: async () => {
          if (this.machines instanceof Error) throw this.machines;
          return this.machines;
        },
      },
      launch: {
        tiles: async (campaign, unitsDir, list) => {
          record('fly.tiles', readFileSync(list, 'utf8').trim().split('\n').join(' '));
          return this.onTiles(campaign, unitsDir, list);
        },
        drain: async (campaign) => {
          this.drains++;
          return this.onDrain(campaign);
        },
        assemble: (campaign, pilot): AssemblerWait => {
          record('fly.assemble', campaign);
          const code = this.onAssemble(campaign, pilot);
          return { exit: () => code, stop: () => {} };
        },
      },
      row,
      out: (t) => this.out.push(t),
      err: (t) => this.err.push(t),
      now: () => this.clockNow,
      sleep: async () => {},
      clock: () => this.clockNow.getTime(),
      process: { pid: this.pid, host: this.host, alive: (pid) => this.alive.has(pid) },
    };
  }
}

/** A done record a work tile's Machine would land. */
export function doneRecord(campaign: string, workTile: string, inputHash: string): ShardDone {
  return {
    version: SHARD_DONE_VERSION,
    campaign,
    workTile,
    inputHash,
    image: IMAGE,
    tiles: 1,
    bytes: 1,
    packSha256: '0'.repeat(64),
    timings: {},
    cellCounts: {},
    finishedAt: '2026-12-12T00:00:00Z',
  };
}

// ── The select stage's fixture: 117 real catalog rows (`selectFixture.jsonl`) ─────────────────────

export const FIXTURE_ITEMS: NaipCatalogItem[] = readFileSync(
  new URL('./selectFixture.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => {
    const { scoutsPick: _, ...c } = JSON.parse(l) as NaipCatalogItem & { scoutsPick?: true };
    return { ...c, thumbnail: `https://blob.example/${c.itemId}.200.jpg` };
  });

const PER_STATE = Object.fromEntries(
  NAIP_STATES.map((s) => [s, FIXTURE_ITEMS.filter((i) => i.state === s).length]),
) as Record<NaipState, number>;

/** The cells the fixture's selection picks (every one a `--cells` file may list), with their states. */
export const FIXTURE_PICKS: readonly { key: string; states: readonly NaipState[] }[] =
  selectNaipPicks(FIXTURE_ITEMS, NAIP_EXCLUSIONS, NAIP_FOLIAGE_STRIKES).picks;

/**
 * A pilot's `--cells` file over the fixture (a pilot takes `--cells` only): the name a test passes,
 * which `fixtureSources`' reader answers with every picked cell `state` lists — what `--states`
 * would have reached, as cells: a part of the fixture.
 */
export const fixtureCellsFile = (state: NaipState): string => `fixture-cells-${state}.txt`;

/** The text of a `--cells` file listing `keys`. */
export const cellsText = (keys: Iterable<string>): string =>
  `${[...new Set(keys)].sort().join('\n')}\n`;

function readFixtureCells(path: string): string {
  const state = /^fixture-cells-([A-Z]{2})\.txt$/.exec(path)?.[1] as NaipState | undefined;
  return state === undefined
    ? ''
    : cellsText(FIXTURE_PICKS.filter((p) => p.states.includes(state)).map((p) => p.key));
}

/** The select stage's sources over the fixture: every frame scored clean, nothing written. */
export function fixtureSources(over: Partial<SelectSources> = {}): SelectSources {
  const snapshot: CatalogSnapshot = {
    walkedOn: '2026-11-25',
    perState: PER_STATE,
    pages: {},
    items: FIXTURE_ITEMS,
    walked: true,
  };
  return {
    walk: async (onState) => {
      for (const s of NAIP_STATES) onState(s, PER_STATE[s]);
      return snapshot;
    },
    score: async (targets: readonly ScoreTarget[]) =>
      new Map<string, ThumbnailScore | null>(
        targets.map((t) => [t.itemId, { white: 0.001, valid: 1 }]),
      ),
    readCellList: readFixtureCells,
    log: () => {},
    fetchCurrent: async () => {
      throw new Error('not asked');
    },
    thumbsDir: join(tmpdir(), 'aerial-no-thumbs'),
    ...over,
  };
}

/**
 * The fixture's manifest for `campaign`, as the select stage writes it (a dry run by default: no
 * snapshot to archive, so the tiles stage uploads the manifest alone).
 */
export async function fixtureManifest(
  campaign = 'naip-20261212',
  extra: string[] = ['--dry-run'],
): Promise<NaipManifest> {
  const src = fixtureSources();
  const { fetchCurrent: _, thumbsDir: __, ...deps } = src;
  const result = await runSelect(parseStageArgs([campaign, ...extra], 'select'), {
    ...deps,
    readCurrent: () => Promise.reject(new Error('not asked')),
    readPublished: async () => null,
    writeManifest: () => '',
    writeSheet: () => '',
    run: null,
    now: () => new Date('2026-12-12T00:00:00Z'),
  });
  return result.manifest;
}
