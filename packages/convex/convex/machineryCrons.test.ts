/**
 * The crons' reads (D343, D347, B01-8b). What matters:
 *
 *  - **One verdict.** Every view's `liveness` is core's `cronLiveness` over the `inputs` it sends,
 *    at the caller's clamped `now`, so the web re-reading the inputs on its own clock agrees.
 *  - **Sparse is honest.** A `sparse` cron's view says so (`record`), its inputs carry the hour's
 *    floor, and its hour-old quiet tick is on time; its strip is what was recorded.
 *  - **Every read is admin's** and bounded (the harness counts ranges and documents read, and one
 *    `.paginate()` per execution).
 *
 * The recorder (`cronRuns.ts`) is another builder's: these tests write `cronHeartbeats`,
 * `cronTicks`, `cronRuns` and `runEvents` rows directly, as the design's write rules have the
 * dispatchers write them (ticks packed by core's `packTick`; an hourly bucket for a job ticking more
 * often than every 30 minutes, a daily one otherwise; at most 60 ticks a row).
 */
import {
  CRON_SPARSE_QUIET_FLOOR_MS,
  CRON_TICK_CODES,
  cronLiveness,
  cronTickBucketMs,
  cronTickBucketStart,
  packTick,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { CRON_JOBS, cronPeriodMs, FREQUENT_CRON_RECORD } from './cronJobs';
import { CRON_JOB_NAMES, RUNS_PAGE_SIZE, STRIP_MAX_TICKS, STRIP_ROWS } from './machineryCrons';
import { EVENTS_PAGE_SIZE } from './machineryRuns';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Friday 27 November 2026, 14:00 UTC. */
const NOW = Date.UTC(2026, 10, 27, 14, 0);

const POLL = 'poll for new satellite imagery';
const PUMP = 'pump live satellite imagery';
const INDEX = 'rebuild the live imagery index';
const WATCH = 'watch for the imagery season to open';
const FLUSH = 'flush notification queue';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const NOTIF_PREFS = {
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
};

let seq = 0;
async function seedUser(t: T, role: 'member' | 'moderator' | 'admin', name: string = role) {
  const subject = `crons-${role}-${seq++}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: name,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: NOW - 400 * DAY,
      profileImageUrl: `https://img/${subject}`,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

type Heartbeat = Omit<Doc<'cronHeartbeats'>, '_id' | '_creationTime' | 'job'>;
async function seedHeartbeat(t: T, job: string, hb: Heartbeat) {
  return await t.run((ctx) => ctx.db.insert('cronHeartbeats', { job, ...hb }));
}

type Run = Partial<Omit<Doc<'cronRuns'>, '_id' | '_creationTime'>>;
async function seedRun(t: T, job: string, over: Run = {}): Promise<Id<'cronRuns'>> {
  return await t.run((ctx) =>
    ctx.db.insert('cronRuns', {
      job,
      startedAt: NOW - HOUR,
      finishedAt: NOW - HOUR + 2_000,
      outcome: 'ok',
      trigger: 'cron',
      keepUntil: NOW + 30 * DAY,
      ...over,
    }),
  );
}

/** Ticks written as the recorder writes them: one row per bucket, packed, durations in step. */
async function seedTicks(t: T, job: string, ticks: { at: number; code: number; ms?: number }[]) {
  const entry = CRON_JOBS.find((j) => j.name === job);
  if (entry === undefined) throw new Error(`no cron ${job}`);
  const bucketMs = cronTickBucketMs(cronPeriodMs(entry.schedule));
  const rows = new Map<number, { ticks: number[]; ms: number[] }>();
  for (const tick of [...ticks].sort((a, b) => a.at - b.at)) {
    const start = cronTickBucketStart(tick.at, bucketMs);
    const row = rows.get(start) ?? { ticks: [], ms: [] };
    row.ticks.push(packTick((tick.at - start) / 1000, tick.code));
    row.ms.push(tick.ms ?? 40);
    if (row.ticks.length > 60) throw new Error('a tick row holds at most 60');
    rows.set(start, row);
  }
  await t.run(async (ctx) => {
    for (const [bucketStart, row] of rows) {
      await ctx.db.insert('cronTicks', {
        job,
        bucketStart,
        bucketMs,
        ...row,
        keepUntil: bucketStart + 35 * DAY,
      });
    }
  });
}

const page = (numItems: number, cursor: string | null = null) => ({ numItems, cursor });

describe('who reads', () => {
  test('a moderator and a member are refused each read; an admin is served', async () => {
    const t = harness();
    const runId = await seedRun(t, PUMP);
    const reads = (as: Awaited<ReturnType<typeof seedUser>>['as']) => [
      as.query(api.machineryCrons.jobs, { names: [PUMP] }),
      as.query(api.machineryCrons.strip, { job: PUMP, from: NOW - HOUR, to: NOW }),
      as.query(api.machineryCrons.runsPage, { job: PUMP, filter: 'all', paginationOpts: page(5) }),
      as.query(api.machineryCrons.runLog, { runId, paginationOpts: page(5) }),
    ];
    for (const role of ['moderator', 'member'] as const) {
      const { as } = await seedUser(t, role);
      for (const read of reads(as)) await expect(read).rejects.toThrow();
    }
    for (const read of reads(t)) await expect(read).rejects.toThrow();
    const { as } = await seedUser(t, 'admin');
    for (const read of reads(as)) await expect(read).resolves.toBeDefined();
  });
});

describe('jobs', () => {
  test('every registered cron reads never before its first tick, its entry’s facts beside it', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const views = await as.query(api.machineryCrons.jobs, { names: [...CRON_JOB_NAMES], now: NOW });
    // As many as the registry holds, whatever that is (a cron added is one more read).
    expect(views).toHaveLength(CRON_JOBS.length);
    expect(views.map((j) => j.job)).toEqual(CRON_JOBS.map((j) => j.name));
    for (const [i, view] of views.entries()) {
      const entry = CRON_JOBS[i] as (typeof CRON_JOBS)[number];
      expect(view.liveness).toEqual({ state: 'never' });
      expect(view.lastRun).toBeNull();
      expect(view.record).toBe(entry.record);
      expect(view.pipeline).toBe(entry.pipeline);
      // A sparse cron's inputs carry the hour's floor; one recorded every tick carries none.
      expect(view.inputs).toEqual(
        entry.record === 'sparse' ? { quietFloorMs: CRON_SPARSE_QUIET_FLOOR_MS } : {},
      );
    }
    // The five crons that tick every one to three minutes are the sparse ones (the founder's fork 1).
    expect(FREQUENT_CRON_RECORD).toBe('sparse');
    expect(views.filter((j) => j.record === 'sparse')).toHaveLength(5);
    expect(views[0]?.title).toBe('Flush notification queue');
  });

  test('in the order asked, each name once, a name not in the registry left out', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const views = await as.query(api.machineryCrons.jobs, {
      names: [INDEX, 'toString', POLL, INDEX, 'no such cron'],
    });
    expect(views.map((j) => j.job)).toEqual([INDEX, POLL]);
    expect(await as.query(api.machineryCrons.jobs, { names: [] })).toEqual([]);
  });

  test('each state, and every verdict is core’s rule over the inputs it sends', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const failedRun = await seedRun(t, POLL, { outcome: 'failed', error: 'catalog 503' });
    // ok: the pump ticked a minute ago.
    await seedHeartbeat(t, PUMP, { lastTickAt: NOW - MINUTE, lastOutcome: 'ok', lastMs: 30 });
    // failed: the poll's last tick failed an hour ago, inside its six hours.
    await seedHeartbeat(t, POLL, {
      lastTickAt: NOW - HOUR,
      lastOutcome: 'failed',
      lastError: 'catalog 503',
      lastRunId: failedRun,
    });
    // late: the index quiet for 25 minutes (2E is 20).
    await seedHeartbeat(t, INDEX, { lastTickAt: NOW - 25 * MINUTE, lastOutcome: 'ok' });
    // running: the hazard refresh began 5 minutes ago; killed: the geometry began 20 minutes ago.
    await seedHeartbeat(t, 'refresh hazard weather', {
      lastTickAt: NOW - HOUR,
      lastOutcome: 'ok',
      runningSince: NOW - 5 * MINUTE,
    });
    await seedHeartbeat(t, 'compute body geometry facts', {
      lastTickAt: NOW - 25 * MINUTE,
      lastOutcome: 'ok',
      runningSince: NOW - 20 * MINUTE,
    });
    // stalled: the bounty expiry quiet for three days (10E is 60 hours).
    await seedHeartbeat(t, 'expire bounties', { lastTickAt: NOW - 3 * DAY, lastOutcome: 'worked' });
    // A daily cron: due 11:30 today, ticked yesterday — late past 12:30, its next time sent.
    await seedHeartbeat(t, WATCH, {
      lastTickAt: Date.UTC(2026, 10, 26, 11, 30, 2),
      lastOutcome: 'ok',
    });
    const names = [
      PUMP,
      POLL,
      INDEX,
      'refresh hazard weather',
      'compute body geometry facts',
      'expire bounties',
      WATCH,
      FLUSH,
    ];
    const views = await as.query(api.machineryCrons.jobs, { names, now: NOW });
    expect(views.map((j) => [j.job, j.liveness.state])).toEqual([
      [PUMP, 'ok'],
      [POLL, 'failed'],
      [INDEX, 'late'],
      ['refresh hazard weather', 'running'],
      ['compute body geometry facts', 'killed'],
      ['expire bounties', 'stalled'],
      [WATCH, 'late'],
      [FLUSH, 'never'],
    ]);
    for (const view of views) {
      expect(view.liveness).toEqual(cronLiveness(view.inputs, view.schedule, NOW));
    }
    const poll = views[1];
    expect(poll?.inputs).toEqual({ lastTickAt: NOW - HOUR, lastOutcome: 'failed' });
    expect(poll?.schedule).toEqual({ every: 6 * HOUR });
    expect(poll?.lastRun).toEqual({
      id: failedRun,
      startedAt: NOW - HOUR,
      outcome: 'failed',
      counts: null,
    });
    expect(views[6]?.liveness).toMatchObject({ nextAt: Date.UTC(2026, 10, 27, 11, 30) });
    expect(views[6]?.schedule).toEqual({ daily: { hourUTC: 11, minuteUTC: 30 } });
  });

  test('a sparse cron’s quiet tick an hour old is on time; two hours of silence is late', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedHeartbeat(t, FLUSH, { lastTickAt: NOW - HOUR - 30_000, lastOutcome: 'ok' });
    const [flush] = await as.query(api.machineryCrons.jobs, { names: [FLUSH], now: NOW });
    expect(flush?.record).toBe('sparse');
    expect(flush?.inputs.quietFloorMs).toBe(HOUR);
    expect(flush?.liveness).toMatchObject({ state: 'ok', expectedMs: HOUR });
    // The web, re-reading the same inputs on its clock two hours on, calls it late.
    expect(
      cronLiveness(flush?.inputs ?? {}, flush?.schedule ?? { every: MINUTE }, NOW + HOUR).state,
    ).toBe('late');
  });

  test('the caller’s clock moves a cron late, but only within a minute of the server’s', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedHeartbeat(t, PUMP, { lastTickAt: NOW - 5 * MINUTE - 30_000, lastOutcome: 'ok' });
    const liveness = async (now?: number) =>
      (
        await as.query(
          api.machineryCrons.jobs,
          now === undefined ? { names: [PUMP] } : { names: [PUMP], now },
        )
      )[0]?.liveness;
    // Five and a half minutes, inside 2E (six): on time by the server's clock and by a bad one.
    expect((await liveness())?.state).toBe('ok');
    expect((await liveness(Number.NaN))?.state).toBe('ok');
    expect((await liveness(NOW - 30 * MINUTE))?.state).toBe('ok');
    // A client a minute on sees it late; one claiming a day on is held to that minute.
    expect((await liveness(NOW + MINUTE))?.state).toBe('late');
    // (The harness's clock moves a millisecond a call, so the quiet is read to the second.)
    const held = await liveness(NOW + DAY);
    expect(held?.state).toBe('late');
    expect(held && 'quietMs' in held ? Math.floor(held.quietMs / 1000) : null).toBe(390);
  });
});

