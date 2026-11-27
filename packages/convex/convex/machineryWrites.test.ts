/**
 * The Machinery writes on a corpus run (D342, B01-8a): *Mark failed*, *Wait 30 minutes* and the
 * hidden *Stop*, each through its real mutation, each refusal in words, each gate, each undo through
 * `api.undo.run` — and the rule the founder ruled first: a late `finish` never erases a hand mark.
 */

import { RUN_QUIET_MS, RUN_WAIT_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { DRY_RUN_NOTE } from './importRuns';
import {
  MARK_REPLACED,
  machineryUndoRefusal,
  STOP_REPLACED,
  WAIT_REPLACED,
} from './lib/undoHandlersMachinery';
import { UNDO_POLICY } from './lib/undoPolicy';
import {
  MARK_NEEDS_REASON,
  RUN_ALREADY_MARKED,
  RUN_GONE,
  RUN_NOT_MARKED,
  RUN_NOT_RUNNING,
  STOP_ALREADY,
  STOP_FINISHED,
  STOP_NONE,
  STOP_SEEN,
  WAIT_ALREADY,
  WAIT_EXPIRED,
  WAIT_FINISHED,
  WAIT_NO_HEARTBEAT,
  WAIT_NONE,
  WAIT_NOT_STALLED,
} from './machineryWrites';
import schema from './schema';

/**
 * Core's stall rule lands with S2 (`runLiveness`); until it does, its stub throws. This falls back to
 * the rule as the design writes it only while the real one throws "not built yet", so the suite runs
 * against the real rule the moment it lands.
 */
vi.mock('@skating/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@skating/core')>();
  const fake: typeof core.runLiveness = (run, now) => {
    if (run.status !== 'running' || run.markedFailed !== undefined) return { state: 'finished' };
    if (run.progressAt === undefined) return { state: 'notRecorded' };
    const quietMs = Math.max(0, now - run.progressAt);
    const expectedMs = core.RUN_QUIET_MS[run.kind] ?? null;
    const base = { quietMs, expectedMs, waitUntil: null };
    if (expectedMs === null || quietMs <= core.RUN_LATE_FACTOR * expectedMs) {
      return { state: 'running', ...base };
    }
    if (quietMs <= core.RUN_STALLED_FACTOR * expectedMs) return { state: 'late', ...base };
    if (run.stallWaitUntil !== undefined && now < run.stallWaitUntil) {
      return { state: 'waiting', ...base, waitUntil: run.stallWaitUntil };
    }
    return { state: 'stalled', ...base };
  };
  return {
    ...core,
    runLiveness: (run: Parameters<typeof fake>[0], now: number) => {
      try {
        return core.runLiveness(run, now);
      } catch (e) {
        if (e instanceof Error && e.message.includes('not built yet')) return fake(run, now);
        throw e;
      }
    },
  };
});

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;

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

const MINUTE = 60_000;
const LOAD_GAP = RUN_QUIET_MS.canonical_water as number;

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

async function seedRun(
  t: T,
  fields: Partial<Omit<Doc<'importRuns'>, '_id' | '_creationTime'>> = {},
): Promise<Id<'importRuns'>> {
  return t.run((ctx) =>
    ctx.db.insert('importRuns', {
      kind: 'canonical_water',
      label: 'VT canonical water',
      deployment: 'dev:agile-bee-397',
      isProd: false,
      status: 'running',
      startedAt: Date.now(),
      progressAt: Date.now(),
      counts: [],
      stages: [],
      failures: [],
      failuresTotal: 0,
      ...fields,
    }),
  );
}

const getRun = (t: T, id: Id<'importRuns'>) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<'importRuns'>);
const linesOf = (t: T, id: Id<'importRuns'>) =>
  t.run((ctx) =>
    ctx.db
      .query('runEvents')
      .withIndex('by_run_seq', (q) => q.eq('runId', id))
      .collect(),
  );
const auditOf = (t: T, id: Id<'importRuns'>) =>
  t.run((ctx) =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', 'importRun').eq('targetId', id))
      .collect(),
  );
const scheduledNames = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).map((f) => f.name),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 11, 1, 13, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const admin = await seedPerson(t, 'teagan', 'admin');
  return { t, admin };
}

