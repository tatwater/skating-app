/**
 * **A run that continues past its tick** (D349, B01-8c): `cronRuns.openRun`, `chainStep`, the
 * recorder's merge of a head's tick into its run, and every order of the model under the harness — a
 * step before the head's `finish`, a head that throws with its run open, a killed head, a straggler on
 * a killed run, `busy`, the line cap, a stale run closed by the next `openRun`, two branches closing
 * at once, and the recorder throwing at each call (the job's work goes on).
 *
 * A synthetic chained job lives in a probe module that exists only in this file's module map
 * (`./chainProbe.ts`) and reaches the real dispatchers through a spy on the registry's lookup, as
 * `crons.test.ts`' probes do. Mutation-checked: each mutation of `cronRuns.ts` below was run and seen
 * to fail the tests named, then the source restored —
 *
 *  - **R1** the head's merge counted as a batch (`mode` ignored): *a fan-out chain through the
 *    dispatcher is one run*;
 *  - **R2** `openRun` kills a quiet run (`!== 'running'` for `=== 'stopped'`): *busy while a step is
 *    inside the action limit and its minute*;
 *  - **R3** the merge inserts a run row as well (`else` dropped): *a fan-out chain…*, *a step before
 *    the head's finish*;
 *  - **R4** a straggler applied (the closed check dropped): *a straggler on a killed run*;
 *  - **R5** the outcome set `failed` while the run is still open: *a batch's error closes the run
 *    failed only when its last branch ends*;
 *  - **R6** `begin`'s chain lookup dropped: *a killed head is the chain's row*.
 */

import {
  CHAIN_LINES_HEAD,
  CHAIN_LINES_MAX,
  CHAIN_LINES_TAIL,
  CRON_KILLED_AFTER_MS,
  type CronTickContext,
  withCronReport,
} from '@skating/core';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { type ActionCtx, internalAction, internalMutation } from './_generated/server';
import * as cronJobsModule from './cronJobs';
import { CRON_RETENTION, type CronActionJob, SEASON_CRON_RETENTION } from './cronJobs';
import { OPEN_RUN_LOOKBACK, readCauses, recorder, tickContextOf } from './cronRuns';
import {
  CHAIN_STEP_ATTEMPTS,
  chainStepSafely,
  closeChainHead,
  openChainBranch,
  openChainRun,
  retryOnWriteConflict,
} from './lib/chainRun';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const MINUTE = 60_000;
const DAY = 86_400_000;
/** 07:00 UTC, the append's time. */
const T0 = Date.UTC(2026, 11, 3, 7, 0, 0);
const JOB = 'c chain';

// ─── The probe module: a synthetic chained job ──────────────────────────────────────────────────

const batchRef = makeFunctionReference<'action'>('chainProbe:batch');

/** What the probe's head does, set per test. */
const plan = {
  branches: 2,
  batches: 3,
  /** A batch that throws before its step, by `branch:left`. */
  throwsAt: null as string | null,
  /** A batch that catches its failure and sends it as the step's error, by `branch:left`. */
  errorAt: null as string | null,
  /** The head throws after starting its branches. */
  headThrows: false,
  /** The tick the head was handed. */
  seenTick: undefined as CronTickContext | undefined,
  linesPerBatch: 2,
  /** Batches that ran their work. */
  ran: 0,
};

const probe = {
  /** One batch: 40 "cells", one timed-out cell, then its step, then its next. */
  batch: internalAction({
    args: {
      runId: v.optional(v.id('cronRuns')),
      branch: v.string(),
      left: v.number(),
    },
    handler: async (ctx, { runId, branch, left }) => {
      const at = `${branch}:${left}`;
      if (plan.throwsAt === at) throw new Error(`batch ${at} died`);
      plan.ran++;
      const more = left > 1;
      await chainStepSafely(ctx, runId, {
        closed: 1,
        opened: more ? 1 : 0,
        counts: { cells: 40, cellsFailed: 1, fetchMsMax: left * 10, oldestOpenDay: 100 - left },
        causes: [
          {
            cause: 'timeout',
            count: 1,
            sampleKey: `f:${at}`,
            sampleText: `timed out https://api.example/v1?apikey=s3cret&cell=${at}`,
            sampleAt: Date.now(),
          },
        ],
        lines: Array.from({ length: plan.linesPerBatch }, (_, i) => ({
          kind: 'line' as const,
          text: `${at} line ${i}`,
          loggedAt: Date.now(),
        })),
        ...(plan.errorAt === at ? { error: `batch ${at} wrote nothing` } : {}),
      });
      if (more) {
        await ctx.scheduler.runAfter(0, batchRef, {
          ...(runId !== undefined ? { runId } : {}),
          branch,
          left: left - 1,
        });
      }
      return null;
    },
  }),
};
const probeModules = { ...modules, './chainProbe.ts': async () => probe };