describe('strip', () => {
  test('the pump’s ticks over twelve hours, oldest first, unpacked, nothing outside the range', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const ticks = Array.from({ length: 13 * 20 }, (_, i) => ({
      at: NOW - 13 * HOUR + i * 3 * MINUTE + 4_000,
      code: i % 50 === 7 ? CRON_TICK_CODES.failed : i % 9 === 0 ? CRON_TICK_CODES.worked : 0,
      ms: 30 + i,
    }));
    await seedTicks(t, PUMP, ticks);
    // Another cron's rows are never read into this one's strip.
    await seedTicks(t, INDEX, [{ at: NOW - HOUR, code: 0 }]);
    const from = NOW - 12 * HOUR;
    const strip = await as.query(api.machineryCrons.strip, { job: PUMP, from, to: NOW });
    const expected = ticks.filter((k) => k.at >= from && k.at <= NOW);
    expect(strip.truncated).toBe(false);
    expect(strip.ticks).toEqual(expected.map((k) => ({ at: k.at, code: k.code, ms: k.ms })));
    expect(strip.ticks.some((k) => k.code === CRON_TICK_CODES.failed)).toBe(true);
  });

  test('a daily row that began before the range still gives up the ticks inside it', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // The poll ticks every six hours: a daily bucket. Today's 00:00 row holds 01:00, 07:00, 13:00.
    await seedTicks(t, POLL, [
      { at: Date.UTC(2026, 10, 27, 1), code: 1 },
      { at: Date.UTC(2026, 10, 27, 7), code: 0 },
      { at: Date.UTC(2026, 10, 27, 13), code: 2 },
    ]);
    const strip = await as.query(api.machineryCrons.strip, {
      job: POLL,
      from: Date.UTC(2026, 10, 27, 6),
      to: NOW,
    });
    expect(strip.ticks.map((k) => [k.at, k.code])).toEqual([
      [Date.UTC(2026, 10, 27, 7), 0],
      [Date.UTC(2026, 10, 27, 13), 2],
    ]);
  });

  test('a sparse cron’s strip is what was recorded: one quiet tick an hour, every failure', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    await seedTicks(t, FLUSH, [
      { at: NOW - 3 * HOUR + 20_000, code: 0 },
      { at: NOW - 2 * HOUR + 20_000, code: 0 },
      { at: NOW - 2 * HOUR + 17 * MINUTE, code: CRON_TICK_CODES.failed },
      { at: NOW - HOUR + 20_000, code: 0 },
    ]);
    const strip = await as.query(api.machineryCrons.strip, {
      job: FLUSH,
      from: NOW - 4 * HOUR,
      to: NOW,
    });
    expect(strip.ticks.map((k) => k.code)).toEqual([0, 0, 2, 0]);
  });

  test('bounded: the newest rows and ticks kept, and it says it was cut', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // A row an hour for STRIP_ROWS + 5 hours, one tick each.
    const hours = STRIP_ROWS + 5;
    await seedTicks(
      t,
      PUMP,
      Array.from({ length: hours }, (_, i) => ({ at: NOW - (hours - i) * HOUR + MINUTE, code: 0 })),
    );
    const strip = await as.query(api.machineryCrons.strip, {
      job: PUMP,
      from: NOW - 400 * DAY,
      to: NOW,
    });
    expect(strip.truncated).toBe(true);
    expect(strip.ticks).toHaveLength(STRIP_ROWS);
    expect(strip.ticks.at(-1)?.at).toBe(NOW - HOUR + MINUTE);
    // A range read backwards, or not a number, is empty.
    expect(await as.query(api.machineryCrons.strip, { job: PUMP, from: NOW, to: NOW - 1 })).toEqual(
      {
        ticks: [],
        truncated: false,
      },
    );
    expect(
      await as.query(api.machineryCrons.strip, { job: PUMP, from: Number.NaN, to: NOW }),
    ).toEqual({ ticks: [], truncated: false });
  });

  test('past the tick bound, the newest ticks are kept', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    // A one-minute cron failing every minute: 60 ticks an hour, past the bound in under 90 hours.
    const hours = Math.ceil(STRIP_MAX_TICKS / 60) + 2;
    await t.run(async (ctx) => {
      for (let h = 0; h < hours; h++) {
        const bucketStart = cronTickBucketStart(NOW - (h + 1) * HOUR, HOUR);
        await ctx.db.insert('cronTicks', {
          job: FLUSH,
          bucketStart,
          bucketMs: HOUR,
          ticks: Array.from({ length: 60 }, (_, i) => packTick(i * 60, CRON_TICK_CODES.failed)),
          ms: Array.from({ length: 60 }, () => 5),
          keepUntil: NOW + DAY,
        });
      }
    });
    const strip = await as.query(api.machineryCrons.strip, {
      job: FLUSH,
      from: NOW - 30 * DAY,
      to: NOW,
    });
    expect(strip.truncated).toBe(true);
    expect(strip.ticks).toHaveLength(STRIP_MAX_TICKS);
    expect(strip.ticks.at(-1)?.at).toBe(NOW - HOUR + 59 * MINUTE);
    const ats = strip.ticks.map((k) => k.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });
});

