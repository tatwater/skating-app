/**
 * **Decide before you write** (B05 §2.8, the eighth review): every mutating stage's preflight.
 *
 * The rule: on any refusal path a stage has written nothing — not to R2, not to the campaign's
 * scratch files a later stage reads, not a Fly Machine, and nothing to its run row beyond opening it
 * and closing it failed. Four review rounds in a row found a stage that wrote first and refused
 * after (a manifest uploaded before the live-assembler check, a done record, a shard, a row's
 * terminal state), so each stage now runs in two halves:
 *
 * 1. **a preflight**, here, that reads every fact a refusal depends on — is this campaign published
 *    and from which inputs, is its assembler up, can Fly be listed, can the bucket be read, have its
 *    work tiles landed, where may its rows go, which variables are set — through a `ReadView`, which
 *    has no way to write, and returns a plan or throws a `StageRefusal`;
 * 2. **a body** (`stage/`) that only carries the plan out.
 *
 * Each fact is read at most once per stage (`CampaignFacts`). What a check can't decide before a
 * write — a race that exists only once something is spawned — is named where it is checked again,
 * after, and the phase doc's §2.8 lists them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type NaipManifest, naipBuildInputsHash } from '@skating/core';
import {
  type AssemblyRecord,
  assembleMessages,
  assemblyKeys,
  refuseExisting,
} from './assemble/assemble';
import { finishedAssembly } from './assemble/orchestrate';
import { type CleanupPlan, parseLiveSince, planCleanup, webArchiveUrls } from './cleanup';
import {
  archiveKey,
  buildManifestKey,
  buildPrefix,
  indexKey,
  manifestKey,
  parseCampaign,
  publishPrefix,
  scratchPaths,
} from './keys';
import { againstPublished, publishedConflict } from './publishedBuild';
import { StageRefusal } from './refusals';
import { checkRunTarget, type DeploymentTarget } from './runTarget';
import { parseShardDone, type ShardDone, shardLanded } from './shard';
import type { StageArgs } from './stages';
import { type AerialWorkUnit, selectUploads, type Upload, workUnitsFor } from './tiles';
import { type BucketReader, type BucketTarget, bucketTarget, type ReadView } from './world';

/** `name` from the environment, or a refusal naming it (`env.missing`). */
export function needEnv(
  view: Pick<ReadView, 'env'>,
  name: string,
  where = 'scripts/aerial/.env.local',
): string {
  const v = view.env(name);
  if (v === undefined || v === '') {
    throw new StageRefusal('env.missing', `${name} is not set (${where})`);
  }
  return v;
}

/** The bucket the environment names, or a refusal (`env.missing`: `R2_BUCKET`). */
export function needBucket(view: Pick<ReadView, 'env'>): BucketTarget {
  const target = bucketTarget(view);
  if (target === null) {
    throw new StageRefusal('env.missing', 'R2_BUCKET is not set (scripts/aerial/.env.local)');
  }
  return target;
}

/** Where this run's rows go, checked (`runTarget.ts`). */
export function checkedTarget(
  view: Pick<ReadView, 'deployment'>,
  pilot: string | null,
): DeploymentTarget {
  const target = view.deployment();
  checkRunTarget(pilot, target);
  return target;
}

// ── The facts ───────────────────────────────────────────────────────────────────────────────────

/**
 * A campaign's facts in the bucket and on Fly, each read at most once and only when asked for. A
 * read that fails throws (can't tell is never none) — and throws before anything is written.
 */
export class CampaignFacts {
  private readonly memo = new Map<string, Promise<unknown>>();
  readonly bucket: BucketReader;

  constructor(
    private readonly view: ReadView,
    readonly target: BucketTarget,
    readonly campaign: string,
    readonly pilot: string | null,
  ) {
    this.bucket = view.bucket(target);
  }

