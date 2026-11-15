/**
 * The People backfills as an operator runs them (B01 §5.7, "After merge"): one command —
 * `peopleJobs:backfillRows '{}'` — starts the chain, each backfill starting the next when it ends.
 * Whatever the database holds, empty or full of rows written before this build, once the chain has
 * drained every flag in `PEOPLE_BACKFILLS` is set and no People read says `pending`. The registry
 * holds every `READY_*` flag; `packages/guards` holds every `ready:` flag to the registry's module.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import * as peopleRows from './lib/peopleRows';
import { PEOPLE_BACKFILLS, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

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
};

function profile(subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return {
    clerkUserId: subject,
    displayName: subject,
    username: subject,
    driveTimePrefMinutes: 60,
    profileVisibility: 'public' as const,
    notificationPrefs: NOTIF_PREFS,
    dateOfBirth: Date.UTC(1990, 0, 1),
    reputationPoints: 0,
    role: 'member' as const,
    status: 'active' as const,
    createdAt: T0 - 30 * 86_400_000,
    ...over,
  };
}

/** The documented step: one command, drained to the end of the chain. */
async function runDocumentedSteps(t: T) {
  await t.mutation(internal.peopleJobs.backfillRows, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
}

async function flagsSet(t: T): Promise<string[]> {
  const rows = await t.run((ctx) => ctx.db.query('peopleCounts').collect());
  const keys = new Set(rows.map((r) => r.key));
  return PEOPLE_BACKFILLS.filter((b) => keys.has(b.flag)).map((b) => b.flag);
}

/** Every People read an admin's console makes, each asserted to say nothing is pending or short. */
async function expectNothingPending(t: T, adminId: Id<'profiles'>, subject: string) {
  const as = t.withIdentity({ subject });
  const lanes = await as.query(api.people.lanes, {});
  expect(lanes.pending).toEqual([]);
  for (const l of lanes.lanes) {
    expect({ lane: l.lane, pending: l.pending, reasons: l.reasons }).toEqual({
      lane: l.lane,
      pending: [],
      reasons: [],
    });
    const page = await as.query(api.people.listPage, { lane: l.lane });
    expect({ lane: l.lane, pending: page.pending, partial: page.partial }).toEqual({
      lane: l.lane,
      pending: [],
      partial: false,
    });
  }
  const search = await as.query(api.people.listPage, { lane: 'everyone', search: subject });
  expect(search).toMatchObject({ pending: [], partial: false });
  expect((await as.query(api.people.person, { userId: adminId }))?.pending).toEqual([]);
  expect((await as.query(api.people.history, { userId: adminId }))?.pending).toEqual([]);
  const stats = await as.query(api.people.staffStats, { userId: adminId });
  expect(stats).toMatchObject({ pending: [], tenureCapped: false });
  expect((await as.query(api.people.staffSeason, { userId: adminId }))?.pending).toEqual([]);
  expect((await as.query(api.console.overview, {})).people.pending).toEqual([]);
}

describe('the after-merge steps, as documented', () => {
  test('on an empty database the one command sets every flag', async () => {
    const t = convexTest(schema, modules);
    expect(await flagsSet(t)).toEqual([]);
    await runDocumentedSteps(t);
    expect(await flagsSet(t)).toEqual(PEOPLE_BACKFILLS.map((b) => b.flag));
    // The first account, made through the writers after the steps: every read whole.
    const adminId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('profiles', profile('adm', { role: 'admin' }));
      await refreshPersonRow(ctx, id);
      return id;
    });
    await expectNothingPending(t, adminId, 'adm');
  });

  test('on a database written before this build, the one command sets every flag and every read is whole', async () => {
    const t = convexTest(schema, modules);
    // Rows as the old writers left them: profiles with no People row, a flag with no subject, and
    // an undo chain with no stored place.
    const { adminId } = await t.run(async (ctx) => {
      const adminId = await ctx.db.insert('profiles', profile('adm', { role: 'admin' }));
      const skater = await ctx.db.insert('profiles', profile('skater'));
      await ctx.db.insert('contentFlags', {
        flaggerId: adminId,
        targetType: 'user',
        targetId: skater,
        reason: 'spam',
        status: 'open',
        createdAt: T0 - 1_000,
      });
      const role = { actorId: adminId, targetType: 'user' as const, reason: 'r' };
      const first = await ctx.db.insert('moderationActions', {
        ...role,
        targetId: skater,
        action: 'set_posting_permission',
        createdAt: T0 - 3_000,
      });
      await ctx.db.insert('moderationActions', {
        ...role,
        targetId: skater,
        action: 'set_posting_permission',
        undoesActionId: first,
        createdAt: T0 - 2_000,
      });
      return { adminId };
    });
    const as = t.withIdentity({ subject: 'adm' });
    // Before: every dependent read says not ready.
    expect((await as.query(api.people.lanes, {})).pending).toEqual(['rows', 'flagSubjects']);
    expect((await as.query(api.people.staffStats, { userId: adminId }))?.pending).toEqual([
      'undoChains',
    ]);

    await runDocumentedSteps(t);
    expect(await flagsSet(t)).toEqual(PEOPLE_BACKFILLS.map((b) => b.flag));
    const flag = await t.run((ctx) => ctx.db.query('contentFlags').first());
    expect(flag?.subjectUserId).toBeDefined();
    const undo = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .filter((q) => q.neq(q.field('undoesActionId'), undefined))
        .first(),
    );
    expect(undo?.undoRoot).toBeDefined();
    await expectNothingPending(t, adminId, 'adm');
    expect(
      (await as.query(api.people.lanes, {})).lanes.find((l) => l.lane === 'everyone')?.count,
    ).toEqual({ count: 2, capped: false });
  });

  test('`alone` re-runs one backfill without starting the rest', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.peopleJobs.backfillRows, { alone: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    expect(await flagsSet(t)).toEqual([peopleRows.READY_ROWS]);
    await t.mutation(internal.peopleJobs.backfillFlagSubjects, { alone: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    expect(await flagsSet(t)).toEqual([peopleRows.READY_ROWS, peopleRows.READY_FLAG_SUBJECTS]);
  });

  test('a backfill with a failure leaves its own flag unset and still starts the next', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', profile('skater'));
    });
    const refresh = vi
      .spyOn(peopleRows, 'refreshPersonRow')
      .mockRejectedValueOnce(new Error('boom'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runDocumentedSteps(t);
    refresh.mockRestore();
    quiet.mockRestore();
    expect(await flagsSet(t)).toEqual([
      peopleRows.READY_FLAG_SUBJECTS,
      peopleRows.READY_UNDO_CHAINS,
    ]);
  });
});

describe('the registry', () => {
  test('every READY_* flag the module exports is in PEOPLE_BACKFILLS, once, in a job of its own', () => {
    const exported = Object.entries(peopleRows)
      .filter(([name]) => /^READY_[A-Z_]+$/.test(name))
      .map(([, value]) => value);
    expect(exported.length).toBeGreaterThan(0);
    const flags = PEOPLE_BACKFILLS.map((b) => b.flag);
    expect([...flags].sort()).toEqual([...exported].sort());
    expect(new Set(flags).size).toBe(flags.length);
    expect(new Set(PEOPLE_BACKFILLS.map((b) => b.job)).size).toBe(flags.length);
    for (const flag of flags) expect(flag).toMatch(/^ready:/);
  });
});
