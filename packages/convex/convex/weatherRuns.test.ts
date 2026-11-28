/**
 * **The weather jobs' runs** (B01-8c-1, D345, D349): what each weather job reports — its counts, its
 * failures by cause with one sample each, its lines — how a chained job opens one run and steps it
 * per batch, and the gap repair's partial-day refetch (fork 2 (b)) at its bounds.
 *
 * `cronRuns.openRun` / `chainStep` are the chain builder's (S4's); here they are replaced at the
 * module boundary by recorders with the stubs' own argument validators, so every test asserts what
 * the jobs **pass** them, and every call shape is checked against the contract's validators. Core's
 * `fetchFailureCause` is likewise wrapped: its inputs are recorded and a stand-in classifier (the
 * nine causes by the design's words) sorts them, so the grouping and the samples can be read.
 */

import type { CronFailureCause, CronTickContext, FetchFailure } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import * as recurringWork from './lib/recurringWork';
import { CAUSE_WORDS, StepTally, sampleTextOf, thrownText } from './lib/weatherReport';
import schema from './schema';
import { standInBaseUrl } from './weather';
import {
  maybeRefreshBayTierHandler,
  maybeRefreshFilterTierHandler,
  maybeSweepGapsHandler,
  maybeSyncWeatherCellsHandler,
  PARTIAL_REPAIR_BUDGET,
  PARTIAL_REPAIR_DAY_CEILING,
  partialBudgetFor,
} from './weatherArchive';

interface StepArgs {
  runId: Id<'cronRuns'>;
  opened?: number;
  closed?: number;
  counts?: Record<string, number>;
  causes?: {
    cause: CronFailureCause;
    count: number;
    sampleKey?: string;
    sampleText: string;
    sampleAt: number;
  }[];
  lines?: { kind: string; text: string; loggedAt: number }[];
  error?: string;
}

const rec = vi.hoisted(() => ({
  steps: [] as unknown[],
  opens: [] as unknown[],
  busy: null as string | null,
  failures: [] as unknown[],
  /** A cell key whose digest rebuild throws. */
  digestThrows: null as string | null,
  /** The archive's day write refuses what it is given. */
  writeThrows: false,
  openThrows: false,
  stepThrows: false,
}));

// The chain's two writes, recorded with the stubs' own validators (the contract's shapes).
vi.mock('./cronRuns', async (importOriginal) => {
  const real = await importOriginal<typeof import('./cronRuns')>();
  const { internalMutation } = await import('./_generated/server');
  const { v } = await import('convex/values');
  const { cronCauseTally, cronReportLine } = await import('./lib/cronValidators');
  const { CRON_TRIGGERS } = await import('./lib/enums');
  const { literals } = await import('./lib/validators');
  return {
    ...real,
    openRun: internalMutation({
      args: {
        job: v.string(),
        startedAt: v.number(),
        trigger: literals(CRON_TRIGGERS),
        byUserId: v.optional(v.id('profiles')),
        detail: v.optional(v.string()),
        season: v.optional(v.string()),
        counts: v.optional(v.record(v.string(), v.number())),
      },
      returns: v.union(v.object({ runId: v.id('cronRuns') }), v.object({ busy: v.id('cronRuns') })),
      handler: async (ctx, args) => {
        rec.opens.push(args);
        if (rec.openThrows) throw new Error('open refused');
        if (rec.busy !== null) return { busy: rec.busy as never };
        const runId = await ctx.db.insert('cronRuns', {
          job: args.job,
          startedAt: args.startedAt,
          finishedAt: args.startedAt,
          outcome: 'ok',
          trigger: args.trigger,
          chain: { open: 1, steps: 0, progressAt: args.startedAt, lines: 0 },
          keepUntil: args.startedAt + 1,
        });
        return { runId };
      },
    }),
    chainStep: internalMutation({
      args: {
        runId: v.id('cronRuns'),
        opened: v.optional(v.number()),
        closed: v.optional(v.number()),
        head: v.optional(v.boolean()),
        counts: v.optional(v.record(v.string(), v.number())),
        causes: v.optional(v.array(cronCauseTally)),
        lines: v.optional(v.array(cronReportLine)),
        error: v.optional(v.string()),
      },
      returns: v.null(),
      handler: async (_ctx, args) => {
        if (rec.stepThrows) throw new Error('step refused');
        rec.steps.push(args);
        return null;
      },
    }),
  };
});

// Core's one rule, recorded (and called through: the causes asserted are the real rule's).
vi.mock('@skating/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@skating/core')>();
  return {
    ...core,
    summarizeWeatherDays: (...args: Parameters<typeof core.summarizeWeatherDays>) => {
      const days = core.summarizeWeatherDays(...args);
      // A day the write's validator refuses: the write throws, as an over-limit write would.
      return rec.writeThrows ? days.map((d) => ({ ...d, localDate: 5 as never })) : days;
    },
    buildWeatherCellDigest: (...args: Parameters<typeof core.buildWeatherCellDigest>) => {
      if (rec.digestThrows !== null) throw new RangeError('digest refused');
      return core.buildWeatherCellDigest(...args);
    },
    // The real rule, its inputs recorded: every injected fault must land in its own cause.
    fetchFailureCause: (f: FetchFailure): CronFailureCause => {
      rec.failures.push(f);
      return core.fetchFailureCause(f);
    },
  };
});

const modules = import.meta.glob('./**/*.*s');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 10:00 UTC on 20 January 2026: the gap repair's hour, 05:00 at the lake. */
const T0 = Date.UTC(2026, 0, 20, 10);

const steps = () => rec.steps as StepArgs[];
const opens = () =>
  rec.opens as { job: string; trigger: string; detail?: string; season?: string }[];

beforeEach(() => {
  rec.steps.length = 0;
  rec.opens.length = 0;
  rec.failures.length = 0;
  rec.busy = null;
  rec.digestThrows = null;
  rec.writeThrows = false;
  rec.openThrows = false;
  rec.stepThrows = false;
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type Call = (ref: unknown, args: unknown) => Promise<unknown>;

/** An action context over the test backend, for calling a handler with a tick as the dispatcher will. */
function actionCtx(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) => (t.query as Call)(ref, args),
    runMutation: (ref: unknown, args: unknown) => (t.mutation as Call)(ref, args),
    runAction: (ref: unknown, args: unknown) => (t.action as Call)(ref, args),
  } as unknown as ActionCtx;
}

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

/** `n` registered cells of `tier`, keyed `c000…`, each at its own latitude (the stand-in's index). */
async function seedCells(t: T, n: number, tier: 'filter' | 'browse' = 'filter') {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
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
const cellKey = (i: number) => `c${String(i).padStart(3, '0')}`;
const latOf = (i: number) => 40 + i / 1000;
const indexOf = (url: string) =>
  Math.round((Number(new URL(url).searchParams.get('latitude')) - 40) * 1000);
const pastDaysOf = (url: string) => Number(new URL(url).searchParams.get('past_days'));

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayKey = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * The stand-in's answer to an archive request, in UTC: `past_days` past dates and today, 24 hours
 * each unless `hoursFor` says fewer.
 */
function answer(url: string, hoursFor: (date: string) => number = () => 24): Response {
  const past = pastDaysOf(url);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const time: number[] = [];
  for (let d = past; d >= 0; d--) {
    const date = isoDate(today - d * DAY_MS);
    for (let h = 0; h < hoursFor(date); h++) time.push((dayKey(date) + h * HOUR_MS) / 1000);
  }
  const n = time.length;
  const fill = (x: number) => new Array(n).fill(x);
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

/** One way a request fails, as the stand-in serves it. */
type Fault = 'timeout' | '429' | '503' | '404' | 'unreachable' | 'malformed' | 'empty';
function faulted(fault: Fault): Response {
  switch (fault) {
    case 'timeout':
      throw Object.assign(new Error('The operation timed out: https://x/v1/forecast?latitude=1'), {
        name: 'TimeoutError',
      });
    case 'unreachable':
      throw new TypeError('fetch failed');
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
  }
}

/** A stand-in Open-Meteo: `fault(i)` for cell `i`, else a full answer. Records every request. */
function standIn(
  fault: (i: number) => Fault | null = () => null,
  hoursFor?: (d: string) => number,
) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const f = fault(indexOf(url));
      return f === null ? answer(url, hoursFor) : faulted(f);
    }),
  );
  return urls;
}

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);

