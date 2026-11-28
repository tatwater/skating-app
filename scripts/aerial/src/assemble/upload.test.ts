/**
 * **`rcatSink` is never completed by its parent's death** (PR #188's tenth review). `rclone rcat`
 * completes its upload when its stdin ends, and a parent that exits ends it — so a process that died
 * mid-stream (the watchdog's `process.exit`, a crash, a stop) would publish the bytes so far at a key
 * the pipeline never overwrites. Shown here against a stand-in `rclone` that does what rcat does with
 * its input (it lands the object only once its stdin ends); the real one is the stream proof's, and
 * the scratch proof in the phase doc's review record.
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const PKG = join(import.meta.dirname, '..', '..');
const UPLOAD = join(import.meta.dirname, 'upload.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type How = 'end' | 'exit' | 'throw' | 'sigterm';

/** What each parent does once its bytes are written. */
const ENDINGS: Record<How, string> = {
  end: 'await sink.end();',
  exit: 'process.exit(1);',
  throw: "throw new Error('a crash mid-stream');",
  // As `cli/assemble.ts`' Machine does: a stop is an exit.
  sigterm: [
    'process.once("SIGTERM", () => process.exit(143));',
    'process.kill(process.pid, "SIGTERM");',
    'await new Promise((r) => setTimeout(r, 60_000));',
  ].join('\n'),
};

/** A parent that streams into an `rcatSink` and then ends it, exits, throws, or is stopped. */
async function parent(how: How): Promise<{ status: number | null; landed: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'aerial-rcat-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const out = join(dir, 'object');
  mkdirSync(bin);
  // The stand-in: its pid first, then its input, and the object only once that input ends.
  writeFileSync(
    join(bin, 'rclone'),
    `#!/usr/bin/env bash\necho $$ > "${out}.pid"\ncat > "${out}.part"\nmv "${out}.part" "${out}"\n`,
  );
  chmodSync(join(bin, 'rclone'), 0o755);
  const script = join(dir, 'parent.mts');
  writeFileSync(
    script,
    [
      `const { rcatSink } = await import(${JSON.stringify(UPLOAD)});`,
      "const sink = rcatSink({ remote: 'r2', bucket: 'b' }, 'k', { contentType: 'x' });",
      'await sink.write(new Uint8Array(1000).fill(7));',
      // Mid-stream for real: the stand-in has started and taken the bytes, its input still open.
      "const { existsSync, statSync } = await import('node:fs');",
      `const part = ${JSON.stringify(`${out}.part`)};`,
      'while (!existsSync(part) || statSync(part).size < 1000) await new Promise((r) => setTimeout(r, 5));',
      ENDINGS[how],
    ].join('\n'),
  );
  const status = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: PKG,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'ignore',
    });
    child.on('close', done);
  });
  // Until the stand-in has gone — killed, or done with its input: a condition, never a fixed sleep.
  const pid = Number(readFileSync(`${out}.pid`, 'utf8'));
  for (let i = 0; i < 4000; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return { status, landed: existsSync(out) };
}

describe('rcatSink', () => {
  test('an upload that was ended lands', async () => {
    expect(await parent('end')).toEqual({ status: 0, landed: true });
  });

  test('a parent that exits, throws or is stopped mid-stream lands nothing', async () => {
    for (const how of ['exit', 'throw', 'sigterm'] as const) {
      const run = await parent(how);
      expect(run.status, how).not.toBe(0);
      expect(run.landed, how).toBe(false);
    }
  });
});
