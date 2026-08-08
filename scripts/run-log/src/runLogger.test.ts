import { describe, expect, it } from 'vitest';
import type { DeploymentTarget } from './deployment';
import { MAX_FORWARDED_FAILURES, RunLogger } from './runLogger';

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
});