  private once<T>(name: string, read: () => Promise<T>): Promise<T> {
    let p = this.memo.get(name) as Promise<T> | undefined;
    if (p === undefined) {
      p = read();
      this.memo.set(name, p);
    }
    return p;
  }

  private json<T>(key: string): Promise<T | null> {
    return this.once(`json:${key}`, async () => {
      const text = await this.bucket.read(key);
      return text === null || text.trim() === '' ? null : (JSON.parse(text) as T);
    });
  }

  private get p(): string | undefined {
    return this.pilot ?? undefined;
  }

  /** The manifest published under the campaign's own keys, or `null`. */
  published(): Promise<NaipManifest | null> {
    return this.json(manifestKey(this.campaign, this.p));
  }

  /** The build manifest the assembler and verify read, or `null`. */
  buildManifest(): Promise<NaipManifest | null> {
    return this.json(buildManifestKey(this.campaign, this.p));
  }

  /** The assembly record (the assembler's last write), or `null`. */
  record(): Promise<AssemblyRecord | null> {
    return this.json(assemblyKeys(this.campaign, this.p).record);
  }

  /** An earlier attempt's error object's time, or `null`. */
  async errorAt(): Promise<string | null> {
    const key = assemblyKeys(this.campaign, this.p).progress.replace(
      /progress\.json$/,
      'error.json',
    );
    return (await this.json<{ at?: string }>(key))?.at ?? null;
  }

  /** A manifest under the campaign's publish prefix, by file name (`basedOn.manifest`), or `null`. */
  publishedByName(name: string): Promise<NaipManifest | null> {
    return this.json(`${publishPrefix(this.campaign, this.p)}${name}`);
  }

  /** Which of the campaign's three published keys exist: one listing of its publish prefix. */
  publishedKeys(): Promise<Set<string>> {
    return this.once('publishedKeys', async () => {
      const mine = new Set([
        archiveKey(this.campaign, this.p),
        indexKey(this.campaign, this.p),
        manifestKey(this.campaign, this.p),
      ]);
      const listed = await this.bucket.list(publishPrefix(this.campaign, this.p));
      return new Set(listed.map((o) => o.key).filter((k) => mine.has(k)));
    });
  }

  /** Every done record under the shards prefix, parsed (`null`: unreadable, said on stderr). */
  done(): Promise<Map<string, ShardDone | null>> {
    return this.once('done', async () => {
      const texts = await this.bucket.doneRecords(`${buildPrefix(this.campaign, this.p)}shards/`);
      const out = new Map<string, ShardDone | null>();
      for (const [workTile, text] of texts) {
        try {
          out.set(workTile, parseShardDone(JSON.parse(text)));
        } catch (e) {
          this.view.err(`${workTile}: unreadable done record (${(e as Error).message})\n`);
          out.set(workTile, null);
        }
      }
      return out;
    });
  }

  /** The campaign's live Machines, or the refusal `id` when Fly can't be listed. */
  machines(
    id: 'tiles.flyUnlisted' | 'assemble.flyUnlisted',
  ): Promise<{ assembler: boolean; workTiles: string[] }> {
    return this.once('machines', async () => {
      try {
        return await this.view.fly.live(this.campaign);
      } catch (e) {
        throw new StageRefusal(
          id,
          `can't list the app's Machines (${(e as Error).message}), so whether ${this.campaign}'s assembler is running can't be told — nothing was started or uploaded`,
        );
      }
    });
  }
}

/** Do two manifests name the same build (core's one identity)? A missing one names none. */
export function sameInputs(a: NaipManifest | null, b: NaipManifest | null): boolean {
  return a !== null && b !== null && naipBuildInputsHash(a) === naipBuildInputsHash(b);
}

// ── Tiles ───────────────────────────────────────────────────────────────────────────────────────

interface TilesPlanBase {
  manifest: NaipManifest;
  units: AerialWorkUnit[];
}

