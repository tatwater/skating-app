/**
 * `run-corpus.sh`'s log (B01-7a): every line stamped, every pass carrying the campaign id, and the
 * exit status still the script's own — the `| tee` trap its header records is the one this must not
 * reopen. The script runs for real, from a copy in a temp directory, against a `pnpm` on `PATH`
 * that records its arguments and fails the pass it is told to.
 *
 * And its campaign row (B01-8a, D341): opened with the flags and the plan, beaten before each pass,
 * closed with the real exit status on every path — success, a failing pass, a refused merge, a stop
 * asked in the console, Ctrl-C — and never able to change that status, even when the campaign CLI
 * fails or is missing. The fake `pnpm` answers the campaign CLI's verbs as the real one would.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../run-corpus.sh', import.meta.url));

/** ISO 8601 to the second, with its offset, then one space. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} /;

/**
 * Stands in for `pnpm`. The campaign CLI (`--silent --filter @skating/run-log campaign …`) is
 * recorded to `$CAMPAIGN_CALLS` and answered per `$CAMPAIGN_MODE`; every other call is a pass:
 * recorded to `$CALLS` (and the pass's environment to `$ENVS`), writing the merge's manifest unless
 * `$NO_MANIFEST`, failing `$FAIL_ON`, sleeping in `$SLEEP_ON` (for the interrupt).
 */