/** The head: opens its run with its tick, one branch per tier, each tier's first batch inline. */
async function head(ctx: ActionCtx, _args: unknown, tick?: CronTickContext) {
  plan.seenTick = tick;
  const opened = await openChainRun(ctx, tick, {
    job: JOB,
    detail: '3-day append',
    counts: { registry: 3_043 },
  });
  if ('busy' in opened) return { cronReport: { worked: false, detail: 'still running' } };
  const runId = opened.runId;
  for (let b = 0; b < plan.branches; b++) {
    await openChainBranch(ctx, runId);
    await ctx.runAction(batchRef, {
      ...(runId !== null ? { runId } : {}),
      branch: `b${b}`,
      left: plan.batches,
    });
  }
  const report = {
    worked: true,
    ...(runId !== null ? { runId } : {}),
    counts: { heads: 1 },
    lines: [{ kind: 'stage' as const, text: 'start', loggedAt: Date.now() }],
  };
  if (plan.headThrows) throw withCronReport(new Error('the head fell over'), report);
  return { cronReport: report };
}

const CHAIN_ENTRY: CronActionJob = {
  name: JOB,
  schedule: { daily: { hourUTC: 7, minuteUTC: 0 } },
  kind: 'action',
  fn: internal.imageryLive.poll,
  handler: head as CronActionJob['handler'],
  args: {},
  pipeline: 'weather',
  retention: SEASON_CRON_RETENTION,
  announces: true,
  record: 'every',
};
const OTHER_ENTRY: CronActionJob = { ...CHAIN_ENTRY, name: 'c other' };

