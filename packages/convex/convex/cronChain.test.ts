/**
 * PLACEHOLDER (B01-8c-1 seams): pins the chain stubs' shapes (`cronRuns.openRun`, `chainStep`).
 * The chain's builder replaces this with every order of the model under the harness (`crons.test.ts`
 * or here): a step before the head's `finish`, a head that throws with an open run, a straggler on a
 * killed run, `busy`, the line cap, a stale run closed by the next `openRun`.
 */

import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

test('openRun inserts an open chained run; chainStep accepts the contract’s arguments', async () => {
  const t = convexTest(schema, modules);
  const opened = await t.mutation(internal.cronRuns.openRun, {
    job: 'append daily weather archive',
    startedAt: 1_000,
    trigger: 'cron',
    detail: '3-day append',
  });
  expect('runId' in opened).toBe(true);
  if (!('runId' in opened)) return;
  await expect(
    t.mutation(internal.cronRuns.chainStep, {
      runId: opened.runId,
      opened: 1,
      closed: 1,
      counts: { cells: 40 },
      causes: [
        { cause: 'timeout', count: 3, sampleKey: 'f:1:2', sampleText: 'timed out', sampleAt: 2 },
      ],
      lines: [{ kind: 'warn', text: '3 cells timed out', loggedAt: 2 }],
    }),
  ).resolves.toBeNull();
  const run = await t.run((ctx) => ctx.db.get(opened.runId));
  expect(run).toMatchObject({
    job: 'append daily weather archive',
    outcome: 'ok',
    trigger: 'cron',
    detail: '3-day append',
    chain: { open: 1, steps: 0, progressAt: 1_000, lines: 0 },
    keepUntil: 1_000 + 200 * 86_400_000,
  });
});

test('openRun refuses a name that is not an action job', async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.mutation(internal.cronRuns.openRun, { job: 'nope', startedAt: 1, trigger: 'manual' }),
  ).rejects.toThrow(/no cron named "nope"/);
});
