/**
 * **One stage of a campaign at a time, on this machine** (B05 §2.8). Two terminals running stages
 * of one campaign at once raced on its scratch — the tiles stage rewrites the units `spawn.sh` is
 * reading and empties the done records the other reconcile reads; two selects write one manifest and
 * one kept walk — and on its keys: a select's manifest uploaded while the other terminal's
 * assembler starts from the one before.
 *
 * The lock is a file, `<locks>/<campaign>.lock`, created with `O_EXCL` (atomic on one filesystem)
 * before the stage reads anything and removed when it ends, whatever way it ends — so a refused stage
 * leaves the scratch as it found it. It holds who took it; a second stage refuses, naming the holder.
 * A lock whose process has gone (a crash, `kill -9`, a laptop that lost power) is refused as stale,
 * never broken silently, and the message says how to clear it.
 *
 * **Its reach is this machine, every checkout and worktree of it** (the governor, at the PR's eighth
 * review): the repo is worked from many git worktrees, each with its own scratch, and the bucket's
 * keys are one for all of them — so the locks live in one per-user directory,
 * `${XDG_CACHE_HOME:-$HOME/.cache}/skating-aerial/locks/` ({@link lockDir}; `AERIAL_LOCK_DIR`
 * overrides it, for the tests). Across machines nothing is exclusive — a lock in the bucket would
 * need a conditional write, which `rclone` can't make (README).
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StageRefusal } from './refusals';
import type { ProcessInfo } from './world';

/** Who holds a campaign's lock. */
export interface LockHolder {
  pid: number;
  host: string;
  stage: string;
  startedAt: string;
  /** The holder's checkout's scratch, where its run log is (`run-<campaign>.log`). */
  scratch?: string;
}

/** Where a stage takes its campaign's lock: the locks' directory, its own scratch, its process. */
export interface LockPlace {
  locks: string;
  scratch: string;
  process: ProcessInfo;
  now(): Date;
}

/** The variable that points the locks elsewhere (the tests: a temporary directory, never home). */
export const LOCK_DIR_ENV = 'AERIAL_LOCK_DIR';

/**
 * The locks' one directory for every checkout on this machine:
 * `${XDG_CACHE_HOME:-$HOME/.cache}/skating-aerial/locks/` (an `XDG_CACHE_HOME` that isn't absolute
 * is ignored, as the XDG spec says), or `AERIAL_LOCK_DIR`. `home` is the OS's answer when `HOME`
 * is unset.
 */
export function lockDir(env: (name: string) => string | undefined, home: string): string {
  const override = env(LOCK_DIR_ENV);
  if (override !== undefined && override !== '') return override;
  const xdg = env('XDG_CACHE_HOME');
  const cache = xdg !== undefined && isAbsolute(xdg) ? xdg : join(env('HOME') || home, '.cache');
  return join(cache, 'skating-aerial', 'locks');
}

/** `<locks>/<campaign>.lock`. */
export function lockPath(locks: string, campaign: string): string {
  return join(locks, `${campaign}.lock`);
}

function readHolder(path: string): LockHolder | null {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    return typeof h.pid === 'number' && typeof h.host === 'string' ? (h as LockHolder) : null;
  } catch {
    return null;
  }
}

/**
 * Take the campaign's lock for `stage`, or refuse (`lock.held`, `lock.stale`) with nothing written.
 * Returns the release, which removes the file only while it is still this holder's.
 */
export function acquireCampaignLock(place: LockPlace, campaign: string, stage: string): () => void {
  const path = lockPath(place.locks, campaign);
  const proc = place.process;
  const me: LockHolder = {
    pid: proc.pid,
    host: proc.host,
    stage,
    startedAt: place.now().toISOString(),
    scratch: place.scratch,
  };
  mkdirSync(place.locks, { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const holder = readHolder(path);
    const clear = `remove ${path} and run again`;
    if (holder === null) {
      throw new StageRefusal(
        'lock.held',
        `${campaign} is locked by ${path}, which names no holder: if no other stage of ${campaign} is running in any checkout, ${clear}`,
      );
    }
    const from = holder.scratch === undefined ? '' : `, from ${holder.scratch}`;
    const who = `${holder.stage} (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}${from})`;
    if (holder.host === proc.host && !proc.alive(holder.pid)) {
      const log =
        holder.scratch === undefined
          ? `run-${campaign}.log in its checkout's scripts/aerial/.scratch/`
          : join(holder.scratch, `run-${campaign}.log`);
      throw new StageRefusal(
        'lock.stale',
        `${campaign}'s lock was left by ${who}, which has gone (it crashed or was killed): read its log (${log}), then ${clear}`,
      );
    }
    throw new StageRefusal(
      'lock.held',
      `${campaign} is held by ${who}: one stage of a campaign runs at a time, in any checkout on this machine — wait for it (or, if it is not running, ${clear})`,
    );
  }
  try {
    writeSync(fd, `${JSON.stringify(me)}\n`);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const holder = readHolder(path);
    if (holder !== null && holder.pid === me.pid && holder.startedAt === me.startedAt) {
      rmSync(path, { force: true });
    }
  };
}

/** Run `body` under the campaign's lock, released however it ends. */
export async function withCampaignLock<T>(
  place: LockPlace,
  campaign: string,
  stage: string,
  body: () => Promise<T>,
): Promise<T> {
  const release = acquireCampaignLock(place, campaign, stage);
  const unregister = place.process.onInterrupt?.(release);
  try {
    return await body();
  } finally {
    unregister?.();
    release();
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/** The slice of `process` the release hooks use (an `EventEmitter` in the tests). */
export interface ExitingProcess {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  exit(code: number): void;
}

/**
 * `ProcessInfo.onInterrupt` for a real process: the release runs **however the process ends without
 * reaching the body's `finally`** — a signal (Ctrl-C, a hang-up, a `kill`: release, then exit with
 * the signal's status), and `process.exit` or an uncaught exception or rejection, which skip every
 * `finally` but still emit `exit`. The last is not hypothetical: `RunLogger` closes a row that
 * Machinery asked to stop and calls `process.exit(130)` from inside the stage, which left the lock
 * behind (found at the eighth review's independent pass, reproduced in `campaignLock.test.ts`).
 */
export function releaseOnExit(proc: ExitingProcess): (release: () => void) => () => void {
  return (release) => {
    const handlers = SIGNALS.map((signal) => {
      const h = () => {
        release();
        proc.exit(SIGNAL_EXIT[signal]);
      };
      proc.once(signal, h);
      return [signal, h] as const;
    });
    proc.once('exit', release);
    return () => {
      for (const [signal, h] of handlers) proc.off(signal, h);
      proc.off('exit', release);
    };
  };
}