const realCronJob = cronJobsModule.cronJob;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  Object.assign(plan, {
    branches: 2,
    batches: 3,
    throwsAt: null,
    errorAt: null,
    headThrows: false,
    seenTick: undefined,
    linesPerBatch: 2,
    ran: 0,
  });
  vi.spyOn(cronJobsModule, 'cronJob').mockImplementation((name) =>
    name === JOB ? CHAIN_ENTRY : name === OTHER_ENTRY.name ? OTHER_ENTRY : realCronJob(name),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const harness = () => convexTest(schema, probeModules);
type T = ReturnType<typeof harness>;

const runs = (t: T) => t.run((ctx) => ctx.db.query('cronRuns').collect());
const linesOf = (t: T, runId: Id<'cronRuns'>) =>
  t.run((ctx) =>
    ctx.db
      .query('runEvents')
      .withIndex('by_cron_run_seq', (q) => q.eq('cronRunId', runId))
      .collect(),
  );
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const tick = (t: T, extra: Record<string, unknown> = {}) =>
  t.action(internal.cronRuns.tickAction, { job: JOB, ...extra });
const open = async (t: T, job = JOB, startedAt = Date.now()) => {
  const r = await t.mutation(internal.cronRuns.openRun, { job, startedAt, trigger: 'cron' });
  if (r.runId === undefined) throw new Error('busy');
  return r.runId;
};
const step = (t: T, runId: Id<'cronRuns'>, args: Record<string, unknown> = {}) =>
  t.mutation(internal.cronRuns.chainStep, { runId, ...args });
/** An action context whose `runMutation` is the harness's. */
const asCtx = (t: T) =>
  ({
    runMutation: (ref: unknown, args: unknown) =>
      (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  }) as never;
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const warns = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

// ─── Through the dispatcher ─────────────────────────────────────────────────────────────────────

describe('a fan-out chain through the dispatcher is one run', () => {
  test('two branches of three batches: one row, summed and folded, closed when the last ends', async () => {
    const t = harness();
    await tick(t);
    // The head's tick is recorded, its first batches ran inline; the rest still wait.
    let [run] = await runs(t);
    expect(run?.chain).toMatchObject({ open: 2, steps: 2 });
    expect(run?.finishedAt).toBe(T0);
    vi.setSystemTime(T0 + 5 * MINUTE);
    await drain(t);
    const all = await runs(t);
    expect(all).toHaveLength(1);
    run = all[0];
    expect(run).toMatchObject({
      job: JOB,
      trigger: 'cron',
      outcome: 'ok',
      detail: '3-day append',
      startedAt: T0,
      chain: { open: 0, steps: 6, lines: 1 + 6 * 2 },
      counts: {
        registry: 3_043,
        heads: 1,
        cells: 240,
        cellsFailed: 6,
        fetchMsMax: 30,
        oldestOpenDay: 97,
      },
      keepUntil: T0 + 200 * DAY,
    });
    expect(run?.finishedAt).toBeGreaterThan(T0);
    expect(run?.causes).toEqual([
      {
        cause: 'timeout',
        count: 6,
        sampleKey: 'f:b0:3',
        // The provider's query string never reaches the record.
        sampleText: 'timed out https://api.example/v1',
        sampleAt: T0,
      },
    ]);
    const hb = await t.run((ctx) =>
      ctx.db
        .query('cronHeartbeats')
        .withIndex('by_job', (q) => q.eq('job', JOB))
        .first(),
    );
    expect(hb).toMatchObject({ lastOutcome: 'worked', lastRunId: run?._id });
    expect(hb?.runningSince).toBeUndefined();
    const lines = await linesOf(t, run?._id as Id<'cronRuns'>);
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(lines.every((l) => l.keepUntil === T0 + 30 * DAY)).toBe(true);
  });

  test('the handler is told its tick; a manual press carries its presser', async () => {
    const t = harness();
    await tick(t, { trigger: 'manual' });
    expect(plan.seenTick).toEqual({ job: JOB, startedAt: T0, trigger: 'manual' });
    expect(tickContextOf('j', 5, 'manual', 'p' as Id<'profiles'>)).toEqual({
      job: 'j',
      startedAt: 5,
      trigger: 'manual',
      byUserId: 'p',
    });
    expect((await runs(t))[0]).toMatchObject({ trigger: 'manual' });
  });

  test('a press while the chain is live is busy: no second run, the press a quiet tick', async () => {
    const t = harness();
    await tick(t);
    await tick(t, { trigger: 'manual' });
    const all = await runs(t);
    // The manual press always makes a run row (8b-2's rule); the chain is still the one chain.
    expect(all.filter((r) => r.chain !== undefined)).toHaveLength(1);
    expect(all.find((r) => r.chain === undefined)).toMatchObject({
      trigger: 'manual',
      detail: 'still running',
    });
  });

  test('a batch’s error closes the run failed only when its last branch ends', async () => {
    const t = harness();
    plan.errorAt = 'b0:2';
    await tick(t);
    // b0:2 is scheduled; run the first wave only.
    await t.finishInProgressScheduledFunctions();
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    let [run] = await runs(t);
    expect(run?.error).toBe('batch b0:2 wrote nothing');
    expect(run?.outcome).toBe('ok');
    expect(run?.chain?.open).toBeGreaterThan(0);
    await drain(t);
    [run] = await runs(t);
    expect(run).toMatchObject({ outcome: 'failed', chain: { open: 0, steps: 6 } });
  });

  test('a head that throws with its run open: the run takes its error, closes failed at the end', async () => {
    const t = harness();
    quiet();
    plan.headThrows = true;
    await expect(tick(t)).rejects.toThrow('the head fell over');
    await drain(t);
    const all = await runs(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      outcome: 'failed',
      error: 'the head fell over',
      chain: { open: 0, steps: 6 },
      counts: { heads: 1, cells: 240 },
    });
  });

  test('a batch that dies before its step: the run stays open, reads stopped, the next run kills it', async () => {
    const t = harness();
    quiet();
    plan.throwsAt = 'b1:2';
    await tick(t);
    await drain(t).catch(() => undefined);
    let [run] = await runs(t);
    expect(run?.chain).toMatchObject({ open: 1, steps: 4 });
    const progressAt = run?.chain?.progressAt as number;
    // A day on, the next cron tick opens its run: the dead one is closed killed at its last word.
    plan.throwsAt = null;
    vi.setSystemTime(T0 + DAY);
    await tick(t);
    await drain(t);
    const all = (await runs(t)).sort((a, b) => a.startedAt - b.startedAt);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      outcome: 'killed',
      finishedAt: progressAt,
      error: 'No word after step 4',
      chain: { open: 0, steps: 4 },
    });
    run = all[1];
    expect(run).toMatchObject({ outcome: 'ok', chain: { open: 0, steps: 6 } });
    const lines = await linesOf(t, all[0]?._id as Id<'cronRuns'>);
    expect(lines.at(-1)).toMatchObject({
      kind: 'fail',
      text: 'No word after step 4; closed when the next run began',
    });
  });

  test('a killed head is the chain’s row: begin closes its branch, never a second killed row', async () => {
    const t = harness();
    // A head that opened its run (and one branch) at T0 and died: its stamp and its run remain.
    const runId = await open(t, JOB, T0);
    await step(t, runId, { opened: 1 });
    await t.run((ctx) =>
      ctx.db.insert('cronHeartbeats', { job: JOB, runningSince: T0, runningTrigger: 'cron' }),
    );
    // Its branch is still live (a step a minute ago): begin closes the head's branch with an error.
    vi.setSystemTime(T0 + 20 * MINUTE);
    await step(t, runId, { closed: 1, opened: 1, counts: { cells: 40 } });
    vi.setSystemTime(T0 + 21 * MINUTE);
    quiet();
    await t.mutation(internal.cronRuns.begin, { job: JOB, startedAt: Date.now() });
    let all = await runs(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      outcome: 'ok',
      error: 'its first step never finished',
      chain: { open: 1, steps: 1 },
    });
    await step(t, runId, { closed: 1 });
    all = await runs(t);
    expect(all[0]).toMatchObject({ outcome: 'failed', chain: { open: 0, steps: 2 } });
    const hb = await t.run((ctx) => ctx.db.query('cronHeartbeats').first());
    expect(hb).toMatchObject({ lastOutcome: 'killed', lastRunId: runId });
  });

  test('a killed head whose whole chain stopped: the run is closed killed, still one row', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    await step(t, runId, { opened: 1 });
    await t.run((ctx) =>
      ctx.db.insert('cronHeartbeats', { job: JOB, runningSince: T0, runningTrigger: 'cron' }),
    );
    vi.setSystemTime(T0 + DAY);
    quiet();
    await t.mutation(internal.cronRuns.begin, { job: JOB, startedAt: Date.now() });
    const all = await runs(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'killed', finishedAt: T0, chain: { open: 0 } });
  });
});

