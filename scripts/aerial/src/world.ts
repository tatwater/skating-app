/**
 * **What a stage touches, as ports** (B05 §2.8): the bucket, Fly, the Machines it starts, the run
 * row, the environment and the clock. Every stage body (`stage/`) takes a `StageWorld`; the CLIs
 * hand it the real one (`cli/world.ts`, the process boundary), and the tests hand it stand-ins that
 * record every write (`stageHarness.ts`).
 *
 * **A preflight sees only `ReadView`** — the read half of each port — so what a stage decides before
 * it writes is decided from reads alone; the type has no way to upload, delete, spawn or open a row.
 */

import type { RunLogger } from '@skating/run-log';
import type { DeploymentTarget } from './runTarget';

/** Where on R2: the laptop's rclone remote and the bucket. */
export interface BucketTarget {
  remote: string;
  bucket: string;
}

/** One object of a listing. */
export interface BucketObject {
  /** The bucket key. */
  key: string;
  modified: Date;
}

/** The bucket, read. Every method throws when the bucket can't be read: can't tell is never none. */
export interface BucketReader {
  /** The object's text, or `null` when it isn't there. */
  read(key: string): Promise<string | null>;
  /** Every object under `prefix` (recursively). */
  list(prefix: string): Promise<BucketObject[]>;
  /**
   * Every done record under a campaign's shards prefix, by work tile (`11/<x>/<y>` → its text): one
   * listing-and-copy, never a read per work tile.
   */
  doneRecords(shardsPrefix: string): Promise<Map<string, string>>;
}

/** The bucket, read and written. */
export interface Bucket extends BucketReader {
  /** Copies a local file to `key`. */
  upload(local: string, key: string): Promise<void>;
  /** Deletes one object; one that isn't there is not an error. */
  deleteFile(key: string): Promise<void>;
  /** Deletes every object under `prefix`; nothing there is not an error. */
  deletePrefix(prefix: string): Promise<void>;
}

/**
 * A campaign's live Machines on Fly, as `spawn.sh status` reads them (the one file that knows how
 * Machines are named): whether its assembler is up, and which of its work tiles are. Throws when
 * Fly can't be listed.
 */
export interface FlyReader {
  live(campaign: string): Promise<{ assembler: boolean; workTiles: string[] }>;
}

/** A started assembler's wait (`spawn.sh assemble`): its exit once it has one, and a way to stop waiting. */
export interface AssemblerWait {
  /** `undefined` while it runs; then the exit code (`null` on a signal). */
  exit(): number | null | undefined;
  /** Stop the wait — never the Machine: `spawn.sh` only watches it. */
  stop(): void;
}

/** Starting Machines: `spawn.sh`. */
export interface Launcher {
  /** One round of work tiles (`spawn.sh tiles … --drain`); resolves with its exit code. */
  tiles(campaign: string, unitsDir: string, listFile: string): Promise<number | null>;
  /** The assembler (`spawn.sh assemble`), or the one already running, followed. */
  assemble(campaign: string, pilot: string | null): AssemblerWait;
}

/** The run row, as far as the stages write it. */
export type RunRow = Pick<RunLogger, 'start' | 'count' | 'flush' | 'fail' | 'succeed' | 'failed'>;

/** The run row's options (`RunLogger`'s, less the Convex caller the world supplies). */
export type RowOptions = Omit<ConstructorParameters<typeof RunLogger>[0], 'call'>;

/** This process, for the campaign lock. */
export interface ProcessInfo {
  pid: number;
  host: string;
  /** Is a process of this host with this pid alive? */
  alive(pid: number): boolean;
  /**
   * Run `release` if this process is interrupted (Ctrl-C, a hang-up, a `kill`), before it exits;
   * returns the unregistration. The campaign lock's: a stage stopped by hand leaves no lock behind.
   */
  onInterrupt?(release: () => void): () => void;
}

/** Everything a stage may read. */
export interface ReadView {
  env(name: string): string | undefined;
  deployment(): DeploymentTarget;
  /** The scratch root (`keys.ts`' `AERIAL_SCRATCH`; a temp directory in the tests). */
  scratch: string;
  bucket(target: BucketTarget): BucketReader;
  fly: FlyReader;
  now(): Date;
  /** A line for the operator (stderr): what a read found unreadable. Not a write to the world. */
  err(text: string): void;
}

/** Everything a stage may touch. */
export interface StageWorld extends Omit<ReadView, 'bucket'> {
  bucket(target: BucketTarget): Bucket;
  launch: Launcher;
  /** A run row, not yet started. */
  row(options: RowOptions): RunRow;
  out(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Milliseconds, for the follower's quiet clock. */
  clock(): number;
  process: ProcessInfo;
}

/** The bucket the environment names: `R2_REMOTE` (default `r2`) and `R2_BUCKET`, or `null`. */
export function bucketTarget(view: Pick<ReadView, 'env'>): BucketTarget | null {
  const bucket = view.env('R2_BUCKET');
  if (bucket === undefined || bucket === '') return null;
  return { remote: view.env('R2_REMOTE') || 'r2', bucket };
}