// ── The gate ───────────────────────────────────────────────────────────────────────────────────────

describe('every write is gated machinery.corpus (admin)', () => {
  const writes = [
    ['markRunFailed', (id: Id<'importRuns'>) => ({ runId: id, reason: 'gone' })],
    ['reopenRun', (id: Id<'importRuns'>) => ({ runId: id })],
    ['waitOnRun', (id: Id<'importRuns'>) => ({ runId: id, now: Date.now() })],
    ['stopWaitingOnRun', (id: Id<'importRuns'>) => ({ runId: id })],
    ['requestRunStop', (id: Id<'importRuns'>) => ({ runId: id })],
    ['withdrawRunStop', (id: Id<'importRuns'>) => ({ runId: id })],
  ] as const;

  test.each(writes)(
    '%s refuses a moderator, a member and nobody, and writes nothing',
    async (name, args) => {
      const { t } = await setup();
      const runId = await seedRun(t);
      const moderator = await seedPerson(t, 'mod', 'moderator');
      const member = await seedPerson(t, 'mem', 'member');
      const fn = api.machineryWrites[name] as never;
      for (const who of [moderator.as, member.as, t]) {
        await expect(who.mutation(fn, args(runId) as never)).rejects.toThrow();
      }
      expect(await auditOf(t, runId)).toEqual([]);
      expect(await linesOf(t, runId)).toEqual([]);
      expect((await getRun(t, runId)).status).toBe('running');
    },
  );

  test('the undo registry holds every verb to the same capability', () => {
    for (const verb of [
      'mark_run_failed',
      'reopen_run',
      'wait_on_run',
      'stop_waiting_on_run',
      'request_run_stop',
      'withdraw_run_stop',
    ] as const) {
      expect(UNDO_POLICY[verb].capability).toBe('machinery.corpus');
      expect(UNDO_POLICY[verb].takesAway()).toBe(false);
    }
  });
});

// ── Mark failed ────────────────────────────────────────────────────────────────────────────────────

describe('markRunFailed', () => {
  test('marks the run failed: who, when, why, the audit row, a mark line', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId,
      reason: '  laptop slept  ',
    });
    const run = await getRun(t, runId);
    expect(run.status).toBe('failed');
    expect(run.finishedAt).toBe(run.markedFailed?.at);
    expect(Math.abs((run.finishedAt as number) - Date.now())).toBeLessThan(1_000);
    expect(run.markedFailed).toEqual({
      byUserId: admin.id,
      at: run.finishedAt,
      reason: 'laptop slept',
      actionId,
    });
    const [row] = await auditOf(t, runId);
    expect(row).toMatchObject({
      _id: actionId,
      action: 'mark_run_failed',
      actorId: admin.id,
      reason: 'laptop slept',
    });
    const lines = await linesOf(t, runId);
    expect(lines.map((l) => [l.seq, l.kind, l.text])).toEqual([
      [0, 'mark', 'Marked failed by teagan: laptop slept'],
    ]);
  });

  test.each([
    ['an empty reason', { status: 'running' as const }, '   ', MARK_NEEDS_REASON],
    ['a finished run', { status: 'succeeded' as const }, 'x', RUN_NOT_RUNNING],
    ['a failed run', { status: 'failed' as const }, 'x', RUN_NOT_RUNNING],
  ])('refuses %s, in words, writing nothing', async (_what, fields, reason, words) => {
    const { t, admin } = await setup();
    const runId = await seedRun(t, fields);
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason }),
    ).rejects.toThrow(words);
    expect(await auditOf(t, runId)).toEqual([]);
    expect(await linesOf(t, runId)).toEqual([]);
  });

  test('refuses a run already marked, and a run that is gone', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'a' });
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'b' }),
    ).rejects.toThrow(RUN_ALREADY_MARKED);
    await t.run((ctx) => ctx.db.delete(runId));
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'b' }),
    ).rejects.toThrow(RUN_GONE);
  });

  test('refuses a reason past the audit cap, the whole write with it', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'x'.repeat(2_001) }),
    ).rejects.toThrow();
    expect((await getRun(t, runId)).status).toBe('running');
    expect(await linesOf(t, runId)).toEqual([]);
  });

  // The founder's ruling on fork 2.
  describe('asks for the weather-cell walk when the run changed bodies', () => {
    test.each([
      ['a load that applied a batch', { counts: [{ name: 'batchesApplied', value: 3 }] }, true],
      ['a load that applied none', { counts: [{ name: 'batchesApplied', value: 0 }] }, false],
      ['a dry run', { notes: [DRY_RUN_NOTE] }, false],
      ['a kind that counts no batches', { kind: 'floor_prune' as const }, true],
      ['a kind that changes no bodies', { kind: 'corpus_merge' as const }, false],
      ['a campaign row', { kind: 'corpus_campaign' as const }, false],
    ])('%s → %s', async (_what, fields, schedules) => {
      const { t, admin } = await setup();
      const runId = await seedRun(t, fields);
      await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'gone' });
      expect((await scheduledNames(t)).includes('weatherArchive:maybeSyncWeatherCells')).toBe(
        schedules,
      );
    });
  });
});