// ─── The rules, one call at a time ──────────────────────────────────────────────────────────────

describe('openRun', () => {
  test('inserts the open run: the head’s branch, its counts, keepUntil from the entry', async () => {
    const t = harness();
    const r = await t.mutation(internal.cronRuns.openRun, {
      job: JOB,
      startedAt: T0,
      trigger: 'manual',
      detail: 'd'.repeat(2_000),
      season: 's'.repeat(50),
      counts: { registry: 3_043, 'bad key': 1 },
    });
    const run = await t.run((ctx) => ctx.db.get((r as { runId: Id<'cronRuns'> }).runId));
    expect(run).toMatchObject({
      outcome: 'ok',
      finishedAt: T0,
      trigger: 'manual',
      counts: { registry: 3_043 },
      chain: { open: 1, steps: 0, progressAt: T0, lines: 0 },
      keepUntil: T0 + 200 * DAY,
    });
    expect(run?.detail).toHaveLength(1_000);
    expect(run?.season).toHaveLength(32);
  });

  test('refuses a name that is not an action job', async () => {
    const t = harness();
    await expect(
      t.mutation(internal.cronRuns.openRun, { job: 'nope', startedAt: 1, trigger: 'manual' }),
    ).rejects.toThrow(/no cron named "nope"/);
  });

  test('busy while a step is inside the action limit and its minute; killed one past it', async () => {
    const t = harness();
    const first = await open(t, JOB, T0);
    for (const age of [0, 16 * MINUTE, CRON_KILLED_AFTER_MS]) {
      vi.setSystemTime(T0 + age);
      expect(
        await t.mutation(internal.cronRuns.openRun, {
          job: JOB,
          startedAt: Date.now(),
          trigger: 'manual',
        }),
      ).toEqual({ busy: first });
    }
    // 31 minutes and a millisecond: no batch can still be alive.
    vi.setSystemTime(T0 + CRON_KILLED_AFTER_MS + 1);
    const second = await open(t);
    const killed = await t.run((ctx) => ctx.db.get(first));
    expect(killed).toMatchObject({
      outcome: 'killed',
      finishedAt: T0,
      error: 'No word after step 0',
      chain: { open: 0, steps: 0, lines: 1 },
    });
    expect(second).not.toBe(first);
  });

  test('reads only the newest runs: an open chain older than them is left to the prune', async () => {
    const t = harness();
    const old = await open(t, JOB, T0 - 10 * DAY);
    for (let i = 0; i < OPEN_RUN_LOOKBACK; i++) {
      const at = T0 - (OPEN_RUN_LOOKBACK - i) * DAY;
      await t.run((ctx) =>
        ctx.db.insert('cronRuns', {
          job: JOB,
          startedAt: at,
          finishedAt: at,
          outcome: 'ok',
          trigger: 'cron',
          chain: { open: 0, steps: 1, progressAt: at, lines: 0 },
          keepUntil: T0 + DAY,
        }),
      );
    }
    await open(t);
    expect((await t.run((ctx) => ctx.db.get(old)))?.chain?.open).toBe(1);
  });

  test('rows that are not chains (presses skipped as busy) never hide a live chain', async () => {
    const t = harness();
    const live = await open(t, JOB, T0);
    // More skipped presses than the lookback, each a manual tick's run row of its own.
    for (let i = 1; i <= OPEN_RUN_LOOKBACK + 2; i++) {
      await t.run((ctx) =>
        ctx.db.insert('cronRuns', {
          job: JOB,
          startedAt: T0 + i * MINUTE,
          finishedAt: T0 + i * MINUTE,
          outcome: 'ok',
          trigger: 'manual',
          detail: 'A run of this job is already going',
          keepUntil: T0 + DAY,
        }),
      );
    }
    vi.setSystemTime(T0 + 10 * MINUTE);
    expect(
      await t.mutation(internal.cronRuns.openRun, {
        job: JOB,
        startedAt: Date.now(),
        trigger: 'manual',
      }),
    ).toEqual({ busy: live });
  });

  test('another job’s open run never makes this one busy', async () => {
    const t = harness();
    await open(t, OTHER_ENTRY.name);
    await expect(open(t)).resolves.toBeDefined();
  });
});