/** Every step's counts added key by key — what the run row will hold once the chain merges them. */
function summed(list: StepArgs[] = steps()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of list)
    for (const [k, n] of Object.entries(s.counts ?? {})) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** The run's branches: what `open` comes to after every step (1 from `openRun`). */
function openAfter(list: StepArgs[] = steps()): number {
  return list.reduce((open, s) => open + (s.opened ?? 0) - (s.closed ?? 0), 1);
}

/** Causes merged over steps: counts summed, the first sample kept. */
function mergedCauses(list: StepArgs[] = steps()) {
  const out = new Map<string, { count: number; sampleKey?: string; sampleText: string }>();
  for (const s of list) {
    for (const c of s.causes ?? []) {
      const had = out.get(c.cause);
      if (had) had.count += c.count;
      else out.set(c.cause, { count: c.count, sampleKey: c.sampleKey, sampleText: c.sampleText });
    }
  }
  return out;
}

// ─── The pieces ─────────────────────────────────────────────────────────────────────────────────

describe('a sample never carries a query string or a key', () => {
  test('a URL loses its query and fragment; a key, token or secret loses its value', () => {
    expect(
      sampleTextOf(
        'fetch failed: https://api.open-meteo.com/v1/forecast?latitude=44&apikey=s3cr3t#x',
      ),
    ).toBe('fetch failed: https://api.open-meteo.com/v1/forecast');
    expect(sampleTextOf('bad token=abc123 and key=zzz, secret=q')).toBe(
      'bad token=… and key=…, secret=…',
    );
    expect(sampleTextOf('   ')).toBe('no detail');
  });

  test('trimmed to the sample limit, never through a surrogate pair', () => {
    expect(sampleTextOf('x'.repeat(400))).toHaveLength(300);
    const cut = sampleTextOf(`${'x'.repeat(299)}😀tail`);
    expect(cut).toBe('x'.repeat(299));
  });

  test('a step groups failures by cause: the count, the first sample', () => {
    const tally = new StepTally();
    tally.fail({ cause: 'timeout', text: 'first' }, 'a', 1);
    tally.fail({ cause: 'rateLimit', text: 'r' }, 'b', 2);
    tally.fail({ cause: 'timeout', text: 'second' }, 'c', 3);
    expect(tally.causes()).toEqual([
      { cause: 'timeout', count: 2, sampleKey: 'a', sampleText: 'first', sampleAt: 1 },
      { cause: 'rateLimit', count: 1, sampleKey: 'b', sampleText: 'r', sampleAt: 2 },
    ]);
    expect(tally.failures()).toBe(3);
    tally.causeLines('cell', 9);
    expect(tally.lines.map((l) => l.text)).toEqual([
      '2 cells failed (timed out) · e.g. a: first',
      '1 cell failed (rate limited) · e.g. b: r',
    ]);
  });

  test('the log words every cause and none says anything about the ice (D3)', () => {
    for (const word of Object.values(CAUSE_WORDS)) {
      expect(word).not.toMatch(/safe|skat|ice|frozen|good/i);
    }
    expect(Object.keys(CAUSE_WORDS)).toHaveLength(9);
  });
});

describe('the provider stand-ins (OPEN_METEO_BASE_URL, NWS_BASE_URL)', () => {
  test('honored only for a loopback http URL on a local backend', () => {
    expect(standInBaseUrl('OPEN_METEO_BASE_URL', {})).toBeNull();
    expect(
      standInBaseUrl('OPEN_METEO_BASE_URL', { OPEN_METEO_BASE_URL: 'http://127.0.0.1:8787/' }),
    ).toBe('http://127.0.0.1:8787');
    expect(
      standInBaseUrl('NWS_BASE_URL', {
        NWS_BASE_URL: 'http://localhost:9000',
        CONVEX_CLOUD_URL: 'http://127.0.0.1:3210',
      }),
    ).toBe('http://localhost:9000');
  });

  test('loopback spellings that are loopback are honored, rebuilt without userinfo, query or fragment', () => {
    const honored = (url: string, deployment = 'http://127.0.0.1:3210') =>
      standInBaseUrl('OPEN_METEO_BASE_URL', {
        OPEN_METEO_BASE_URL: url,
        CONVEX_CLOUD_URL: deployment,
      });
    expect(honored('http://[::1]:8787/')).toBe('http://[::1]:8787');
    expect(honored('HTTP://LOCALHOST:8787')).toBe('http://localhost:8787');
    expect(honored('http://127.1:8787')).toBe('http://127.0.0.1:8787');
    expect(honored('http://user:pw@127.0.0.1:8787/base/?q=1#f')).toBe('http://127.0.0.1:8787/base');
    expect(honored('http://127.0.0.1:8787', 'http://[::1]:3210')).toBe('http://127.0.0.1:8787');
  });

  test('impossible to set by accident on a real deployment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A cloud deployment ignores even a loopback stand-in…
    expect(
      standInBaseUrl('OPEN_METEO_BASE_URL', {
        OPEN_METEO_BASE_URL: 'http://127.0.0.1:8787',
        CONVEX_CLOUD_URL: 'https://diligent-guanaco-965.convex.cloud',
      }),
    ).toBeNull();
    // …and no deployment honors one that isn't on this machine, or isn't plain http.
    for (const url of [
      'https://127.0.0.1:8787',
      'http://example.com',
      'http://10.0.0.2',
      'nonsense',
    ]) {
      expect(standInBaseUrl('OPEN_METEO_BASE_URL', { OPEN_METEO_BASE_URL: url })).toBeNull();
    }
    // A hostile reading: look-alike hosts, userinfo and fragment tricks, other loopback spellings
    // that aren't the three named, and a cloud deployment with a loopback stand-in set.
    for (const url of [
      'http://localhost.evil.com',
      'http://127.0.0.1@evil.com',
      'http://evil.com#@127.0.0.1',
      'http://evil.com\\@127.0.0.1',
      'http://127.0.0.1.nip.io',
      'http://[::ffff:127.0.0.1]',
      'http://localhost.:1',
      'ftp://127.0.0.1',
      'file:///etc/hosts',
    ]) {
      expect(standInBaseUrl('OPEN_METEO_BASE_URL', { OPEN_METEO_BASE_URL: url })).toBeNull();
    }
    for (const deployment of [
      'https://diligent-guanaco-965.convex.cloud',
      'https://127.0.0.1:3210',
      'http://localhost.evil.com:3210',
    ]) {
      expect(
        standInBaseUrl('NWS_BASE_URL', {
          NWS_BASE_URL: 'http://[::1]:9000',
          CONVEX_CLOUD_URL: deployment,
        }),
      ).toBeNull();
    }
    // Logged by name, never by value.
    expect(warn.mock.calls.every(([m]) => !String(m).includes('8787'))).toBe(true);
  });

  test('the archive asks the stand-in when one is honored', async () => {
    vi.stubEnv('OPEN_METEO_BASE_URL', 'http://127.0.0.1:8787');
    vi.stubEnv('CONVEX_CLOUD_URL', '');
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 1);
    const urls = standIn();
    await t.action(internal.weatherArchive.refreshTierDays, { tier: 'filter' });
    expect(urls[0]?.startsWith('http://127.0.0.1:8787/v1/forecast?')).toBe(true);
    vi.unstubAllEnvs();
  });
});

