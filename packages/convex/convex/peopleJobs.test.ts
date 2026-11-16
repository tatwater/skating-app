/**
 * The People jobs: the lapsed-suspension sweep (one failing person never holds up the rest; never an
 * account in its deletion window, being finalized, or deleted), its daily retry, the rows' drift
 * repair, and the backfills — the chains on their dearest pages under Convex's real limits.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { MAX_ATTEMPTS } from './lib/attempts';
import * as audit from './lib/audit';
import { type PeopleBackfill, readPreparation, refreshPersonRow } from './lib/peopleRows';
import { LAPSED_REASON } from './peopleJobs';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2027, 0, 14, 12);
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.restoreAllMocks();
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
};

/**
 * Near the document limit, in a profile's one free-text field: what a profile can weigh (its cached
 * isochrones can too, but a megabyte of polygon coordinates is slow to encode, and the read budget
 * charges a profile at the limit whatever makes it heavy).
 */
const HEAVY_BIO = 'h'.repeat(1000 * 1024);

async function seed(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}, row = true) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
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
      createdAt: Date.now(),
      ...over,
    });
    if (row) await refreshPersonRow(ctx, id);
    return id;
  });
}

const get = (t: T, id: Id<'profiles'>) => t.run((ctx) => ctx.db.get(id));
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);

async function isReady(t: T, backfill: PeopleBackfill) {
  const { pending } = await t.run((ctx) => readPreparation(ctx));
  return !pending.includes(backfill);
}
async function sweep(t: T) {
  await t.mutation(internal.peopleJobs.sweepLapsedSuspensions, {});
  await drain(t);
}

