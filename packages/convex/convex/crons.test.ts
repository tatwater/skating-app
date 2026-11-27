/**
 * **The recorder** (D343, D347, B01-8b): the guards that keep every cron on it, and what it writes
 * for each kind of tick and each order of failure. `cronJobs.test.ts` pins the registry itself.
 *
 * Synthetic jobs live in a probe module that exists only in this file's module map (`./cronProbe.ts`)
 * and reach the dispatchers through a spy on the registry's lookup, so the dispatchers under test
 * are the real ones. Reads no repo file (it imports modules), so it stays in the cached suite.
 */

import { CRON_TICK_CODES, unpackTick } from '@skating/core';
import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import { type ActionCtx, internalMutation, type MutationCtx } from './_generated/server';
import * as cronJobsModule from './cronJobs';
import {
  CRON_JOBS,
  CRON_RETENTION,
  type CronActionJob,
  type CronJobEntry,
  type CronMutationJob,
  SEASON_CRON_RETENTION,
} from './cronJobs';
import { COPY_PAGE, PRUNE_PAGE } from './cronRunJobs';
import {
  bucketMsOf,
  KILLED_AFTER_MS,
  RECORDER_RESERVE,
  readReport,
  recorder,
  TICK_ROW_MAX,
  trimText,
} from './cronRuns';
import crons from './crons';
import { IMAGERY_CRON_JOBS } from './imageryLive';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Mid-hour, so a few minutes on is the same UTC hour. */
const T0 = Date.UTC(2026, 11, 3, 14, 20, 0);
/** The recorder itself, captured before any spy wraps it. */
const realRecord = recorder.recordTick;

// ─── The probe module: synthetic jobs ───────────────────────────────────────────────────────────

/** A row a job writes, to see whether its writes survived. */
const mark = (ctx: MutationCtx, key = 'probe') =>
  ctx.db.insert('dailyThrottle', { key, lastOn: '2026-12-03' });

/** Distinct `eq` ranges, each charged one: a job spending its range budget. */
async function readRanges(ctx: MutationCtx, n: number) {
  for (let i = 0; i < n; i++) {
    await ctx.db
      .query('cronHeartbeats')
      .withIndex('by_job', (q) => q.eq('job', `r${i}`))
      .first();
  }
}

const probeActions = {
  quiet: async (_ctx: ActionCtx) => ({ nothing: true }),
  throws: async (ctx: ActionCtx) => {
    await ctx.runMutation(internal.imageryLive.markIndexDirty, {});
    throw new Error('the action failed');
  },
  worked: async () => ({ cronReport: { worked: true, counts: { did: 3 }, detail: 'did three' } }),
};

const probe = {
  quiet: internalMutation({ args: {}, handler: async () => ({ done: 0 }) }),
  throws: internalMutation({
    args: {},
    handler: async (ctx) => {
      await mark(ctx);
      throw new Error('the job failed');
    },
  }),
  marks: internalMutation({
    args: {},
    handler: async (ctx) => {
      await mark(ctx);
      return null;
    },
  }),
  worked: internalMutation({
    args: {},
    handler: async (ctx) => {
      await mark(ctx);
      return {
        cronReport: {
          worked: true,
          detail: 'x'.repeat(5_000),
          // A Convex value (its return must be one), but no field name for a run's counts.
          counts: { kept: 2, 'has space': 1, '9lead': 3, nan: Number.NaN },
          season: 'winter-2026-27',
          lines: Array.from({ length: 250 }, (_, i) => ({
            kind: i === 0 ? 'stage' : i === 1 ? 'bogus' : 'line',
            text: i === 2 ? 'y'.repeat(900) : `line ${i}`,
            loggedAt: T0 + i,
          })),
        },
      };
    },
  }),
  reportsFailure: internalMutation({
    args: {},
    handler: async () => ({ cronReport: { worked: false, outcome: 'failed', detail: 'no' } }),
  }),
  /** Spends its range budget to the edge, exactly: every range it may read, and no more. */
  edge: internalMutation({
    args: {},
    handler: async (ctx) => {
      const left = (await ctx.meta.getTransactionMetrics()).databaseQueries.remaining;
      await mark(ctx);
      await readRanges(ctx, left);
      return null;
    },
  }),
  /** Ignores its budget: reads the whole transaction's ranges, past the recorder's reserve. */
  pastReserve: internalMutation({
    args: {},
    handler: async (ctx) => {
      await mark(ctx);
      await readRanges(ctx, 4_096);
      return null;
    },
  }),
  /** Writes to its write budget's edge, then one more. */
  pastWrites: internalMutation({
    args: {},
    handler: async (ctx) => {
      const left = (await ctx.meta.getTransactionMetrics()).documentsWritten.remaining;
      for (let i = 0; i <= left; i++) await mark(ctx, `w${i}`);
      return null;
    },
  }),
  /** Writes down the budget it was given, as it sees it. */
  budget: internalMutation({
    args: {},
    handler: async (ctx) => {
      const m = await ctx.meta.getTransactionMetrics();
      await mark(ctx, `ranges ${m.databaseQueries.remaining}`);
      await mark(ctx, `writes ${m.documentsWritten.remaining}`);
      return null;
    },
  }),
};