// ─── The appends ────────────────────────────────────────────────────────────────────────────────

describe('the filter append records one run of its whole chain (D349)', () => {
  /** 100 cells over three batches; one of each fault among them. */
  const FAULTS: Record<number, Fault> = {
    3: 'timeout',
    41: '429',
    42: '429',
    55: '503',
    60: '404',
    81: 'unreachable',
    90: 'malformed',
    99: 'empty',
  };

  test('one open, a step per batch, the head closing its own branch, counts that add up', async () => {
    const t = convexTest(schema, modules);
    const season = await openSeason(t);
    await seedCells(t, 100);
    const urls = standIn((i) => FAULTS[i] ?? null);
    // Warm: every cell holds yesterday, so this is the 3-day append.
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert('weatherDays', {
          cellKey: cellKey(i),
          tier: 'filter',
          dayMs: Math.floor(T0 / DAY_MS) * DAY_MS - DAY_MS,
          localDate: isoDate(T0 - DAY_MS),
          source: 'forecast',
          hours: 24,
          fetchedAt: T0,
        });
      }
    });

    const res = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    expect(res).toMatchObject({ started: true, pastDays: 3 });

    // One run, opened as a run another job chained (no tick here: the registered action).
    expect(opens()).toEqual([
      expect.objectContaining({
        job: 'append daily weather archive',
        trigger: 'manual',
        season,
        detail: '3-day append',
      }),
    ]);
    // Three batches and the head's own close.
    const s = steps();
    expect(s).toHaveLength(5);
    // In arrival order: the head opens a branch for its inline batch; that batch closes it and
    // opens the next; the head closes its own (no tick: `closeChainHead`, before the scheduled
    // batches run); the middle batch; the last.
    // The open carries the tier's start line (and nothing else); the start counts rode the open.
    expect(s[0]).toEqual({
      runId: s[0]?.runId,
      opened: 1,
      lines: [expect.objectContaining({ kind: 'stage' })],
    });
    expect(s[1]).toMatchObject({ opened: 1, closed: 1 });
    expect(s[2]).toEqual({ runId: s[0]?.runId, closed: 1, head: true });
    expect(s[3]).toMatchObject({ opened: 1, closed: 1 });
    expect(s[4]?.opened).toBeUndefined();
    expect(s[4]).toMatchObject({ closed: 1 });
    expect(openAfter()).toBe(0);
    expect(new Set(s.map((x) => x.runId)).size).toBe(1);

    // The counts: every cell either stored or failed; each request counted and weighed (×10).
    const c = summed();
    const failed = Object.keys(FAULTS).length;
    // What is known at the start rides the open, once; no step repeats it.
    expect(rec.opens[0]).toMatchObject({ counts: { pastDays: 3 } });
    expect(c.pastDays).toBeUndefined();
    expect(c).toMatchObject({
      cells: 100,
      cellsStored: 100 - failed,
      cellsFailed: failed,
      calls: 100,
      weighted: 100 * 12,
      daysWritten: (100 - failed) * 4,
    });
    expect(urls).toHaveLength(100);
    expect(c.digestFailed).toBeUndefined();
    // Every step names its slowest request under a `Max` key (the run keeps the largest).
    expect(steps().filter((x) => x.counts?.fetchMsMax !== undefined)).toHaveLength(3);

    // The causes: grouped, counted, one sample each, keyed by cell, no query string.
    const causes = mergedCauses();
    expect(Object.fromEntries([...causes].map(([k, v]) => [k, v.count]))).toEqual({
      timeout: 1,
      rateLimit: 2,
      serverError: 1,
      refused: 1,
      unreachable: 1,
      badAnswer: 1,
      emptyAnswer: 1,
    });
    expect(causes.get('rateLimit')).toMatchObject({
      sampleKey: cellKey(41),
      sampleText: 'Open-Meteo answered HTTP 429',
    });
    expect(causes.get('timeout')?.sampleText).not.toContain('?');
    // What reached core's rule, for each fault: a status, the thrown error, or an empty answer.
    expect(rec.failures).toEqual(
      expect.arrayContaining([
        { status: 429 },
        { status: 503 },
        { status: 404 },
        { empty: true },
        expect.objectContaining({ error: expect.any(TypeError) }),
        expect.objectContaining({ error: expect.any(SyntaxError) }),
      ]),
    );

    // The lines: the start first, a line per cause per step, the end last.
    const lines = s.flatMap((x) => x.lines ?? []).map((l) => l.text);
    expect(lines[0]).toBe('3-day append · every registered cell');
    expect(lines.at(-1)).toBe(
      `Done in 3 steps · ${100 - failed} of 100 cells stored, ${failed} failed`,
    );
    expect(lines.filter((l) => l.includes('failed ('))).toHaveLength(7);
    for (const l of lines) expect(l).not.toMatch(/safe|skateable|good to go/i);
  });

  test('the registry size on the start line once a walk has stamped it', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 2);
    await t.run((ctx) =>
      ctx.db.insert('weatherCellSyncs', {
        tier: 'filter',
        runId: 'w',
        startedAt: 0,
        completedAt: 1,
        cellCount: 3043,
      }),
    );
    standIn();
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    expect(steps()[0]?.lines?.[0]?.text).toBe('14-day append · 3,043 cells registered');
    expect(rec.opens[0]).toMatchObject({ counts: { registry: 3043, pastDays: 14 } });
    expect(summed().registry).toBeUndefined();
  });

  test('under the dispatcher (a tick) the head returns its run for the merge and closes nothing itself', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 2);
    standIn();
    const tick: CronTickContext = {
      job: 'append daily weather archive',
      startedAt: T0 - 5,
      trigger: 'cron',
    };
    const res = await maybeRefreshFilterTierHandler(actionCtx(t), {}, tick);
    await drain(t);
    expect(opens()).toEqual([
      expect.objectContaining({ job: tick.job, startedAt: tick.startedAt, trigger: 'cron' }),
    ]);
    const runId = steps()[0]?.runId;
    expect(res.cronReport).toMatchObject({ worked: true, runId, season: expect.any(String) });
    // The head opened its batch's branch, the batch closed it; the head's own is left for the
    // dispatcher's merge of the returned report.
    expect(steps()).toEqual([
      expect.objectContaining({ runId, opened: 1 }),
      expect.objectContaining({ runId, closed: 1 }),
    ]);
    expect(steps()[1]?.opened).toBeUndefined();
    expect(openAfter()).toBe(1);
  });

  test('a manual press carries its presser', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 1);
    standIn();
    const byUserId = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'admin',
        displayName: 'Admin',
        username: 'admin',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
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
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'admin' as const,
        status: 'active' as const,
        createdAt: 0,
      }),
    );
    await maybeRefreshFilterTierHandler(
      actionCtx(t),
      {},
      { job: 'append daily weather archive', startedAt: T0, trigger: 'manual', byUserId },
    );
    expect(opens()[0]).toMatchObject({ trigger: 'manual', byUserId });
  });

  test('busy: a manual press is skipped with a quiet report; a cron tick does its work unrecorded', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 3);
    const urls = standIn();
    rec.busy = await anyRun(t);
    const press = await maybeRefreshFilterTierHandler(
      actionCtx(t),
      {},
      {
        job: 'append daily weather archive',
        startedAt: T0,
        trigger: 'manual',
      },
    );
    await drain(t);
    expect(press).toMatchObject({
      started: false,
      cronReport: { worked: false, detail: 'A run of this job is already going' },
    });
    expect(urls).toHaveLength(0);
    // The schedule's tick: every cell asked for, nothing stepped into the busy run.
    const tick = await maybeRefreshFilterTierHandler(
      actionCtx(t),
      {},
      {
        job: 'append daily weather archive',
        startedAt: T0,
        trigger: 'cron',
      },
    );
    await drain(t);
    expect(tick).toMatchObject({ started: true, cronReport: { worked: true } });
    expect(tick.cronReport).not.toHaveProperty('runId');
    expect(urls).toHaveLength(3);
    // And a head with no tick (an operator's call) does the same.
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    expect(urls).toHaveLength(6);
    expect(steps()).toHaveLength(0);
  });

  test('a head that throws closes its run with the error (no tick), and rethrows', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 1);
    const ctx = actionCtx(t);
    (ctx as { runAction: unknown }).runAction = async () => {
      throw new Error('batch died: https://x/?latitude=1');
    };
    await expect(maybeRefreshFilterTierHandler(ctx, {})).rejects.toThrow('batch died');
    // The dead inline batch's branch, then the head's own: every branch closed, the run failed.
    expect(steps()).toEqual([
      expect.objectContaining({ runId: expect.any(String), opened: 1 }),
      { runId: expect.any(String), closed: 1, head: true, error: 'batch died: https://x/' },
      { runId: expect.any(String), closed: 1, head: true, error: 'batch died: https://x/' },
    ]);
    expect(openAfter()).toBe(0);
  });

  test('with a tick, the thrown error carries the run for the recorder to close failed', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 1);
    const ctx = actionCtx(t);
    (ctx as { runAction: unknown }).runAction = async () => {
      throw new Error('boom');
    };
    const err = await maybeRefreshFilterTierHandler(
      ctx,
      {},
      {
        job: 'append daily weather archive',
        startedAt: T0,
        trigger: 'cron',
      },
    ).catch((e: unknown) => e);
    expect((err as { cronReport?: unknown }).cronReport).toMatchObject({
      worked: true,
      runId: expect.any(String),
    });
    // The branch it opened for the batch that never reported is closed by the head; its own is
    // left for the recorder's merge of the thrown report.
    expect(steps()).toEqual([
      expect.objectContaining({ runId: expect.any(String), opened: 1 }),
      { runId: expect.any(String), closed: 1, head: true, error: 'boom' },
    ]);
    expect(openAfter()).toBe(1);
  });

  test('out of season: a quiet tick, no run opened', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 1);
    const urls = standIn();
    const res = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    expect(res.cronReport).toEqual({ worked: false });
    expect(opens()).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });

  test('a digest rebuild that throws is counted, and the batch goes on', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 2);
    standIn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rec.digestThrows = 'any';
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    expect(summed()).toMatchObject({ cellsStored: 2, digestFailed: 2 });
  });
});

