/**
 * **Machinery › Imagery's reads and writes** (D344, D346, D348, B01-8b-2): the page in each state,
 * the granule list's filters and its bounds, one granule's attempts (and the honest *before 8b*), an
 * attempt's log, the lane; the five writes through their real mutations — each gate, each refusal in
 * words, each audit row — and Start and Pause undoing each other through `api.undo.run`.
 */

import { CRON_KILLED_AFTER_MS } from '@skating/core';
import type { FunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { IMAGERY_CRON_JOBS, NO_FAILED_CUTS, NOTHING_WAITING, slotOf } from './imageryLive';
import {
  IMAGERY_NOT_PAUSED,
  IMAGERY_NOT_RUNNING,
  imageryUndoRefusal,
} from './lib/undoHandlersMachinery';
import { UNDO_POLICY } from './lib/undoPolicy';
import {
  ALREADY_PAUSED,
  ALREADY_RUNNING,
  GRANULES_PAGE_SIZE,
  NO_WATCH,
  NOT_STARTED,
  POLL_NOT_RUNNING,
  POLL_RUNNING,
  WATCH_ENDED,
} from './machineryImagery';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const SEASON = 'winter-2026-27';
const NOW = Date.parse('2026-12-10T12:00:00Z');
const MIN = 60_000;
/** A time written by a mutation: convex-test's clock moves a millisecond or so a call. */
const near = (at: number) => expect.closeTo(at, -2);

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

async function seedPerson(t: T, subject: string, role: 'member' | 'moderator' | 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function openSeason(t: T, fields: Partial<Doc<'imageryIngestSeasons'>> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert('imageryIngestSeasons', {
      season: SEASON,
      opensOn: '2026-11-20',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 28,
      detectedAt: NOW - 20 * 86_400_000,
      ...fields,
    }),
  );
}

let n = 0;
async function granule(t: T, fields: Partial<Doc<'imageryGranules'>> = {}) {
  const id = `S2C_19T${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + (Math.floor(n / 26) % 26))}_20261205_${n++}_L2A`;
  return await t.run((ctx) =>
    ctx.db.insert('imageryGranules', {
      granuleId: id,
      slot: slotOf(id)?.slot ?? id,
      mission: 's2',
      season: SEASON,
      capturedAt: '2026-12-05T15:30:00Z',
      status: 'queued',
      attempts: 0,
      queuedAt: Date.now() + n,
      ...fields,
    }),
  );
}

const audit = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('moderationActions').collect()).filter(
      (r) => r.targetType === 'imagerySeason',
    ),
  );
const scheduled = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
      j.name.includes('tickAction'),
    ),
  );
const seasonRow = (t: T) => t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());

describe('the gates', () => {
  test.each([
    ['startImagery', { season: SEASON }],
    ['pauseImagery', { season: SEASON }],
    ['pollNow', {}],
    ['retryFailed', {}],
    ['tryAgainNow', {}],
  ] as const)('%s is admin-only (machinery.imagery)', async (name, args) => {
    const t = harness();
    const mod = await seedPerson(t, 'mod', 'moderator');
    const fn = api.machineryImagery[name] as unknown as FunctionReference<'mutation'>;
    await expect(mod.as.mutation(fn, args as never)).rejects.toThrow('Requires admin role');
    await expect(t.mutation(fn, args as never)).rejects.toThrow('Not authenticated');
  });

  test.each([
    ['page', { now: NOW }],
    ['granules', { filter: 'all', paginationOpts: { numItems: 25, cursor: null } }],
    ['failedFirst', {}],
  ] as const)('%s needs machinery.read', async (name, args) => {
    const t = harness();
    const mod = await seedPerson(t, 'mod', 'moderator');
    const fn = api.machineryImagery[name] as unknown as FunctionReference<'query'>;
    await expect(mod.as.query(fn, args as never)).rejects.toThrow();
  });

  test('the undo registry holds the five verbs to machinery.imagery, Start and Pause inverses', () => {
    for (const verb of [
      'start_imagery',
      'pause_imagery',
      'poll_imagery',
      'retry_failed_cuts',
      'retry_imagery_now',
    ] as const) {
      expect(UNDO_POLICY[verb].capability).toBe('machinery.imagery');
      expect(UNDO_POLICY[verb].takesAway()).toBe(false);
    }
    expect(UNDO_POLICY.start_imagery.undo).toEqual({ kind: 'inverse', inverse: 'pause_imagery' });
    expect(UNDO_POLICY.pause_imagery.undo).toEqual({ kind: 'inverse', inverse: 'start_imagery' });
  });
});