const FAKE_PNPM = `#!/usr/bin/env bash
if [ "$1" = "--silent" ] && [ "$3" = "@skating/run-log" ] && [ "$4" = "campaign" ]; then
  shift 4
  printf '%s\\n' "$*" >> "$CAMPAIGN_CALLS"
  case "\${CAMPAIGN_MODE:-ok}" in
    missing) echo "ERR_PNPM_NO_SCRIPT Missing script: campaign" >&2; exit 1 ;;
    garbage) if [ "$1" = open ] && [ -z "\${GARBAGE_EMPTY:-}" ]; then echo "> @skating/run-log campaign"; fi; exit 0 ;;
    failing) echo "[run-log] campaign $1 failed (the campaign itself is unaffected)" >&2; exit 1 ;;
  esac
  case "$1" in
    open) echo "run123" ;;
    close) if [ -n "\${CLOSE_FAILS:-}" ]; then exit 9; fi ;;
    pass) if [ -n "\${STOP_BEFORE:-}" ] && [ "$3" = "\${STOP_BEFORE}" ]; then echo stop; fi ;;
  esac
  exit 0
fi
echo "$*" >> "$CALLS"
echo "$3 pass=\${RUN_CORPUS_PASS:-} parent=\${RUN_CORPUS_PARENT:-}" >> "$ENVS"
for arg in "$@"; do
  if [ "$arg" = "merge" ] && [ -z "\${NO_MANIFEST:-}" ]; then
    mkdir -p .scratch/merge; echo '{}' > .scratch/merge/merge-manifest.json
  fi
  if [ -n "\${SLEEP_ON:-}" ] && [ "$arg" = "$SLEEP_ON" ]; then
    echo "sleeping in $SLEEP_ON"
    sleep 30
  fi
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

type Env = Record<string, string>;

/** A temp copy of the script with the fake `pnpm` first on `PATH`. */
function harness(env: Env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-corpus-'));
  dirs.push(dir);
  const etl = join(dir, 'etl');
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', etl, bin]);
  copyFileSync(SCRIPT, join(etl, 'run-corpus.sh'));
  writeFileSync(join(bin, 'pnpm'), FAKE_PNPM);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const files = {
    CALLS: join(dir, 'calls.txt'),
    CAMPAIGN_CALLS: join(dir, 'campaign.txt'),
    ENVS: join(dir, 'envs.txt'),
  };
  for (const file of Object.values(files)) writeFileSync(file, '');
  const childEnv: Env = {
    ...(process.env as Env),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ...files,
    ...env,
  };
  // The suite's own environment must not leak a campaign into the script's passes.
  delete childEnv.RUN_CORPUS_PASS;
  delete childEnv.RUN_CORPUS_PARENT;
  const lines = (file: string) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
  const read = (campaignId: string, status: number | null, stdout: string) => {
    const logFile = join(etl, '.scratch', 'merge', `run-${campaignId}.log`);
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    return {
      status,
      stdout,
      log,
      logLines: log.split('\n').filter((l) => l.length > 0),
      calls: lines(files.CALLS),
      campaign: lines(files.CAMPAIGN_CALLS),
      envs: lines(files.ENVS),
    };
  };
  return { script: join(etl, 'run-corpus.sh'), env: childEnv, read };
}

function runCorpus(args: string[], env: Env = {}) {
  const h = harness(env);
  const result = spawnSync('bash', [h.script, ...args], { encoding: 'utf8', env: h.env });
  return h.read(args[0] as string, result.status, result.stdout);
}

/** The pass names the fake saw, in order — the third word of each call. */
const passes = (calls: string[]) => calls.map((c) => c.split(' ')[2]);

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
    const run = runCorpus(['c-fail', '--skip-landmarks'], { FAIL_ON: 'load' });

    // The status is the pass's, not tee's 0 and not the stamper's.
    expect(run.status).toBe(3);
    // Nothing after the failure ran, and nothing claims the campaign completed.
    expect(passes(run.calls)).toEqual(['build-region', 'merge', 'load']);
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

  describe('the campaign’s own row (D341)', () => {
    it('opens with the flags and the plan, beats each pass, and closes with exit 0', () => {
      const run = runCorpus(['c-row', '--without-corpus', '--refresh']);

      expect(run.status).toBe(0);
      expect(run.campaign).toEqual([
        'open c-row --plan=build-region,merge,load,load-sub-areas,landmarks,load-landmarks,load-landmark-names ' +
          '--hand=prune-floor,seed-standing,retire-absorbed ' +
          '--skipped=load-sub-areas:no --actor given ' +
          '--skipped=load-landmark-names:built without the corpus ' +
          '-- --without-corpus --refresh',
        'pass run123 build-region',
        'pass run123 merge',
        'pass run123 load',
        // The fake merge wrote no sub-areas: skipped at run time, with why.
        'skip run123 load-sub-areas the merge emitted no sub-areas',
        'pass run123 landmarks',
        'pass run123 load-landmarks',
        'close run123 --exit=0 --last-pass=load-landmarks',
      ]);
      // Each pass runs under its own name and its campaign's row.
      expect(run.envs).toEqual([
        'build-region pass=build-region parent=run123',
        'merge pass=merge parent=run123',
        'load pass=load parent=run123',
        'landmarks pass=landmarks parent=run123',
        'load-landmarks pass=load-landmarks parent=run123',
      ]);
      // The console's URL first, and again at the end.
      const watch = run.logLines.findIndex((l) =>
        l.includes('watch it at /admin/machinery/corpus?campaign=c-row'),
      );
      const firstPass = run.logLines.findIndex((l) => l.includes('══ region masks'));
      expect(watch).toBeGreaterThan(-1);
      expect(watch).toBeLessThan(firstPass);
      expect(run.log).toMatch(
        /complete — its record is at \/admin\/machinery\/corpus\?campaign=c-row/,
      );
      expect(run.log).not.toContain('/admin/imports');
    });

    it('plans every landmark pass as skipped under --skip-landmarks, and none with an actor', () => {
      const run = runCorpus(['c-skip', '--skip-landmarks', '--actor=p1']);
      expect(run.campaign[0]).toContain('--skipped=landmarks:--skip-landmarks');
      expect(run.campaign[0]).toContain('--skipped=load-landmarks:--skip-landmarks');
      expect(run.campaign[0]).toContain('--skipped=load-landmark-names:--skip-landmarks');
      expect(run.campaign[0]).not.toContain('load-sub-areas:');
      expect(run.campaign[0]?.endsWith('-- --skip-landmarks --actor=p1')).toBe(true);
    });

    it('closes failed with the failing pass and its exit code, and still exits with that code', () => {
      const run = runCorpus(['c-fail', '--skip-landmarks'], { FAIL_ON: 'load' });
      expect(run.status).toBe(3);
      expect(run.campaign.at(-1)).toBe('close run123 --exit=3 --last-pass=load');
    });

    it('closes failed on a refused merge — no manifest, no load', () => {
      const run = runCorpus(['c-nomanifest', '--skip-landmarks'], { NO_MANIFEST: '1' });
      expect(run.status).toBe(1);
      expect(passes(run.calls)).toEqual(['build-region', 'merge']);
      expect(run.log).toContain('refusing to load a corpus it did not finish producing');
      expect(run.campaign.at(-1)).toBe('close run123 --exit=1 --last-pass=merge');
    });

    it('stops between passes when the console asks, exiting 130 before the next pass runs', () => {
      const run = runCorpus(['c-stop', '--skip-landmarks'], { STOP_BEFORE: 'load' });
      expect(run.status).toBe(130);
      expect(passes(run.calls)).toEqual(['build-region', 'merge']);
      expect(run.log).toContain('asked to stop in the console — stopping before load');
      // The last pass that ran is the one it stopped after.
      expect(run.campaign.at(-1)).toBe('close run123 --exit=130 --last-pass=merge');
    });

    it.each([
      ['the campaign CLI fails every call', { CAMPAIGN_MODE: 'failing' }],
      ['the campaign CLI is missing', { CAMPAIGN_MODE: 'missing' }],
      ['the open answers something that is not a row', { CAMPAIGN_MODE: 'garbage' }],
      ['the open answers nothing', { CAMPAIGN_MODE: 'garbage', GARBAGE_EMPTY: '1' }],
    ])('when %s, the campaign runs as before and its status is unchanged', (_, env) => {
      const ok = runCorpus(['c-cli', '--without-corpus'], env);
      expect(ok.status).toBe(0);
      expect(passes(ok.calls)).toEqual([
        'build-region',
        'merge',
        'load',
        'landmarks',
        'load-landmarks',
      ]);
      // No row: the passes list on their own, and nothing is beaten or closed.
      for (const e of ok.envs) expect(e).toMatch(/parent=$/);
      expect(ok.campaign).toHaveLength(1);
      expect(ok.log).toContain('could not be opened');

      const failing = runCorpus(['c-cli-fail', '--skip-landmarks'], { ...env, FAIL_ON: 'merge' });
      expect(failing.status).toBe(3);
    });

    it('re-raises a failing pass’s status when the close itself fails', () => {
      const run = runCorpus(['c-close', '--skip-landmarks'], { FAIL_ON: 'load', CLOSE_FAILS: '1' });
      expect(run.campaign.at(-1)).toBe('close run123 --exit=3 --last-pass=load');
      expect(run.status).toBe(3);
      const ok = runCorpus(['c-close-ok', '--skip-landmarks'], { CLOSE_FAILS: '1' });
      expect(ok.status).toBe(0);
    });

    it('closes with exit 130 and the pass it was in on Ctrl-C, its log kept', async () => {
      const h = harness({ SLEEP_ON: 'load' });
      // Its own process group, as a terminal gives it, so the interrupt reaches the pass too.
      const child = spawn('bash', [h.script, 'c-int', '--skip-landmarks'], {
        env: h.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      const exited = new Promise<number | null>((resolve) =>
        child.on('exit', (code) => resolve(code)),
      );
      // Wait for the pass to be asleep, then press Ctrl-C on the whole group.
      const deadline = Date.now() + 15_000;
      while (!stdout.includes('sleeping in load') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stdout).toContain('sleeping in load');
      process.kill(-(child.pid as number), 'SIGINT');
      const status = await exited;
      const run = h.read('c-int', status, stdout);

      expect(run.status).toBe(130);
      expect(run.campaign.at(-1)).toBe('close run123 --exit=130 --last-pass=load');
      // The logger ignored the interrupt, so the log still holds what the run last said.
      expect(run.log).toContain('sleeping in load');
      expect(passes(run.calls)).toEqual(['build-region', 'merge', 'load']);
    });
  });
});