const probeModules = { ...modules, './cronProbe.ts': async () => probe };

function mutationJob(
  name: string,
  fn: keyof typeof probe,
  extra: Partial<CronMutationJob> = {},
): CronMutationJob {
  return {
    name,
    schedule: { every: { minutes: 1 } },
    kind: 'mutation',
    fn: makeFunctionReference<'mutation'>(`cronProbe:${fn}`) as FunctionReference<
      'mutation',
      'internal'
    >,
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    record: 'every',
    ...extra,
  };
}

function actionJob(
  name: string,
  handler: keyof typeof probeActions,
  extra: Partial<CronActionJob> = {},
): CronActionJob {
  return {
    name,
    schedule: { every: { minutes: 5 } },
    kind: 'action',
    fn: internal.imageryLive.poll,
    handler: probeActions[handler] as CronActionJob['handler'],
    args: {},
    pipeline: 'hygiene',
    retention: CRON_RETENTION,
    announces: true,
    record: 'every',
    ...extra,
  };
}

const PROBES: CronJobEntry[] = [
  mutationJob('p quiet', 'quiet'),
  mutationJob('p sparse', 'quiet', { record: 'sparse' }),
  mutationJob('p daily', 'quiet', { schedule: { every: { hours: 1 } } }),
  mutationJob('p throws', 'throws'),
  mutationJob('p marks', 'marks'),
  mutationJob('p worked', 'worked', { retention: SEASON_CRON_RETENTION }),
  mutationJob('p reports failure', 'reportsFailure'),
  mutationJob('p edge', 'edge'),
  mutationJob('p past reserve', 'pastReserve'),
  mutationJob('p past writes', 'pastWrites'),
  mutationJob('p budget', 'budget'),
  actionJob('a quiet', 'quiet'),
  actionJob('a throws', 'throws'),
  actionJob('a worked', 'worked'),
  actionJob('a silent', 'quiet', { announces: false }),
];
const probeByName = new Map<string, CronJobEntry>();

