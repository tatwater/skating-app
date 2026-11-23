/**
 * **Run a command, its stderr live and kept** — for `convexRun`, which must stay synchronous (every
 * loader calls it so) and yet both show the function's logs as they arrive (an ETL load runs for
 * hours, watched as it goes) and keep them, so a failed call throws the server's own sentence.
 *
 * A synchronous spawn can't do both, so the command runs under a small Node tee ({@link TEE}): the
 * tee passes the command's stderr through to the inherited stderr chunk by chunk, keeps a copy, and
 * hands the copy back on fd 3 when the command exits; the command's stdout is the tee's (captured,
 * as before, for the result). The tee exits with the command's status.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** The tee itself, run by `node -e`: its one argument is the command and its arguments, as JSON. */
export const TEE = `
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const [command, ...args] = JSON.parse(process.argv[1]);
const kept = [];
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  kept.push(chunk);
});
let started = true;
child.on('error', (err) => {
  started = false;
  writeSync(3, String(err && err.message));
  process.exitCode = 127;
});
child.on('close', (code) => {
  if (!started) return;
  writeSync(3, Buffer.concat(kept));
  process.exitCode = code === null ? 1 : code;
});
`;

/** What a teed run gave: its status, its stdout, and the stderr it showed as it ran. */
export interface Teed {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Run `command` under the tee: stderr shown live and returned; stdout returned. */
export function runTeed(command: string, args: readonly string[]): Teed {
  const res = spawnSync(process.execPath, ['-e', TEE, JSON.stringify([command, ...args])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: String(res.output?.[3] ?? ''),
    ...(res.error ? { error: res.error } : {}),
  };
}
