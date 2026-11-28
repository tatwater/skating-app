/**
 * The campaign lock's release in a real process (B05 §2.8): however a stage's process ends, it
 * leaves no lock — including the ways that skip the body's `finally`. Found at the eighth review's
 * independent pass: `RunLogger` answers a stop from Machinery with `process.exit(130)` from inside
 * the stage, and an uncaught exception kills the process the same way; both left the lock, so every
 * later stage of the campaign refused `lock.stale` until the operator removed it by hand.
 *
 * Each case runs a stage-shaped script under `tsx` against the real world (`cli/world.ts`), its
 * locks pointed at a temporary directory (`AERIAL_LOCK_DIR`, and `HOME` too: never the machine's).
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOCK_DIR_ENV, lockPath, releaseOnExit } from './campaignLock';

const SRC = dirname(fileURLToPath(import.meta.url));
const TSX = createRequire(import.meta.url).resolve('tsx/cli');
const CAMPAIGN = 'naip-20261212';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stage that takes the lock in the real world and ends `how`; never ends by itself. */
const SCRIPT = `
import { withCampaignLock } from ${JSON.stringify(join(SRC, 'campaignLock.ts'))};
import { realWorld } from ${JSON.stringify(join(SRC, 'cli', 'world.ts'))};
const world = realWorld();
const how = process.argv[2];
await withCampaignLock(world, ${JSON.stringify(CAMPAIGN)}, 'tiles', async () => {
  if (how === 'returns') return;
  if (how === 'throws') throw new Error('the body threw');
  if (how === 'exit') process.exit(130);
  if (how === 'uncaught') setTimeout(() => { throw new Error('uncaught'); }, 0);
  if (how === 'rejection') void Promise.reject(new Error('unhandled'));
  if (how === 'SIGTERM' || how === 'SIGINT' || how === 'SIGHUP') process.kill(process.pid, how);
  // Held until something ends the process: a lock released here was released by that ending.
  await new Promise(() => { setInterval(() => {}, 1000); });
}).catch(() => { process.exitCode = 1; });
`;

function stage(how: string): { status: number | null; locked: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'aerial-lock-run-'));
  dirs.push(dir);
  const locks = join(dir, 'locks');
  const script = join(dir, 'stage.mts');
  writeFileSync(script, SCRIPT);
  const res = spawnSync(process.execPath, [TSX, script, how], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, [LOCK_DIR_ENV]: locks, HOME: dir, XDG_CACHE_HOME: '' },
  });
  return { status: res.status, locked: existsSync(lockPath(locks, CAMPAIGN)) };
}

describe('the campaign lock, in a real process', () => {
  test.each([
    ['returns', 0],
    ['throws', 1],
    ['exit', 130],
    ['uncaught', 1],
    ['rejection', 1],
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ])('a stage that %s leaves no lock (exit %i)', (how, status) => {
    const run = stage(how);
    expect(run.status).toBe(status);
    expect(run.locked).toBe(false);
  });
});

describe('releaseOnExit', () => {
  test('releases on a signal (then exits with its status) and on exit; unregisters all of it', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const release = vi.fn();
    const unregister = releaseOnExit(proc)(release);
    proc.emit('SIGHUP');
    expect(release).toHaveBeenCalledOnce();
    expect(proc.exit).toHaveBeenCalledWith(129);
    proc.emit('exit');
    expect(release).toHaveBeenCalledTimes(2);
    unregister();
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) {
      expect(proc.listenerCount(event), event).toBe(0);
    }
  });
});