const realCronJob = cronJobsModule.cronJob;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  probeByName.clear();
  for (const p of PROBES) probeByName.set(p.name, p);
  vi.spyOn(cronJobsModule, 'cronJob').mockImplementation(
    (name) => probeByName.get(name) ?? realCronJob(name),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tickM = (t: T, job: string, extra: Record<string, unknown> = {}) =>
  t.mutation(internal.cronRuns.tickMutation, { job, ...extra });
const tickA = (t: T, job: string, extra: Record<string, unknown> = {}) =>
  t.action(internal.cronRuns.tickAction, { job, ...extra });

const all = (t: T) =>
  t.run(async (ctx) => ({
    heartbeats: await ctx.db.query('cronHeartbeats').collect(),
    ticks: await ctx.db.query('cronTicks').collect(),
    runs: await ctx.db.query('cronRuns').collect(),
    lines: await ctx.db.query('runEvents').collect(),
    marks: await ctx.db.query('dailyThrottle').collect(),
  }));
const heartbeat = async (t: T, job: string) =>
  (await all(t)).heartbeats.find((h) => h.job === job) ?? null;
const ticksOf = async (t: T, job: string) =>
  (await all(t)).ticks
    .filter((r) => r.job === job)
    .flatMap((r) => r.ticks.map((p) => ({ ...unpackTick(p), bucketStart: r.bucketStart })));

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

// ─── The guards ─────────────────────────────────────────────────────────────────────────────────

describe('every cron runs through the recorder', () => {
  test('the registrations are the registry’s (the guard on a bare crons.interval is cronJobs.test)', () => {
    const registered = (crons as unknown as { crons: Record<string, unknown> }).crons;
    expect(Object.keys(registered)).toEqual(CRON_JOBS.map((j) => j.name));
    expect(Object.keys(registered)).toHaveLength(53);
  });

  test("each action entry's handler is the body its function is registered with", async () => {
    for (const entry of CRON_JOBS) {
      if (entry.kind !== 'action') continue;
      const [file, name] = getFunctionName(entry.fn).split(':') as [string, string];
      const mod = (await modules[`./${file}.ts`]?.()) as Record<string, unknown>;
      expect(mod[`${name}Handler`], `${entry.name}: ${file}.${name}Handler`).toBe(entry.handler);
      // Convex keeps the registered body on the function (`_handler`): the same function.
      expect((mod[name] as { _handler: unknown })._handler, entry.name).toBe(entry.handler);
    }
  });

  test("each entry's arguments are ones its function's validator declares", async () => {
    for (const entry of CRON_JOBS) {
      const [file, name] = getFunctionName(entry.fn).split(':') as [string, string];
      const mod = (await modules[`./${file}.ts`]?.()) as Record<
        string,
        { exportArgs: () => string }
      >;
      const validator = JSON.parse(mod[name]?.exportArgs() ?? '{}') as {
        type: string;
        value: Record<string, unknown>;
      };
      expect(validator.type, entry.name).toBe('object');
      for (const key of Object.keys(entry.args)) {
        expect(Object.keys(validator.value), `${entry.name}: ${key}`).toContain(key);
      }
    }
  });

  test('the imagery jobs’ names are the registry’s, on their own functions', () => {
    const fnOf = (name: string) => getFunctionName(realCronJob(name)?.fn as never);
    expect(fnOf(IMAGERY_CRON_JOBS.poll)).toBe('imageryLive:poll');
    expect(fnOf(IMAGERY_CRON_JOBS.pump)).toBe('imageryLive:pump');
    expect(fnOf(IMAGERY_CRON_JOBS.index)).toBe('imageryLive:buildIndex');
  });

  /**
   * Every entry once through its dispatcher on an empty database (the network is the suite's offline
   * stub; no credential is set): each records exactly one tick under its own name, whatever the job
   * made of it — `bodyGeo.computeDue`'s two entries each under theirs.
   */
  test.each(CRON_JOBS.map((e) => [e.name, e] as const))('%s records one tick', async (name, e) => {
    const t = convexTest(schema, modules);
    quiet();
    if (e.kind === 'mutation') await tickM(t, name);
    else await tickA(t, name).catch(() => undefined);
    const s = await all(t);
    expect(s.heartbeats.map((h) => h.job)).toEqual([name]);
    expect(s.heartbeats[0]?.lastTickAt).toBe(T0);
    expect(s.heartbeats[0]?.runningSince).toBeUndefined();
    expect(await ticksOf(t, name)).toHaveLength(1);
  });
});

// ─── What a tick writes ─────────────────────────────────────────────────────────────────────────

describe('a quiet tick', () => {
  test('a heartbeat and one tick, no run row', async () => {
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p quiet');
    const s = await all(t);
    expect(s.runs).toEqual([]);
    expect(s.heartbeats).toEqual([
      expect.objectContaining({
        job: 'p quiet',
        lastTickAt: T0,
        lastOutcome: 'ok',
        lastOkAt: T0,
        lastMs: 0,
      }),
    ]);
    const bucketStart = Math.floor(T0 / HOUR) * HOUR;
    expect(s.ticks).toEqual([
      expect.objectContaining({
        bucketStart,
        bucketMs: HOUR,
        ms: [0],
        keepUntil: bucketStart + HOUR + 35 * DAY,
      }),
    ]);
    expect(unpackTick(s.ticks[0]?.ticks[0] ?? -1)).toEqual({
      offsetSec: 20 * 60,
      code: CRON_TICK_CODES.ok,
    });
  });

  test('ticks append to the hour’s row; a job ticking every 30 minutes or less often gets a day’s', async () => {
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p quiet');
    vi.setSystemTime(T0 + 60_000);
    await tickM(t, 'p quiet');
    vi.setSystemTime(T0 + HOUR);
    await tickM(t, 'p quiet');
    const rows = (await all(t)).ticks.filter((r) => r.job === 'p quiet');
    expect(rows.map((r) => r.ticks.length)).toEqual([2, 1]);
    await tickM(t, 'p daily');
    expect((await all(t)).ticks.find((r) => r.job === 'p daily')).toMatchObject({
      bucketMs: DAY,
      bucketStart: Math.floor((T0 + HOUR) / DAY) * DAY,
    });
    expect(bucketMsOf(realCronJob('repair body geometry drift') as CronJobEntry)).toBe(DAY);
    expect(bucketMsOf(realCronJob('reset lapsed suspensions') as CronJobEntry)).toBe(HOUR);
  });

  test('a row holds at most TICK_ROW_MAX ticks; the heartbeat still moves', async () => {
    const t = convexTest(schema, probeModules);
    await t.run((ctx) =>
      ctx.db.insert('cronTicks', {
        job: 'p quiet',
        bucketStart: Math.floor(T0 / HOUR) * HOUR,
        bucketMs: HOUR,
        ticks: Array(TICK_ROW_MAX).fill(0),
        ms: Array(TICK_ROW_MAX).fill(0),
        keepUntil: T0 + DAY,
      }),
    );
    await tickM(t, 'p quiet');
    expect((await all(t)).ticks[0]?.ticks).toHaveLength(TICK_ROW_MAX);
    expect((await heartbeat(t, 'p quiet'))?.lastTickAt).toBe(T0);
  });
});

describe('a tick that worked: its run row and its log', () => {
  test('the report’s counts, detail, season and lines, made writable', async () => {
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p worked');
    const s = await all(t);
    expect(s.runs).toHaveLength(1);
    const run = s.runs[0];
    expect(run).toMatchObject({
      job: 'p worked',
      outcome: 'ok',
      trigger: 'cron',
      season: 'winter-2026-27',
      counts: { kept: 2 },
      keepUntil: T0 + 200 * DAY,
    });
    expect(run?.detail).toHaveLength(1_000);
    expect(s.lines).toHaveLength(200);
    expect(s.lines.every((l) => l.cronRunId === run?._id && l.runId === undefined)).toBe(true);
    expect(s.lines.map((l) => l.seq)).toEqual([...Array(200).keys()]);
    expect(s.lines[0]).toMatchObject({ kind: 'stage', loggedAt: T0, keepUntil: T0 + 30 * DAY });
    expect(s.lines[1]?.kind).toBe('line');
    expect(s.lines[2]?.text).toHaveLength(500);
    expect(await heartbeat(t, 'p worked')).toMatchObject({
      lastOutcome: 'worked',
      lastRunId: run?._id,
    });
    expect((await ticksOf(t, 'p worked'))[0]?.code).toBe(CRON_TICK_CODES.worked);
    expect(s.marks).toHaveLength(1);
  });

  test('a report of failure is a failed run though it did no work', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    await tickM(t, 'p reports failure');
    const s = await all(t);
    expect(s.runs[0]).toMatchObject({ outcome: 'failed', detail: 'no' });
    expect(s.heartbeats[0]).toMatchObject({ lastOutcome: 'failed', lastError: 'no' });
  });

  test('a manual press is a run with who pressed it, even when it found nothing to do', async () => {
    const t = convexTest(schema, probeModules);
    const who = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'u',
        displayName: 'u',
        username: 'u',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyAnswered: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
          moderatorDecision: false,
        },
        dateOfBirth: 0,
        reputationPoints: 0,
        role: 'admin',
        status: 'active',
        createdAt: 0,
      } as never),
    );
    await tickM(t, 'p quiet', { trigger: 'manual', byUserId: who });
    await tickA(t, 'a quiet', { trigger: 'manual', byUserId: who });
    const runs = (await all(t)).runs;
    expect(runs.map((r) => [r.job, r.outcome, r.trigger, r.byUserId])).toEqual([
      ['p quiet', 'ok', 'manual', who],
      ['a quiet', 'ok', 'manual', who],
    ]);
    expect((await heartbeat(t, 'p quiet'))?.lastOutcome).toBe('ok');
  });
});