/** What the tiles stage will do, decided. */
export type TilesPlan =
  | (TilesPlanBase & { kind: 'dry' })
  /** Published from these inputs: nothing to cut; `repair` re-uploads a build manifest that drifted. */
  | (TilesPlanBase & {
      kind: 'published';
      target: BucketTarget;
      repair: Upload | null;
      /** The build manifest drifted, but the assembler is still up: put back on a later run. */
      waiting: boolean;
    })
  /** The campaign's assembler is up, from these inputs, and every work tile has landed: upload nothing. */
  | (TilesPlanBase & { kind: 'attached'; target: BucketTarget; deployment: DeploymentTarget })
  /** Upload the manifest (and the snapshot) and cut what is outstanding. */
  | (TilesPlanBase & {
      kind: 'cut';
      target: BucketTarget;
      deployment: DeploymentTarget;
      uploads: Upload[];
    });

/**
 * The tiles stage's preflight. **The finding it closes** (PR #188, the seventh review): the stage
 * uploaded the newly selected manifest to the build key and only then reached `spawn.sh`'s
 * live-assembler check, so a refused re-run left the bucket's manifest changed under an assembler
 * still reading the one before — and `verify` then rejected the mismatch, which restoring the old
 * selection couldn't repair. Now whether the assembler is up, and what it reads, is read first.
 */
export async function preflightTiles(args: StageArgs, view: ReadView): Promise<TilesPlan> {
  const paths = scratchPaths(args.campaign, view.scratch);
  if (!existsSync(paths.manifest)) {
    throw new StageRefusal(
      'tiles.noManifest',
      `no manifest at ${paths.manifest}: run the select stage first`,
    );
  }
  const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as NaipManifest;
  if (manifest.campaign !== args.campaign || manifest.pilot !== args.pilot) {
    throw new StageRefusal(
      'tiles.otherCampaign',
      `the manifest is ${manifest.campaign}'s, not this run's`,
    );
  }
  const units = workUnitsFor(manifest);
  if (args.dryRun) return { kind: 'dry', manifest, units };

  const deployment = checkedTarget(view, args.pilot);
  const target = needBucket(view);
  const facts = new CampaignFacts(view, target, args.campaign, args.pilot);

  // **Never over a published campaign's inputs** (the sixth review): the same inputs have nothing
  // to cut; other inputs are refused, saying what differs. A build manifest that drifted from the
  // published one (an upload that raced an assembler from another machine, an edit by hand, or this
  // finding's leftovers) is put back, so verify can pass again.
  const published = await facts.published();
  if (againstPublished(published, manifest) === 'published') {
    const build = await facts.buildManifest();
    if (sameInputs(build, published)) {
      return { kind: 'published', manifest, units, target, repair: null, waiting: false };
    }
    // Put back — but never while the assembler is up (it may still be writing its record): the
    // build manifest moves under no live assembler, even to the inputs it read.
    const live = await facts.machines('tiles.flyUnlisted');
    const repair = live.assembler
      ? null
      : { local: paths.manifest, key: buildManifestKey(args.campaign, args.pilot ?? undefined) };
    return { kind: 'published', manifest, units, target, repair, waiting: live.assembler };
  }

  needEnv(view, 'AERIAL_IMAGE');
  // **Never under a live assembler** (the seventh review): it read the bucket's build manifest when
  // it started and range-reads the shards for an hour and more. Replacing that manifest, or re-cutting
  // a shard it reads, changes what it streams; so while it is up the stage writes nothing — unless it
  // is reading exactly this selection and nothing is left to cut, which has nothing to write anyway.
  const live = await facts.machines('tiles.flyUnlisted');
  if (live.assembler) {
    const build = await facts.buildManifest();
    if (!sameInputs(build, manifest)) {
      throw new StageRefusal(
        'tiles.assembling',
        `${args.campaign}'s assembler is running from ${build === null ? 'no build manifest' : 'the build manifest in the bucket'}, and this selection differs from it: replacing that manifest now would leave the archive built from one selection and the bucket naming another — nothing was uploaded. Let the assembly finish (then a changed selection is a new campaign: --from-current), or stop it first`,
      );
    }
    const done = await facts.done();
    const outstanding = units.filter(
      (u) =>
        !shardLanded(done.get(u.workTile) ?? null, {
          campaign: args.campaign,
          workTile: u.workTile,
          inputHash: u.inputHash,
        }),
    );
    if (outstanding.length > 0) {
      throw new StageRefusal(
        'tiles.recutUnderAssembler',
        `${args.campaign}'s assembler is reading these work tiles' shards: re-cutting ${outstanding.length} now would change what it reads — nothing was uploaded or spawned; let the assembly finish (or stop it) first`,
      );
    }
    return { kind: 'attached', manifest, units, target, deployment };
  }
  const uploads = selectUploads(manifest, view.scratch);
  return { kind: 'cut', manifest, units, target, deployment, uploads };
}

