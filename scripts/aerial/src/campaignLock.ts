/**
 * **One stage of a campaign at a time, on this laptop** (B05 §2.8). Two terminals running stages
 * of one campaign at once raced on its scratch — the tiles stage rewrites the units `spawn.sh` is
 * reading and empties the done records the other reconcile reads; two selects write one manifest and
 * one kept walk — and on its keys: a select's manifest uploaded while the other terminal's
 * assembler starts from the one before.
 *
 * The lock is a file, `<scratch>/<campaign>.lock`, created with `O_EXCL` (atomic on one filesystem)
 * before the stage reads anything and removed when it ends, whatever way it ends — so a refused stage
 * leaves the scratch as it found it. It holds who took it; a second stage refuses, naming the holder.
 * A lock whose process has gone (a crash, `kill -9`, a laptop that lost power) is refused as stale,
 * never broken silently, and the message says how to clear it.
 *
 * **Its reach is this laptop's scratch**: the scratch is where a campaign's manifest lives, so a
 * second checkout has its own manifest and its own lock. Across machines nothing is exclusive — a
 * lock in the bucket would need a conditional write, which `rclone` can't make (README).
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { StageRefusal } from './refusals';
import type { ProcessInfo } from './world';

/** Who holds a campaign's lock. */
export interface LockHolder {
  pid: number;
  host: string;
  stage: string;
  startedAt: string;
}

/** `<scratch>/<campaign>.lock`. */
export function lockPath(scratch: string, campaign: string): string {
  return join(scratch, `${campaign}.lock`);
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
export function acquireCampaignLock(
  scratch: string,
  campaign: string,
  stage: string,
  proc: ProcessInfo,
  now: Date,
): () => void {
  const path = lockPath(scratch, campaign);
  const me: LockHolder = { pid: proc.pid, host: proc.host, stage, startedAt: now.toISOString() };
  mkdirSync(scratch, { recursive: true });
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
        `${campaign} is locked by ${path}, which names no holder: if no other stage of ${campaign} is running, ${clear}`,
      );
    }
    const who = `${holder.stage} (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`;
    if (holder.host === proc.host && !proc.alive(holder.pid)) {
      throw new StageRefusal(
        'lock.stale',
        `${campaign}'s lock was left by ${who}, which has gone (it crashed or was killed): read its log (run-${campaign}.log), then ${clear}`,
      );
    }
    throw new StageRefusal(
      'lock.held',
      `${campaign} is held by ${who}: one stage of a campaign runs at a time — wait for it (or, if it is not running, ${clear})`,
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
  scratch: string,
  campaign: string,
  stage: string,
  proc: ProcessInfo,
  now: Date,
  body: () => Promise<T>,
): Promise<T> {
  const release = acquireCampaignLock(scratch, campaign, stage, proc, now);
  const unregister = proc.onInterrupt?.(release);
  try {
    return await body();
  } finally {
    unregister?.();
    release();
  }
}