describe('readReport', () => {
  test('no report is a quiet tick; anything else is made writable', () => {
    expect(readReport(null, 0)).toBeNull();
    expect(readReport(3, 0)).toBeNull();
    expect(readReport({ done: 1 }, 0)).toBeNull();
    expect(readReport({ cronReport: null }, 0)).toBeNull();
    expect(readReport({ cronReport: {} }, 0)).toEqual({ worked: false });
    expect(
      readReport(
        {
          cronReport: {
            worked: 'yes',
            outcome: 'sideways',
            detail: '',
            counts: {
              $bad: 1,
              ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])),
            },
            lines: [null, { text: 5, loggedAt: Number.NaN }],
          },
        },
        7,
      ),
    ).toEqual({
      worked: false,
      counts: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, i])),
      lines: [{ kind: 'line', text: '5', loggedAt: 7 }],
    });
  });

  test('trimText never cuts through a surrogate pair', () => {
    expect(trimText('ab😀', 3)).toBe('ab');
    expect(trimText('abc', 3)).toBe('abc');
    expect(trimText('abcd', 3)).toBe('abc');
  });
});

// ─── The failure orders ─────────────────────────────────────────────────────────────────────────

describe('a mutation job that throws', () => {
  test('its writes roll back as before; the tick is recorded failed with its message', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    await expect(tickM(t, 'p throws')).resolves.toBeNull();
    const s = await all(t);
    expect(s.marks).toEqual([]);
    expect(s.runs).toEqual([
      expect.objectContaining({ outcome: 'failed', error: 'the job failed', trigger: 'cron' }),
    ]);
    expect(s.heartbeats[0]).toMatchObject({
      lastOutcome: 'failed',
      lastFailedAt: T0,
      lastError: 'the job failed',
      lastRunId: s.runs[0]?._id,
    });
    expect(s.heartbeats[0]?.lastOkAt).toBeUndefined();
    expect((await ticksOf(t, 'p throws'))[0]?.code).toBe(CRON_TICK_CODES.failed);
  });
});