// ── Assemble (the laptop) ───────────────────────────────────────────────────────────────────────

interface AssemblePlanBase {
  deployment: DeploymentTarget;
  target: BucketTarget;
  manifest: NaipManifest;
}

/** What the laptop's assemble stage will do, decided. */
export type AssemblePlan =
  /** An earlier assembly of these inputs finished: take its record. */
  | (AssemblePlanBase & { kind: 'take'; record: AssemblyRecord })
  /** Start the assembler (or follow the one already running). */
  | (AssemblePlanBase & { kind: 'spawn'; attach: boolean; stale: string | null });

/**
 * The laptop's assemble preflight: every refusal the Machine would make that a handful of reads can
 * decide, decided before a Machine is started — so a refused assembly starts nothing. What only the
 * Machine can decide (each shard's index against its record, the date index, an empty zoom: the
 * assembler's own read of every index) is refused there, before its first write, and leaves only
 * its error object (`assemble.ts`).
 */
export async function preflightAssemble(args: StageArgs, view: ReadView): Promise<AssemblePlan> {
  const target = needBucket(view);
  const deployment = checkedTarget(view, args.pilot);
  const facts = new CampaignFacts(view, target, args.campaign, args.pilot);
  const pilot = args.pilot ?? undefined;
  const manifest = await facts.buildManifest();
  if (manifest === null) {
    throw new StageRefusal(
      'assemble.noManifest',
      `no manifest at ${buildManifestKey(args.campaign, pilot)}: run the tiles stage`,
    );
  }
  // A record is the assembler's last write: the same inputs are taken as done (whatever an earlier
  // row says), other inputs refused (`finishedAssembly`).
  const record = await facts.record();
  const taken = await finishedAssembly(record, manifest, () => facts.published());
  if (taken !== null) return { kind: 'take', record: taken, deployment, target, manifest };

  // **A re-run attaches** to an assembler already running — which made every check below itself
  // when it started, and whose archive may already stand without its manifest mid-publish.
  const live = await facts.machines('assemble.flyUnlisted');
  const stale = await facts.errorAt();
  if (live.assembler) return { kind: 'spawn', attach: true, stale, deployment, target, manifest };

  // Published, but no record: an assembly that stopped between its manifest and its record (the
  // sixth review's open item), or other inputs. The Machine would refuse either; refused here.
  const published = await facts.published();
  if (published !== null) {
    const conflict = publishedConflict(published, manifest);
    if (conflict !== null) throw new StageRefusal('published.otherInputs', conflict);
    throw new StageRefusal(
      'assemble.publishedNoRecord',
      `${args.campaign} is published from these inputs (${manifestKey(args.campaign, pilot)}) but has no assembly record: an assembly stopped between its manifest and its record, so verify can't check it and nothing should serve it. Delete the three published keys by hand (${archiveKey(args.campaign, pilot)}, ${indexKey(args.campaign, pilot)}, ${manifestKey(args.campaign, pilot)}) and assemble again`,
    );
  }
  const present = await facts.publishedKeys();
  refuseExisting(
    {
      archive: archiveKey(args.campaign, pilot),
      index: indexKey(args.campaign, pilot),
      manifest: manifestKey(args.campaign, pilot),
    },
    (k) => present.has(k),
  );
  if (parseCampaign(manifest.campaign).pilot !== (manifest.pilot !== null)) {
    throw new StageRefusal(
      'assemble.pilotMismatch',
      assembleMessages.pilotMismatch(manifest.campaign, manifest.pilot),
    );
  }
  if (manifest.workTiles.length === 0) {
    throw new StageRefusal('assemble.noWorkTiles', assembleMessages.noWorkTiles);
  }
  if (manifest.workTiles.some((w) => !w.retile)) {
    if (manifest.basedOn === null) {
      throw new StageRefusal('assemble.noBase', assembleMessages.noBase);
    }
    const current = await facts.publishedByName(manifest.basedOn.manifest);
    if (current === null) {
      throw new StageRefusal(
        'assemble.baseMissing',
        assembleMessages.baseMissing(manifest.basedOn.manifest),
      );
    }
    if (current.archive?.name !== manifest.basedOn.archive) {
      throw new StageRefusal(
        'assemble.baseArchive',
        assembleMessages.baseArchive(current.archive?.name, manifest.basedOn.archive),
      );
    }
  }
  const done = await facts.done();
  for (const wt of manifest.workTiles) {
    if (!wt.retile) continue;
    const d = done.get(wt.key) ?? null;
    if (!shardLanded(d, { campaign: args.campaign, workTile: wt.key, inputHash: wt.inputHash })) {
      throw new StageRefusal(
        'assemble.notLanded',
        assembleMessages.notLanded(wt.key, d, wt.inputHash),
      );
    }
  }
  return { kind: 'spawn', attach: false, stale, deployment, target, manifest };
}