describe('the bay append reports the same, over bays', () => {
  test('one page: the head’s batch opens nothing, the head closes', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    // No live bays: one empty page.
    const urls = standIn();
    await t.action(internal.weatherArchive.maybeRefreshBayTier, {});
    await drain(t);
    expect(opens()[0]).toMatchObject({ job: 'append daily bay weather archive' });
    expect(steps()).toHaveLength(3);
    expect(steps()[0]).toMatchObject({ opened: 1 });
    expect(steps()[1]?.opened).toBeUndefined();
    expect(steps()[1]).toMatchObject({ closed: 1 });
    expect(steps()[2]).toMatchObject({ closed: 1, head: true });
    expect(steps()[0]?.lines?.map((l) => l.text)).toEqual(['14-day append · every live bay']);
    expect(steps()[1]?.lines?.map((l) => l.text)).toEqual([
      'Done in 1 step · 0 of 0 bays stored, 0 failed',
    ]);
    expect(openAfter()).toBe(0);
    expect(urls).toHaveLength(0);
  });
});

// ─── The registry walk ──────────────────────────────────────────────────────────────────────────

describe('the registry walk stamps the registry’s size', () => {
  test('a complete walk stamps cellCount and pruned on both tiers; a run with both branches', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('weatherCells', {
        cellKey: 'vacated',
        tier: 'filter',
        lat: 40,
        lng: -70,
        bodyCount: 1,
        runId: 'old',
        updatedAt: 0,
      });
    });
    const res = await t.action(internal.weatherArchive.maybeSyncWeatherCells, {});
    await drain(t);
    expect(res.tiers).toEqual([
      { tier: 'browse', pruned: 0 },
      { tier: 'filter', pruned: 1 },
    ]);
    const syncs = await t.run((ctx) => ctx.db.query('weatherCellSyncs').collect());
    expect(syncs.map((s) => [s.tier, s.cellCount, s.pruned]).sort()).toEqual([
      ['browse', 0, 0],
      ['filter', 0, 1],
    ]);
    expect(opens()).toEqual([
      expect.objectContaining({
        job: 'reconcile weather cell registry',
        detail: 'Walk started by hand',
      }),
    ]);
    expect(summed()).toMatchObject({ pruned: 1, cellsFilter: 0, cellsBrowse: 0, writesFailed: 0 });
    expect(openAfter()).toBe(0);
    const lines = steps()
      .flatMap((s) => s.lines ?? [])
      .map((l) => l.text);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Filter: walking the corpus',
        'Filter: 0 cells registered, 1 pruned',
        'Browse: 0 cells registered, 0 pruned',
      ]),
    );
  });

  test('a walk with a failing page stamps nothing and says so', async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert('weatherCellSyncs', {
        tier: 'filter',
        runId: 'prev',
        startedAt: 0,
        completedAt: 1,
        cellCount: 7,
        pruned: 2,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('jobFailures', {
        job: 'weatherCells',
        key: 'cell:filter:x',
        scope: 'filter',
        errorClass: 'Error',
        attempts: 1,
        firstFailedAt: T0 + 1,
        lastFailedAt: T0 + 1,
      } as never),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await t.action(internal.weatherArchive.backfillWeatherCells, {
      tier: 'filter',
      startedAt: T0,
      cronRun: { runId: await anyRun(t), step: 1 },
    });
    const sync = await t.run((ctx) => ctx.db.query('weatherCellSyncs').first());
    expect(sync).toMatchObject({ cellCount: 7, pruned: 2 });
    expect(steps()[0]?.lines?.map((l) => l.text)).toEqual([
      "Filter: nothing pruned — a page's writes failed, so the walk isn't complete",
    ]);
    expect(steps()[0]).toMatchObject({ closed: 1 });
  });

  test('a walk an import scheduled is a chained manual run; one already answered opens none', async () => {
    const t = convexTest(schema, modules);
    await maybeSyncWeatherCellsHandler(actionCtx(t), { requestedAt: T0 - 1 });
    expect(opens()[0]).toMatchObject({ trigger: 'manual', detail: 'After a corpus load' });
    rec.opens.length = 0;
    const again = await maybeSyncWeatherCellsHandler(actionCtx(t), { requestedAt: T0 - 1 });
    expect(again).toMatchObject({ skipped: 'already reconciled', cronReport: { worked: false } });
    expect(opens()).toHaveLength(0);
  });

  test('a superseded walk says so and stops', async () => {
    const t = convexTest(schema, modules);
    await seedBodyAt(t);
    // A newer walk owns the tier: this page's write finds it superseded.
    vi.spyOn(recurringWork, 'runItem').mockResolvedValue({
      ok: true,
      value: { superseded: true },
    } as never);
    const res = await t.action(internal.weatherArchive.backfillWeatherCells, {
      tier: 'filter',
      cronRun: { runId: await anyRun(t), step: 4 },
    });
    expect(res).toMatchObject({ superseded: true });
    expect(steps()).toEqual([
      expect.objectContaining({
        closed: 1,
        counts: expect.objectContaining({ superseded: 1 }),
        lines: [
          expect.objectContaining({ text: 'Filter: a newer walk took over; this one stopped' }),
        ],
      }),
    ]);
  });
});

