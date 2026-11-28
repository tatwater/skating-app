/**
 * **The real world** (B05 §2.8): the `StageWorld` every stage CLI hands its body — the laptop's
 * rclone remote for R2, `spawn.sh` for Fly (the one file that knows about Fly: `status` to read,
 * `tiles` and `assemble` to start), `convex run` for the rows, this process and the machine's one locks directory for the lock. A process
 * boundary, excluded from coverage by name as the CLIs are; the stages it serves are tested against
 * stand-ins (`stageHarness.ts`). Every value is read by name; nothing here prints one.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { rcloneList, rcloneRun } from '../assemble/upload';
import { lockDir, releaseOnExit } from '../campaignLock';
import { AERIAL_SCRATCH } from '../keys';
import type { Bucket, BucketTarget, StageWorld } from '../world';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `spawn.sh`, beside the package. */
export const SPAWN = join(HERE, '..', '..', 'spawn.sh');

/** rclone's "not there" (`readObject`'s reading): exit 3 or 4, or an object/file/directory not found. */
const ABSENT = /exited [34]\b|\b(?:object|file|directory) not found\b/i;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

/** The bucket through the laptop's rclone remote. */
export function rcloneBucket(target: BucketTarget): Bucket {
  const at = (key: string) => `${target.remote}:${target.bucket}/${key}`;
  return {
    async read(key) {
      try {
        const text = await rcloneRun(target, ['cat', at(key)]);
        return text.trim() === '' ? null : text;
      } catch (e) {
        if (ABSENT.test((e as Error).message)) return null;
        throw e;
      }
    },
    async list(prefix) {
      return (await rcloneList(target, prefix))
        .filter((o) => !o.IsDir)
        .map((o) => ({ key: `${prefix}${o.Path}`, modified: new Date(o.ModTime) }));
    },
    async doneRecords(shardsPrefix) {
      // A temporary directory, never the campaign's scratch: a read leaves nothing behind. A prefix
      // with nothing under it yet copies nothing and exits 0; a failed listing exits non-zero.
      const dir = mkdtempSync(join(tmpdir(), 'aerial-done-'));
      try {
        await rcloneRun(target, ['copy', at(shardsPrefix), dir, '--include', '*.done.json']);
        const out = new Map<string, string>();
        for (const path of files(dir)) {
          out.set(relative(dir, path).replace(/\.done\.json$/, ''), readFileSync(path, 'utf8'));
        }
        return out;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async upload(local, key) {
      await rcloneRun(target, ['copyto', local, at(key)]);
    },
    async deleteFile(key) {
      // A missing key is exit 4 ("object not found"): already gone.
      await rcloneRun(target, ['deletefile', at(key)]).catch((e: Error) => {
        if (!ABSENT.test(e.message)) throw e;
      });
    },
    async deletePrefix(prefix) {
      await rcloneRun(target, ['delete', at(prefix)]).catch((e: Error) => {
        if (!/directory not found/i.test(e.message)) throw e;
      });
    },
  };
}

/** Is a local process alive? `EPERM` is one that exists but isn't ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The real world. `stdout`/`stderr` are the process's. */
export function realWorld(): StageWorld {
  return {
    env: (name) => process.env[name],
    deployment: () => resolveDeployment(),
    scratch: AERIAL_SCRATCH,
    locks: lockDir((name) => process.env[name], homedir()),
    bucket: rcloneBucket,
    fly: {
      async live(campaign) {
        const res = spawnSync('bash', [SPAWN, 'status', campaign], { encoding: 'utf8' });
        if (res.status !== 0) {
          throw new Error(`spawn.sh status exited ${res.status}: ${(res.stderr ?? '').trim()}`);
        }
        const lines = res.stdout.split('\n').filter((l) => l !== '');
        return {
          assembler: lines.includes('assembler'),
          workTiles: lines.filter((l) => l.startsWith('worktile ')).map((l) => l.slice(9)),
        };
      },
    },
    launch: {
      tiles: (campaign, unitsDir, list) =>
        // Not `spawnSync`: the round's beats run on this process's timers meanwhile.
        new Promise((done, fail) => {
          const child = spawn('bash', [SPAWN, 'tiles', campaign, unitsDir, list, '--drain'], {
            stdio: 'inherit',
          });
          child.on('error', fail);
          child.on('close', done);
        }),
      assemble(campaign, pilot) {
        const child = spawn(
          'bash',
          [SPAWN, 'assemble', campaign, ...(pilot ? ['--pilot', pilot] : [])],
          { stdio: 'inherit' },
        );
        let exit: number | null | undefined;
        child.on('close', (code) => {
          exit = code;
        });
        return { exit: () => exit, stop: () => child.kill('SIGTERM') };
      },
    },
    row: (options) => new RunLogger({ ...options, call: convexRun }),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    clock: () => Date.now(),
    process: {
      pid: process.pid,
      host: hostname(),
      alive,
      onInterrupt: releaseOnExit(process),
    },
  };
}