// ── Verify ──────────────────────────────────────────────────────────────────────────────────────

/** What verify needs, checked: its public origin, its bucket, and (not a dry run) where its row goes. */
export interface VerifyPlan {
  base: string;
  target: BucketTarget;
  deployment: DeploymentTarget | null;
}

/**
 * Verify's preflight. Verify writes its report and its row; its checks failing is its verdict (the
 * report says why), not a refusal — what refuses is what it can't start without.
 */
export function preflightVerify(args: StageArgs, view: ReadView): VerifyPlan {
  const base = needEnv(view, 'R2_PUBLIC_BASE_URL');
  const deployment = args.dryRun ? null : checkedTarget(view, args.pilot);
  return { base, target: needBucket(view), deployment };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────────────────────────

/** What cleanup will delete, decided. */
export interface CleanupStagePlan {
  target: BucketTarget;
  plan: CleanupPlan;
}

/** Cleanup's preflight: the listing and the web's env read, every refusal decided (`planCleanup`). */
export async function preflightCleanup(
  args: StageArgs,
  view: ReadView,
  readWebFile: (file: string) => string | null,
): Promise<CleanupStagePlan> {
  const target = needBucket(view);
  const prefix = publishPrefix(args.campaign, args.pilot ?? undefined);
  const listing = await view.bucket(target).list(prefix);
  const plan = planCleanup({
    campaign: args.campaign,
    pilot: args.pilot,
    old: args.old as string,
    listing,
    liveArchiveUrls: webArchiveUrls(readWebFile),
    liveSince: args.liveSince === null ? null : parseLiveSince(args.liveSince),
    now: view.now(),
  });
  return { target, plan };
}

/** Where `apps/web` lives from the package's directory (cleanup reads its env files by name). */
export function webDir(packageDir: string): string {
  return join(packageDir, '..', '..', 'apps', 'web');
}
