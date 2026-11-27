/**
 * The Machinery writes on a corpus run (D342, B01-8a): *Mark failed*, *Wait 30 minutes* and the
 * hidden *Stop*, each through its real mutation, each refusal in words, each gate, each undo through
 * `api.undo.run` — and the rule the founder ruled first: a late `finish` never erases a hand mark.
 */

import { RUN_QUIET_MS, RUN_WAIT_MS } from '@skating/core';
import type { FunctionReference } from 'convex/server';
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
  CAMPAIGN_MOVED_ON,
  MARK_NEEDS_REASON,
  NOT_A_CAMPAIGN,
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
import { MAX_RUN_EVENTS, RUN_EVENT_CAP_TEXT, RUN_STOP_HANDED_TEXT } from './runEvents';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

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
  type Admin = Awaited<ReturnType<typeof setup>>['admin'];
  /** Each write, and a run in the state where an admin's call of it succeeds. */
  const writes = [
    ['markRunFailed', async () => {}, (id: Id<'importRuns'>) => ({ runId: id, reason: 'gone' })],
    [
      'reopenRun',
      (a: Admin, id: Id<'importRuns'>) =>
        a.as.mutation(api.machineryWrites.markRunFailed, { runId: id, reason: 'x' }),
      (id: Id<'importRuns'>) => ({ runId: id }),
    ],
    ['waitOnRun', async () => {}, (id: Id<'importRuns'>) => ({ runId: id, now: Date.now() })],
    [
      'stopWaitingOnRun',
      (a: Admin, id: Id<'importRuns'>) =>
        a.as.mutation(api.machineryWrites.waitOnRun, { runId: id, now: Date.now() }),
      (id: Id<'importRuns'>) => ({ runId: id }),
    ],
    ['requestRunStop', async () => {}, (id: Id<'importRuns'>) => ({ runId: id })],
    [
      'withdrawRunStop',
      (a: Admin, id: Id<'importRuns'>) =>
        a.as.mutation(api.machineryWrites.requestRunStop, { runId: id }),
      (id: Id<'importRuns'>) => ({ runId: id }),
    ],
  ] as const;

  test.each(writes)(
    '%s refuses a moderator, a member and nobody on a run an admin can act on, writing nothing',
    async (name, ready, args) => {
      const { t, admin } = await setup();
      // Stalled, so every write's own state check would pass: only the gate can refuse.
      const runId = await seedRun(t, { progressAt: Date.now() - 20 * LOAD_GAP });
      await ready(admin, runId);
      const rows = (await auditOf(t, runId)).length;
      const lines = (await linesOf(t, runId)).length;
      const moderator = await seedPerson(t, 'mod', 'moderator');
      const member = await seedPerson(t, 'mem', 'member');
      const fn = api.machineryWrites[name] as unknown as FunctionReference<'mutation'>;
      for (const who of [moderator.as, member.as]) {
        await expect(who.mutation(fn, args(runId) as never)).rejects.toThrow('Requires admin role');
      }
      await expect(t.mutation(fn, args(runId) as never)).rejects.toThrow('Not authenticated');
      expect(await auditOf(t, runId)).toHaveLength(rows);
      expect(await linesOf(t, runId)).toHaveLength(lines);
      // The same call, by an admin, lands: the refusals above were the gate's.
      await admin.as.mutation(fn, args(runId) as never);
      expect(await auditOf(t, runId)).toHaveLength(rows + 1);
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

// ── Mark the campaign failed too ─────────────────────────────────────────────────────────────────

describe('marking the campaign failed after its pass (the founder’s ruling on Ma14)', () => {
  /** A campaign whose load went quiet long ago: the laptop is gone, as far as anyone can tell. */
  async function quietCampaign(t: T) {
    const campaign = await seedRun(t, {
      kind: 'corpus_campaign',
      label: 'Corpus campaign c1',
      campaignId: 'c1',
      startedAt: Date.now() - 90 * MINUTE,
      progressAt: Date.now() - 60 * MINUTE,
    });
    const load = await seedRun(t, {
      campaignId: 'c1',
      parentRunId: campaign,
      campaignPass: 'load',
      startedAt: Date.now() - 60 * MINUTE,
      progressAt: Date.now() - 40 * MINUTE,
    });
    return { campaign, load };
  }
  const offerOf = async (
    as: Awaited<ReturnType<typeof setup>>['admin']['as'],
    id: Id<'importRuns'>,
  ) =>
    (await as.query(api.machineryRuns.campaign, { runId: id, now: Date.now() }))?.campaignToo ??
    null;
  const later = () => vi.advanceTimersByTime(1_000);

  test('after the pass is marked, both pages offer it and the campaign is marked with its pass named', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    expect(await offerOf(admin.as, campaign)).toBeNull();
    const pass = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: load,
      reason: 'laptop died',
    });
    const offer = {
      campaign: { id: campaign, title: 'c1' },
      afterPass: { id: load, pass: 'load' },
    };
    expect(await offerOf(admin.as, campaign)).toEqual(offer);
    expect(
      (await admin.as.query(api.machineryRuns.run, { runId: load, now: Date.now() }))?.campaignToo,
    ).toEqual(offer);
    // The campaign's own page never draws its offer on the campaign's run read.
    expect(
      (await admin.as.query(api.machineryRuns.run, { runId: campaign, now: Date.now() }))
        ?.campaignToo,
    ).toBeNull();

    later();
    const both = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: campaign,
      reason: 'laptop died',
      afterPass: load,
    });
    const row = await getRun(t, campaign);
    expect(row.status).toBe('failed');
    expect(row.markedFailed?.actionId).toBe(both.actionId);
    const [audit] = await auditOf(t, campaign);
    expect(audit?.metadata).toMatchObject({ afterPass: load });
    expect((await linesOf(t, campaign)).map((l) => l.text)).toEqual([
      'Marked failed by teagan after its pass load: laptop died',
    ]);
    expect(await offerOf(admin.as, campaign)).toBeNull();
    // Two marks, two audit rows: neither write touched the other's run.
    expect((await getRun(t, load)).markedFailed?.actionId).toBe(pass.actionId);
  });

  test('a live laptop carries on: once a later pass opens, the offer is gone and the write refused', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId: load, reason: 'quiet' });
    expect(await offerOf(admin.as, campaign)).not.toBeNull();
    later();
    // The script begins the next pass: a beat on the campaign, then the pass's own row.
    await t.mutation(internal.importRuns.progress, { runId: campaign });
    expect(await offerOf(admin.as, campaign)).toBeNull();
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, {
        runId: campaign,
        reason: 'x',
        afterPass: load,
      }),
    ).rejects.toThrow(CAMPAIGN_MOVED_ON);
    await t.mutation(internal.importRuns.start, {
      kind: 'sub_area_seed',
      label: 'sub-areas',
      campaignId: 'c1',
      deployment: 'dev:agile-bee-397',
      isProd: false,
      parentRunId: campaign,
      campaignPass: 'load-sub-areas',
    });
    expect(await offerOf(admin.as, campaign)).toBeNull();
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, {
        runId: campaign,
        reason: 'x',
        afterPass: load,
      }),
    ).rejects.toThrow(CAMPAIGN_MOVED_ON);
    expect((await getRun(t, campaign)).status).toBe('running');
    expect(await auditOf(t, campaign)).toEqual([]);
    expect(await linesOf(t, campaign)).toEqual([]);
  });

  test.each([
    [
      'the pass beat after its mark',
      (t: T, ids: { load: Id<'importRuns'> }) =>
        t.mutation(internal.importRuns.progress, { runId: ids.load }),
    ],
    [
      'the loader closed the pass itself',
      (t: T, ids: { load: Id<'importRuns'> }) =>
        t.mutation(internal.importRuns.finish, { runId: ids.load, status: 'succeeded' }),
    ],
  ])('withdrawn, and refused, when %s', async (_what, act) => {
    const { t, admin } = await setup();
    const ids = await quietCampaign(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId: ids.load, reason: 'q' });
    later();
    await act(t, ids);
    expect(await offerOf(admin.as, ids.campaign)).toBeNull();
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, {
        runId: ids.campaign,
        reason: 'x',
        afterPass: ids.load,
      }),
    ).rejects.toThrow(CAMPAIGN_MOVED_ON);
  });

  test('refused before the pass is marked, for a pass not the newest, and on a run not a campaign', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    const mark = (runId: Id<'importRuns'>, afterPass: Id<'importRuns'>) =>
      admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'x', afterPass });
    await expect(mark(campaign, load)).rejects.toThrow(CAMPAIGN_MOVED_ON);
    await expect(mark(load, load)).rejects.toThrow(NOT_A_CAMPAIGN);
    // An older pass, marked, while a newer one is the campaign's newest.
    const older = await seedRun(t, {
      campaignId: 'c1',
      parentRunId: campaign,
      campaignPass: 'merge',
      kind: 'corpus_merge',
      startedAt: Date.now() - 80 * MINUTE,
      progressAt: Date.now() - 70 * MINUTE,
    });
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId: older, reason: 'q' });
    await expect(mark(campaign, older)).rejects.toThrow(CAMPAIGN_MOVED_ON);
    expect(await offerOf(admin.as, campaign)).toBeNull();
    // The plain mark on a campaign is as it was: no afterPass, no new condition.
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId: campaign, reason: 'x' });
    expect((await getRun(t, campaign)).status).toBe('failed');
  });

  test('the existing refusals come first and stay as they were', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId: load, reason: 'q' });
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, {
        runId: campaign,
        reason: '  ',
        afterPass: load,
      }),
    ).rejects.toThrow(MARK_NEEDS_REASON);
    await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: campaign,
      reason: 'x',
      afterPass: load,
    });
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, {
        runId: campaign,
        reason: 'x',
        afterPass: load,
      }),
    ).rejects.toThrow(RUN_ALREADY_MARKED);
  });

  test('the two marks undo apart, and the offer follows what stands', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    const pass = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: load,
      reason: 'q',
    });
    later();
    const both = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: campaign,
      reason: 'q',
      afterPass: load,
    });
    // Undo the campaign's: the pass keeps its mark, and the offer is back.
    await admin.as.mutation(api.undo.run, { actionId: both.actionId });
    expect((await getRun(t, campaign)).status).toBe('running');
    expect((await getRun(t, load)).markedFailed?.actionId).toBe(pass.actionId);
    expect(await offerOf(admin.as, campaign)).not.toBeNull();
    // Mark it again, then undo the pass's: the campaign keeps its mark; no offer on a marked campaign.
    later();
    await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: campaign,
      reason: 'again',
      afterPass: load,
    });
    await admin.as.mutation(api.undo.run, { actionId: pass.actionId });
    expect((await getRun(t, load)).status).toBe('running');
    expect((await getRun(t, campaign)).markedFailed?.reason).toBe('again');
    expect(await offerOf(admin.as, campaign)).toBeNull();
  });

  test('with the pass’s mark undone and the campaign open, no offer, and the write refused', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    const pass = await admin.as.mutation(api.machineryWrites.markRunFailed, {
      runId: load,
      reason: 'q',
    });
    await admin.as.mutation(api.undo.run, { actionId: pass.actionId });
    expect(await offerOf(admin.as, campaign)).toBeNull();
    await expect(
      admin.as.mutation(api.machineryWrites.markRunFailed, {
        runId: campaign,
        reason: 'x',
        afterPass: load,
      }),
    ).rejects.toThrow(CAMPAIGN_MOVED_ON);
  });

  test('a campaign closed by the script offers nothing', async () => {
    const { t, admin } = await setup();
    const { campaign, load } = await quietCampaign(t);
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId: load, reason: 'q' });
    await t.run((ctx) => ctx.db.patch(campaign, { status: 'failed', finishedAt: Date.now() }));
    expect(await offerOf(admin.as, campaign)).toBeNull();
    expect(
      (await admin.as.query(api.machineryRuns.run, { runId: load, now: Date.now() }))?.campaignToo,
    ).toBeNull();
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

  test('a campaign row between passes is waited on and marked by its own gap', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t, { kind: 'corpus_campaign' });
    vi.advanceTimersByTime(10 * (RUN_QUIET_MS.corpus_campaign as number) + MINUTE);
    await admin.as.mutation(api.machineryWrites.waitOnRun, { runId, now: Date.now() });
    await admin.as.mutation(api.machineryWrites.markRunFailed, { runId, reason: 'slept' });
    expect((await auditOf(t, runId)).map((r) => r.action)).toEqual([
      'wait_on_run',
      'mark_run_failed',
    ]);
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

  test('handing the stop over writes one kept stop line on the run told, past the cap too', async () => {
    const { t, admin } = await setup();
    const runId = await seedRun(t);
    // A log already at its cap: the logger's own words about stopping (a `warn`) are dropped.
    await t.run(async (ctx) => {
      for (let seq = 0; seq < MAX_RUN_EVENTS; seq++) {
        await ctx.db.insert('runEvents', {
          runId,
          seq,
          at: 0,
          loggedAt: 0,
          kind: 'flush',
          text: '',
        });
      }
    });
    await admin.as.mutation(api.machineryWrites.requestRunStop, { runId });
    const answer = await t.mutation(internal.runEvents.append, { runId, events: [line] });
    expect(answer).toMatchObject({ stop: true, dropped: 1 });
    await t.mutation(internal.runEvents.append, {
      runId,
      events: [{ kind: 'warn', text: 'Asked to stop in the console; stopping here', loggedAt: 0 }],
    });
    const kept = (await linesOf(t, runId)).filter((l) => l.seq >= MAX_RUN_EVENTS);
    expect(kept.map((l) => [l.kind, l.text])).toEqual([
      ['cap', RUN_EVENT_CAP_TEXT],
      ['stop', expect.stringContaining('asked the run to stop')],
      ['stop', RUN_STOP_HANDED_TEXT],
    ]);
    expect(kept[0]?.dropped).toBe(2);
  });

  test("a campaign's stop handed to its pass is written on the pass, once", async () => {
    const { t, admin } = await setup();
    const campaign = await seedRun(t, { kind: 'corpus_campaign' });
    const pass = await seedRun(t, { parentRunId: campaign });
    await admin.as.mutation(api.machineryWrites.requestRunStop, { runId: campaign });
    await t.mutation(internal.runEvents.append, { runId: pass, events: [line] });
    await t.mutation(internal.runEvents.append, { runId: pass, events: [line] });
    const handed = (await linesOf(t, pass)).filter((l) => l.kind === 'stop');
    expect(handed.map((l) => l.text)).toEqual([RUN_STOP_HANDED_TEXT]);
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