describe('runsPage', () => {
  test('newest first, 25 a page at most, this cron’s only; Failed reads the failed', async () => {
    const t = harness();
    const { as, id: presser } = await seedUser(t, 'admin', 'Sam Presser');
    for (let i = 0; i < 30; i++) {
      await seedRun(t, PUMP, {
        startedAt: NOW - (30 - i) * MINUTE,
        finishedAt: NOW - (30 - i) * MINUTE + 1_000,
        outcome: i % 10 === 3 ? 'failed' : 'ok',
        counts: { landed: i },
      });
    }
    await seedRun(t, POLL, { outcome: 'failed' });
    const manual = await seedRun(t, PUMP, {
      startedAt: NOW - 10_000,
      finishedAt: NOW - 5_000,
      trigger: 'manual',
      byUserId: presser,
      season: 'winter-2026-27',
      detail: 'Started 2 cuts',
    });
    const first = await as.query(api.machineryCrons.runsPage, {
      job: PUMP,
      filter: 'all',
      paginationOpts: page(100),
    });
    expect(first.page).toHaveLength(RUNS_PAGE_SIZE);
    expect(first.isDone).toBe(false);
    expect(first.page[0]).toEqual({
      id: manual,
      job: PUMP,
      startedAt: NOW - 10_000,
      finishedAt: NOW - 5_000,
      outcome: 'ok',
      trigger: 'manual',
      by: { id: presser, name: 'Sam Presser', avatarUrl: expect.stringContaining('https://img/') },
      season: 'winter-2026-27',
      detail: 'Started 2 cuts',
      error: null,
      counts: null,
    });
    expect(first.page[1]).toMatchObject({ by: null, trigger: 'cron', counts: { landed: 29 } });
    const second = await as.query(api.machineryCrons.runsPage, {
      job: PUMP,
      filter: 'all',
      paginationOpts: page(25, first.continueCursor),
    });
    expect(second.page).toHaveLength(6);
    expect(second.isDone).toBe(true);
    const failed = await as.query(api.machineryCrons.runsPage, {
      job: PUMP,
      filter: 'failed',
      paginationOpts: page(25),
    });
    expect(failed.page.map((r) => r.counts?.landed)).toEqual([23, 13, 3]);
    expect(failed.page.every((r) => r.outcome === 'failed' && r.job === PUMP)).toBe(true);
  });

  test('a presser who left is named but shown without a face', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const gone = await seedUser(t, 'admin', 'Gone Person');
    await t.run((ctx) => ctx.db.patch(gone.id, { status: 'deleted' as const }));
    await seedRun(t, POLL, { trigger: 'manual', byUserId: gone.id });
    const { page: rows } = await as.query(api.machineryCrons.runsPage, {
      job: POLL,
      filter: 'all',
      paginationOpts: page(0),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.by).toEqual({ id: gone.id, name: 'Gone Person', avatarUrl: null });
    // A profile erased outright: no name, no face, the run still listed.
    const erased = await seedUser(t, 'admin', 'Erased');
    await seedRun(t, POLL, { trigger: 'manual', byUserId: erased.id, startedAt: NOW });
    // Before: a presser with no picture has no face.
    await t.run((ctx) => ctx.db.patch(erased.id, { profileImageUrl: undefined }));
    const before = await as.query(api.machineryCrons.runsPage, {
      job: POLL,
      filter: 'all',
      paginationOpts: page(5),
    });
    expect(before.page[0]?.by).toEqual({ id: erased.id, name: 'Erased', avatarUrl: null });
    await t.run((ctx) => ctx.db.delete(erased.id));
    const after = await as.query(api.machineryCrons.runsPage, {
      job: POLL,
      filter: 'all',
      paginationOpts: page(5),
    });
    expect(after.page[0]?.by).toEqual({ id: erased.id, name: '', avatarUrl: null });
  });
});