async function seedBodyAt(t: T) {
  await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'A',
      searchText: 'A',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-72.01, 44],
            [-72, 44],
            [-72, 44.01],
            [-72.01, 44],
          ],
        ],
      },
      bbox: { minLat: 44, minLng: -72.01, maxLat: 44.01, maxLng: -72 },
      centroid: { lat: 44.005, lng: -72.005 },
      interiorPoint: { lat: 44.005, lng: -72.005 },
      dedupStatus: 'clean' as const,
      createdAt: 0,
    }),
  );
}

async function anyRun(t: T): Promise<Id<'cronRuns'>> {
  return await t.run((ctx) =>
    ctx.db.insert('cronRuns', {
      job: 'x',
      startedAt: T0,
      finishedAt: T0,
      outcome: 'ok',
      trigger: 'manual',
      keepUntil: T0 + DAY_MS,
    }),
  );
}

// ─── NWS alerts and hazard weather ──────────────────────────────────────────────────────────────

function nwsFeature(id: string) {
  return {
    properties: {
      id,
      event: 'Winter Storm Warning',
      severity: 'Severe',
      affectedZones: ['https://api.weather.gov/zones/forecast/VTZ001'],
    },
  };
}

describe('NWS alerts: a run row only on a change or a failure', () => {
  test('a poll that changes nothing is a quiet tick; one that does says what started and ended', async () => {
    const t = convexTest(schema, modules);
    let ids: string[] = ['a1'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const state = new URL(url).searchParams.get('area');
        return new Response(
          JSON.stringify({ features: state === 'VT' ? ids.map(nwsFeature) : [] }),
          { status: 200 },
        );
      }),
    );
    const first = await t.action(internal.weatherAlerts.refreshAlerts, {});
    expect(first.cronReport).toMatchObject({
      worked: true,
      counts: { states: 5, statesFailed: 0, active: 1, started: 1, ended: 0 },
    });
    const quiet = await t.action(internal.weatherAlerts.refreshAlerts, {});
    expect(quiet.cronReport).toMatchObject({ worked: false, counts: { started: 0, ended: 0 } });
    ids = ['a2'];
    const changed = await t.action(internal.weatherAlerts.refreshAlerts, {});
    expect(changed.cronReport).toMatchObject({
      worked: true,
      counts: { active: 1, started: 1, ended: 1 },
    });
  });

  test('each state that failed, under its cause, keyed by state; its alerts kept', async () => {
    const t = convexTest(schema, modules);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const faults: Record<string, () => Response> = {
      VT: () => new Response('down', { status: 503 }),
      NH: () => {
        throw new TypeError('fetch failed');
      },
      ME: () => new Response('{"features": [', { status: 200 }),
      NY: () => new Response('slow', { status: 429 }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const state = new URL(url).searchParams.get('area') ?? '';
        const f = faults[state];
        return f ? f() : new Response(JSON.stringify({ features: [] }), { status: 200 });
      }),
    );
    const pending = t.action(internal.weatherAlerts.refreshAlerts, {});
    await vi.advanceTimersByTimeAsync(10_000); // the 429's courtesy pause
    const res = await pending;
    expect(res.cronReport).toMatchObject({
      worked: true,
      detail: '1 of 5 states refreshed',
      counts: { states: 1, statesFailed: 4 },
    });
    expect(
      Object.fromEntries((res.cronReport.causes ?? []).map((c) => [c.cause, c.sampleKey])),
    ).toEqual({ serverError: 'VT', unreachable: 'NH', badAnswer: 'ME', rateLimit: 'NY' });
    expect(res.cronReport.lines?.map((l) => l.text)).toContain(
      "VT wasn't refreshed (server error): its alerts are kept",
    );
    // The job's own count keeps its meaning: writes that threw.
    expect(res.statesFailed).toBe(0);
  });
});

describe('hazard weather reports what it refreshed, skipped and failed', () => {
  test('a tick with nothing due is quiet', async () => {
    const t = convexTest(schema, modules);
    const res = await t.action(internal.hazardWeather.refreshHazardWeather, {});
    expect(res.cronReport).toMatchObject({
      worked: false,
      counts: { refreshed: 0, skipped: 0, failed: 0, calls: 0, weighted: 0 },
    });
  });
});

// ─── The gap repair: the partial-day refetch (fork 2 (b)) ──────────────────────────────────────

const DAY0 = Math.floor(T0 / DAY_MS) * DAY_MS; // UTC today (20 Jan)
const ago = (n: number) => DAY0 - n * DAY_MS;

interface SeedDay {
  day: number;
  hours?: number;
  fetchedAt?: number;
  missing?: boolean;
  utcOffsetSeconds?: number;
  timeZone?: string;
  source?: 'forecast' | 'borrowed';
}

/** Rows for cell `i`: complete days `from…to` days ago (fetched late), with `over` replacing some. */
async function seedDays(
  t: T,
  i: number,
  from: number,
  to: number,
  over: SeedDay[] = [],
  tier: 'filter' | 'browse' = 'filter',
) {
  const byDay = new Map<number, SeedDay>();
  for (let n = from; n >= to; n--) byDay.set(ago(n), { day: ago(n), hours: 24 });
  for (const o of over) byDay.set(o.day, o);
  await t.run(async (ctx) => {
    for (const d of byDay.values()) {
      if (d.hours === undefined && !d.missing) continue; // a hole: no row
      await ctx.db.insert('weatherDays', {
        cellKey: cellKey(i),
        tier,
        dayMs: d.day,
        localDate: isoDate(d.day),
        source: d.source ?? 'forecast',
        fetchedAt: d.fetchedAt ?? d.day + 2 * DAY_MS,
        ...(d.missing ? { missing: true } : { hours: d.hours }),
        ...(d.utcOffsetSeconds !== undefined ? { utcOffsetSeconds: d.utcOffsetSeconds } : {}),
        ...(d.timeZone !== undefined ? { timeZone: d.timeZone } : {}),
      });
    }
  });
}

/** A partial day written by an append while the day was still under way (eligible). */
const written = (day: number, hours = 10): SeedDay => ({
  day,
  hours,
  fetchedAt: day + 7 * HOUR_MS,
  utcOffsetSeconds: 0,
});
/** A hole: no row. */
const hole = (day: number): SeedDay => ({ day });

async function dayRow(t: T, i: number, day: number) {
  return await t.run((ctx) =>
    ctx.db
      .query('weatherDays')
      .withIndex('by_cell_day', (q) => q.eq('cellKey', cellKey(i)).eq('dayMs', day))
      .first(),
  );
}