// ── A late finish never erases a hand mark ───────────────────────────────────────────────────────

describe('importRuns.finish on a marked run', () => {
  test('keeps the mark, the status and the finish time; stores the close beside them', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t, { kind: 'corpus_merge' });
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'slept' });
    const markedAt = (await getRun(t, runId)).finishedAt;
    vi.advanceTimersByTime(5 * MINUTE);
    await t.mutation(internal.importRuns.finish, {
      runId,
      status: 'succeeded',
      counts: [{ name: 'emitted', value: 9 }],
    });
    const run = await getRun(t, runId);
    expect(run.status).toBe('failed');
    expect(run.finishedAt).toBe(markedAt);
    expect(run.markedFailed?.reason).toBe('slept');
    expect(run.loaderFinish).toEqual({ status: 'succeeded', at: run.progressAt });
    expect(run.progressAt).toBeGreaterThan(markedAt as number);
    // The run was alive after all: its counts and its heartbeat say so.
    expect(run.counts).toEqual([{ name: 'emitted', value: 9 }]);
    const lines = await linesOf(t, runId);
    expect(lines.at(-1)).toMatchObject({
      kind: 'close',
      text: 'The loader closed the run itself: succeeded',
    });
  });

  test("a late failed close keeps the loader's error beside the mark, never in the row's", async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'slept' });
    await t.mutation(internal.importRuns.finish, {
      runId,
      status: 'failed',
      error: 'ECONNRESET',
      applied: true,
    });
    const run = await getRun(t, runId);
    expect(run.error).toBeUndefined();
    expect(run.loaderFinish).toMatchObject({
      status: 'failed',
      error: 'ECONNRESET',
      applied: true,
    });
    expect((await linesOf(t, runId)).at(-1)?.text).toBe(
      'The loader closed the run itself: failed: ECONNRESET',
    );
  });

  test("the walk keys on the loader's close: a late success of an invalidating kind schedules it", async () => {
    const { t, admin } = await setup();
    // A load that applied nothing before the mark: the mark asks for no walk.
    const runId = await seedRun(t, { counts: [{ name: 'batchesApplied', value: 0 }] });
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'slept' });
    expect(await scheduledNames(t)).not.toContain('weatherArchive:maybeSyncWeatherCells');
    await t.mutation(internal.importRuns.finish, { runId, status: 'succeeded' });
    expect(await scheduledNames(t)).toContain('weatherArchive:maybeSyncWeatherCells');
  });

  test('an unmarked run closes as it always did', async () => {
    const { t } = await setup();
    const runId = await seedRun(t);
    await t.mutation(internal.importRuns.finish, { runId, status: 'succeeded' });
    const run = await getRun(t, runId);
    expect(run.status).toBe('succeeded');
    expect(run.loaderFinish).toBeUndefined();
    expect(await linesOf(t, runId)).toEqual([]);
  });
});

// ── Reopen, directly and as the mark's undo ──────────────────────────────────────────────────────

