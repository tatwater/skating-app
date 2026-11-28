/**
 * **The weather jobs against the real recorder** (B01-8c-1, D349, D345): the jobs run through the
 * dispatcher (`cronRuns.tickAction`) with the chain's own `openRun` / `chainStep` and core's own
 * `fetchFailureCause` — nothing in the recorder replaced — and what each test reads is the run row,
 * its lines and the heartbeat, as the page (8c-2) will.
 *
 * `weatherRuns.test.ts` asserts what the jobs *pass* the recorder (it records the calls); this file
 * asserts what the recorder *makes* of them: one row per run, every count folded, each injected fault
 * under its own cause, the head's tick merged rather than doubled, and the busy rule on a press and a
 * tick.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import type { CronActionJob } from './cronJobs';
import * as cronJobsModule from './cronJobs';
import schema from './schema';
import { maybeRefreshFilterTierHandler } from './weatherArchive';

const rec = vi.hoisted(() => ({
  /** A summarized batch of exactly this many hours is refused by the day write's validator. */
  refuseHours: null as number | null,
}));

// One cell's write made to throw, as an over-limit write would: its days given a date the day
// write's validator refuses. Everything else in core is the real thing.
vi.mock('@skating/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@skating/core')>();
  return {
    ...core,
    summarizeWeatherDays: (...args: Parameters<typeof core.summarizeWeatherDays>) => {
      const days = core.summarizeWeatherDays(...args);
      return rec.refuseHours !== null && args[0].length === rec.refuseHours
        ? days.map((d) => ({ ...d, localDate: 5 as never }))
        : days;
    },
  };
});

const modules = import.meta.glob('./**/*.*s');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 10:00 UTC on 20 January 2026: the gap repair's hour, 05:00 at the lake. */
const T0 = Date.UTC(2026, 0, 20, 10);
const DAY0 = Math.floor(T0 / DAY_MS) * DAY_MS;
const ago = (n: number) => DAY0 - n * DAY_MS;

const APPEND = 'append daily weather archive';
const REPAIR = 'repair weather archive gaps';
const WALK = 'reconcile weather cell registry';

