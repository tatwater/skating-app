/**
 * Run a child process to completion, its output captured — the one way the assembler calls GDAL
 * (the overviews) and verify calls `pmtiles verify`. Never through a shell: arguments are an array,
 * so a key or a path is never parsed as syntax.
 */

import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<ProcessResult>;

/** Spawn and wait; a missing command rejects, a non-zero exit resolves with its code. */
export const runProcess: ProcessRunner = (command, args, options = {}) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });

/** Run and throw (with the command's last stderr lines) unless it exits 0. */
export async function mustRun(
  run: ProcessRunner,
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
): Promise<string> {
  const res = await run(command, args, options);
  if (res.code !== 0) {
    const tail = res.stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`${command} exited ${res.code}${tail ? `: ${tail}` : ''}`);
  }
  return res.stdout;
}