describe('the transaction’s edge, and the reserve', () => {
  test('the job is given what the transaction has left, less the reserve', async () => {
    const direct = convexTest(schema, probeModules);
    await direct.mutation(makeFunctionReference<'mutation'>('cronProbe:budget'), {});
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p budget');
    const keys = async (c: T) => (await all(c)).marks.map((m) => m.key).sort();
    const [dRanges, dWrites] = (await keys(direct)).map((k) => Number(k.split(' ')[1]));
    const [ranges, writes] = (await keys(t)).map((k) => Number(k.split(' ')[1]));
    expect(ranges).toBe((dRanges ?? 0) - RECORDER_RESERVE.databaseQueries);
    expect(writes).toBe((dWrites ?? 0) - RECORDER_RESERVE.documentsWritten);
  });

  test('a job that spends its budget to the edge is ok, and the recorder commits', async () => {
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p edge');
    const s = await all(t);
    expect(s.heartbeats[0]).toMatchObject({ job: 'p edge', lastOutcome: 'ok' });
    expect(s.marks).toHaveLength(1);
  });

  test('a job past the reserve fails inside its own transaction; the recorder commits', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    await expect(tickM(t, 'p past reserve')).resolves.toBeNull();
    const s = await all(t);
    expect(s.marks).toEqual([]);
    expect(s.heartbeats[0]).toMatchObject({ job: 'p past reserve', lastOutcome: 'failed' });
    expect(s.heartbeats[0]?.lastError).toMatch(/Too many index ranges/);
    expect(s.runs[0]?.outcome).toBe('failed');
  });

  test('a job past its writes fails alone; the recorder still writes', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    await expect(tickM(t, 'p past writes')).resolves.toBeNull();
    const s = await all(t);
    expect(s.marks).toEqual([]);
    expect(s.heartbeats[0]?.lastError).toMatch(/Wrote too many documents/);
  });
});