beforeEach(() => {
  rec.refuseHours = null;
  vi.useFakeTimers({ now: T0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
const tick = (t: T, job: string, trigger: 'cron' | 'manual' = 'cron') =>
  t.action(internal.cronRuns.tickAction, { job, trigger });
const runsOf = (t: T, job: string) =>
  t.run((ctx) =>
    ctx.db
      .query('cronRuns')
      .withIndex('by_job_started', (q) => q.eq('job', job))
      .collect(),
  );
const linesOf = (t: T, runId: Id<'cronRuns'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('runEvents')
        .withIndex('by_cron_run_seq', (q) => q.eq('cronRunId', runId))
        .collect()
    ).map((l) => l.text),
  );
const heartbeatOf = (t: T, job: string) =>
  t.run((ctx) =>
    ctx.db
      .query('cronHeartbeats')
      .withIndex('by_job', (q) => q.eq('job', job))
      .first(),
  );
const causeCounts = (run: Doc<'cronRuns'>) =>
  Object.fromEntries((run.causes ?? []).map((c) => [c.cause, c.count]));

async function openSeason(t: T) {
  const gate = await t.query(internal.weatherArchive.isSweepSeasonOpen, { nowMs: Date.now() });
  await t.run((ctx) =>
    ctx.db.insert('imageryIngestSeasons', {
      season: gate.season,
      opensOn: '2025-12-01',
      openedBy: ['sentinel pond'],
      winterFrom: '2025-11-01',
      sitesSampled: 25,
      detectedAt: Date.now(),
    }),
  );
  return gate.season;
}

const cellKey = (i: number) => `c${String(i).padStart(3, '0')}`;
const latOf = (i: number) => 40 + i / 1000;
const indexOf = (url: string) =>
  Math.round((Number(new URL(url).searchParams.get('latitude')) - 40) * 1000);
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function seedCells(t: T, n: number, tier: 'filter' | 'browse' = 'filter', from = 0) {
  await t.run(async (ctx) => {
    for (let i = from; i < from + n; i++) {
      await ctx.db.insert('weatherCells', {
        cellKey: cellKey(i),
        tier,
        lat: latOf(i),
        lng: -72,
        bodyCount: 1,
        runId: 'seed',
        updatedAt: 0,
      });
    }
  });
}

/** Complete days `from…to` days back for cell `i`; `over` replaces some (a hole, a partial day). */
async function seedDays(
  t: T,
  i: number,
  from: number,
  to: number,
  over: Record<number, 'hole' | number> = {},
  tier: 'filter' | 'browse' = 'filter',
) {
  await t.run(async (ctx) => {
    for (let n = from; n >= to; n--) {
      const o = over[n];
      if (o === 'hole') continue;
      const day = ago(n);
      const partial = typeof o === 'number';
      await ctx.db.insert('weatherDays', {
        cellKey: cellKey(i),
        tier,
        dayMs: day,
        localDate: isoDate(day),
        source: 'forecast',
        // A partial day was written as its own "today" (before it ended); a complete one after.
        fetchedAt: partial ? day + 7 * HOUR_MS : day + 2 * DAY_MS,
        utcOffsetSeconds: 0,
        hours: partial ? o : 24,
      });
    }
  });
}

/** The stand-in's answer: `past_days` past dates and today, `hours` an hour each (UTC). */
function answer(url: string, hours = 24): Response {
  const past = Number(new URL(url).searchParams.get('past_days'));
  const time: number[] = [];
  for (let d = past; d >= 0; d--) {
    const day = DAY0 - d * DAY_MS;
    for (let h = 0; h < hours; h++) time.push((day + h * HOUR_MS) / 1000);
  }
  const fill = (x: number) => new Array(time.length).fill(x);
  return new Response(
    JSON.stringify({
      timezone: 'UTC',
      utc_offset_seconds: 0,
      hourly: {
        time,
        temperature_2m: fill(-5),
        precipitation: fill(0),
        rain: fill(0),
        snowfall: fill(0),
        snow_depth: fill(0),
        wind_speed_10m: fill(3),
        wind_gusts_10m: fill(5),
        wind_direction_10m: fill(300),
        cloud_cover: fill(50),
        sunshine_duration: fill(0),
        shortwave_radiation: fill(0),
        weather_code: fill(0),
      },
    }),
    { status: 200 },
  );
}

type Fault = 'timeout' | '429' | '503' | '404' | 'unreachable' | 'malformed' | 'empty' | 'short';
/** A stand-in Open-Meteo answering cell `i` with `faults[i]`, else in full. Records every request. */
function standIn(faults: Record<number, Fault> = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      switch (faults[indexOf(url)]) {
        case 'timeout':
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        case 'unreachable':
          throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        case '429':
          return new Response('slow down', { status: 429 });
        case '503':
          return new Response('down', { status: 503 });
        case '404':
          return new Response('no', { status: 404 });
        case 'malformed':
          return new Response('{"hourly": {"time": [1, 2', { status: 200 });
        case 'empty':
          return new Response(JSON.stringify({ timezone: 'UTC', hourly: { time: [] } }), {
            status: 200,
          });
        case 'short':
          return answer(url, 23);
        default:
          return answer(url);
      }
    }),
  );
  return urls;
}

// ─── The filter append ──────────────────────────────────────────────────────────────────────────

