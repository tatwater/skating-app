import type { DeploymentTarget } from './deployment';

import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { DRY_RUN_NOTE, MAX_FORWARDED_FAILURES, RunLogger } from './runLogger';

const DEV: DeploymentTarget = { label: 'dev:agile-bee-397', isDev: true, isProd: false };

/** Record every call the logger makes, and hand back a run id from `start`. */
function recorder(overrides: { throwOn?: string } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  const call = <T>(fn: string, args: unknown): T => {
    if (overrides.throwOn === fn) throw new Error(`boom in ${fn}`);
    calls.push({ fn, args: args as Record<string, unknown> });
    return (fn === 'importRuns:start' ? 'run_1' : undefined) as T;
  };
  return { calls, warnings, call, warn: (m: string) => warnings.push(m) };
}

function makeLogger(rec: ReturnType<typeof recorder>, extra: Record<string, unknown> = {}) {
  return new RunLogger({
    kind: 'canonical_water',
    label: 'VT canonical water',
    target: DEV,
    call: rec.call,
    warn: rec.warn,
    ...extra,
  });
}

describe('RunLogger', () => {
  it('opens the row before any work, carrying the target and pre-known stages', () => {
    const rec = recorder();
    const logger = makeLogger(rec, { stages: [{ name: 'extract', sha256: 'abc' }] });
    logger.start();

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.fn).toBe('importRuns:start');
    expect(rec.calls[0]?.args).toMatchObject({
      kind: 'canonical_water',
      deployment: 'dev:agile-bee-397',
      isProd: false,
      stages: [{ name: 'extract', sha256: 'abc' }],
    });
  });

  it('states its scope at the start, and only there (D218)', () => {
    const rec = recorder();
    const scope = { pass: 'full-canonical' as const, states: ['ME', 'VT'], complete: true };
    const logger = makeLogger(rec, { scope });
    logger.start();
    logger.count('inserted', 1);
    logger.flush();
    logger.succeed();

    expect(rec.calls[0]?.args.scope).toEqual(scope);
    // Its intent, never re-sent: a progress or a close carrying it would be a second answer.
    for (const later of rec.calls.slice(1)) expect(later.args).not.toHaveProperty('scope');
  });

  it('omits the scope key entirely when the loader states none', () => {
    const rec = recorder();
    makeLogger(rec).start();
    expect(rec.calls[0]?.args).not.toHaveProperty('scope');
  });

  it('sends counts as running totals, not deltas', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.count('inserted', 100);
    logger.flush();
    logger.count('inserted', 250);
    logger.flush();

    const totals = rec.calls
      .filter((c) => c.fn === 'importRuns:progress')
      .map((c) => (c.args.counts as { name: string; value: number }[])[0]?.value);
    expect(totals).toEqual([100, 250]);
  });

  it('replaces a stage by name rather than appending it twice', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.stage({ name: 'load', counts: [{ name: 'batches', value: 1 }] });
    logger.stage({ name: 'load', counts: [{ name: 'batches', value: 9 }] });
    logger.flush();

    const stages = rec.calls.at(-1)?.args.stages as { name: string; counts: unknown }[];
    expect(stages).toHaveLength(1);
    expect(stages[0]?.counts).toEqual([{ name: 'batches', value: 9 }]);
  });

  it('counts every failure but forwards at most the cap', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    for (let i = 0; i < MAX_FORWARDED_FAILURES + 50; i++) {
      logger.fail({ stage: 'transform', key: `way/${i}`, reason: 'bad geometry' });
    }
    logger.succeed();

    const finish = rec.calls.at(-1);
    expect(finish?.fn).toBe('importRuns:finish');
    expect(finish?.args.failures as unknown[]).toHaveLength(MAX_FORWARDED_FAILURES);
    // The honest denominator survives the truncation — that is the whole point of the pair.
    expect(finish?.args.failuresTotal).toBe(MAX_FORWARDED_FAILURES + 50);
    expect(logger.totalFailures).toBe(MAX_FORWARDED_FAILURES + 50);
  });

  it('never sends the same failure twice across flushes', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.fail({ stage: 'transform', key: 'way/1', reason: 'bad geometry' });
    logger.flush();
    logger.flush();
    logger.succeed();

    const sent = rec.calls
      .filter((c) => c.fn !== 'importRuns:start')
      .flatMap((c) => c.args.failures as unknown[]);
    expect(sent).toHaveLength(1);
  });

  it('sends coverage with the run, replacing rather than merging', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.coverage({ unit: 'bodies', eligible: 10, covered: 1, omissions: [] });
    // A second call is the loader firming up its numbers, not adding to them — a half-updated
    // denominator would be worse than a stale one.
    logger.coverage({
      unit: 'bodies',
      eligible: 116_070,
      covered: 8_100,
      omissions: [{ reason: 'below the source area floor', count: 107_970 }],
    });
    logger.succeed();

    const finish = rec.calls.at(-1);
    expect(finish?.args.coverage).toEqual({
      unit: 'bodies',
      eligible: 116_070,
      covered: 8_100,
      omissions: [{ reason: 'below the source area floor', count: 107_970 }],
    });
  });

  it('omits coverage entirely when a loader never reported one', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.succeed();
    expect(rec.calls.at(-1)?.args).not.toHaveProperty('coverage');
  });

  it('marks a failed run as failed and keeps the message', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.failed(new Error('batch 7 blew the read cap'));

    expect(rec.calls.at(-1)?.args).toMatchObject({
      status: 'failed',
      error: 'batch 7 blew the read cap',
    });
  });

  it('reports a non-Error failure and warns on stderr if it cannot save that failure', () => {
    const originalFailure = 'loader reported a bad source';
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const rec = recorder();
      const logger = makeLogger(rec, {
        warn: undefined,
        call: <T>(functionName: string, args: unknown): T => {
          const result = rec.call<T>(functionName, args);
          if (functionName === 'importRuns:finish') throw 'fixture write failure';
          return result;
        },
      });
      logger.start();
      logger.failed(originalFailure);

      expect(rec.calls.at(-1)?.args).toMatchObject({ status: 'failed', error: originalFailure });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[run-log] finish failed (the import itself is unaffected): fixture write failure\n',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('closes once — a succeed after a failure cannot overwrite the verdict', () => {
    const rec = recorder();
    const logger = makeLogger(rec);
    logger.start();
    logger.failed(new Error('died'));
    logger.succeed();

    const finishes = rec.calls.filter((c) => c.fn === 'importRuns:finish');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.args.status).toBe('failed');
  });

  it('degrades to a warning when the row cannot be opened, and stays silent after', () => {
    const rec = recorder({ throwOn: 'importRuns:start' });
    const logger = makeLogger(rec);
    logger.start();
    logger.count('inserted', 5);
    logger.flush();
    logger.succeed();

    // Rule 1: bookkeeping never breaks the thing it books — no throw, and no calls attempted
    // against a run id we never got.
    expect(rec.calls).toHaveLength(0);
    expect(rec.warnings.join()).toContain('the import itself is unaffected');
  });

  it('degrades to a warning when a progress write fails mid-run', () => {
    const rec = recorder({ throwOn: 'importRuns:progress' });
    const logger = makeLogger(rec);
    logger.start();
    logger.count('inserted', 5);
    expect(() => logger.flush()).not.toThrow();
    expect(rec.warnings.join()).toContain('progress failed');
  });

  describe('a dry run’s row always says it wrote nothing', () => {
    /** The notes the row holds once closed: the finish's when it sent any, else the start's. */
    const stored = (rec: ReturnType<typeof recorder>) => {
      const finish = rec.calls.find((c) => c.fn === 'importRuns:finish')?.args;
      return (finish?.notes ?? rec.calls[0]?.args.notes) as string[] | undefined;
    };

    it.each([
      ['no notes at its close', undefined],
      ['an empty list of notes', []],
      ['trimmed-id notes', ['osm/node/1: 12 catalog ids, the oldest 2 dropped']],
    ])('closed with %s, it ends with the label, and is not applied', (_, notes) => {
      const rec = recorder();
      const logger = makeLogger(rec, { dryRun: true, notes: ['Matched offline.'] });
      logger.start();
      logger.succeed(notes);
      expect(stored(rec)?.at(-1)).toBe(DRY_RUN_NOTE);
      for (const note of notes ?? []) expect(stored(rec)).toContain(note);
      expect(rec.calls.find((c) => c.fn === 'importRuns:finish')?.args.applied).toBe(false);
    });

    it('a failed dry run says it too', () => {
      const rec = recorder();
      const logger = makeLogger(rec, { dryRun: true });
      logger.start();
      logger.failed(new Error('2 batch(es) failed'), ['a note']);
      expect(stored(rec)?.at(-1)).toBe(DRY_RUN_NOTE);
    });

    it('an applied run never carries it, and says nothing of applied', () => {
      for (const dryRun of [false, undefined]) {
        const rec = recorder();
        const logger = makeLogger(rec, { ...(dryRun === false && { dryRun }), notes: ['x'] });
        logger.start();
        logger.succeed(['y']);
        expect(
          rec.calls.flatMap((c) => (c.args.notes as string[] | undefined) ?? []),
        ).not.toContain(DRY_RUN_NOTE);
        expect(rec.calls.find((c) => c.fn === 'importRuns:finish')?.args).not.toHaveProperty(
          'applied',
        );
      }
    });
  });
});