describe('the recorder throws after the job succeeded', () => {
  test('the job’s writes commit; the tick goes unrecorded and is logged', async () => {
    const t = convexTest(schema, probeModules);
    const err = quiet();
    vi.spyOn(recorder, 'recordTick').mockRejectedValueOnce(new Error('recorder down'));
    await expect(tickM(t, 'p marks')).resolves.toBeNull();
    const s = await all(t);
    expect(s.marks).toHaveLength(1);
    expect(s.heartbeats).toEqual([]);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/the recorder failed, the job's work is kept/);
  });
});

describe('an action job', () => {
  test('quiet: begin stamps runningSince, finish records and clears it', async () => {
    const t = convexTest(schema, probeModules);
    const seen: (number | undefined)[] = [];
    vi.spyOn(recorder, 'recordTick').mockImplementation(async (ctx, entry, tick) => {
      const hb = await ctx.db
        .query('cronHeartbeats')
        .withIndex('by_job', (q) => q.eq('job', entry.name))
        .first();
      seen.push(hb?.runningSince);
      return await realRecord(ctx, entry, tick);
    });
    await tickA(t, 'a quiet');
    expect(seen).toEqual([T0]);
    const hb = await heartbeat(t, 'a quiet');
    expect(hb).toMatchObject({ lastOutcome: 'ok', lastTickAt: T0 });
    expect(hb?.runningSince).toBeUndefined();
    expect((await all(t)).runs).toEqual([]);
  });

  test('that throws: recorded failed, then rethrown; its own writes are kept', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    await expect(tickA(t, 'a throws')).rejects.toThrow('the action failed');
    expect((await all(t)).runs[0]).toMatchObject({ outcome: 'failed', error: 'the action failed' });
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: T0 + HOUR })).not.toBeNull();
  });

  test('a report makes its run row', async () => {
    const t = convexTest(schema, probeModules);
    await tickA(t, 'a worked');
    expect((await all(t)).runs[0]).toMatchObject({ counts: { did: 3 }, detail: 'did three' });
  });

  test('a non-announcing action never stamps runningSince', async () => {
    const t = convexTest(schema, probeModules);
    const seen: (number | undefined)[] = [];
    vi.spyOn(recorder, 'recordTick').mockImplementation(async (ctx, entry, tick) => {
      const hb = await ctx.db
        .query('cronHeartbeats')
        .withIndex('by_job', (q) => q.eq('job', entry.name))
        .first();
      seen.push(hb?.runningSince);
      return await realRecord(ctx, entry, tick);
    });
    await tickA(t, 'a silent');
    expect(seen).toEqual([undefined]);
    expect((await heartbeat(t, 'a silent'))?.lastOutcome).toBe('ok');
  });

  test('finish throws: the job’s work stands, the tick is unrecorded, nothing rethrown', async () => {
    const t = convexTest(schema, probeModules);
    const err = quiet();
    vi.spyOn(recorder, 'recordTick').mockRejectedValueOnce(new Error('recorder down'));
    await expect(tickA(t, 'a quiet')).resolves.toBeNull();
    expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/finish failed/);
    // begin's stamp stays: it ages into a recorded kill, which is what an unrecorded tick reads as.
    expect((await heartbeat(t, 'a quiet'))?.runningSince).toBe(T0);
  });

  test('begin throws: the job still runs and is recorded', async () => {
    const t = convexTest(schema, probeModules);
    const err = quiet();
    await t.run((ctx) =>
      ctx.db.insert('cronHeartbeats', { job: 'a worked', runningSince: T0 - KILLED_AFTER_MS - 1 }),
    );
    // begin records the stale kill through the recorder; that write fails, so begin throws.
    vi.spyOn(recorder, 'recordTick').mockRejectedValueOnce(new Error('recorder down'));
    await tickA(t, 'a worked');
    expect(String(err.mock.calls[0]?.[0])).toMatch(/begin failed, running the job anyway/);
    expect((await all(t)).runs).toEqual([expect.objectContaining({ counts: { did: 3 } })]);
  });
});