/** Set today's Open-Meteo meter, so a run's budget is what a test needs. */
async function meterAt(t: T, weighted: number) {
  await t.run((ctx) =>
    ctx.db.insert('externalApiCalls', {
      provider: 'open-meteo',
      dayMs: DAY0,
      calls: 1,
      weightedCalls: weighted,
      updatedAt: T0,
    }),
  );
}

async function sweep(t: T, tier: 'filter' | 'browse' = 'filter') {
  const res = await t.action(internal.weatherArchive.sweepWeatherDayGaps, {
    tier,
    cronRun: { runId: await anyRun(t), step: 1 },
  });
  await drain(t);
  return res;
}

describe('the gap repair completes partial past days (fork 2 (b))', () => {
  test('the budget: a run spends at most PARTIAL_REPAIR_BUDGET, and less on a day the meter has already spent', () => {
    expect(PARTIAL_REPAIR_BUDGET).toBe(2_000);
    expect(PARTIAL_REPAIR_DAY_CEILING).toBe(7_000);
    // ×10, split 80/20 between the tiers.
    expect(partialBudgetFor('filter', 0)).toBe(16_000);
    expect(partialBudgetFor('browse', 0)).toBe(4_000);
    expect(partialBudgetFor('filter', 5_500)).toBe(12_000);
    expect(partialBudgetFor('filter', 7_000)).toBe(0);
    expect(partialBudgetFor('filter', 9_000)).toBe(0);
  });

  test('holes and partial days in one cell: exactly one request, of the span the oldest sets', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 1);
    await seedDays(t, 0, 19, 1, [hole(ago(10)), written(ago(15)), written(ago(5))]);
    const urls = standIn();
    await sweep(t);
    expect(urls).toHaveLength(1);
    // From the oldest partial day (15 days back): ceil(14) + 2.
    expect(pastDaysOf(urls[0] ?? '')).toBe(16);
    expect((await dayRow(t, 0, ago(15)))?.hours).toBe(24);
    expect((await dayRow(t, 0, ago(5)))?.hours).toBe(24);
    expect((await dayRow(t, 0, ago(10)))?.hours).toBe(24);
    expect(summed()).toMatchObject({
      holes: 1,
      filled: 1,
      partialDays: 2,
      partialFilled: 2,
      calls: 1,
      weighted: 24,
      // Named for the run's fold: the smallest kept.
      oldestPartialDay: ago(15),
    });
  });

  test('a partial day the refetch leaves short keeps its hours, is never written missing, and is never asked for again', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 1);
    await seedDays(t, 0, 10, 1, [written(ago(4), 10)]);
    const short = isoDate(ago(4));
    const urls = standIn(
      () => null,
      (date) => (date === short ? 12 : 24),
    );
    await sweep(t);
    expect(urls).toHaveLength(1);
    const row = await dayRow(t, 0, ago(4));
    expect(row?.hours).toBe(12);
    expect(row?.missing).toBeUndefined();
    expect(summed()).toMatchObject({ partialDays: 1, partialStill: 1 });
    // The next run: the row was written after its day ended, so it is left as it is.
    rec.steps.length = 0;
    await sweep(t);
    expect(urls).toHaveLength(1);
    expect(summed()).toMatchObject({ partialDays: 1, partialLeft: 1 });
    expect(summed().partialStill).toBeUndefined();
  });

  test('the budget edge: refetches that fit exactly are made, oldest partial day first; the rest wait', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 4);
    // Every refetch here weighs 1.2 (12 ×10); a budget of 3 run-wide is 24 for the filter tier.
    await meterAt(t, PARTIAL_REPAIR_DAY_CEILING - 3);
    await seedDays(t, 0, 6, 1, [written(ago(2))]);
    await seedDays(t, 1, 6, 1, [written(ago(2))]);
    await seedDays(t, 2, 6, 1, [written(ago(3))]);
    await seedDays(t, 3, 6, 1, [written(ago(1))]);
    const urls = standIn();
    await sweep(t);
    // Oldest first (c002, 3 days back), then the next oldest by key (c000); c001 and c003 wait.
    expect(urls.map(indexOf)).toEqual([2, 0]);
    expect(summed()).toMatchObject({ partialDays: 4, partialFilled: 2, partialDeferred: 2 });
    expect((await dayRow(t, 1, ago(2)))?.hours).toBe(10);
  });

  test('one call over the budget waits for the next run', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 2);
    await meterAt(t, PARTIAL_REPAIR_DAY_CEILING - 2); // 16 for filter: one refetch of 12
    await seedDays(t, 0, 6, 1, [written(ago(2))]);
    await seedDays(t, 1, 6, 1, [written(ago(2))]);
    const urls = standIn();
    await sweep(t);
    expect(urls.map(indexOf)).toEqual([0]);
    expect(summed()).toMatchObject({ partialFilled: 1, partialDeferred: 1 });
  });

  test('a day past the meter’s ceiling refetches no partial day, but still repairs holes', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 2);
    await meterAt(t, PARTIAL_REPAIR_DAY_CEILING);
    await seedDays(t, 0, 20, 1, [hole(ago(3)), written(ago(18))]);
    await seedDays(t, 1, 6, 1, [written(ago(2))]);
    const urls = standIn();
    await sweep(t);
    // Cell 0's hole request is made as before (from its hole), not reaching back to the 18th.
    expect(urls.map(indexOf)).toEqual([0]);
    expect(pastDaysOf(urls[0] ?? '')).toBe(4);
    expect((await dayRow(t, 0, ago(18)))?.hours).toBe(10);
    expect(summed()).toMatchObject({ filled: 1, partialDays: 2, partialDeferred: 2 });
  });

  test('a cell with no partial days asks exactly what it asked before', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 2);
    await seedDays(t, 0, 12, 1, [hole(ago(7))]);
    await seedDays(t, 1, 12, 1);
    const urls = standIn();
    await sweep(t);
    expect(urls.map(indexOf)).toEqual([0]);
    expect(pastDaysOf(urls[0] ?? '')).toBe(Math.ceil((ago(1) - ago(7)) / DAY_MS) + 2);
    expect(summed()).toMatchObject({ holes: 1, filled: 1, partialDays: 0 });
  });

  test("the lake's today is never a gap, even when it is UTC-yesterday", async () => {
    // 02:00 UTC is 21:00 the evening before at the lake: UTC-yesterday is still under way there.
    vi.setSystemTime(Date.UTC(2026, 0, 20, 2));
    const t = convexTest(schema, modules);
    await seedCells(t, 1);
    const lakeToday = Date.UTC(2026, 0, 19);
    await t.run(async (ctx) => {
      for (let n = 1; n <= 5; n++) {
        const d = lakeToday - n * DAY_MS;
        await ctx.db.insert('weatherDays', {
          cellKey: cellKey(0),
          tier: 'filter',
          dayMs: d,
          localDate: isoDate(d),
          source: 'forecast',
          hours: 24,
          fetchedAt: d + 2 * DAY_MS,
          timeZone: 'America/New_York',
          utcOffsetSeconds: -18_000,
        });
      }
      await ctx.db.insert('weatherDays', {
        cellKey: cellKey(0),
        tier: 'filter',
        dayMs: lakeToday,
        localDate: isoDate(lakeToday),
        source: 'forecast',
        hours: 21,
        fetchedAt: Date.UTC(2026, 0, 20, 1),
        timeZone: 'America/New_York',
        utcOffsetSeconds: -18_000,
      });
    });
    const urls = standIn();
    await sweep(t);
    expect(urls).toHaveLength(0);
    expect(summed().partialDays).toBe(0);
  });

  test('a day at the DST change: 23 hours is complete; a short one is judged by that date’s own end', async () => {
    vi.setSystemTime(Date.UTC(2026, 2, 12, 10));
    const t = convexTest(schema, modules);
    await seedCells(t, 3);
    const spring = Date.UTC(2026, 2, 8); // 2 AM EST → 3 AM EDT: a 23-hour day
    const zone = { timeZone: 'America/New_York', utcOffsetSeconds: -18_000 };
    const rows = async (i: number, hours: number, fetchedAt: number) =>
      t.run(async (ctx) => {
        for (let n = 1; n <= 4; n++) {
          const d = Date.UTC(2026, 2, 12) - n * DAY_MS;
          await ctx.db.insert('weatherDays', {
            cellKey: cellKey(i),
            tier: 'filter',
            dayMs: d,
            localDate: isoDate(d),
            source: 'forecast',
            hours: d === spring ? hours : 24,
            fetchedAt: d === spring ? fetchedAt : d + 2 * DAY_MS,
            ...zone,
            ...(d > spring ? { utcOffsetSeconds: -14_400 } : {}),
          });
        }
      });
    // The spring day's stored offset is its start's (EST): its end reads 05:00 UTC on the 9th.
    await rows(0, 23, Date.UTC(2026, 2, 8, 20)); // complete: never partial
    await rows(1, 22, Date.UTC(2026, 2, 8, 20)); // written during the day: refetched
    await rows(2, 22, Date.UTC(2026, 2, 9, 6)); // written after it ended: left as it is
    const urls = standIn();
    await sweep(t);
    expect(urls.map(indexOf)).toEqual([1]);
    expect(summed()).toMatchObject({ partialDays: 2, partialFilled: 1, partialLeft: 1 });
  });

  test('a browse partial day is never borrowed over and never written missing', async () => {
    const t = convexTest(schema, modules);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCells(t, 1, 'browse');
    await seedDays(t, 0, 8, 1, [hole(ago(3)), written(ago(5), 9)], 'browse');
    // Open-Meteo down: the hole falls through the ladder, the partial day stays as it was.
    standIn(() => '503');
    await sweep(t, 'browse');
    const partial = await dayRow(t, 0, ago(5));
    expect(partial).toMatchObject({ hours: 9, source: 'forecast' });
    expect(partial?.missing).toBeUndefined();
    expect((await dayRow(t, 0, ago(3)))?.missing).toBe(true);
    expect(summed()).toMatchObject({ partialStill: 1, stillMissing: 1, oldestOpenDay: ago(3) });
    expect(mergedCauses().get('serverError')?.count).toBe(1);
  });

  test('the two-tier repair is one run, both branches closed, each tier’s end line', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedCells(t, 45);
    await seedDays(t, 0, 6, 1, [written(ago(2))]);
    await seedDays(t, 44, 6, 1, [hole(ago(3))]);
    standIn();
    const res = await maybeSweepGapsHandler(actionCtx(t), {});
    await drain(t);
    expect(res).toMatchObject({ started: true });
    expect(opens()).toEqual([
      expect.objectContaining({ job: 'repair weather archive gaps', detail: 'Gap repair' }),
    ]);
    expect(openAfter()).toBe(0);
    const lines = steps()
      .flatMap((s) => s.lines ?? [])
      .map((l) => l.text);
    // Each tier's start line opens its branch: the tiers run in registry order, browse first.
    expect(lines[0]).toBe('Browse: checking the registered cells');
    expect(lines).toContain('Filter: checking the registered cells');
    expect(lines).toContain(
      'Filter: 45 cells checked · 1 days not recorded, 1 fetched, 0 borrowed, 0 still not recorded · 1 partial days, 1 completed, 0 still partial, 0 left for the next run, 0 left as they are',
    );
    expect(lines.some((l) => l.startsWith('Browse: 0 cells checked'))).toBe(true);
    expect(summed()).toMatchObject({ cellsChecked: 45, cellsUntouched: 43 });
  });

  test('the counts always add up: found = completed + still partial + deferred + left', async () => {
    const t = convexTest(schema, modules);
    await seedCells(t, 5);
    await meterAt(t, PARTIAL_REPAIR_DAY_CEILING - 3); // two refetches
    await seedDays(t, 0, 10, 1, [written(ago(9)), written(ago(4))]);
    await seedDays(t, 1, 10, 1, [written(ago(8))]);
    await seedDays(t, 2, 10, 1, [written(ago(7)), { day: ago(6), hours: 5, fetchedAt: ago(1) }]);
    await seedDays(t, 3, 10, 1, [written(ago(3))]);
    await seedDays(t, 4, 10, 1, [hole(ago(2)), written(ago(6))]);
    standIn(
      () => null,
      (date) => (date === isoDate(ago(7)) ? 3 : 24),
    );
    await sweep(t);
    const c = summed();
    expect(c.partialDays).toBe(
      (c.partialFilled ?? 0) +
        (c.partialStill ?? 0) +
        (c.partialDeferred ?? 0) +
        (c.partialLeft ?? 0),
    );
    expect(c.partialDays).toBe(7);
  });
});