describe('reopenRun and the mark’s undo', () => {
  test('a mark with no late close reopens the run as running', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId,
      reason: 'slept',
    });
    await admin.as.mutation(api.undo.run, { actionId });
    const run = await getRun(t, runId);
    expect(run.status).toBe('running');
    expect(run.finishedAt).toBeUndefined();
    expect(run.markedFailed).toBeUndefined();
    const rows = await auditOf(t, runId);
    expect(rows.map((r) => r.action)).toEqual(['mark_run_failed', 'reopen_run']);
    expect(rows[1]?.undoesActionId).toBe(actionId);
    expect((await linesOf(t, runId)).at(-1)).toMatchObject({
      kind: 'mark',
      text: 'Reopened by teagan: running again',
    });
  });

  test("a mark with a late close reopens to the loader's own close", async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId,
      reason: 'slept',
    });
    vi.advanceTimersByTime(MINUTE);
    await t.mutation(internal.importRuns.finish, { runId, status: 'failed', error: 'boom' });
    const closedAt = Date.now();
    vi.advanceTimersByTime(MINUTE);
    await admin.as.mutation(api.undo.run, { actionId });
    const run = await getRun(t, runId);
    expect(run).toMatchObject({ status: 'failed', finishedAt: closedAt, error: 'boom' });
    expect(run.markedFailed).toBeUndefined();
    expect(run.loaderFinish).toBeUndefined();
  });

  test('the undo is refused once the run was reopened and marked again', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const first = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId,
      reason: 'a',
    });
    await admin.as.mutation(api.machineryWrites.reopenRun, { runId });
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'b' });
    await expect(admin.as.mutation(api.undo.run, { actionId: first.actionId })).rejects.toThrow();
    expect((await getRun(t, runId)).markedFailed?.reason).toBe('b');
  });

  test('the refusal reads the mark itself: a mark not this row’s is refused in words', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId,
      reason: 'a',
    });
    // The mark replaced behind the audit log's back (no row overtakes it): the run's own fact refuses.
    await t.run(async (ctx) => {
      const run = (await ctx.db.get(runId)) as Doc<'importRuns'>;
      const other = await ctx.db.insert('moderationActions', {
        action: 'mark_run_failed',
        targetType: 'importRun',
        targetId: 'elsewhere',
        reason: 'x',
        createdAt: 0,
      });
      await ctx.db.patch(runId, {
        markedFailed: {
          ...(run.markedFailed as NonNullable<Doc<'importRuns'>['markedFailed']>),
          actionId: other,
        },
      });
    });
    await expect(admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(MARK_REPLACED);
  });

  test('reopen refuses a run that isn’t marked', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    await expect(admin.as.mutation(api.machineryWrites.reopenRun, { runId })).rejects.toThrow(
      RUN_NOT_MARKED,
    );
  });

  test('a reopen has no undo of its own', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'a' });
    const { actionId } = await admin.as.mutation(api.machineryWrites.reopenRun, { runId });
    await expect(admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      'To mark it failed again',
    );
  });
});

// ── Wait 30 minutes ────────────────────────────────────────────────────────────────────────────────