describe('the lapsed-suspension sweep', () => {
  test('resets a lapsed suspension with an actorless row, and leaves every other account as it is', async () => {
    const t = convexTest(schema, modules);
    const lapsed = await seed(t, 'lapsed', {
      status: 'suspended',
      suspendedUntil: T0 - MIN,
      statusReason: 'x',
    });
    const running = await seed(t, 'running', { status: 'suspended', suspendedUntil: T0 + DAY });
    const leaving = await seed(t, 'leaving', {
      status: 'suspended',
      suspendedUntil: T0 - MIN,
      deletionRequestedAt: T0 - DAY,
    });
    const deleting = await seed(t, 'deleting', { status: 'deleting', suspendedUntil: T0 - MIN });
    const deleted = await seed(t, 'deleted', {
      status: 'deleted',
      suspendedUntil: T0 - MIN,
      deletedAt: 1,
    });
    const before = await Promise.all([running, leaving, deleting, deleted].map((id) => get(t, id)));
    await sweep(t);
    const after = await get(t, lapsed);
    expect(after).toMatchObject({ status: 'active' });
    expect(after?.suspendedUntil).toBeUndefined();
    expect(after?.statusReason).toBeUndefined();
    const rows = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'unban', targetId: lapsed, reason: LAPSED_REASON });
    expect(rows[0]?.actorId).toBeUndefined();
    expect(
      await Promise.all([running, leaving, deleting, deleted].map((id) => get(t, id))),
    ).toEqual(before);
    // The row moved with it: no longer in Suspended's index range, and its status is active.
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', lapsed))
        .first(),
    );
    expect(row).toMatchObject({ status: 'active', suspendedUntil: 0 });
  });

  test('the nested reset itself refuses an account in the window, being finalized, or a tombstone', async () => {
    const t = convexTest(schema, modules);
    const leaving = await seed(t, 'l', {
      status: 'suspended',
      suspendedUntil: 1,
      deletionRequestedAt: 1,
    });
    const deleting = await seed(t, 'd', { status: 'deleting' });
    const active = await seed(t, 'a');
    const running = await seed(t, 'r', { status: 'suspended', suspendedUntil: T0 + DAY });
    const outcome = (userId: Id<'profiles'>) =>
      t.mutation(internal.peopleJobs.lapseOne, { userId, now: T0 });
    expect(await outcome(leaving)).toBe('leaving');
    expect(await outcome(deleting)).toBe('gone');
    expect(await outcome(active)).toBe('not_suspended');
    expect(await outcome(running)).toBe('not_lapsed');
  });

  test('a failing person is counted and walked past; three runs park them; the daily retry frees what heals', async () => {
    const t = convexTest(schema, modules);
    const poison = await seed(t, 'poison', { status: 'suspended', suspendedUntil: T0 - 2 * MIN });
    const healthy = await seed(t, 'healthy', { status: 'suspended', suspendedUntil: T0 - MIN });
    const real = audit.writePersonAudit;
    let failing = true;
    vi.spyOn(audit, 'writePersonAudit').mockImplementation(async (ctx, entry) => {
      if (failing && entry.targetId === poison) throw new Error('poison');
      return real(ctx, entry);
    });
    await sweep(t);
    expect((await get(t, healthy))?.status).toBe('active');
    expect(await get(t, poison)).toMatchObject({
      status: 'suspended',
      lapseAttempts: 1,
      lapseErrorClass: 'Error',
    });
    for (let run = 1; run < MAX_ATTEMPTS; run++) {
      vi.advanceTimersByTime(15 * MIN);
      await sweep(t);
    }
    const parked = await get(t, poison);
    expect(parked?.lapseAttempts).toBe(MAX_ATTEMPTS);
    expect(parked?.lapseParkedAt).toBeDefined();
    // Parked is out of the due range: a fourth run doesn't try it.
    vi.advanceTimersByTime(15 * MIN);
    await sweep(t);
    expect((await get(t, poison))?.lapseAttempts).toBe(MAX_ATTEMPTS);
    await t.mutation(internal.peopleJobs.retryLapsedDaily, {});
    await drain(t);
    // Tried once this run: the failure re-stamps it at the run's own start, which the run never rereads.
    expect(await get(t, poison)).toMatchObject({ lapseAttempts: MAX_ATTEMPTS + 1 });
    expect((await get(t, poison))?.lapseRetriedAt).toBeDefined();
    const listed = await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        clerkUserId: 'ops',
        displayName: 'ops',
        username: 'ops',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: 0,
        reputationPoints: 0,
        role: 'admin' as const,
        status: 'active' as const,
        createdAt: 0,
      });
      return null;
    });
    void listed;
    const view = await t.withIdentity({ subject: 'ops' }).query(api.peopleJobs.parkedLapses, {});
    expect(view.parked.map((p) => p.userId)).toEqual([poison]);
    failing = false;
    vi.advanceTimersByTime(DAY);
    await t.mutation(internal.peopleJobs.retryLapsedDaily, {});
    await drain(t);
    const freed = await get(t, poison);
    expect(freed?.status).toBe('active');
    expect(freed?.lapseParkedAt).toBeUndefined();
    expect(freed?.lapseAttempts).toBeUndefined();
  });

  test('a failed reset is charged its whole allowance: the pass ends there, and the next goes on', async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const poison = await seed(t, 'poison', { status: 'suspended', suspendedUntil: T0 - 3 * MIN });
    const rest = [
      await seed(t, 'r1', { status: 'suspended', suspendedUntil: T0 - 2 * MIN }),
      await seed(t, 'r2', { status: 'suspended', suspendedUntil: T0 - MIN }),
    ];
    const real = audit.writePersonAudit;
    vi.spyOn(audit, 'writePersonAudit').mockImplementation(async (ctx, entry) => {
      if (entry.targetId === poison) throw new Error('poison');
      return real(ctx, entry);
    });
    expect(await t.mutation(internal.peopleJobs.sweepLapsedSuspensions, {})).toMatchObject({
      reset: 0,
      failed: 1,
      more: true,
    });
    await drain(t);
    for (const id of rest) expect((await get(t, id))?.status).toBe('active');
    expect((await get(t, poison))?.lapseAttempts).toBe(1);
  });

  test('a new suspension starts the record over', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'mod', { role: 'moderator' });
    const p = await seed(t, 'p', {
      status: 'suspended',
      suspendedUntil: T0 - MIN,
      lapseAttempts: 3,
      lapseParkedAt: T0 - DAY,
      lapseErrorClass: 'Error',
    });
    await t.withIdentity({ subject: 'mod' }).mutation(api.moderation.suspendUser, {
      userId: p,
      reason: 'again',
      suspendedUntil: T0 + MIN,
    });
    const after = await get(t, p);
    expect(after?.lapseParkedAt).toBeUndefined();
    expect(after?.lapseAttempts).toBeUndefined();
    vi.advanceTimersByTime(2 * MIN);
    await sweep(t);
    expect((await get(t, p))?.status).toBe('active');
  });

  test('fairness: over any outcomes across runs, healthy people are reset in their run and the failing park after three', async () => {
    type Outcome = 'fail' | 'succeed';
    const RUNS = 4;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.constantFrom<Outcome>('fail', 'succeed'), {
            minLength: RUNS,
            maxLength: RUNS,
          }),
          {
            minLength: 1,
            maxLength: 4,
          },
        ),
        async (plans) => {
          vi.restoreAllMocks();
          vi.setSystemTime(T0);
          const t = convexTest(schema, modules);
          const ids: Id<'profiles'>[] = [];
          for (const [i] of plans.entries()) {
            ids.push(
              await seed(t, `p${i}`, { status: 'suspended', suspendedUntil: T0 - (i + 1) * MIN }),
            );
          }
          const failing = new Set<string>();
          const real = audit.writePersonAudit;
          vi.spyOn(audit, 'writePersonAudit').mockImplementation(async (ctx, entry) => {
            if (failing.has(entry.targetId)) throw new Error('poison');
            return real(ctx, entry);
          });
          const model = plans.map(() => ({ failures: 0, parked: false, done: false }));
          for (let run = 0; run < RUNS; run++) {
            failing.clear();
            for (const [i, plan] of plans.entries()) {
              if (plan[run] === 'fail') failing.add(ids[i] as string);
            }
            await sweep(t);
            for (const [i, plan] of plans.entries()) {
              const m = model[i] as { failures: number; parked: boolean; done: boolean };
              if (!m.done && !m.parked) {
                if (plan[run] === 'fail') {
                  m.failures++;
                  if (m.failures >= MAX_ATTEMPTS) m.parked = true;
                } else m.done = true;
              }
              const p = await get(t, ids[i] as Id<'profiles'>);
              expect(p?.status === 'active').toBe(m.done);
              expect(p?.lapseParkedAt !== undefined).toBe(m.parked);
              if (!m.done) expect(p?.lapseAttempts ?? 0).toBe(m.failures);
            }
            vi.advanceTimersByTime(15 * MIN);
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  test('a chain of heavy profiles finishes under the real limits', async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids: Id<'profiles'>[] = [];
    // Three people a pass at the worst a profile weighs (each step keeps its head, its nested reset and a failure's record in reach): seven take three passes.
    for (let i = 0; i < 7; i++) {
      ids.push(
        await seed(t, `h${i}`, {
          status: 'suspended',
          suspendedUntil: T0 - MIN,
          bio: HEAVY_BIO,
        }),
      );
    }
    await sweep(t);
    for (const id of ids) expect((await get(t, id))?.status).toBe('active');
  });
});