describe('Start and Pause', () => {
  test('Start: refused with no watch, and once the watch has ended', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await expect(
      admin.as.mutation(api.machineryImagery.startImagery, { season: SEASON }),
    ).rejects.toThrow(NO_WATCH(SEASON));
    await openSeason(t, { closesOn: '2027-04-01' });
    await expect(
      admin.as.mutation(api.machineryImagery.startImagery, { season: SEASON }),
    ).rejects.toThrow(WATCH_ENDED(SEASON));
    expect(await audit(t)).toEqual([]);
  });

  test('Start runs a poll at once with who pressed it, and is audited; again is refused', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await openSeason(t);
    const { actionId } = await admin.as.mutation(api.machineryImagery.startImagery, {
      season: SEASON,
    });
    expect(await seasonRow(t)).toMatchObject({
      imageryStartedAt: near(NOW),
      imageryStartedBy: admin.id,
    });
    expect((await scheduled(t)).map((j) => j.args[0])).toEqual([
      { job: IMAGERY_CRON_JOBS.poll, trigger: 'manual', byUserId: admin.id },
    ]);
    expect(await audit(t)).toEqual([
      expect.objectContaining({
        _id: actionId,
        action: 'start_imagery',
        actorId: admin.id,
        targetId: SEASON,
        reason: 'Started the satellite imagery',
      }),
    ]);
    await expect(
      admin.as.mutation(api.machineryImagery.startImagery, { season: SEASON }),
    ).rejects.toThrow(ALREADY_RUNNING);
  });

  test('Pause: refused before Start and when already paused; Resume keeps who started it', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const other = await seedPerson(t, 'other', 'admin');
    await openSeason(t);
    await expect(
      admin.as.mutation(api.machineryImagery.pauseImagery, { season: SEASON }),
    ).rejects.toThrow(NOT_STARTED);
    await admin.as.mutation(api.machineryImagery.startImagery, { season: SEASON });
    await admin.as.mutation(api.machineryImagery.pauseImagery, { season: SEASON });
    expect((await seasonRow(t))?.imageryPausedAt).toEqual(near(NOW));
    await expect(
      admin.as.mutation(api.machineryImagery.pauseImagery, { season: SEASON }),
    ).rejects.toThrow(ALREADY_PAUSED);
    vi.advanceTimersByTime(MIN);
    await other.as.mutation(api.machineryImagery.startImagery, { season: SEASON });
    expect(await seasonRow(t)).toMatchObject({
      imageryStartedAt: near(NOW),
      imageryStartedBy: admin.id,
    });
    expect((await seasonRow(t))?.imageryPausedAt).toBeUndefined();
    expect((await audit(t)).map((r) => r.reason)).toEqual([
      'Started the satellite imagery',
      'Paused the satellite imagery',
      'Resumed the satellite imagery',
    ]);
  });

  test('Pause undoes Start, and Start (Resume) undoes Pause, while the season stands so', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await openSeason(t);
    const start = await admin.as.mutation(api.machineryImagery.startImagery, { season: SEASON });
    vi.advanceTimersByTime(MIN);
    await admin.as.mutation(api.undo.run, { actionId: start.actionId });
    expect((await seasonRow(t))?.imageryPausedAt).toEqual(near(NOW + MIN));
    const undone = (await audit(t)).at(-1);
    expect(undone).toMatchObject({ action: 'pause_imagery', undoesActionId: start.actionId });

    vi.advanceTimersByTime(MIN);
    const resume = await admin.as.mutation(api.machineryImagery.startImagery, { season: SEASON });
    const pause = await admin.as.mutation(api.machineryImagery.pauseImagery, { season: SEASON });
    void resume;
    await admin.as.mutation(api.undo.run, { actionId: pause.actionId });
    expect((await seasonRow(t))?.imageryPausedAt).toBeUndefined();
    expect((await audit(t)).at(-1)).toMatchObject({
      action: 'start_imagery',
      undoesActionId: pause.actionId,
    });
  });

  test('the undo’s refusal reads the season as it stands', async () => {
    const row = (action: 'start_imagery' | 'pause_imagery') =>
      ({ action, targetId: SEASON }) as Doc<'moderationActions'>;
    const season = (fields: Partial<Doc<'imageryIngestSeasons'>>) =>
      ({ imageryStartedAt: 1, ...fields }) as Doc<'imageryIngestSeasons'>;
    expect(imageryUndoRefusal(row('start_imagery'), season({}))).toBeNull();
    expect(imageryUndoRefusal(row('start_imagery'), season({ imageryPausedAt: 2 }))).toBe(
      IMAGERY_NOT_RUNNING,
    );
    expect(imageryUndoRefusal(row('start_imagery'), season({ closesOn: '2027-04-01' }))).toBe(
      IMAGERY_NOT_RUNNING,
    );
    expect(imageryUndoRefusal(row('pause_imagery'), season({ imageryPausedAt: 2 }))).toBeNull();
    expect(imageryUndoRefusal(row('pause_imagery'), season({}))).toBe(IMAGERY_NOT_PAUSED);
    expect(imageryUndoRefusal(row('pause_imagery'), null)).toMatch(/no longer exists/);
  });
});