describe('waitOnRun and its undo', () => {
  async function stalled(t: T) {
    const runId = await seedRun(t);
    vi.advanceTimersByTime(10 * LOAD_GAP + MINUTE);
    return runId;
  }

  test('a stalled run is waited on until the caller’s now plus 30 minutes', async () => {
    const { t, admin } = await setup();
    const runId = await stalled(t);
    const now = Date.now();
    const { actionId, until } = await admin.as.mutation(api.machineryWrites.waitOnRun, {
      runId,
      now,
    });
    expect(until).toBe(now + RUN_WAIT_MS);
    expect((await getRun(t, runId)).stallWait).toEqual({
      until,
      byUserId: admin.id,
      at: now,
      actionId,
    });
    expect((await linesOf(t, runId)).map((l) => l.kind)).toEqual(['wait']);
  });

  test("the caller's clock is held within a minute of the server's", async () => {
    const { t, admin } = await setup();
    const runId = await stalled(t);
    const { until } = await admin.as.mutation(api.machineryWrites.waitOnRun, {
      runId,
      now: Date.now() + 3 * 60 * MINUTE,
    });
    expect(until).toBe(Date.now() + MINUTE + RUN_WAIT_MS);
  });

  test.each([
    ['running', LOAD_GAP, WAIT_NOT_STALLED],
    ['late', 5 * LOAD_GAP, WAIT_NOT_STALLED],
  ])('refuses a %s run by the server’s clock', async (_state, quiet, words) => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    vi.advanceTimersByTime(quiet);
    // The page thinks it is an hour later; the server's clock decides.
    await expect(
      admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() + 3_600_000 }),
    ).rejects.toThrow(words);
  });

  test('refuses a finished run, a marked one, one with no heartbeat, and a second wait', async () => {
    const { t, admin } = await setup();
    const done = await seedRun(t, { status: 'succeeded' });
    await expect(
      admin.as.mutation(api.machineryWrites.waitOnRun, { runId: done, now: Date.now() }),
    ).rejects.toThrow(WAIT_FINISHED);
    const silent = await seedRun(t, { progressAt: undefined });
    await expect(
      admin.as.mutation(api.machineryWrites.waitOnRun, { runId: silent, now: Date.now() }),
    ).rejects.toThrow(WAIT_NO_HEARTBEAT);
    const runId = await stalled(t);
    await admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() });
    await expect(
      admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() }),
    ).rejects.toThrow(WAIT_ALREADY);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'x' });
    await expect(
      admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() }),
    ).rejects.toThrow(WAIT_FINISHED);
  });

  test('a run stalled again after its wait ran out can be waited on again', async () => {
    const { t, admin } = await setup();
    const runId = await stalled(t);
    await admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() });
    vi.advanceTimersByTime(RUN_WAIT_MS + MINUTE);
    await admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() });
    expect((await auditOf(t, runId)).map((r) => r.action)).toEqual(['wait_on_run', 'wait_on_run']);
  });

  test('the undo clears the wait; refused once it has run out', async () => {
    const { t, admin } = await setup();
    const runId = await stalled(t);
    const first = await admin.as.mutation(api.machineryWrites.waitOnRun, {
      runId,
      now: Date.now(),
    });
    await admin.as.mutation(api.undo.run, { actionId: first.actionId });
    expect((await getRun(t, runId)).stallWait).toBeUndefined();
    const rows = await auditOf(t, runId);
    expect(rows.map((r) => r.action)).toEqual(['wait_on_run', 'stop_waiting_on_run']);

    const second = await admin.as.mutation(api.machineryWrites.waitOnRun, {
      runId,
      now: Date.now(),
    });
    vi.advanceTimersByTime(RUN_WAIT_MS + 1);
    await expect(admin.as.mutation(api.undo.run, { actionId: second.actionId })).rejects.toThrow(
      WAIT_EXPIRED,
    );
    await expect(
      admin.as.mutation(api.machineryWrites.stopWaitingOnRun, { runId }),
    ).rejects.toThrow(WAIT_EXPIRED);
  });

  test('stopWaitingOnRun refuses a run nobody waits on; the undo refuses a replaced wait', async () => {
    const { t, admin } = await setup();
    const runId = await stalled(t);
    await expect(
      admin.as.mutation(api.machineryWrites.stopWaitingOnRun, { runId }),
    ).rejects.toThrow(WAIT_NONE);
    const { actionId } = await admin.as.mutation(api.machineryWrites.waitOnRun, {
      runId,
      now: Date.now(),
    });
    await t.run(async (ctx) => {
      const run = (await ctx.db.get(runId)) as Doc<'importRuns'>;
      const other = await ctx.db.insert('moderationActions', {
        action: 'wait_on_run',
        targetType: 'importRun',
        targetId: 'elsewhere',
        reason: 'x',
        createdAt: 0,
      });
      await ctx.db.patch(runId, {
        stallWait: {
          ...(run.stallWait as NonNullable<Doc<'importRuns'>['stallWait']>),
          actionId: other,
        },
      });
    });
    await expect(admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(WAIT_REPLACED);
  });
});

// ── Stop (built, not drawn) ───────────────────────────────────────────────────────────────────────