describe('chainStep', () => {
  test('a step before the head’s finish, and after: either order, one run, one close', async () => {
    for (const order of ['batch first', 'head first'] as const) {
      const t = harness();
      const runId = await open(t, JOB, T0);
      await step(t, runId, { opened: 1 });
      const batch = () => step(t, runId, { closed: 1, counts: { cells: 40 } });
      const headFinish = () =>
        t.mutation(internal.cronRuns.finish, {
          job: JOB,
          trigger: 'cron',
          startedAt: T0,
          finishedAt: T0 + 1,
          report: { worked: true, runId, counts: { heads: 1 } },
        });
      if (order === 'batch first') {
        await batch();
        await headFinish();
      } else {
        await headFinish();
        await batch();
      }
      const all = await runs(t);
      expect(all, order).toHaveLength(1);
      expect(all[0], order).toMatchObject({
        outcome: 'ok',
        counts: { cells: 40, heads: 1 },
        chain: { open: 0, steps: 1 },
      });
    }
  });

  test('two branches closing at once close the run once', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    await step(t, runId, { opened: 2 });
    await step(t, runId, { closed: 1, head: true });
    vi.setSystemTime(T0 + MINUTE);
    await Promise.all([
      step(t, runId, { closed: 1, counts: { cells: 1 } }),
      step(t, runId, { closed: 1, counts: { cells: 2 } }),
    ]);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({
      outcome: 'ok',
      finishedAt: T0 + MINUTE,
      counts: { cells: 3 },
      chain: { open: 0, steps: 2 },
    });
  });

  test('a straggler on a killed run changes nothing and says so once', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    vi.setSystemTime(T0 + DAY);
    await open(t);
    const before = await t.run((ctx) => ctx.db.get(runId));
    const warn = warns();
    await step(t, runId, { closed: 1, counts: { cells: 40 }, lines: [] });
    expect(await t.run((ctx) => ctx.db.get(runId))).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/already closed \(killed\); nothing changed/);
  });

  test('a step on a run that is gone, or not a chain, changes nothing', async () => {
    const t = harness();
    const warn = warns();
    const runId = await open(t);
    await t.run((ctx) => ctx.db.delete(runId));
    await expect(step(t, runId, { closed: 1 })).resolves.toBeNull();
    const plain = await t.run((ctx) =>
      ctx.db.insert('cronRuns', {
        job: JOB,
        startedAt: T0,
        finishedAt: T0,
        outcome: 'ok',
        trigger: 'cron',
        keepUntil: T0 + DAY,
      }),
    );
    await step(t, plain, { closed: 1, counts: { cells: 1 } });
    expect((await t.run((ctx) => ctx.db.get(plain)))?.counts).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('branches are whole and bounded; a garbage open count can’t leave the run unclosable', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    await step(t, runId, { opened: 1e9 });
    expect((await t.run((ctx) => ctx.db.get(runId)))?.chain?.open).toBe(65);
    await step(t, runId, { closed: -4, opened: Number.NaN });
    await step(t, runId, { closed: 1e9 });
    expect((await t.run((ctx) => ctx.db.get(runId)))?.chain?.open).toBe(1);
    await step(t, runId, { closed: 1e9 });
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.chain).toMatchObject({ open: 0, steps: 2 });
  });

  test('the line cap: the first 200 and the newest 100 kept, the rest counted', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    await step(t, runId, { opened: 9 });
    for (let s = 0; s < 9; s++) {
      await step(t, runId, {
        closed: 1,
        lines: Array.from({ length: 50 }, (_, i) => ({
          kind: 'line',
          text: `s${s} l${i} ${'x'.repeat(600)}`,
          loggedAt: T0,
        })),
      });
    }
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.chain).toMatchObject({ lines: CHAIN_LINES_MAX, linesDropped: 150, steps: 9 });
    const lines = await linesOf(t, runId);
    expect(lines).toHaveLength(CHAIN_LINES_MAX);
    expect(lines.slice(0, CHAIN_LINES_HEAD).map((l) => l.seq)).toEqual(
      Array.from({ length: CHAIN_LINES_HEAD }, (_, i) => i),
    );
    expect(lines.slice(CHAIN_LINES_HEAD).map((l) => l.seq)).toEqual(
      Array.from({ length: CHAIN_LINES_TAIL }, (_, i) => 350 + i),
    );
    expect(lines.at(-1)?.text.startsWith('s8 l49')).toBe(true);
    expect(lines.every((l) => l.text.length <= 500)).toBe(true);
  });

  test('causes fold to one entry per cause with the first sample; nine at most', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    const causes = [
      'timeout',
      'rateLimit',
      'serverError',
      'refused',
      'unreachable',
      'badAnswer',
      'emptyAnswer',
      'writeFailed',
      'other',
    ].map((cause, i) => ({ cause, count: 2, sampleText: `${cause} first`, sampleAt: i }));
    await step(t, runId, { causes });
    await step(t, runId, {
      causes: causes.map((c) => ({ ...c, sampleText: 'later', sampleKey: 'k' })),
    });
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.causes).toHaveLength(9);
    expect(run?.causes?.every((c) => c.count === 4 && c.sampleText.endsWith('first'))).toBe(true);
    expect(run?.causes?.every((c) => c.sampleKey === undefined)).toBe(true);
  });

  test('a head-only close never counts a batch; a capped head is the run’s outcome', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    await t.mutation(internal.cronRuns.finish, {
      job: JOB,
      trigger: 'cron',
      startedAt: T0,
      finishedAt: T0,
      report: { worked: true, outcome: 'capped', runId },
    });
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      outcome: 'capped',
      chain: { open: 0, steps: 0 },
    });
  });

  test('a head that reports failure with no throw closes its run failed with its detail', async () => {
    const t = harness();
    const runId = await open(t, JOB, T0);
    await t.mutation(internal.cronRuns.finish, {
      job: JOB,
      trigger: 'cron',
      startedAt: T0,
      finishedAt: T0,
      report: { worked: false, outcome: 'failed', detail: 'no registry', runId },
    });
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      outcome: 'failed',
      error: 'no registry',
    });
  });
});

