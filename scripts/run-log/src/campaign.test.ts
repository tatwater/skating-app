/**
 * The campaign CLI's four verbs (D341, B01-8a), against a fake deployment: what each writes, what it
 * prints for the script to read, and that none can fail the campaign whatever Convex says.
 */

import type { DeploymentTarget } from './deployment';
import type { RunEventLine } from './runLogger';

import { describe, expect, it } from 'vitest';
import { campaignFromCommandLine, planOf, stoppedAt } from './campaign';

const DEV: DeploymentTarget = { label: 'dev:agile-bee-397', isDev: true, isProd: false };

function world(
  options: {
    refuse?: (fn: string, args: Record<string, unknown>) => string | undefined;
    answer?: unknown;
    startsAs?: unknown;
  } = {},
) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const out: string[] = [];
  const warnings: string[] = [];
  const run = (...args: string[]) =>
    campaignFromCommandLine(args, {
      call: <T>(fn: string, raw: unknown): T => {
        const a = raw as Record<string, unknown>;
        const refusal = options.refuse?.(fn, a);
        if (refusal !== undefined) throw new Error(refusal);
        calls.push({ fn, args: a });
        if (fn === 'importRuns:start')
          return ('startsAs' in options ? options.startsAs : 'camp_1') as T;
        if (fn === 'runEvents:append') {
          return (options.answer ?? {
            stop: false,
            markedFailed: false,
            stored: 1,
            dropped: 0,
          }) as T;
        }
        return undefined as T;
      },
      target: () => DEV,
      out: (t) => out.push(t),
      warn: (t) => warnings.push(t),
      now: () => 42,
    });
  const lines = () =>
    calls
      .filter((c) => c.fn === 'runEvents:append')
      .flatMap((c) => (c.args.events as RunEventLine[]).map((l) => `${l.kind}: ${l.text}`));
  return { calls, out, warnings, run, lines };
}

describe('campaign open', () => {
  it('opens the campaign’s row with its flags and plan, and prints only its id', () => {
    const w = world();
    const code = w.run(
      'open',
      'n8-20261128',
      '--plan=build-region,merge,load,load-sub-areas',
      '--hand=prune-floor,retire-absorbed',
      '--skipped=load-sub-areas:no --actor given',
      '--',
      '--without-corpus',
      '--refresh',
    );
    expect(code).toBe(0);
    expect(w.out).toEqual(['camp_1\n']);
    expect(w.calls[0]).toEqual({
      fn: 'importRuns:start',
      args: {
        kind: 'corpus_campaign',
        label: 'Corpus campaign n8-20261128',
        campaignId: 'n8-20261128',
        deployment: 'dev:agile-bee-397',
        isProd: false,
        stages: [],
        scope: { pass: 'full-canonical', complete: true },
        campaign: {
          flags: ['--without-corpus', '--refresh'],
          plan: [
            { pass: 'build-region', by: 'script' },
            { pass: 'merge', by: 'script' },
            { pass: 'load', by: 'script' },
            { pass: 'load-sub-areas', by: 'script', skipped: 'no --actor given' },
            { pass: 'prune-floor', by: 'hand' },
            { pass: 'retire-absorbed', by: 'hand' },
          ],
        },
      },
    });
    expect(w.lines()).toEqual([
      'start: Campaign started · --without-corpus --refresh · 4 passes planned, 1 to skip',
      'stage: Pass load-sub-areas will be skipped: no --actor given',
    ]);
    expect(w.calls[1]?.args.runId).toBe('camp_1');
  });

  it('says when it was given no flags', () => {
    const w = world();
    w.run('open', 'c', '--plan=merge');
    expect(w.lines()).toEqual(['start: Campaign started · no flags · 1 passes planned']);
    expect(w.calls[0]?.args.campaign).toEqual({
      flags: [],
      plan: [{ pass: 'merge', by: 'script' }],
    });
  });

  it('prints nothing and exits 0 when the deployment refuses the row', () => {
    const w = world({
      refuse: (fn) => (fn === 'importRuns:start' ? 'Value does not match validator' : undefined),
    });
    expect(w.run('open', 'c', '--plan=merge')).toBe(0);
    expect(w.out).toEqual([]);
    expect(w.warnings.join()).toContain(
      'campaign open failed (the campaign itself is unaffected): Value does not match validator',
    );
    expect(w.calls).toHaveLength(0);
  });

  it('prints nothing when the start answers something that is not an id', () => {
    for (const startsAs of [undefined, '', 7]) {
      const w = world({ startsAs });
      expect(w.run('open', 'c', '--plan=merge')).toBe(0);
      expect(w.out).toEqual([]);
    }
  });

  it('still prints the id when only its lines are refused', () => {
    const w = world({
      refuse: (fn) => (fn === 'runEvents:append' ? 'Could not find function' : undefined),
    });
    expect(w.run('open', 'c', '--plan=merge')).toBe(0);
    expect(w.out).toEqual(['camp_1\n']);
  });
});

