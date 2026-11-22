import { spawn } from 'node:child_process';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { runTeed, TEE } from './tee';

/** A fake child: writes to stderr, waits, writes again, then exits with `code`. */
const slowChild = (code: number) => [
  '-e',
  `process.stdout.write('{"r":1}');
   process.stderr.write('first\\n');
   setTimeout(() => { process.stderr.write('Uncaught Error: second\\n'); process.exitCode = ${code}; }, 600);`,
];

describe('the tee', () => {
  it('forwards a long-running child’s stderr as it arrives, before the child exits', async () => {
    // The tee as `convexRun` runs it, watched from outside: when each chunk reaches its stderr.
    const tee = spawn(
      process.execPath,
      ['-e', TEE, JSON.stringify([process.execPath, ...slowChild(0)])],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      },
    );
    const seen: { text: string; at: number }[] = [];
    tee.stderr?.on('data', (c: Buffer) => seen.push({ text: c.toString(), at: Date.now() }));
    let kept = '';
    tee.stdio[3]?.on('data', (c: Buffer) => {
      kept += c.toString();
    });
    let out = '';
    tee.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const exited = await new Promise<{ code: number | null; at: number }>((resolve) =>
      tee.on('close', (code) => resolve({ code, at: Date.now() })),
    );
    const first = seen.find((s) => s.text.includes('first'));
    expect(first).toBeDefined();
    // Shown live: the first line reached the terminal well before the child finished.
    expect(exited.at - (first?.at ?? exited.at)).toBeGreaterThan(300);
    expect(seen.map((s) => s.text).join('')).toBe('first\nUncaught Error: second\n');
    // And kept whole for the sentence, the result on stdout, the child's status its own.
    expect(kept).toBe('first\nUncaught Error: second\n');
    expect(out).toBe('{"r":1}');
    expect(exited.code).toBe(0);
  });

  it('runTeed returns the status, the stdout and the stderr it showed', () => {
    expect(runTeed(process.execPath, slowChild(3))).toEqual({
      status: 3,
      stdout: '{"r":1}',
      stderr: 'first\nUncaught Error: second\n',
    });
  });

  it('a command that cannot start: the tee says why and exits 127', () => {
    const res = runTeed('/no/such/command-anywhere', []);
    expect(res.status).toBe(127);
    expect(res.stderr).toMatch(/ENOENT/);
  });
});