describe('a killed action', () => {
  test('the next begin records a stale runningSince as killed, then runs', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    const since = T0 - KILLED_AFTER_MS - 1;
    await t.run((ctx) => ctx.db.insert('cronHeartbeats', { job: 'a quiet', runningSince: since }));
    await tickA(t, 'a quiet');
    const s = await all(t);
    expect(s.runs).toEqual([
      expect.objectContaining({ outcome: 'killed', startedAt: since, trigger: 'cron' }),
    ]);
    expect((await ticksOf(t, 'a quiet')).map((x) => x.code).sort()).toEqual([
      CRON_TICK_CODES.ok,
      CRON_TICK_CODES.killed,
    ]);
    // The kill stays on the heartbeat as its last failure; the tick after it is its last word.
    const hb = await heartbeat(t, 'a quiet');
    expect(hb).toMatchObject({ lastOutcome: 'ok', lastFailedAt: since, lastError: 'killed' });
    expect(hb?.runningSince).toBeUndefined();
  });

  test('a young runningSince is left alone: a run inside the limit, or a kill still ageing', async () => {
    const t = convexTest(schema, probeModules);
    const since = T0 - KILLED_AFTER_MS;
    await t.run((ctx) => ctx.db.insert('cronHeartbeats', { job: 'a quiet', runningSince: since }));
    await tickA(t, 'a quiet');
    expect((await all(t)).runs).toEqual([]);
    expect((await heartbeat(t, 'a quiet'))?.runningSince).toBe(since);
  });
});

// ─── Recording mode ─────────────────────────────────────────────────────────────────────────────

describe('a sparse job', () => {
  test('a quiet tick after the hour’s first writes nothing and reads only the heartbeat', async () => {
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p sparse');
    const first = await all(t);
    vi.setSystemTime(T0 + 60_000);
    const cost: { reads: number; writes: number }[] = [];
    vi.spyOn(recorder, 'recordTick').mockImplementation(async (ctx, entry, tick) => {
      const before = await ctx.meta.getTransactionMetrics();
      const wrote = await realRecord(ctx, entry, tick);
      const after = await ctx.meta.getTransactionMetrics();
      cost.push({
        reads: after.documentsRead.used - before.documentsRead.used,
        writes: after.documentsWritten.used - before.documentsWritten.used,
      });
      return wrote;
    });
    await tickM(t, 'p sparse');
    expect(cost).toEqual([{ reads: 1, writes: 0 }]);
    expect(await all(t)).toEqual(first);
  });

  test('the next hour’s first quiet tick is recorded', async () => {
    const t = convexTest(schema, probeModules);
    await tickM(t, 'p sparse');
    vi.setSystemTime(T0 + 30 * 60_000);
    await tickM(t, 'p sparse');
    vi.setSystemTime(T0 + HOUR);
    await tickM(t, 'p sparse');
    expect(await ticksOf(t, 'p sparse')).toHaveLength(2);
    expect((await heartbeat(t, 'p sparse'))?.lastTickAt).toBe(T0 + HOUR);
  });

  test('a failure is recorded as it happens, and so is the first quiet tick after it', async () => {
    const t = convexTest(schema, probeModules);
    quiet();
    const as = (fn: keyof typeof probe) =>
      probeByName.set('s', mutationJob('s', fn, { record: 'sparse' }));
    as('quiet');
    await tickM(t, 's');
    as('throws');
    vi.setSystemTime(T0 + 60_000);
    await tickM(t, 's');
    as('quiet');
    vi.setSystemTime(T0 + 120_000);
    await tickM(t, 's');
    vi.setSystemTime(T0 + 180_000);
    await tickM(t, 's');
    as('worked');
    vi.setSystemTime(T0 + 240_000);
    await tickM(t, 's');
    expect((await ticksOf(t, 's')).map((x) => x.code)).toEqual([
      CRON_TICK_CODES.ok,
      CRON_TICK_CODES.failed,
      CRON_TICK_CODES.ok,
      CRON_TICK_CODES.worked,
    ]);
    expect((await all(t)).runs.map((r) => r.outcome)).toEqual(['failed', 'ok']);
    expect((await heartbeat(t, 's'))?.lastOutcome).toBe('worked');
  });
});

// ─── The backbone's own jobs ────────────────────────────────────────────────────────────────────