describe('the triggers', () => {
  test('Run now: refused unless imagery runs (the waiting states draw none), and while a poll runs', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await expect(admin.as.mutation(api.machineryImagery.pollNow, {})).rejects.toThrow(
      POLL_NOT_RUNNING,
    );
    await openSeason(t);
    await expect(admin.as.mutation(api.machineryImagery.pollNow, {})).rejects.toThrow(
      POLL_NOT_RUNNING,
    );
    await t.run(async (ctx) => {
      const r = await ctx.db.query('imageryIngestSeasons').first();
      await ctx.db.patch((r as Doc<'imageryIngestSeasons'>)._id, {
        imageryStartedAt: NOW,
        imageryPausedAt: NOW,
      });
    });
    await expect(admin.as.mutation(api.machineryImagery.pollNow, {})).rejects.toThrow(
      POLL_NOT_RUNNING,
    );
    await t.run(async (ctx) => {
      const r = await ctx.db.query('imageryIngestSeasons').first();
      await ctx.db.patch((r as Doc<'imageryIngestSeasons'>)._id, { imageryPausedAt: undefined });
      await ctx.db.insert('cronHeartbeats', {
        job: IMAGERY_CRON_JOBS.poll,
        runningSince: NOW - 5 * MIN,
      });
    });
    await expect(admin.as.mutation(api.machineryImagery.pollNow, {})).rejects.toThrow(POLL_RUNNING);
    // A stamp past the action limit is a dead run, not one under way.
    await t.run(async (ctx) => {
      const hb = await ctx.db.query('cronHeartbeats').first();
      await ctx.db.patch((hb as Doc<'cronHeartbeats'>)._id, {
        runningSince: NOW - CRON_KILLED_AFTER_MS - 1,
      });
    });
    const { actionId } = await admin.as.mutation(api.machineryImagery.pollNow, {});
    expect((await audit(t)).map((r) => [r._id, r.action])).toEqual([[actionId, 'poll_imagery']]);
    expect((await scheduled(t)).map((j) => j.args[0])).toEqual([
      { job: IMAGERY_CRON_JOBS.poll, trigger: 'manual', byUserId: admin.id },
    ]);
  });

  test('Retry failed: refused with none failed; else requeues, audits the count, runs the pump', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await expect(admin.as.mutation(api.machineryImagery.retryFailed, {})).rejects.toThrow(
      NO_FAILED_CUTS,
    );
    const failed = await granule(t, { status: 'failed', attempts: 2, refusals: 1, settledAt: NOW });
    await granule(t, { status: 'landed' });
    const receipt = await admin.as.mutation(api.machineryImagery.retryFailed, {});
    expect(receipt.requeued).toBe(1);
    expect(await t.run((ctx) => ctx.db.get(failed))).toMatchObject({
      status: 'queued',
      attempts: 0,
      refusals: 0,
    });
    expect((await audit(t))[0]).toMatchObject({
      _id: receipt.actionId,
      action: 'retry_failed_cuts',
      metadata: { requeued: 1 },
    });
    expect((await scheduled(t))[0]?.args[0]).toEqual({
      job: IMAGERY_CRON_JOBS.pump,
      trigger: 'manual',
      byUserId: admin.id,
    });
  });

  test('Try again now: refused with nothing waiting; lifts a backoff and a pending re-read', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await expect(admin.as.mutation(api.machineryImagery.tryAgainNow, {})).rejects.toThrow(
      NOTHING_WAITING,
    );
    // A backoff that already ran out is nothing waiting.
    await t.run((ctx) =>
      ctx.db.insert('imageryPump', { key: 'pump', runningUntil: 0, backoffUntil: NOW - 1 }),
    );
    await expect(admin.as.mutation(api.machineryImagery.tryAgainNow, {})).rejects.toThrow(
      NOTHING_WAITING,
    );
    await t.run(async (ctx) => {
      const p = await ctx.db.query('imageryPump').first();
      await ctx.db.patch((p as Doc<'imageryPump'>)._id, { backoffUntil: NOW + 20 * MIN });
    });
    const { actionId } = await admin.as.mutation(api.machineryImagery.tryAgainNow, {});
    expect(
      (await t.run((ctx) => ctx.db.query('imageryPump').first()))?.backoffUntil,
    ).toBeUndefined();
    expect((await audit(t))[0]).toMatchObject({ _id: actionId, action: 'retry_imagery_now' });
    // An index re-read pending is something waiting too.
    await t.run((ctx) =>
      ctx.db.insert('imageryPump', { key: 'index', runningUntil: 0, retryAt: NOW + 60 * MIN }),
    );
    await admin.as.mutation(api.machineryImagery.tryAgainNow, {});
    expect(
      (
        await t.run(async (ctx) =>
          (await ctx.db.query('imageryPump').collect()).find((r) => r.key === 'index'),
        )
      )?.retryAt,
    ).toEqual(near(NOW));
  });
});

