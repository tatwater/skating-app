/**
 * **A launcher never outlives its stage** (PR #188's tenth review): `cli/world.ts`' `launched`, the
 * process every `spawn.sh` call runs as. A stage that exits mid-round — the console's stop is the
 * run row's `process.exit(130)` — left `spawn.sh tiles` spawning the rest of its round's Machines
 * past the released lock. Shown with a stand-in launcher that "spawns" forever (a line a tick, and a
 * call in flight in the background, as `spawn.sh`'s `( fly machine run … ) &` is).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const PKG = join(import.meta.dirname, '..');
const WORLD = join(import.meta.dirname, 'cli', 'world.ts');

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  // Whatever a failing case left running.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Until `pred` holds or `ms` pass: a condition, never a fixed sleep. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe('launched', { timeout: 120_000 }, () => {
  test('a stage that exits mid-round stops its launcher and the spawn call in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerial-launch-'));
    dirs.push(dir);
    const spawned = join(dir, 'spawned');
    const launcher = join(dir, 'launcher.sh');
    writeFileSync(spawned, '');
    writeFileSync(
      launcher,
      [
        `echo $$ > "${dir}/launcher.pid"`,
        `sleep 600 & echo $! > "${dir}/inflight.pid"`,
        `while true; do echo machine >> "${spawned}"; sleep 0.05; done`,
      ].join('\n'),
    );
    const script = join(dir, 'stage.mts');
    writeFileSync(
      script,
      [
        `const { launched } = await import(${JSON.stringify(WORLD)});`,
        `launched([${JSON.stringify(launcher)}]);`,
        "const { readFileSync } = await import('node:fs');",
        `while (readFileSync(${JSON.stringify(spawned)}, 'utf8') === '') await new Promise((r) => setTimeout(r, 10));`,
        // The console's stop: the run row exits the stage.
        'process.exit(130);',
      ].join('\n'),
    );
    const status = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: PKG,
        stdio: 'ignore',
      });
      child.on('close', done);
    });
    expect(status).toBe(130);
    const launcherPid = Number(readFileSync(join(dir, 'launcher.pid'), 'utf8'));
    const inflightPid = Number(readFileSync(join(dir, 'inflight.pid'), 'utf8'));
    pids.push(launcherPid, inflightPid);
    expect(await until(() => !alive(launcherPid) && !alive(inflightPid), 10_000)).toBe(true);
    // And nothing more is "spawned" once they have gone.
    const after = readFileSync(spawned, 'utf8');
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(spawned, 'utf8')).toBe(after);
  });
});