describe('the filter append through the dispatcher is one run (D349)', () => {
  /** 100 cells over three batches; one of each cause among them (two rate limits). */
  const FAULTS: Record<number, Fault> = {
    3: 'timeout',
    41: '429',
    42: '429',
    55: '503',
    60: '404',
    81: 'unreachable',
    90: 'malformed',
    95: 'empty',
    99: 'short', // its write is refused: writeFailed
  };

  test('one row: the counts folded, every fault under its own cause, the head merged', async () => {
    const t = harness();
    const season = await openSeason(t);
    await seedCells(t, 100);
    // Warm (every cell holds yesterday): the 3-day append.
    for (let i = 0; i < 100; i++) await seedDays(t, i, 1, 1);
    rec.refuseHours = 4 * 23;
    const urls = standIn(FAULTS);

    await tick(t, APPEND);
    await drain(t);

    const runs = await runsOf(t, APPEND);
    expect(runs).toHaveLength(1);
    const run = runs[0] as Doc<'cronRuns'>;
    expect(run).toMatchObject({
      trigger: 'cron',
      outcome: 'ok',
      season,
      detail: '3-day append',
      chain: { open: 0, steps: 3 },
    });
    expect(run.error).toBeUndefined();
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    const failed = Object.keys(FAULTS).length;
    expect(run.counts).toMatchObject({
      pastDays: 3,
      cells: 100,
      cellsStored: 100 - failed,
      cellsFailed: failed,
      calls: 100,
      weighted: 100 * 12,
      daysWritten: (100 - failed) * 4,
    });
    expect(run.counts?.registry).toBeUndefined(); // no walk has measured it yet
    expect(urls).toHaveLength(100);
    // Core's real rule, each fault in its own cause, the first sample kept, keyed by cell.
    expect(causeCounts(run)).toEqual({
      timeout: 1,
      rateLimit: 2,
      serverError: 1,
      refused: 1,
      unreachable: 1,
      badAnswer: 1,
      emptyAnswer: 1,
      writeFailed: 1,
    });
    const by = new Map((run.causes ?? []).map((c) => [c.cause, c]));
    expect(by.get('rateLimit')).toMatchObject({
      sampleKey: cellKey(41),
      sampleText: 'Open-Meteo answered HTTP 429',
    });
    expect(by.get('writeFailed')?.sampleKey).toBe(cellKey(99));
    // The heartbeat points at the one run; nothing else was inserted for the tick.
    expect((await heartbeatOf(t, APPEND))?.lastRunId).toBe(run._id);
    // The lines: the start first, one per cause per step, the end last.
    const lines = await linesOf(t, run._id);
    expect(lines[0]).toBe('3-day append · every registered cell');
    expect(lines.at(-1)).toBe(
      `Done in 3 steps · ${100 - failed} of 100 cells stored, ${failed} failed`,
    );
    expect(lines.filter((l) => l.includes(' failed ('))).toHaveLength(8);
    for (const l of lines) expect(l).not.toMatch(/safe|skateable|good to go|frozen/i);
  });

  test('a manual press while a run is live is skipped quietly; a cron tick works, unrecorded as a chain', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 3);
    const urls = standIn();
    const live = await t.mutation(internal.cronRuns.openRun, {
      job: APPEND,
      startedAt: Date.now() - 60_000,
      trigger: 'cron',
    });
    if (!('runId' in live)) throw new Error('expected a run');

    await tick(t, APPEND, 'manual');
    await drain(t);
    expect(urls).toHaveLength(0);
    let runs = await runsOf(t, APPEND);
    expect(runs).toHaveLength(2);
    const press = runs.find((r) => r._id !== live.runId);
    expect(press).toMatchObject({
      trigger: 'manual',
      outcome: 'ok',
      detail: 'A run of this job is already going',
    });
    expect(press?.chain).toBeUndefined();

    await tick(t, APPEND, 'cron');
    await drain(t);
    expect(urls).toHaveLength(3);
    runs = await runsOf(t, APPEND);
    expect(runs).toHaveLength(3);
    const cron = runs.find((r) => r.trigger === 'cron' && r._id !== live.runId);
    // A cold start (no yesterday held): the 14-day append, its tick's own row.
    expect(cron).toMatchObject({ outcome: 'ok', detail: '14-day append' });
    expect(cron?.chain).toBeUndefined();
    // The live run was never stepped into.
    const still = runs.find((r) => r._id === live.runId);
    expect(still?.chain).toMatchObject({ open: 1, steps: 0 });
  });

  test('a head that throws after its run opened: the one row closes failed with the error', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 2);
    standIn();
    const real = cronJobsModule.cronJob;
    vi.spyOn(cronJobsModule, 'cronJob').mockImplementation((name) => {
      const entry = real(name);
      if (name !== APPEND || entry?.kind !== 'action') return entry;
      return {
        ...entry,
        // The real head, its first batch's action refused after the run opened.
        handler: ((ctx: ActionCtx, args: never, tickCtx) =>
          maybeRefreshFilterTierHandler(
            new Proxy(ctx, {
              get: (target, key) =>
                key === 'runAction'
                  ? async () => {
                      throw new Error('the batch fell over: https://x/v1?latitude=1');
                    }
                  : Reflect.get(target, key),
            }),
            args,
            tickCtx,
          )) as CronActionJob['handler'],
      } as CronActionJob;
    });

    // The dispatcher records the throw, then rethrows it (Convex's own log keeps the failure).
    await expect(tick(t, APPEND)).rejects.toThrow('the batch fell over');
    await drain(t);
    const runs = await runsOf(t, APPEND);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'failed',
      chain: { open: 0, steps: 0 },
      counts: { pastDays: 14 },
    });
    expect(runs[0]?.error).toContain('the batch fell over');
    expect(runs[0]?.error).not.toContain('latitude');
    expect((await heartbeatOf(t, APPEND))?.lastRunId).toBe(runs[0]?._id);
  });
});