describe('the page', () => {
  test('no watch: noWatch, the line from the settings, nothing counted', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const page = await admin.as.query(api.machineryImagery.page, { now: NOW });
    expect(page).toMatchObject({
      season: SEASON,
      state: 'noWatch',
      startedBy: null,
      counts: { queued: 0, spawned: 0, landed: 0, empty: 0, failed: 0 },
      machines: { live: null, cap: 25, at: null },
      index: { built: false, frames: 0, retryAt: null },
      fly: { machineMs: 0, countedFrom: null },
      image: null,
      backoffUntil: null,
      configured: false,
      watch: { season: SEASON, opensOn: null, crossed: null, staffEmailAt: null },
    });
    expect(page?.crons.map((c) => c.job)).toEqual([
      IMAGERY_CRON_JOBS.poll,
      IMAGERY_CRON_JOBS.pump,
      IMAGERY_CRON_JOBS.index,
    ]);
    expect(page?.crons.every((c) => c.liveness.state === 'never')).toBe(true);
  });

  test('waiting for cold, then crossed: the watch’s facts and the staff email’s time', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const id = await openSeason(t, {
      emailsSent: [{ kind: 'opened', sentOn: '2026-11-21', sentAt: NOW - 19 * 86_400_000 }],
    });
    const waiting = await admin.as.query(api.machineryImagery.page, { now: NOW });
    expect(waiting).toMatchObject({
      state: 'notStarted',
      watch: {
        opensOn: '2026-11-20',
        openedAt: NOW - 20 * 86_400_000,
        crossed: null,
        staffEmailAt: null,
        openedEmailAt: NOW - 19 * 86_400_000,
      },
    });
    expect(typeof waiting?.watch?.lineC).toBe('number');
    await t.run((ctx) =>
      ctx.db.patch(id, {
        imageryNudgeOn: '2026-12-08',
        imageryNudgeSites: [{ name: 'Lake of the Clouds', lowC: -9 }],
        emailsSent: [
          { kind: 'opened', sentOn: '2026-11-21', sentAt: NOW - 19 * 86_400_000 },
          { kind: 'imagery', sentOn: '2026-12-09', sentAt: NOW - 86_400_000 },
        ],
      }),
    );
    expect((await admin.as.query(api.machineryImagery.page, { now: NOW }))?.watch).toMatchObject({
      crossed: { on: '2026-12-08', sites: [{ name: 'Lake of the Clouds', lowC: -9 }] },
      staffEmailAt: NOW - 86_400_000,
    });
  });

  test('running: the head from the ledger, the pump’s row, the index’s run, and who started it', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    for (const [k, v] of Object.entries({
      IMAGERY_ARCHIVE_URL: 'https://a',
      R2_ACCESS_KEY_ID: 'i',
      R2_SECRET_ACCESS_KEY: 's',
      R2_ENDPOINT: 'https://e',
      FLY_API_TOKEN: 't',
      FLY_IMAGE: 'img',
    }))
      vi.stubEnv(k, v);
    await openSeason(t, { imageryStartedAt: NOW - 86_400_000, imageryStartedBy: admin.id });
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryCounts', {
        season: SEASON,
        queued: 3,
        spawned: 2,
        landed: 40,
        empty: 5,
        failed: 1,
        machineMs: 38 * MIN,
      });
      await ctx.db.insert('imageryPump', {
        key: 'pump',
        runningUntil: 0,
        image: 'img',
        imageSeenAt: NOW - 3_600_000,
        liveMachines: 2,
        liveMachinesAt: NOW - MIN,
        backoffUntil: NOW + 10 * MIN,
      });
      await ctx.db.insert('cronRuns', {
        job: IMAGERY_CRON_JOBS.index,
        startedAt: NOW - 5 * MIN,
        finishedAt: NOW - 5 * MIN,
        outcome: 'ok',
        trigger: 'cron',
        season: SEASON,
        counts: { frames: 41 },
        keepUntil: NOW + 86_400_000,
      });
    });
    const page = await admin.as.query(api.machineryImagery.page, { now: NOW });
    expect(page).toMatchObject({
      state: 'running',
      startedBy: { id: admin.id, name: 'admin' },
      startedAt: NOW - 86_400_000,
      counts: { queued: 3, spawned: 2, landed: 40, empty: 5, failed: 1 },
      machines: { live: 2, cap: 25, at: NOW - MIN },
      index: { built: true, frames: 41 },
      // The season cut before attempts were recorded: no attempt yet, so counted from now.
      fly: { machineMs: 38 * MIN, countedFrom: NOW },
      image: { ref: 'img', seenAt: NOW - 3_600_000 },
      backoffUntil: NOW + 10 * MIN,
      configured: true,
      watch: { closestNight: null },
    });
  });

  test('countedFrom: the first attempt, when the season’s oldest granule was tried before it', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    await openSeason(t, { imageryStartedAt: NOW });
    const countedFrom = async () =>
      (await admin.as.query(api.machineryImagery.page, { now: NOW })).fly.countedFrom;
    const attempt = (granuleRowId: Id<'imageryGranules'>, n: number, spawnedAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('imageryAttempts', {
          granuleRowId,
          granuleId: 'x',
          season: SEASON,
          attempt: n,
          machineName: 'granule-x',
          spawnedAt,
          verdict: 'cutting',
          log: 'pending',
        }),
      );
    // Queued a day before its first spawn, and that spawn is its attempt 1: every cut counted.
    const early = await granule(t, { queuedAt: NOW - 86_400_000, status: 'spawned', attempts: 1 });
    await attempt(early, 1, NOW - 3_600_000);
    expect(await countedFrom()).toBeNull();
    // Tried before recording began: its first recorded attempt is its second.
    await t.run(async (ctx) => {
      for (const a of await ctx.db.query('imageryAttempts').collect()) await ctx.db.delete(a._id);
      await ctx.db.patch(early, { attempts: 2 });
    });
    await attempt(early, 2, NOW - 3_600_000);
    expect(await countedFrom()).toBe(NOW - 3_600_000);
  });
});