// ─── The edges ──────────────────────────────────────────────────────────────────────────────────

describe('the edges of a run', () => {
  test('a thrown non-Error reads as its string', () => {
    expect(thrownText('plain')).toBe('plain');
    expect(thrownText(new RangeError(''))).toBe('RangeError');
  });

  test('a write that throws is writeFailed, the cell counted failed, the batch going on', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 2);
    standIn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rec.writeThrows = true;
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    // A cold start: 14 past days and today, two billing units (2.4 each).
    expect(summed()).toMatchObject({ cells: 2, cellsFailed: 2, calls: 2, weighted: 48 });
    expect([...mergedCauses().keys()]).toEqual(['writeFailed']);
    expect(rec.failures).toEqual([]);
  });

  test('a refetch whose write throws is counted, and its partial days stay as they were', async () => {
    const t = harness();
    await seedCells(t, 1);
    await seedDays(t, 0, 8, 1, [hole(ago(3)), written(ago(2))]);
    standIn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rec.writeThrows = true;
    await sweep(t);
    expect(summed()).toMatchObject({ holes: 1, calls: 1, partialStill: 1, stillMissing: 1 });
    expect(mergedCauses().get('writeFailed')?.count).toBe(1);
    expect((await dayRow(t, 0, ago(2)))?.hours).toBe(10);
  });

  test('an answer with times but no usable hour is emptyAnswer', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ hourly: { time: [Math.floor(T0 / 1000)], temperature_2m: [null] } }),
            { status: 200 },
          ),
      ),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    expect(mergedCauses().get('emptyAnswer')).toMatchObject({
      count: 1,
      sampleText: 'Open-Meteo answered with no usable hour',
    });
  });

  test('a run that couldn’t be opened: every job still does its work, unreported', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 2);
    await seedDays(t, 0, 6, 1, [hole(ago(3))]);
    const urls = standIn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rec.openThrows = true;
    // The repair first, while the hole is still there for it (the append's fortnight would fill it).
    const gaps = await t.action(internal.weatherArchive.maybeSweepGaps, {});
    const append = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    const bays = await t.action(internal.weatherArchive.maybeRefreshBayTier, {});
    const walk = await t.action(internal.weatherArchive.maybeSyncWeatherCells, {});
    await drain(t);
    expect(append).toMatchObject({ started: true, cronReport: { worked: true } });
    expect(bays.cronReport.worked).toBe(true);
    expect(gaps).toMatchObject({
      started: true,
      cronReport: { worked: true, detail: 'Gap repair' },
    });
    expect(walk.cronReport).toEqual({ worked: true, detail: 'Walk started by hand' });
    expect(steps()).toEqual([]);
    // The append's two cells and the repair's one hole were all asked for.
    expect(urls).toHaveLength(3);
  });

  test('a step that couldn’t be recorded changes nothing the job does', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 45);
    const urls = standIn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rec.stepThrows = true;
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    expect(urls).toHaveLength(45);
  });

  test('busy: a repair, a bay append or a walk pressed by hand is skipped; with no tick it does its work', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 1);
    await seedDays(t, 0, 6, 1, [hole(ago(3))]);
    const urls = standIn();
    rec.busy = await anyRun(t);
    const press = (job: string): CronTickContext => ({ job, startedAt: T0, trigger: 'manual' });
    const ctx = actionCtx(t);
    expect(
      await maybeSweepGapsHandler(ctx, {}, press('repair weather archive gaps')),
    ).toMatchObject({
      started: false,
      reason: 'a run is still going',
      cronReport: { worked: false, detail: 'A run of this job is already going' },
    });
    expect(
      await maybeRefreshBayTierHandler(ctx, {}, press('append daily bay weather archive')),
    ).toMatchObject({ started: false });
    expect(
      await maybeSyncWeatherCellsHandler(ctx, {}, press('reconcile weather cell registry')),
    ).toMatchObject({ skipped: 'a run is still going', tiers: [] });
    expect(urls).toHaveLength(0);
    expect(await t.run((c) => c.db.query('weatherCellSyncs').collect())).toEqual([]);
    // No tick (an import's walk, an operator's call): the work, unrecorded as a chain.
    expect(await t.action(internal.weatherArchive.maybeSweepGaps, {})).toMatchObject({
      started: true,
      cronReport: { worked: true },
    });
    await drain(t);
    expect(urls).toHaveLength(1);
    await maybeSyncWeatherCellsHandler(ctx, { requestedAt: T0 - 1 });
    expect(await t.run((c) => c.db.query('weatherCellSyncs').collect())).toHaveLength(2);
    expect(steps()).toEqual([]);
  });

  test('the repair out of season is a quiet tick; a repair or walk head that throws closes its run', async () => {
    const t = harness();
    expect(await t.action(internal.weatherArchive.maybeSweepGaps, {})).toMatchObject({
      started: false,
      cronReport: { worked: false },
    });
    expect(opens()).toHaveLength(0);
    await openSeason(t);
    const ctx = actionCtx(t);
    (ctx as { runAction: unknown }).runAction = async () => {
      throw new Error('tier died');
    };
    await expect(maybeSweepGapsHandler(ctx, {})).rejects.toThrow('tier died');
    expect(steps()).toEqual([
      expect.objectContaining({ runId: expect.any(String), opened: 1 }),
      { runId: expect.any(String), closed: 1, head: true, error: 'tier died' },
      { runId: expect.any(String), closed: 1, head: true, error: 'tier died' },
    ]);
    expect(openAfter()).toBe(0);
    rec.steps.length = 0;
    await expect(maybeSyncWeatherCellsHandler(ctx, {})).rejects.toThrow('tier died');
    expect(steps()).toEqual([
      expect.objectContaining({ runId: expect.any(String), opened: 1 }),
      { runId: expect.any(String), closed: 1, head: true, error: 'tier died' },
      { runId: expect.any(String), closed: 1, head: true, error: 'tier died' },
    ]);
    expect(openAfter()).toBe(0);
    // With the open failing too, the throw is the job's own.
    rec.openThrows = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(maybeSweepGapsHandler(ctx, {})).rejects.toThrow('tier died');
    await expect(maybeSyncWeatherCellsHandler(ctx, {})).rejects.toThrow('tier died');
  });

  test('a progress line every tenth step', async () => {
    const t = harness();
    await openSeason(t);
    await seedCells(t, 401);
    standIn();
    await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await drain(t);
    const lines = steps()
      .flatMap((s) => s.lines ?? [])
      .map((l) => l.text);
    expect(lines).toContain('Step 10 · 400 cells so far, 400 stored, 0 failed');
    expect(lines.at(-1)).toBe('Done in 11 steps · 401 of 401 cells stored, 0 failed');
    expect(summed()).toMatchObject({ cells: 401, cellsStored: 401 });
    expect(openAfter()).toBe(0);
  }, 60_000);

  test('a queue longer than a batch is refetched a batch at a time; a cell that throws is counted', async () => {
    const t = harness();
    await seedCells(t, 45);
    for (let i = 0; i < 45; i++) await seedDays(t, i, 4, 1, [written(ago(2))]);
    const urls = standIn();
    const real = recurringWork.asItem;
    vi.spyOn(recurringWork, 'asItem').mockImplementation(async (key, work) => {
      // The refetch of the last cell throws (its walk item, earlier, went through).
      if (key === `filter:${cellKey(44)}` && urls.length >= 44) throw new Error('poison');
      return real(key, work);
    });
    await sweep(t);
    expect(urls).toHaveLength(44);
    expect(summed()).toMatchObject({ partialDays: 45, partialFilled: 44, partialStill: 1 });
    expect(openAfter()).toBe(0);
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toMatchObject([
      { job: 'weatherGaps', key: `filter:${cellKey(44)}` },
    ]);
  });

  test('oldest first stops at the first refetch the budget can’t pay, though a cheaper one would fit', async () => {
    const t = harness();
    await seedCells(t, 3);
    // 4.0 run-wide → 32 for filter: one 2.4 refetch (16+ days back) leaves 8, under any refetch.
    await meterAt(t, PARTIAL_REPAIR_DAY_CEILING - 4);
    await seedDays(t, 0, 20, 1, [written(ago(18))]);
    await seedDays(t, 1, 20, 1, [written(ago(17))]);
    await seedDays(t, 2, 20, 1, [written(ago(2))]);
    const urls = standIn();
    await sweep(t);
    expect(urls.map(indexOf)).toEqual([0]);
    expect(summed()).toMatchObject({ partialFilled: 1, partialDeferred: 2, weighted: 24 });
  });
  test('a queued refetch that fails keeps its days partial; digest rebuilds that throw are counted', async () => {
    const t = harness();
    await seedCells(t, 2);
    await seedDays(t, 0, 6, 1, [written(ago(2))]);
    await seedDays(t, 1, 6, 1, [hole(ago(3))]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rec.digestThrows = 'any';
    standIn((i) => (i === 0 ? '503' : null));
    await sweep(t);
    expect(summed()).toMatchObject({ partialStill: 1, filled: 1, digestFailed: 2 });
    expect((await dayRow(t, 0, ago(2)))?.hours).toBe(10);
  });

  test('a batch that pages nothing still ends its branch', async () => {
    const t = harness();
    await seedCells(t, 1);
    await t.action(internal.weatherArchive.refreshTierDays, {
      tier: 'filter',
      afterKey: 'zzz',
      cronRun: { runId: await anyRun(t), step: 2 },
    });
    expect(steps()).toEqual([
      expect.objectContaining({
        closed: 1,
        lines: [
          expect.objectContaining({ text: 'Done in 2 steps · 0 of 0 cells stored, 0 failed' }),
        ],
      }),
    ]);
  });
});