describe('the recorder’s merge', () => {
  test('a run id that isn’t this job’s open chain falls back to a row of the tick’s own', async () => {
    const t = harness();
    const warn = warns();
    const other = await open(t, OTHER_ENTRY.name, T0);
    for (const runId of ['not-an-id', other]) {
      await t.mutation(internal.cronRuns.finish, {
        job: JOB,
        trigger: 'cron',
        startedAt: T0,
        finishedAt: T0,
        report: { worked: true, runId, counts: { did: 1 } },
      });
    }
    const all = await runs(t);
    expect(all.filter((r) => r.job === JOB)).toHaveLength(2);
    expect(all.filter((r) => r.job === JOB).every((r) => r.chain === undefined)).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(other)))?.chain?.open).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('a mutation job can’t merge: its report’s run id is dropped, its row its own', async () => {
    vi.spyOn(cronJobsModule, 'cronJob').mockImplementation((name) =>
      name === 'm job'
        ? {
            name,
            schedule: { every: { minutes: 1 } },
            kind: 'mutation',
            fn: makeFunctionReference<'mutation'>('chainProbe:m') as never,
            args: {},
            pipeline: 'hygiene',
            retention: CRON_RETENTION,
            record: 'every',
          }
        : realCronJob(name),
    );
    const said: { runId?: Id<'cronRuns'> } = {};
    const t = convexTest(schema, {
      ...probeModules,
      './chainProbe.ts': async () => ({
        ...probe,
        m: internalMutation({
          args: {},
          handler: async () => ({ cronReport: { worked: true, runId: said.runId } }),
        }),
      }),
    });
    // An open chain of the mutation job's own name: the one a merge would find.
    said.runId = await t.run((ctx) =>
      ctx.db.insert('cronRuns', {
        job: 'm job',
        startedAt: T0,
        finishedAt: T0,
        outcome: 'ok',
        trigger: 'cron',
        chain: { open: 1, steps: 0, progressAt: T0, lines: 0 },
        keepUntil: T0 + DAY,
      }),
    );
    await t.mutation(internal.cronRuns.tickMutation, { job: 'm job' });
    const rows = await runs(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r._id === said.runId)?.chain?.open).toBe(1);
  });

  test('a plain report’s causes are kept on its own row, made writable', async () => {
    const t = harness();
    await t.mutation(internal.cronRuns.finish, {
      job: JOB,
      trigger: 'cron',
      startedAt: T0,
      finishedAt: T0,
      report: {
        worked: true,
        causes: [
          {
            cause: 'rateLimit',
            count: 2.7,
            sampleText: 'HTTP 429 at https://x/y?key=1',
            sampleAt: 1,
          },
          { cause: 'rateLimit', count: 1, sampleText: 'second', sampleAt: 2 },
        ],
      },
    });
    expect((await runs(t))[0]?.causes).toEqual([
      { cause: 'rateLimit', count: 3, sampleText: 'HTTP 429 at https://x/y', sampleAt: 1 },
    ]);
  });

  test('readCauses: anything an action returns is made writable', () => {
    expect(readCauses('no', 1)).toBeUndefined();
    expect(readCauses([], 1)).toBeUndefined();
    expect(
      readCauses(
        [
          null,
          { cause: 'nope', count: -1, sampleKey: 'k'.repeat(500), sampleAt: Number.NaN },
          { cause: 'timeout', count: Number.POSITIVE_INFINITY, sampleText: '' },
        ],
        9,
      ),
    ).toEqual([
      { cause: 'timeout', count: 0, sampleText: 'timeout', sampleAt: 9 },
      { cause: 'other', count: 0, sampleKey: 'k'.repeat(120), sampleText: 'other', sampleAt: 9 },
    ]);
  });
});