describe('the granules', () => {
  test('each filter newest first; All leaves the failed to failedFirst', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const q = await granule(t, { status: 'queued' });
    const c = await granule(t, { status: 'spawned' });
    const e = await granule(t, { status: 'empty', emptyReason: 'no lake inside the footprint' });
    const f = await granule(t, { status: 'failed', lastError: 'exit 137 · out of memory' });
    await granule(t, { season: 'winter-2025-26' });
    const list = async (filter: 'all' | 'queued' | 'cutting' | 'empty' | 'failed') =>
      (
        await admin.as.query(api.machineryImagery.granules, {
          filter,
          paginationOpts: { numItems: 25, cursor: null },
        })
      ).page.map((g) => g.id);
    expect(await list('all')).toEqual([e, c, q]);
    expect(await list('queued')).toEqual([q]);
    expect(await list('cutting')).toEqual([c]);
    expect(await list('empty')).toEqual([e]);
    expect(await list('failed')).toEqual([f]);
    expect((await admin.as.query(api.machineryImagery.failedFirst, {})).map((g) => g.id)).toEqual([
      f,
    ]);
    const [row] = await admin.as.query(api.machineryImagery.failedFirst, {});
    expect(row).toMatchObject({
      lastError: 'exit 137 · out of memory',
      catalogedAt: null,
      refusals: 0,
    });
  });

  test(`pages ${GRANULES_PAGE_SIZE} at a time, however many the caller asks for`, async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    for (let i = 0; i < 30; i++) await granule(t);
    const page = await admin.as.query(api.machineryImagery.granules, {
      filter: 'all',
      paginationOpts: { numItems: 500, cursor: null },
    });
    expect(page.page).toHaveLength(GRANULES_PAGE_SIZE);
    expect(page.isDone).toBe(false);
  });

  test('one granule: its attempts oldest first, and before8b told honestly', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const fresh = await granule(t);
    const old = await granule(t, { status: 'failed', attempts: 2, lastError: 'exit 1' });
    const mixed = await granule(t, { status: 'spawned', attempts: 2 });
    const attempt = (
      g: Id<'imageryGranules'>,
      n: number,
      fields: Partial<Doc<'imageryAttempts'>> = {},
    ) =>
      t.run((ctx) =>
        ctx.db.insert('imageryAttempts', {
          granuleRowId: g,
          granuleId: 'x',
          season: SEASON,
          attempt: n,
          machineName: `granule-x-r${n}`,
          spawnedAt: NOW + n,
          verdict: 'requeued',
          log: 'kept',
          ...fields,
        }),
      );
    await attempt(mixed, 3, { verdict: 'cutting', log: 'pending', machineId: 'm3' });
    await attempt(mixed, 2, {
      exitCode: 137,
      oomKilled: true,
      machineMs: 60_000,
      machineMsFrom: 'fly',
    });
    const view = (id: Id<'imageryGranules'>) =>
      admin.as.query(api.machineryImagery.granule, { id });
    expect(await view(fresh)).toMatchObject({ attempts: [], before8b: false });
    expect(await view(old)).toMatchObject({
      attempts: [],
      before8b: true,
      row: { lastError: 'exit 1' },
    });
    const m = await view(mixed);
    expect(m?.before8b).toBe(true); // its first try (attempt 1) was before attempts were kept
    expect(m?.attempts.map((a) => [a.attempt, a.verdict, a.exitCode, a.oomKilled])).toEqual([
      [2, 'requeued', 137, true],
      [3, 'cutting', null, null],
    ]);
    // At most ten, the newest.
    const many = await granule(t, { attempts: 12 });
    for (let i = 1; i <= 12; i++) await attempt(many, i);
    const v = await view(many);
    expect(v?.attempts.map((a) => a.attempt)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(v?.before8b).toBe(false);
    // A link whose id names no granule (mistyped, or another table's) is missing, never a throw.
    expect(await admin.as.query(api.machineryImagery.granule, { id: 'k'.repeat(32) })).toBeNull();
    expect(await admin.as.query(api.machineryImagery.granule, { id: admin.id })).toBeNull();
  });

  test('an attempt’s log, newest first, with who wrote each line', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const g = await granule(t);
    const a = await t.run((ctx) =>
      ctx.db.insert('imageryAttempts', {
        granuleRowId: g,
        granuleId: 'x',
        season: SEASON,
        attempt: 1,
        machineName: 'granule-x',
        spawnedAt: NOW,
        verdict: 'cutting',
        log: 'pending',
      }),
    );
    await t.mutation(internal.imageryLive.appendAttemptLines, {
      attemptId: a,
      from: 0,
      keepUntil: NOW,
      lines: [
        { origin: 'pump', kind: 'stage', loggedAt: 1, text: 'Asked Fly' },
        { origin: 'cutter', kind: 'line', loggedAt: 2, text: 'start' },
        { origin: 'fly', kind: 'fail', loggedAt: 3, text: 'exit 137 · out of memory' },
      ],
    });
    const page = await admin.as.query(api.machineryImagery.attemptLog, {
      attemptId: a,
      paginationOpts: { numItems: 1_000, cursor: null },
    });
    expect(page.page.map((l) => [l.seq, l.origin, l.text])).toEqual([
      [2, 'fly', 'exit 137 · out of memory'],
      [1, 'cutter', 'start'],
      [0, 'pump', 'Asked Fly'],
    ]);
  });
});