describe('runLog', () => {
  test('a run’s lines, newest first, 200 a page; another run’s and an import’s never', async () => {
    const t = harness();
    const { as } = await seedUser(t, 'admin');
    const runId = await seedRun(t, POLL);
    const other = await seedRun(t, POLL, { startedAt: NOW - 2 * HOUR });
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert('runEvents', {
          cronRunId: runId,
          seq: i,
          at: NOW - HOUR + i,
          loggedAt: NOW - HOUR + i,
          kind: i === 0 ? ('stage' as const) : ('line' as const),
          text: `line ${i}`,
          keepUntil: NOW + 30 * DAY,
        });
      }
      await ctx.db.insert('runEvents', {
        cronRunId: other,
        seq: 0,
        at: NOW,
        loggedAt: NOW,
        kind: 'line' as const,
        text: 'the other run',
        keepUntil: NOW + 30 * DAY,
      });
    });
    const first = await as.query(api.machineryCrons.runLog, { runId, paginationOpts: page(1000) });
    expect(first.page).toHaveLength(EVENTS_PAGE_SIZE);
    expect(first.page[0]).toEqual({
      seq: 229,
      loggedAt: NOW - HOUR + 229,
      kind: 'line',
      text: 'line 229',
      dropped: null,
    });
    const rest = await as.query(api.machineryCrons.runLog, {
      runId,
      paginationOpts: page(200, first.continueCursor),
    });
    expect(rest.page.map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 29 - i));
    expect(rest.isDone).toBe(true);
    expect([...first.page, ...rest.page].some((e) => e.text === 'the other run')).toBe(false);
  });
});