describe('campaign pass', () => {
  it('beats the row and says the pass is starting', () => {
    const w = world();
    expect(w.run('pass', 'camp_1', 'merge')).toBe(0);
    expect(w.calls.map((c) => c.fn)).toEqual(['importRuns:progress', 'runEvents:append']);
    expect(w.calls[0]?.args).toEqual({ runId: 'camp_1' });
    expect(w.lines()).toEqual(['stage: Pass merge starting']);
    expect(w.out).toEqual([]);
  });

  it('prints `stop` when the console asked the campaign to stop, and says so in the log', () => {
    const w = world({ answer: { stop: true, markedFailed: false, stored: 1, dropped: 0 } });
    expect(w.run('pass', 'camp_1', 'load')).toBe(0);
    expect(w.out).toEqual(['stop\n']);
    expect(w.lines()).toEqual([
      'stage: Pass load starting',
      'warn: Asked to stop in the console: stopping before pass load',
    ]);
  });

  it('carries on silently when the deployment refuses both writes', () => {
    const w = world({ refuse: () => 'unreachable' });
    expect(w.run('pass', 'camp_1', 'load')).toBe(0);
    expect(w.out).toEqual([]);
    expect(w.warnings).toHaveLength(2);
  });
});

describe('campaign skip', () => {
  it('says the pass was skipped, and why', () => {
    const w = world();
    expect(w.run('skip', 'camp_1', 'load-sub-areas', 'the merge emitted', 'no sub-areas')).toBe(0);
    expect(w.lines()).toEqual([
      'stage: Pass load-sub-areas skipped: the merge emitted no sub-areas',
    ]);
    const bare = world();
    bare.run('skip', 'camp_1', 'landmarks');
    expect(bare.lines()).toEqual(['stage: Pass landmarks skipped']);
  });
});

describe('campaign close', () => {
  it('closes succeeded on exit 0, recording the exit and the last pass', () => {
    const w = world();
    expect(w.run('close', 'camp_1', '--exit=0', '--last-pass=load-landmark-names')).toBe(0);
    expect(w.calls[0]).toEqual({
      fn: 'importRuns:finish',
      args: {
        runId: 'camp_1',
        status: 'succeeded',
        campaign: { exitCode: 0, lastPass: 'load-landmark-names' },
      },
    });
    expect(w.lines()).toEqual(['close: Succeeded']);
  });

  it('closes failed on any other exit, naming the pass it stopped at', () => {
    const w = world();
    w.run('close', 'camp_1', '--exit=3', '--last-pass=load');
    expect(w.calls[0]?.args).toEqual({
      runId: 'camp_1',
      status: 'failed',
      error: 'Stopped at load (exit 3)',
      campaign: { exitCode: 3, lastPass: 'load' },
    });
    expect(w.lines()).toEqual(['close: Failed: Stopped at load (exit 3)']);
  });

  it('closes failed before its first pass with an empty last pass', () => {
    const w = world();
    w.run('close', 'camp_1', '--exit=130', '--last-pass=');
    expect(w.calls[0]?.args).toEqual({
      runId: 'camp_1',
      status: 'failed',
      error: 'Stopped before its first pass (exit 130)',
      campaign: { exitCode: 130 },
    });
  });

  it('still closes the row when the deployment refuses the exit code', () => {
    const w = world({
      refuse: (fn, args) =>
        fn === 'importRuns:finish' && 'campaign' in args ? 'extra field' : undefined,
    });
    expect(w.run('close', 'camp_1', '--exit=1', '--last-pass=merge')).toBe(0);
    expect(w.calls[0]).toEqual({
      fn: 'importRuns:finish',
      args: { runId: 'camp_1', status: 'failed', error: 'Stopped at merge (exit 1)' },
    });
  });

  it('exits 0 when every write is refused', () => {
    const w = world({ refuse: () => 'unreachable' });
    expect(w.run('close', 'camp_1', '--exit=2')).toBe(0);
    expect(w.warnings).toHaveLength(3);
  });
});

describe('a malformed command line', () => {
  it.each([
    [[]],
    [['open']],
    [['open', 'c']],
    [['pass', 'camp_1']],
    [['skip', 'camp_1']],
    [['close', 'camp_1']],
    [['close', 'camp_1', '--exit=x']],
    [['what', 'camp_1']],
  ])('%j prints the usage, writes nothing and exits 2', (args) => {
    const w = world();
    expect(w.run(...args)).toBe(2);
    expect(w.calls).toHaveLength(0);
    expect(w.warnings.join()).toContain('usage: campaign open');
  });
});

describe('the plan', () => {
  it('drops a skip that names no planned pass, or carries no pass', () => {
    expect(planOf(['--plan=a,b', '--skipped=c:why', '--skipped=:why', '--skipped=b'])).toEqual([
      { pass: 'a', by: 'script' },
      { pass: 'b', by: 'script' },
    ]);
  });

  it('gives a skip with no reason a word, and takes the last --plan', () => {
    expect(planOf(['--plan=x', '--plan=a, b ,', '--skipped=a:'])).toEqual([
      { pass: 'a', by: 'script', skipped: 'skipped' },
      { pass: 'b', by: 'script' },
    ]);
  });

  it('words a stop', () => {
    expect(stoppedAt(3, 'load')).toBe('Stopped at load (exit 3)');
    expect(stoppedAt(130, undefined)).toBe('Stopped before its first pass (exit 130)');
  });
});