describe('the lane', () => {
  test('not started, paused, ended; running reads the worst of its crons', async () => {
    const t = harness();
    const admin = await seedPerson(t, 'admin', 'admin');
    const lane = async () => (await admin.as.query(api.machineryRuns.lanes, { now: NOW })).imagery;
    expect(await lane()).toEqual({ state: 'notStarted', at: null, crons: null, ready: false });
    const id = await openSeason(t);
    expect(await lane()).toMatchObject({ state: 'notStarted', ready: false });
    // A sentinel crossed the imagery line: a start now waits on a person.
    await t.run((ctx) => ctx.db.patch(id, { imageryNudgeOn: '2026-10-12' }));
    expect(await lane()).toMatchObject({ state: 'notStarted', ready: true });
    await t.run((ctx) => ctx.db.patch(id, { imageryStartedAt: NOW, imageryPausedAt: NOW }));
    expect((await lane()).state).toBe('paused');
    await t.run((ctx) => ctx.db.patch(id, { closesOn: '2027-04-01' }));
    expect((await lane()).state).toBe('ended');
    await t.run((ctx) => ctx.db.patch(id, { closesOn: undefined, imageryPausedAt: undefined }));
    // Running: the pump ticked a minute ago, the index not since the deploy, the poll failed.
    await t.run(async (ctx) => {
      await ctx.db.insert('cronHeartbeats', {
        job: IMAGERY_CRON_JOBS.pump,
        lastTickAt: NOW - MIN,
        lastOutcome: 'ok',
      });
      await ctx.db.insert('cronHeartbeats', {
        job: IMAGERY_CRON_JOBS.poll,
        lastTickAt: NOW - 30 * MIN,
        lastOutcome: 'failed',
      });
    });
    const running = await lane();
    expect(running).toMatchObject({ state: 'failed', at: NOW - 30 * MIN });
    expect(running.crons?.map((c) => c.job)).toHaveLength(3);
    await t.run(async (ctx) => {
      const hb = (await ctx.db.query('cronHeartbeats').collect()).find(
        (h) => h.job === IMAGERY_CRON_JOBS.poll,
      );
      await ctx.db.patch((hb as Doc<'cronHeartbeats'>)._id, { lastOutcome: 'ok' });
    });
    // All on time: ok, and the newest tick's time.
    expect(await lane()).toMatchObject({ state: 'ok', at: NOW - MIN });
  });
});
