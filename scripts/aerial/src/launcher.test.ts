/**
 * **A launcher never outlives its stage** (PR #188's tenth review): `cli/world.ts`' `launched`, the
 * process every `spawn.sh` call runs as. A stage that exits mid-round — the console's stop is the
 * run row's `process.exit(130)` — left `spawn.sh tiles` spawning the rest of its round's Machines
 * past the released lock. Shown with a stand-in launcher that "spawns" forever (a line a tick, and a
 * call in flight in the background, as `spawn.sh`'s `( fly machine run … ) &` is).
 */

import { spawn, spawnSync } from 'node:child_process';
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

/** coreutils' `timeout`, as `spawn.sh` finds it (CI's Linux has it; a Mac has it from Homebrew). */
const hasTimeout = spawnSync('bash', ['-c', 'command -v timeout']).status === 0;

describe('launched', { timeout: 120_000 }, () => {
  test('every spawn call spawn.sh makes on the laptop runs under `timeout --foreground`', () => {
    const sh = readFileSync(join(PKG, 'spawn.sh'), 'utf8');
    const calls = sh.split('\n').filter((l) => /\bfly machine run\b/.test(l) && !/^\s*#/.test(l));
    expect(calls.length).toBe(2);
    for (const line of calls)
      expect(line.trim()).toMatch(/^timeout --foreground "\$SPAWN_TIMEOUT" fly/);
  });

  test.each([
    ['a spawn call in flight', 'sleep 600'],
    // As `spawn.sh` makes each `fly machine run`: under coreutils' `timeout`, which by default puts
    // itself in a process group of its own — out of reach of the group's signal (the eleventh
    // review); `--foreground` keeps it in the launcher's group.
    ...(hasTimeout
      ? [['a spawn call in flight under spawn.sh’s timeout', 'timeout --foreground 600 sleep 600']]
      : []),
  ])('a stage that exits mid-round stops its launcher and %s', async (_, inflight) => {
    const dir = mkdtempSync(join(tmpdir(), 'aerial-launch-'));
    dirs.push(dir);
    const spawned = join(dir, 'spawned');
    const launcher = join(dir, 'launcher.sh');
    writeFileSync(spawned, '');
    writeFileSync(
      launcher,
      [
        `echo $$ > "${dir}/launcher.pid"`,
        `${inflight} & echo $! > "${dir}/inflight.pid"`,
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