// ─── The gap repair ─────────────────────────────────────────────────────────────────────────────

describe('the gap repair through the dispatcher is one run over both tiers', () => {
  test('holes, partial days, a failing cell and an untouched one: each counted once, on one row', async () => {
    const t = harness();
    const season = await openSeason(t);
    await seedCells(t, 5);
    await seedCells(t, 1, 'browse', 50);
    // c000: a hole 3 days back and a partial day 6 back — one request from the partial day.
    await seedDays(t, 0, 10, 1, { 3: 'hole', 6: 10 });
    // c001: a partial day only — queued, refetched once the walk ends.
    await seedDays(t, 1, 10, 1, { 2: 12 });
    // c002: never touched — skipped, no request.
    // c003: complete — nothing to do.
    await seedDays(t, 3, 10, 1);
    // c004: a hole, and Open-Meteo answers 503 — the hole stays not recorded.
    await seedDays(t, 4, 10, 1, { 5: 'hole' });
    // c050 (browse): a hole 4 days back, Open-Meteo answers 503 and no filter parent holds it.
    await seedDays(t, 50, 10, 1, { 4: 'hole' }, 'browse');
    const urls = standIn({ 4: '503', 50: '503' });

    await tick(t, REPAIR);
    await drain(t);

    const runs = await runsOf(t, REPAIR);
    expect(runs).toHaveLength(1);
    const run = runs[0] as Doc<'cronRuns'>;
    // filter: its walk's one batch and the refetch batch; browse: its walk's one batch.
    expect(run).toMatchObject({ outcome: 'ok', season, chain: { open: 0, steps: 3 } });
    expect(run.counts).toMatchObject({
      cellsChecked: 6,
      cellsUntouched: 1,
      holes: 3,
      filled: 1,
      borrowed: 0,
      stillMissing: 2,
      oldestOpenDay: ago(5),
      partialDays: 2,
      partialFilled: 2,
      oldestPartialDay: ago(6),
      calls: 4,
    });
    expect(run.counts?.partialStill ?? 0).toBe(0);
    expect(urls.map(indexOf).sort((a, b) => a - b)).toEqual([0, 1, 4, 50]);
    expect(causeCounts(run)).toEqual({ serverError: 2 });
    const lines = await linesOf(t, run._id);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Filter: checking the registered cells',
        'Browse: checking the registered cells',
      ]),
    );
    expect(lines.filter((l) => / cells checked · /.test(l))).toHaveLength(2);
    for (const l of lines) expect(l).not.toMatch(/safe|skateable|good to go|clear/i);
    // A partial day is never written missing: c001's day is complete now, c004's hole is marked.
    const c001 = await t.run((ctx) =>
      ctx.db
        .query('weatherDays')
        .withIndex('by_cell_day', (q) => q.eq('cellKey', cellKey(1)).eq('dayMs', ago(2)))
        .first(),
    );
    expect(c001).toMatchObject({ hours: 24 });
    expect(c001?.missing).toBeUndefined();
  });
});

// ─── The registry walk ──────────────────────────────────────────────────────────────────────────

describe('the registry walk through the dispatcher is one run over both tiers', () => {
  test('a complete walk: one row with both tiers, the sizes stamped', async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert('weatherCells', {
        cellKey: 'vacated',
        tier: 'filter',
        lat: 40,
        lng: -70,
        bodyCount: 1,
        runId: 'old',
        updatedAt: 0,
      }),
    );
    await tick(t, WALK);
    await drain(t);
    const runs = await runsOf(t, WALK);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'ok',
      detail: 'Weekly walk',
      chain: { open: 0, steps: 2 },
      counts: { pruned: 1, cellsFilter: 0, cellsBrowse: 0, writesFailed: 0 },
    });
    const syncs = await t.run((ctx) => ctx.db.query('weatherCellSyncs').collect());
    expect(syncs.map((s) => [s.tier, s.cellCount, s.pruned]).sort()).toEqual([
      ['browse', 0, 0],
      ['filter', 0, 1],
    ]);
  });
});
