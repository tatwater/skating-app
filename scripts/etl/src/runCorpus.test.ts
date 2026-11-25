/**
 * `run-corpus.sh`'s log (B01-7a): every line stamped, every pass carrying the campaign id, and the
 * exit status still the script's own — the `| tee` trap its header records is the one this must not
 * reopen. The script runs for real, from a copy in a temp directory, against a `pnpm` on `PATH`
 * that records its arguments and fails the pass it is told to.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../run-corpus.sh', import.meta.url));

/** ISO 8601 to the second, with its offset, then one space. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} /;

/** Stands in for `pnpm`: records each call, writes the merge's manifest, fails `$FAIL_ON`. */
const FAKE_PNPM = `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
for arg in "$@"; do
  if [ "$arg" = "merge" ]; then mkdir -p .scratch/merge; echo '{}' > .scratch/merge/merge-manifest.json; fi
  if [ -n "\${FAIL_ON:-}" ] && [ "$arg" = "$FAIL_ON" ]; then
    echo "boom: $FAIL_ON failed" >&2
    printf 'last words, no newline' >&2
    exit 3
  fi
done
echo "ran $*"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCorpus(args: string[], failOn?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'run-corpus-'));
  dirs.push(dir);
  const etl = join(dir, 'etl');
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', etl, bin]);
  copyFileSync(SCRIPT, join(etl, 'run-corpus.sh'));
  writeFileSync(join(bin, 'pnpm'), FAKE_PNPM);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const calls = join(dir, 'calls.txt');
  writeFileSync(calls, '');
  const result = spawnSync('bash', [join(etl, 'run-corpus.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CALLS: calls,
      ...(failOn !== undefined && { FAIL_ON: failOn }),
    },
  });
  const log = readFileSync(join(etl, '.scratch', 'merge', `run-${args[0]}.log`), 'utf8');
  return {
    status: result.status,
    stdout: result.stdout,
    log,
    logLines: log.split('\n').filter((l) => l.length > 0),
    calls: readFileSync(calls, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0),
  };
}

describe('run-corpus.sh', () => {
  it('stamps every line of its log and its terminal, and gives every pass the campaign', () => {
    const run = runCorpus(['c-ok', '--without-corpus']);

    expect(run.status).toBe(0);
    expect(run.logLines.length).toBeGreaterThan(10);
    for (const line of run.logLines) expect(line).toMatch(STAMP);
    for (const line of run.stdout.split('\n').filter((l) => l.length > 0)) {
      expect(line).toMatch(STAMP);
    }
    // The passes' own output is stamped as it passes through, not only the script's headings.
    expect(run.log).toMatch(/T\d{2}:\d{2}:\d{2}[+-]\d{4} ran --filter @skating\/etl merge/);

    // The masks and the landmark match join the campaign, as the merge and the loads always did.
    expect(run.calls).toEqual([
      '--filter @skating/admin-areas build-region --campaign=c-ok',
      '--filter @skating/etl merge --campaign=c-ok',
      '--filter @skating/etl load .scratch/merge/bodies.ndjson --campaign=c-ok',
      '--filter @skating/etl landmarks --refresh-bodies --without-corpus --campaign=c-ok',
      '--filter @skating/etl load-landmarks --campaign=c-ok --apply --without-corpus',
    ]);
    // And the by-hand passes it prints are worded to join it too.
    expect(run.log).toContain('prune-floor --campaign=c-ok');
    expect(run.log).toContain('seed-standing --campaign=c-ok');
    expect(run.log).toContain('retire-absorbed \\');
  });

  it('exits with the failing pass’s own status, its last words logged and stamped', () => {
    const run = runCorpus(['c-fail', '--skip-landmarks'], 'load');

    // The status is the pass's, not tee's 0 and not the stamper's.
    expect(run.status).toBe(3);
    // Nothing after the failure ran, and nothing claims the campaign completed.
    expect(run.calls.map((c) => c.split(' ')[2])).toEqual(['build-region', 'merge', 'load']);
    expect(run.log).not.toContain('complete');
    // The lines a failing run most needs kept — the last ones, the very last with no newline.
    const tail = run.logLines.slice(-2);
    expect(tail[0]).toMatch(STAMP);
    expect(tail[0]).toContain('boom: load failed');
    expect(tail[1]).toMatch(STAMP);
    expect(tail[1]).toContain('last words, no newline');
  });

  it('fails a pipeline inside it on any stage, not only the last (pipefail)', () => {
    // The script's own `set -euo pipefail` line, held to: a failing producer piped into a consumer
    // that succeeds must still stop the run.
    const flags = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('set '));
    expect(flags).toEqual(['set -euo pipefail']);
    const probe = spawnSync('bash', ['-c', `${flags[0]}; false | cat; echo unreachable`], {
      encoding: 'utf8',
    });
    expect(probe.status).toBe(1);
    expect(probe.stdout).not.toContain('unreachable');
  });
});