// ─── The recorder failing never fails the job ───────────────────────────────────────────────────

describe('when the recorder throws, the job goes on', () => {
  test('openRun throws: the chain runs unrecorded as a chain; the head’s tick is its own row', async () => {
    const t = harness();
    const err = quiet();
    // openRun refuses a name the registry doesn't hold: the head asks for its run under "nope".
    const original = CHAIN_ENTRY.handler;
    CHAIN_ENTRY.handler = (async (ctx: ActionCtx, args: unknown, tk?: CronTickContext) =>
      head(ctx, args, tk && { ...tk, job: 'nope' })) as CronActionJob['handler'];
    try {
      await tick(t);
      await drain(t);
    } finally {
      CHAIN_ENTRY.handler = original;
    }
    const all = await runs(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ job: JOB, outcome: 'ok', counts: { heads: 1 } });
    expect(all[0]?.chain).toBeUndefined();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/openRun failed, running unrecorded/);
    // Every batch still ran and scheduled its next.
    expect(plan.ran).toBe(6);
  });

  test('chainStep throws mid-chain: the batch still schedules its next; the run reads one short', async () => {
    const t = harness();
    const err = quiet();
    const realStep = internal.cronRuns.chainStep;
    let calls = 0;
    const ctx = {
      runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
        calls++;
        if (calls === 1) throw new Error('recorder down');
        return t.mutation(realStep, args as never);
      },
    };
    const runId = await open(t, JOB, T0);
    await chainStepSafely(ctx as never, runId, { opened: 1 });
    await chainStepSafely(ctx as never, runId, { closed: 1, counts: { cells: 40 } });
    expect(String(err.mock.calls[0]?.[0])).toMatch(/chainStep failed on run .*the work goes on/);
    // The lost step opened a branch: the batch's close then took the head's, and the run closed
    // early — its counts kept, a later step a straggler, never an error to the job.
    const run = await t.run((c) => c.db.get(runId));
    expect(run).toMatchObject({ counts: { cells: 40 }, chain: { open: 0 } });
    warns();
    await expect(closeChainHead(ctx as never, runId)).resolves.toBeUndefined();
  });

  test('no run: every call is a no-op; a head with no tick opens a manual run of its own', async () => {
    const t = harness();
    const ctx = { runMutation: vi.fn() };
    await chainStepSafely(ctx as never, null, { closed: 1 });
    await openChainBranch(ctx as never, undefined);
    expect(ctx.runMutation).not.toHaveBeenCalled();
    const opened = await openChainRun(asCtx(t), undefined, { job: JOB, season: 'winter-2026-27' });
    expect('runId' in opened && opened.runId !== null).toBe(true);
    const runId = (opened as { runId: Id<'cronRuns'> }).runId;
    await closeChainHead(asCtx(t), runId, { counts: { scanned: 5 } });
    expect(await t.run((c) => c.db.get(runId))).toMatchObject({
      trigger: 'manual',
      season: 'winter-2026-27',
      counts: { scanned: 5 },
      chain: { open: 0, steps: 0 },
    });
    expect((await t.run((c) => c.db.get(runId)))?.byUserId).toBeUndefined();
  });
});