describe('requestRunStop, the logger’s directive, and the withdrawal', () => {
  const line = { kind: 'flush' as const, text: 'batchesApplied=3', loggedAt: 0 };

  test('the run’s next append is told to stop, and the request is stamped seen', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    await admin.as.mutation(api.machineryWrites.requestRunStop, { runId });
    expect((await linesOf(t, runId)).map((l) => l.kind)).toEqual(['stop']);
    const answer = await t.mutation(internal.runEvents.append, { runId, events: [line] });
    expect(answer).toMatchObject({ stop: true, markedFailed: false, stored: 1 });
    expect((await getRun(t, runId)).stopRequest?.seenAt).toBeGreaterThanOrEqual(Date.now());
    await expect(admin.as.mutation(api.machineryWrites.withdrawRunStop, { runId })).rejects.toThrow(
      STOP_SEEN,
    );
  });

  test("a campaign's stop reaches every pass under it", async () => {
    const { t, admin } = await setup();
    const campaign = await seedRun(t, { kind: 'corpus_campaign' });
    const pass = await seedRun(t, { parentRunId: campaign });
    const loose = await seedRun(t);
    await admin.as.mutation(api.machineryWrites.requestRunStop, { runId: campaign });
    expect((await t.mutation(internal.runEvents.append, { runId: loose, events: [] })).stop).toBe(
      false,
    );
    expect(
      (await t.mutation(internal.runEvents.append, { runId: pass, events: [line] })).stop,
    ).toBe(true);
    // The campaign's request was obeyed by its pass: it can no longer be withdrawn.
    expect((await getRun(t, campaign)).stopRequest?.seenAt).toBeGreaterThanOrEqual(Date.now());
  });

  test('the withdrawal clears it before it is seen, as the request’s undo too', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.requestRunStop, { runId });
    await admin.as.mutation(api.undo.run, { actionId });
    expect((await getRun(t, runId)).stopRequest).toBeUndefined();
    expect((await t.mutation(internal.runEvents.append, { runId, events: [line] })).stop).toBe(
      false,
    );
    expect((await auditOf(t, runId)).map((r) => r.action)).toEqual([
      'request_run_stop',
      'withdraw_run_stop',
    ]);
  });

  test('refuses a finished or marked run, a second request, and a withdrawal of nothing', async () => {
    const { t, admin } = await setup();
    const done = await seedRun(t, { status: 'failed' });
    await expect(
      admin.as.mutation(api.machineryWrites.requestRunStop, { runId: done }),
    ).rejects.toThrow(STOP_FINISHED);
    const runId = await seedRun(t);
    await expect(admin.as.mutation(api.machineryWrites.withdrawRunStop, { runId })).rejects.toThrow(
      STOP_NONE,
    );
    await admin.as.mutation(api.machineryWrites.requestRunStop, { runId });
    await expect(admin.as.mutation(api.machineryWrites.requestRunStop, { runId })).rejects.toThrow(
      STOP_ALREADY,
    );
  });

  test('the undo refuses once the run has seen it, and a replaced request', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.requestRunStop, { runId });
    await t.mutation(internal.runEvents.append, { runId, events: [] });
    await expect(admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(STOP_SEEN);

    const other = await seedRun(t);
    const second = await admin.as.mutation(api.machineryWrites.requestRunStop, { runId: other });
    await t.run((ctx) => ctx.db.patch(other, { stopRequest: undefined }));
    await expect(admin.as.mutation(api.undo.run, { actionId: second.actionId })).rejects.toThrow(
      STOP_REPLACED,
    );
  });

  test('an undo of a run that is gone says so', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    const { actionId } = await admin.as.mutation(api.machineryWrites.requestRunStop, { runId });
    await t.run((ctx) => ctx.db.delete(runId));
    await expect(admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(RUN_GONE);
  });
});

// ── The marked directive ─────────────────────────────────────────────────────────────────────────

test('append tells a marked run it was marked', async () => {
  const { t, admin } = await setup();
  const runId = await seedRun(t);
  await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'slept' });
  const answer = await t.mutation(internal.runEvents.append, { runId, events: [] });
  expect(answer).toEqual({ stop: false, markedFailed: true, stored: 0, dropped: 0 });
});

test('the refusal names a verb it has no undo for, rather than offering one', () => {
  const row = { action: 'reopen_run', _id: 'a' } as unknown as Doc<'moderationActions'>;
  expect(machineryUndoRefusal(row, {} as Doc<'importRuns'>, 0)).toBe(
    'Undo for this is not built yet.',
  );
  expect(machineryUndoRefusal(row, null, 0)).toBe(RUN_GONE);
});