describe('the rows: backfill, drift repair, a tombstone put back', () => {
  test('the backfill writes every heavy profile’s row, reports an overwritten tombstone, and marks ready', async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    for (let i = 0; i < 12; i++) await seed(t, `h${i}`, { bio: HEAVY_BIO }, false);
    const broken = await seed(t, 'broken', { status: 'banned', deletedAt: T0 - DAY }, false);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await t.mutation(internal.peopleJobs.backfillRows, {});
    await drain(t);
    const rows = await t.run((ctx) => ctx.db.query('peopleRows').collect());
    expect(rows).toHaveLength(13);
    expect(await isReady(t, 'rows')).toBe(true);
    expect(errors.mock.calls.some((c) => String(c[0]).includes(broken))).toBe(true);
    await t.mutation(internal.peopleJobs.restoreTombstoneStatus, { userId: broken });
    expect((await get(t, broken))?.status).toBe('deleted');
    expect(
      await t.mutation(internal.peopleJobs.restoreTombstoneStatus, { userId: broken }),
    ).toEqual({
      restored: false,
    });
  });

  test('a backfill with a failure is not marked ready', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'a', {}, false);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = await import('./lib/peopleRows');
    vi.spyOn(real, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
    await t.mutation(internal.peopleJobs.backfillRows, {});
    await drain(t);
    expect(await isReady(t, 'rows')).toBe(false);
    expect(errors).toHaveBeenCalled();
  });

  test('a failed refresh ends the backfill’s pass; the next goes on after it, and nothing is marked ready', async () => {
    const t = convexTest(schema, modules);
    const first = await seed(t, 'a', {}, false);
    const second = await seed(t, 'b', {}, false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lib = await import('./lib/peopleRows');
    vi.spyOn(lib, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
    expect(await t.mutation(internal.peopleJobs.backfillRows, {})).toEqual({ done: false });
    await drain(t);
    const rows = await t.run((ctx) => ctx.db.query('peopleRows').collect());
    expect(rows.map((r) => r.userId)).toEqual([second]);
    expect(rows.some((r) => r.userId === first)).toBe(false);
    expect(await isReady(t, 'rows')).toBe(false);
  });

  test('a failed drift repair leaves the rest of its rows for the next run', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'p');
    await seed(t, 'q');
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('peopleRows').collect()) {
        await ctx.db.patch(row._id, { refreshedAt: T0 - 2 * DAY });
      }
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lib = await import('./lib/peopleRows');
    vi.spyOn(lib, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
    expect(await t.mutation(internal.peopleJobs.repairDrift, {})).toEqual({
      repaired: 0,
      failed: 1,
    });
    expect(await t.mutation(internal.peopleJobs.repairDrift, {})).toEqual({
      repaired: 1,
      failed: 0,
    });
  });

  test('the drift repair re-derives a row a write missed, and moves a failing one to the back', async () => {
    const t = convexTest(schema, modules);
    const p = await seed(t, 'p');
    await t.run(async (ctx) => {
      await ctx.db.patch(p, { status: 'banned' });
      const row = await ctx.db.query('peopleRows').first();
      if (row) await ctx.db.patch(row._id, { refreshedAt: T0 - 2 * DAY });
    });
    await t.mutation(internal.peopleJobs.repairDrift, {});
    expect((await t.run((ctx) => ctx.db.query('peopleRows').first()))?.status).toBe('banned');
    await t.run(async (ctx) => {
      const row = await ctx.db.query('peopleRows').first();
      if (row) await ctx.db.patch(row._id, { refreshedAt: T0 - 2 * DAY });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lib = await import('./lib/peopleRows');
    vi.spyOn(lib, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
    expect(await t.mutation(internal.peopleJobs.repairDrift, {})).toEqual({
      repaired: 0,
      failed: 1,
    });
    expect((await t.run((ctx) => ctx.db.query('peopleRows').first()))?.refreshedAt).toBe(T0);
  });

  test('the flag-subject backfill stamps every older flag over heavy targets, then marks ready', async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const author = await seed(t, 'author', { bio: HEAVY_BIO });
    const filer = await seed(t, 'filer');
    for (let i = 0; i < 14; i++) {
      await t.run((ctx) =>
        ctx.db.insert('contentFlags', {
          flaggerId: filer,
          targetType: 'user',
          targetId: author,
          reason: 'spam',
          status: 'dismissed',
          createdAt: Date.now(),
        }),
      );
    }
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer,
        targetType: 'report',
        targetId: 'gone',
        reason: 'spam',
        status: 'open',
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.peopleJobs.backfillFlagSubjects, {});
    await drain(t);
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags.filter((f) => f.subjectUserId === author)).toHaveLength(14);
    expect(flags.filter((f) => f.subjectUserId === null)).toHaveLength(1);
    expect(await isReady(t, 'flagSubjects')).toBe(true);
  });
});