describe('prune', () => {
  test('deletes what is due in each table, page by page; never an import run’s lines', async () => {
    const t = convexTest(schema, modules);
    const run = await t.run(async (ctx) => {
      const base = {
        job: 'x',
        startedAt: 0,
        finishedAt: 0,
        outcome: 'ok',
        trigger: 'cron',
      } as const;
      const due = await ctx.db.insert('cronRuns', { ...base, keepUntil: T0 - 1 });
      await ctx.db.insert('cronRuns', { ...base, keepUntil: T0 + 1 });
      for (let i = 0; i < PRUNE_PAGE + 3; i++) {
        await ctx.db.insert('cronTicks', {
          job: 'x',
          bucketStart: i,
          bucketMs: HOUR,
          ticks: [0],
          ms: [0],
          keepUntil: T0 - 1,
        });
      }
      await ctx.db.insert('cronTicks', {
        job: 'x',
        bucketStart: -1,
        bucketMs: HOUR,
        ticks: [0],
        ms: [0],
        keepUntil: T0 + 1,
      });
      const line = { seq: 0, at: 0, loggedAt: 0, kind: 'line' } as const;
      await ctx.db.insert('runEvents', { ...line, cronRunId: due, text: 'old', keepUntil: T0 - 1 });
      // An import run's line carries no keepUntil: never swept.
      await ctx.db.insert('runEvents', { ...line, text: 'an import line' });
      return due;
    });
    expect(await tickM(t, 'prune cron records')).toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const s = await all(t);
    expect(s.ticks.filter((r) => r.job === 'x').map((r) => r.bucketStart)).toEqual([-1]);
    expect(s.runs.some((r) => r._id === run)).toBe(false);
    expect(s.runs.some((r) => r.keepUntil === T0 + 1)).toBe(true);
    expect(s.lines.map((l) => l.text)).toEqual(['an import line']);
    // The cron's own tick: a run that did work, counting its first page.
    expect(s.runs.find((r) => r.job === 'prune cron records')?.counts).toEqual({
      cronTicks: PRUNE_PAGE,
    });
  });
});

describe('copyImageryRuns', () => {
  async function seed(t: T, n: number) {
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert('imageryRuns', {
          season: 'winter-2026-27',
          kind: (['poll', 'pump', 'index'] as const)[i % 3] ?? 'poll',
          startedAt: T0 - (n - i) * 60_000,
          finishedAt: T0 - (n - i) * 60_000 + 500,
          outcome: i % 10 === 9 ? 'skipped' : i % 7 === 0 ? 'failed' : 'ok',
          ...(i % 7 === 0 ? { detail: `failed ${i}` } : {}),
          counts: { i },
        });
      }
    });
  }

  test('a dry run copies nothing and counts; the run copies; a rerun copies nothing more', async () => {
    const t = convexTest(schema, modules);
    const n = COPY_PAGE * 2 + 30;
    await seed(t, n);
    const quietRows = Math.floor(n / 10);
    expect(await t.mutation(internal.cronRunJobs.copyImageryRuns, { dryRun: true })).toEqual({
      dryRun: true,
      copied: COPY_PAGE - 10,
      alreadyCopied: 0,
      quiet: 10,
      more: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await all(t)).runs).toEqual([]);

    await t.mutation(internal.cronRunJobs.copyImageryRuns, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const runs = (await all(t)).runs;
    expect(runs).toHaveLength(n - quietRows);
    const first = runs.find((r) => r.counts?.i === 0);
    expect(first).toMatchObject({
      job: IMAGERY_CRON_JOBS.poll,
      outcome: 'failed',
      detail: 'failed 0',
      trigger: 'cron',
      season: 'winter-2026-27',
      keepUntil: (first?.startedAt ?? 0) + 200 * DAY,
    });
    expect(first?.copiedFrom).toBeDefined();
    expect(runs.find((r) => r.counts?.i === 1)?.job).toBe(IMAGERY_CRON_JOBS.pump);
    expect(runs.find((r) => r.counts?.i === 2)?.job).toBe(IMAGERY_CRON_JOBS.index);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await t.mutation(internal.cronRunJobs.copyImageryRuns, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await all(t)).runs).toHaveLength(n - quietRows);
    expect(String(log.mock.calls.at(-1)?.[0])).toBe(
      `copyImageryRuns: copied 0, already copied ${n - quietRows}, quiet (not copied) ${quietRows}`,
    );
  });
});
