/**
 * The run logger's live log (D341, B01-8a): the lines it sends at each flush and at its close, the
 * beat that keeps a silent pass visibly alive, the console's directives it obeys, the campaign's
 * pass and parent read from the environment, and the fallbacks that keep it working against a
 * deployment from before the live log — which may cost the lines, never the counts.
 */

import type { DeploymentTarget } from './deployment';
import type { RunEventLine } from './runLogger';

import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import {
  boundEvents,
  countsLine,
  DEFAULT_BEAT_MS,
  eventText,
  failuresLine,
  MAX_EVENT_TEXT,
  MAX_EVENTS_PER_APPEND,
  RunLogger,
  readDirectives,
  STOPPED_ERROR,
  scopeWords,
} from './runLogger';

const DEV: DeploymentTarget = { label: 'dev:agile-bee-397', isDev: true, isProd: false };

type Call = { fn: string; args: Record<string, unknown> };

/** A fake deployment: every call recorded in order, `append` answered by `answer`. */
function fake(
  options: {
    answer?: (n: number) => unknown;
    refuse?: (fn: string, args: Record<string, unknown>) => string | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const warnings: string[] = [];
  let appends = 0;
  let clock = 1_000_000;
  const call = <T>(fn: string, raw: unknown): T => {
    const args = raw as Record<string, unknown>;
    const refusal = options.refuse?.(fn, args);
    if (refusal !== undefined) throw new Error(refusal);
    calls.push({ fn, args });
    if (fn === 'importRuns:start') return 'run_1' as T;
    if (fn === 'runEvents:append') {
      appends++;
      return (options.answer?.(appends) ?? {
        stop: false,
        markedFailed: false,
        stored: (args.events as unknown[]).length,
        dropped: 0,
      }) as T;
    }
    return undefined as T;
  };
  const lines = () =>
    calls
      .filter((c) => c.fn === 'runEvents:append')
      .flatMap((c) => c.args.events as RunEventLine[]);
  return {
    calls,
    warnings,
    call,
    warn: (m: string) => warnings.push(m),
    lines,
    texts: () => lines().map((l) => `${l.kind}: ${l.text}`),
    fns: () => calls.map((c) => c.fn),
    now: () => clock,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function logger(f: ReturnType<typeof fake>, extra: Record<string, unknown> = {}) {
  return new RunLogger({
    kind: 'canonical_water',
    label: 'A07a unified corpus',
    target: DEV,
    call: f.call,
    warn: f.warn,
    now: f.now,
    env: {},
    onStop: (() => undefined) as unknown as () => never,
    ...extra,
  });
}

describe('the live log', () => {
  it('says the run started, with its scope, deployment and dry run, as soon as the row opens', () => {
    const f = fake();
    logger(f, {
      scope: { pass: 'full-canonical', states: ['CT', 'MA', 'ME', 'NH', 'VT'], complete: true },
      dryRun: true,
    }).start();

    expect(f.fns()).toEqual(['importRuns:start', 'runEvents:append']);
    expect(f.calls[1]?.args.runId).toBe('run_1');
    expect(f.texts()).toEqual([
      'start: Run started · A07a unified corpus · full canonical, 5 states · dev:agile-bee-397 · dry run',
    ]);
    expect(f.lines()[0]?.loggedAt).toBe(f.now());
  });

  it('sends its lines after each progress, and its last after the finish', () => {
    const f = fake();
    const l = logger(f);
    l.start();
    l.count('inserted', 10);
    l.flush();
    l.succeed();
    expect(f.fns()).toEqual([
      'importRuns:start',
      'runEvents:append',
      'importRuns:progress',
      'runEvents:append',
      'importRuns:finish',
      'runEvents:append',
    ]);
    expect(f.texts().at(-1)).toBe('close: Succeeded');
  });

  it('reports only the counts that changed, in the order the loader set them', () => {
    const f = fake();
    const l = logger(f);
    l.start();
    l.count('updated', 1);
    l.count('inserted', 5);
    l.flush();
    l.count('inserted', 9);
    l.count('updated', 1);
    l.flush();
    l.flush();
    expect(f.texts().slice(1)).toEqual([
      'flush: updated=1, inserted=5',
      'flush: inserted=9',
      // A flush with nothing new still says it reported, so the tail shows the run alive.
      'flush: No new counts since the last report',
    ]);
  });

  it('names a stage the first time it is sent, never on a re-send', () => {
    const f = fake();
    const l = logger(f);
    l.start();
    l.stage({ name: 'load', detail: 'waterBodies:importCanonical' });
    l.stage({ name: 'load', detail: 'waterBodies:importCanonical', counts: [] });
    l.stage({ name: 'filter' });
    l.flush();
    expect(f.texts().slice(1, 3)).toEqual([
      'stage: load · waterBodies:importCanonical',
      'stage: filter',
    ]);
  });

  it('summarizes the failures since the last report, with the first as its example', () => {
    const f = fake();
    const l = logger(f);
    l.start();
    l.fail({ stage: 'load', key: 'nhd/3290011', reason: 'self-intersects after simplify' });
    l.fail({ stage: 'load', key: 'nhd/1', reason: 'other' });
    l.fail({ stage: 'load', reason: 'no key' });
    l.flush();
    l.flush();
    l.fail({ stage: 'load', reason: 'late' });
    l.failed(new Error('3 of 9 batches failed'));
    expect(f.texts().filter((t) => t.startsWith('fail') || t.startsWith('close'))).toEqual([
      'fail: 3 new failures · e.g. nhd/3290011 · self-intersects after simplify',
      'fail: 1 new failure · e.g. late',
      'close: Failed: 3 of 9 batches failed',
    ]);
  });

  it('keeps an append within what the server takes', () => {
    const f = fake();
    const l = logger(f);
    l.start();
    for (let i = 0; i < 260; i++) l.stage({ name: `s${i}` });
    l.flush();
    const sent = f.calls.at(-1)?.args.events as RunEventLine[];
    expect(sent).toHaveLength(MAX_EVENTS_PER_APPEND);
    expect(sent[0]?.text).toBe('s0');
    expect(sent[149]?.text).toBe('s149');
    expect(sent[150]).toMatchObject({ kind: 'warn', text: expect.stringContaining('left out') });
    // The last lines kept.
    expect(sent.at(-1)?.text).toBe('s259');
    expect(sent[151]?.text).toBe('s211');
  });

  describe('beat()', () => {
    it('is a clock read until the cadence has passed, then a flush with its latest label', () => {
      const f = fake();
      const l = logger(f, { beatMs: 60_000 });
      l.start();
      const before = f.calls.length;
      for (let i = 0; i < 1_000; i++) l.beat(`matching · ${i} of 1,000 groups`);
      expect(f.calls).toHaveLength(before);

      f.tick(60_000);
      l.beat('matching · 1,000 of 4,000 groups');
      expect(f.fns().slice(before)).toEqual(['importRuns:progress', 'runEvents:append']);
      expect(f.texts().at(-1)).toBe('beat: matching · 1,000 of 4,000 groups');

      // The cadence restarts from that report.
      f.tick(59_999);
      l.beat();
      expect(f.calls).toHaveLength(before + 2);
      f.tick(1);
      l.beat();
      expect(f.calls).toHaveLength(before + 4);
    });

    it('counts from the last time the logger reached the deployment, a flush included', () => {
      const f = fake();
      const l = logger(f);
      l.start();
      f.tick(DEFAULT_BEAT_MS - 1);
      l.flush();
      const after = f.calls.length;
      f.tick(DEFAULT_BEAT_MS - 1);
      l.beat('quiet');
      expect(f.calls).toHaveLength(after);
      // A label left from a beat that did not report rides the next report.
      l.flush();
      expect(f.texts().at(-1)).toBe('beat: quiet');
    });

    it('does nothing before a row is open or after it is closed', () => {
      const f = fake();
      const l = logger(f, { beatMs: 0 });
      l.beat('early');
      expect(f.calls).toHaveLength(0);
      l.start();
      l.succeed();
      const closed = f.calls.length;
      l.beat('late');
      l.flush();
      expect(f.calls).toHaveLength(closed);
    });
  });

  describe('the console’s directives', () => {
    it('carries on when the run was marked failed, saying so once', () => {
      const f = fake({
        answer: (n) => ({ stop: false, markedFailed: n >= 2, stored: 1, dropped: 0 }),
      });
      const onStop = vi.fn();
      const l = logger(f, { onStop });
      l.start();
      l.count('inserted', 1);
      l.flush();
      l.count('inserted', 2);
      l.flush();
      l.succeed();
      const marked = f.warnings.filter((w) => w.includes('marked failed'));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain('its own close will be kept beside the mark');
      // The run carried on to its own close, as succeeded.
      const finish = f.calls.find((c) => c.fn === 'importRuns:finish');
      expect(finish?.args.status).toBe('succeeded');
      expect(onStop).not.toHaveBeenCalled();
    });

    it('stops at the next flush: a stop line, the row closed as failed on request, then onStop', () => {
      let asked = false;
      const f = fake({
        answer: () => ({ stop: asked, markedFailed: false, stored: 1, dropped: 0 }),
      });
      const onStop = vi.fn();
      const l = logger(f, { onStop });
      l.start();
      l.count('inserted', 1);
      l.flush();
      expect(onStop).not.toHaveBeenCalled();

      asked = true;
      l.count('inserted', 2);
      l.flush();
      const finishes = f.calls.filter((c) => c.fn === 'importRuns:finish');
      expect(finishes).toHaveLength(1);
      expect(finishes[0]?.args).toMatchObject({ status: 'failed', error: STOPPED_ERROR });
      expect(f.texts().slice(-2)).toEqual([
        'warn: Asked to stop in the console; stopping here',
        `close: Failed: ${STOPPED_ERROR}`,
      ]);
      expect(onStop).toHaveBeenCalledTimes(1);

      // Closed: the loader's own later close changes nothing.
      const after = f.calls.length;
      l.succeed();
      l.flush();
      expect(f.calls).toHaveLength(after);
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('stops from a beat, as soon as the beat reports', () => {
      const f = fake({
        answer: (n) => ({ stop: n >= 2, markedFailed: false, stored: 1, dropped: 0 }),
      });
      const onStop = vi.fn();
      const l = logger(f, { onStop, beatMs: 10 });
      l.start();
      l.beat('a');
      expect(onStop).not.toHaveBeenCalled();
      f.tick(10);
      l.beat('b');
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(f.calls.filter((c) => c.fn === 'importRuns:finish')[0]?.args.status).toBe('failed');
    });

    it('stops before any work when the campaign was asked to stop before this pass opened', () => {
      const f = fake({
        answer: () => ({ stop: true, markedFailed: false, stored: 1, dropped: 0 }),
      });
      const onStop = vi.fn();
      logger(f, { onStop }).start();
      expect(f.fns()).toEqual([
        'importRuns:start',
        'runEvents:append',
        'importRuns:finish',
        'runEvents:append',
      ]);
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('exits the process with 130 by default', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const say = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const f = fake({
          answer: () => ({ stop: true, markedFailed: false, stored: 1, dropped: 0 }),
        });
        logger(f, { onStop: undefined, warn: undefined }).start();
        expect(exit).toHaveBeenCalledWith(130);
        expect(say).toHaveBeenCalledWith(expect.stringContaining('asked to stop'));
      } finally {
        exit.mockRestore();
        say.mockRestore();
      }
    });

    it('reads an answer that is not an object as no directive', () => {
      expect(readDirectives(undefined)).toEqual({ stop: false, markedFailed: false });
      expect(readDirectives(null)).toEqual({ stop: false, markedFailed: false });
      expect(readDirectives('stop')).toEqual({ stop: false, markedFailed: false });
      expect(readDirectives({ stop: 'yes' })).toEqual({ stop: false, markedFailed: false });
      expect(readDirectives({ stop: true, markedFailed: true })).toEqual({
        stop: true,
        markedFailed: true,
      });
    });
  });

  describe('the campaign’s pass and parent, from the environment', () => {
    it('sends both at start when run-corpus.sh set them', () => {
      const f = fake();
      logger(f, { env: { RUN_CORPUS_PASS: 'merge', RUN_CORPUS_PARENT: 'camp_1' } }).start();
      expect(f.calls[0]?.args).toMatchObject({ campaignPass: 'merge', parentRunId: 'camp_1' });
    });

    it('omits them when absent or empty — a loader run by hand lists on its own', () => {
      for (const env of [{}, { RUN_CORPUS_PASS: '', RUN_CORPUS_PARENT: '' }]) {
        const f = fake();
        logger(f, { env }).start();
        expect(f.calls[0]?.args).not.toHaveProperty('campaignPass');
        expect(f.calls[0]?.args).not.toHaveProperty('parentRunId');
      }
    });

    it('a pass with no campaign row still names itself', () => {
      const f = fake();
      logger(f, { env: { RUN_CORPUS_PASS: 'load', RUN_CORPUS_PARENT: '' } }).start();
      expect(f.calls[0]?.args.campaignPass).toBe('load');
      expect(f.calls[0]?.args).not.toHaveProperty('parentRunId');
    });

    it('reads process.env by default', () => {
      vi.stubEnv('RUN_CORPUS_PASS', 'landmarks');
      vi.stubEnv('RUN_CORPUS_PARENT', 'camp_2');
      try {
        const f = fake();
        logger(f, { env: undefined }).start();
        expect(f.calls[0]?.args).toMatchObject({
          campaignPass: 'landmarks',
          parentRunId: 'camp_2',
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('against a deployment from before the live log', () => {
    /** What a 7a deployment does: refuses the new keys and has no `runEvents:append`. */
    const oldDeployment = (fn: string, args: Record<string, unknown>) => {
      if (fn === 'importRuns:start' && ('parentRunId' in args || 'campaignPass' in args)) {
        return 'ArgumentValidationError: Object contains extra field `parentRunId` that is not in the validator.';
      }
      if (fn === 'runEvents:append') {
        return "Could not find function for 'runEvents:append'. Did you forget to run `npx convex dev`?";
      }
      return undefined;
    };

    it('opens the row without the campaign’s keys, and keeps every count', () => {
      const f = fake({ refuse: oldDeployment });
      const l = logger(f, { env: { RUN_CORPUS_PASS: 'load', RUN_CORPUS_PARENT: 'camp_1' } });
      l.start();
      l.count('inserted', 100);
      l.flush();
      l.count('inserted', 250);
      l.succeed();

      expect(f.fns()).toEqual(['importRuns:start', 'importRuns:progress', 'importRuns:finish']);
      expect(f.calls[0]?.args).not.toHaveProperty('parentRunId');
      expect(f.calls[0]?.args).toMatchObject({
        kind: 'canonical_water',
        label: 'A07a unified corpus',
      });
      expect(f.calls[1]?.args.counts).toEqual([{ name: 'inserted', value: 100 }]);
      expect(f.calls[2]?.args).toMatchObject({
        runId: 'run_1',
        status: 'succeeded',
        counts: [{ name: 'inserted', value: 250 }],
      });
      // One warning for the keys, one for the lines — never one per flush.
      expect(f.warnings.filter((w) => w.includes('start refused'))).toHaveLength(1);
      expect(f.warnings.filter((w) => w.includes('keeps no run log'))).toHaveLength(1);
      expect(f.warnings).toHaveLength(2);
    });

    it('turns the lines off at the first missing-function refusal and never asks again', () => {
      let attempts = 0;
      const f = fake({
        refuse: (fn) => {
          if (fn !== 'runEvents:append') return undefined;
          attempts++;
          return "Could not find function for 'runEvents:append'.";
        },
      });
      const l = logger(f, { beatMs: 0 });
      l.start();
      for (let i = 0; i < 5; i++) l.beat(`b${i}`);
      l.succeed();
      expect(attempts).toBe(1);
      expect(f.fns().filter((fn) => fn === 'importRuns:progress')).toHaveLength(5);
    });

    it('warns on any other refusal of the lines and keeps trying', () => {
      let n = 0;
      const f = fake({
        refuse: (fn) => (fn === 'runEvents:append' && ++n === 1 ? 'Value is too large' : undefined),
      });
      const l = logger(f);
      l.start();
      l.flush();
      expect(f.warnings.join()).toContain(
        'log lines failed (the import itself is unaffected): Value is too large',
      );
      expect(f.fns().filter((fn) => fn === 'runEvents:append')).toHaveLength(1);
    });

    it('still warns and stays silent when the retry without the keys fails too', () => {
      const f = fake({ refuse: (fn) => (fn === 'importRuns:start' ? 'unreachable' : undefined) });
      const l = logger(f, { env: { RUN_CORPUS_PASS: 'load' } });
      l.start();
      l.flush();
      l.succeed();
      expect(f.calls).toHaveLength(0);
      expect(f.warnings.join()).toContain(
        'start failed (the import itself is unaffected): unreachable',
      );
    });

    it('a deployment that refuses only the progress still gets the lines', () => {
      const f = fake({ refuse: (fn) => (fn === 'importRuns:progress' ? 'boom' : undefined) });
      const l = logger(f);
      l.start();
      l.count('inserted', 3);
      l.flush();
      expect(f.texts().at(-1)).toBe('flush: inserted=3');
    });
  });
});

describe('the line helpers', () => {
  it('trims a line to what the server keeps', () => {
    expect(eventText('short')).toBe('short');
    const long = eventText('x'.repeat(MAX_EVENT_TEXT + 10));
    expect(long).toHaveLength(MAX_EVENT_TEXT);
    expect(long.endsWith('…')).toBe(true);
  });

  it('bounds an append, keeping the start and the end', () => {
    const lines = (n: number): RunEventLine[] =>
      Array.from({ length: n }, (_, i) => ({ kind: 'beat', text: `l${i}`, loggedAt: i }));
    expect(boundEvents(lines(200))).toHaveLength(200);
    const bounded = boundEvents(lines(1_000));
    expect(bounded).toHaveLength(MAX_EVENTS_PER_APPEND);
    expect(bounded[150]).toEqual({
      kind: 'warn',
      text: '801 lines left out here — too many for one report',
      loggedAt: 150,
    });
    expect(bounded.at(-1)?.text).toBe('l999');
    expect(bounded[151]?.text).toBe('l951');
  });

  it('caps the counts line, saying how many it left out', () => {
    expect(countsLine([])).toBe('');
    expect(countsLine([{ name: 'a', value: 1 }])).toBe('a=1');
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `count${i}`, value: i * 1000 }));
    const line = countsLine(many);
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_TEXT);
    const kept = line.split(' … ')[0]?.split(', ').length ?? 0;
    expect(line).toMatch(new RegExp(`… and ${80 - kept} more$`));
    // One count too long for a line on its own is trimmed, never dropped.
    expect(countsLine([{ name: 'x'.repeat(600), value: 1 }])).toHaveLength(MAX_EVENT_TEXT);
  });

  it('says a scope in words', () => {
    expect(scopeWords({ pass: 'full-canonical', states: ['ME', 'VT'], complete: true })).toBe(
      'full canonical, 2 states',
    );
    expect(scopeWords({ pass: 'derived', states: ['VT'], complete: false })).toBe(
      'derived, VT, partial',
    );
    expect(scopeWords({ pass: 'seed', complete: true })).toBe('seed');
  });

  it('says a failure count with its example', () => {
    expect(failuresLine(1, { stage: 'load', reason: 'bad' })).toBe('1 new failure · e.g. bad');
    expect(failuresLine(1_200, { stage: 'load', key: 'k', reason: 'r' })).toBe(
      '1,200 new failures · e.g. k · r',
    );
  });
});