// ─── A lost write conflict is sent again; nothing else is ───────────────────────────────────────

/** Convex's words for a mutation that lost its write conflict on every one of its own retries. */
const CONFLICT = new Error(
  'Documents read from or written to the "cronRuns" table changed while this mutation was being run and on every subsequent retry.',
);

describe('write conflicts (measured on a local backend: branches stepping on one row at once)', () => {
  test('a lost conflict is sent again with a backoff; any other error is not', async () => {
    let calls = 0;
    const flaky = () => {
      calls++;
      return calls < 3 ? Promise.reject(CONFLICT) : Promise.resolve('ok');
    };
    const p = retryOnWriteConflict(flaky);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    const other = () => {
      calls++;
      return Promise.reject(new Error('reply lost'));
    };
    await expect(retryOnWriteConflict(other)).rejects.toThrow('reply lost');
    expect(calls).toBe(1);

    calls = 0;
    const always = () => {
      calls++;
      return Promise.reject(CONFLICT);
    };
    const q = retryOnWriteConflict(always).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(await q).toBe(CONFLICT);
    expect(calls).toBe(CHAIN_STEP_ATTEMPTS);
  });

  test('a step that keeps losing is given up once, logged, never thrown at the job', async () => {
    const err = quiet();
    const ctx = { runMutation: vi.fn(() => Promise.reject(CONFLICT)) };
    const p = chainStepSafely(ctx as never, 'r' as Id<'cronRuns'>, { closed: 1 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(ctx.runMutation).toHaveBeenCalledTimes(CHAIN_STEP_ATTEMPTS);
    expect(err).toHaveBeenCalledTimes(1);
  });

  test('a chained head’s finish that loses a conflict is sent again: the run still closes', async () => {
    const t = harness();
    plan.branches = 1;
    plan.batches = 1;
    const real = recorder.recordTick;
    let lost = false;
    vi.spyOn(recorder, 'recordTick').mockImplementation(async (ctx, entry, tk) => {
      if (entry.name === JOB && !lost) {
        lost = true;
        throw CONFLICT;
      }
      return await real(ctx, entry, tk);
    });
    const p = tick(t);
    await vi.runAllTimersAsync();
    await p;
    const [run] = await runs(t);
    expect(lost).toBe(true);
    expect(run).toMatchObject({ outcome: 'ok', chain: { open: 0, steps: 1 } });
  });

  test('any other job’s finish is sent once, as before the chain', async () => {
    const t = convexTest(schema, probeModules);
    const err = quiet();
    vi.spyOn(cronJobsModule, 'cronJob').mockImplementation((name) =>
      name === 'c plain'
        ? {
            ...CHAIN_ENTRY,
            name,
            handler: (async () => ({ cronReport: { worked: true } })) as CronActionJob['handler'],
          }
        : realCronJob(name),
    );
    const record = vi.spyOn(recorder, 'recordTick').mockRejectedValue(CONFLICT);
    await t.action(internal.cronRuns.tickAction, { job: 'c plain' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/finish failed, the tick is unrecorded/);
  });
});
