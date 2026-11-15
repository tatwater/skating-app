/**
 * The People reads at their maximum supported input, every row on its most expensive branch, under
 * Convex's real transaction limits — bytes, documents and database calls. Nothing may throw: a read
 * that runs out of budget returns what it has and says `capped`.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { asUndoOf, writeAudit } from './lib/audit';
import {
  markReady,
  READY_FLAG_SUBJECTS,
  READY_ROWS,
  READY_UNDO_CHAINS,
  refreshPersonRow,
} from './lib/peopleRows';
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

async function seed(t: T, subject: string, role: Doc<'profiles'>['role']) {
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
      role,
      status: 'active' as const,
      createdAt: 0,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

async function setup(ready = true) {
  const t = convexTest({ schema, modules, transactionLimits: true });
  if (ready) {
    await t.run(async (ctx) => {
      await markReady(ctx, READY_ROWS);
      await markReady(ctx, READY_FLAG_SUBJECTS);
      await markReady(ctx, READY_UNDO_CHAINS);
    });
  }
  return t;
}

/** `count` decisions by `actorId` this week, written straight to the log, each shaped by `extra`. */
async function decisions(
  t: T,
  actorId: Id<'profiles'>,
  count: number,
  extra: (i: number) => Partial<Doc<'moderationActions'>>,
) {
  return t.run(async (ctx) => {
    const ids: Id<'moderationActions'>[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        await ctx.db.insert('moderationActions', {
          actorId,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: actorId,
          reason: 'r',
          createdAt: T0 - i * 60_000,
          ...extra(i),
        }),
      );
    }
    return ids;
  });
}

describe('staffStats at its maximum supported input', () => {
  test('a full week of decisions, every one undone by someone else, in an open season', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    // One under the read's row cap, so the read is whole: the most it supports.
    await decisions(t, matt, 1_999, () => ({ undoTop: 1, undoTopActorId: adm }));
    const s = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.thisWeek).toEqual({ count: 1_999, capped: false });
    expect(s?.decisions.undoneByOthers).toEqual({ count: 1_999, capped: false });
    const ss = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffSeason, { userId: matt });
    // A season's checks stop at their time bound: past it, the count says capped.
    expect(ss?.overturned).toEqual({ count: 600, capped: true });
  });

  test('a full week of takedowns whose verdicts others reversed: the budget stops it and says capped', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      // Two reads a row (its verdict, the row that ended it — a restore is its own chain's first
      // row, never read again): past the calls a transaction allows before the last row.
      for (let i = 0; i < 1_900; i++) {
        const at = T0 - i * 60_000;
        const restore = await ctx.db.insert('moderationActions', {
          actorId: adm,
          action: 'restore',
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'r',
          createdAt: at + 1,
        });
        const hide = await ctx.db.insert('moderationActions', {
          actorId: matt,
          action: 'hide',
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'r',
          createdAt: at,
        });
        await ctx.db.insert('contentVerdicts', {
          subjectUserId: adm,
          targetType: 'report',
          targetId: `r${i}`,
          actionId: hide,
          kind: 'hidden',
          at,
          standing: false,
          endedAt: at + 1,
          endedByActionId: restore,
        });
      }
    });
    const s = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.thisWeek.count).toBe(1_900);
    const ss = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffSeason, { userId: matt });
    expect(ss?.overturned?.capped).toBe(true);
    expect(ss?.overturned?.count).toBeGreaterThan(0);
    // The role rows are read before the loop that ran out, so the dates aren't starved by it.
    expect(s?.tenureCapped).toBe(false);
    // Reaching the calls limit genuinely takes past 3,500 reads, so this one test carries its own
    // bound: about 2.7 s here with coverage, several times that on CI's runner.
  }, 60_000);

  test('a chain of nine undos and one of fifty, read from the row and its chain’s first row', async () => {
    for (const [top, undone] of [
      [9, 1],
      [50, 0],
    ] as const) {
      const t = await setup();
      const matt = await seed(t, 'matt', 'moderator');
      const adm = await seed(t, 'adm', 'admin');
      await decisions(t, matt, 1, () => ({ undoTop: top, undoTopActorId: adm }));
      const s = await t
        .withIdentity({ subject: 'adm' })
        .query(api.people.staffStats, { userId: matt });
      expect(s?.decisions.undoneByOthers).toEqual({ count: undone, capped: false });
    }
  });

  test('a real chain of nine undos through the writes stamps its depth, and counts as undone', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', 'moderator');
    await seed(t, 'adm', 'admin');
    const skater = await seed(t, 'skater', 'member');
    await t.withIdentity({ subject: 'matt' }).mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'hazards',
      allowed: false,
      reason: 'r',
    });
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(1_000);
      const [newest] = await t.run((ctx) =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', skater))
          .order('desc')
          .take(1),
      );
      await t
        .withIdentity({ subject: 'adm' })
        .mutation(api.undo.run, { actionId: newest?._id as Id<'moderationActions'>, reason: 'r' });
    }
    const s = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.undoneByOthers).toEqual({ count: 1, capped: false });
  });

  test('before the undo-chain backfill, the undo figures say not ready (not capped); the backfill places old chains', async () => {
    const t = await setup(false);
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      await markReady(ctx, READY_ROWS);
      // A decision and three undos on it, written before the chains were kept.
      let prev = await ctx.db.insert('moderationActions', {
        actorId: matt,
        action: 'set_posting_permission',
        targetType: 'user',
        targetId: 'x',
        reason: 'r',
        createdAt: T0,
      });
      for (let i = 1; i <= 3; i++) {
        prev = await ctx.db.insert('moderationActions', {
          actorId: adm,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: 'x',
          reason: 'r',
          undoesActionId: prev,
          createdAt: T0 + i,
        });
      }
    });
    const before = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(before?.decisions.undoneByOthers).toEqual({ count: 0, capped: false });
    expect(before?.pending).toEqual(['undoChains']);
    await t.mutation(internal.peopleJobs.backfillUndoChains, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    const after = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(after?.decisions.undoneByOthers).toEqual({ count: 1, capped: false });
    expect(after?.pending).toEqual([]);
  });
});

describe('the figures say capped rather than throw or mislead', () => {
  test('a heavily flagged person’s page: the helpers’ reads are reserved first, so the flags cap instead of throwing', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', 'admin');
    const spam = await seed(t, 'spam', 'member');
    await t.run(async (ctx) => {
      const flag = (over: Partial<Doc<'contentFlags'>>) =>
        ctx.db.insert('contentFlags', {
          flaggerId: adm,
          targetType: 'user',
          targetId: spam,
          reason: 'spam',
          status: 'open',
          origin: 'user',
          createdAt: T0,
          ...over,
        });
      for (const status of ['open', 'reviewing'] as const) {
        for (let i = 0; i < 51; i++) await flag({ status });
        for (let i = 0; i < 101; i++) {
          await flag({ status, targetType: 'report', targetId: `r${i}`, subjectUserId: spam });
        }
      }
      for (let i = 0; i < 101; i++) {
        await flag({
          flaggerId: spam,
          targetType: 'report',
          targetId: `f${i}`,
          status: 'dismissed',
        });
      }
    });
    const page = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.person, { userId: spam });
    expect(page?.open.flagsCapped).toBe(true);
    expect(page?.rights.flagsFiled.capped).toBe(true);
  });

  test('time to decide says capped, not unrecorded, when the budget runs out reading filings', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      // Decisions from before the row recorded its filing: each reads its flag, and every flag
      // weighs its worst, so the budget is spent long before the last.
      for (let i = 0; i < 1_000; i++) {
        const flagId = await ctx.db.insert('contentFlags', {
          flaggerId: adm,
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'spam',
          note: 'n'.repeat(13_000),
          status: 'actioned',
          origin: 'user',
          createdAt: T0 - 3_600_000,
        });
        await ctx.db.insert('moderationActions', {
          actorId: matt,
          action: 'resolve_flag',
          targetType: 'contentFlag',
          targetId: flagId,
          reason: 'r',
          createdAt: T0 - i * 60_000,
        });
      }
    });
    const s = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(s?.timeToDecide).toEqual({ medianMs: null, decided: 1_000, capped: true });
  }, 60_000);

  test('an undo of an undo written before chains were kept places that undo first', async () => {
    const t = await setup(false);
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    const base = {
      action: 'set_posting_permission' as const,
      targetType: 'user' as const,
      targetId: 'x',
      reason: 'r',
    };
    const ids = await t.run(async (ctx) => {
      await markReady(ctx, READY_ROWS);
      const change = await ctx.db.insert('moderationActions', {
        ...base,
        actorId: matt,
        createdAt: T0,
      });
      const legacy = await ctx.db.insert('moderationActions', {
        ...base,
        actorId: adm,
        undoesActionId: change,
        createdAt: T0 + 1,
      });
      const redo = await asUndoOf(ctx, legacy, () =>
        writeAudit(ctx, { ...base, actorId: adm, createdAt: T0 + 2 }),
      );
      return { change, legacy, redo };
    });
    const [change, legacy, redo] = await t.run((ctx) =>
      Promise.all([ids.change, ids.legacy, ids.redo].map((id) => ctx.db.get(id))),
    );
    expect(legacy).toMatchObject({ undoRoot: ids.change, undoDepth: 1 });
    expect(redo).toMatchObject({ undoRoot: ids.change, undoDepth: 2 });
    expect(change).toMatchObject({ undoTop: 2, undoTopActorId: adm });
    // The backfill leaves the chain as the write placed it: the change, undone twice, stands.
    await t.mutation(internal.peopleJobs.backfillUndoChains, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    const s = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.undoneByOthers).toEqual({ count: 0, capped: false });
  });

  test('before the backfill, a role undo from before the chains makes the dates not ready, never wrong', async () => {
    const t = await setup(false);
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      await markReady(ctx, READY_ROWS);
      const role = { actorId: adm, targetType: 'user' as const, targetId: matt, reason: 'r' };
      const grant = await ctx.db.insert('moderationActions', {
        ...role,
        action: 'grant_role',
        metadata: { role: 'moderator', priorRole: 'member' },
        createdAt: T0 - 3,
      });
      const undo = await ctx.db.insert('moderationActions', {
        ...role,
        action: 'revoke_role',
        metadata: { priorRole: 'moderator' },
        undoesActionId: grant,
        createdAt: T0 - 2,
      });
      await ctx.db.insert('moderationActions', {
        ...role,
        action: 'grant_role',
        metadata: { role: 'moderator', priorRole: 'member' },
        undoesActionId: undo,
        createdAt: T0 - 1,
      });
    });
    const stats = () =>
      t.withIdentity({ subject: 'adm' }).query(api.people.staffStats, { userId: matt });
    expect(await stats()).toMatchObject({
      staffSince: null,
      roleSince: null,
      tenureCapped: false,
      pending: ['undoChains'],
    });
    await t.mutation(internal.peopleJobs.backfillUndoChains, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    // Undone twice, the grant is back with its own time.
    expect(await stats()).toMatchObject({
      staffSince: { at: T0 - 3, role: 'moderator' },
      roleSince: { at: T0 - 3, role: 'moderator' },
      tenureCapped: false,
      pending: [],
    });
  });

  test('a role walk that reads its last row without the entering grant says capped; one short is whole', async () => {
    for (const [rows, capped] of [
      [49, false],
      [50, true],
    ] as const) {
      const t = await setup();
      const matt = await seed(t, 'matt', 'moderator');
      const adm = await seed(t, 'adm', 'admin');
      await t.run(async (ctx) => {
        // Moves between admin and moderator only: none of them is the entering grant.
        for (let i = 0; i < rows; i++) {
          await ctx.db.insert('moderationActions', {
            actorId: adm,
            action: 'grant_role',
            targetType: 'user',
            targetId: matt,
            reason: 'r',
            metadata: { role: 'moderator', priorRole: 'admin' },
            createdAt: T0 - rows + i,
          });
        }
      });
      const s = await t
        .withIdentity({ subject: 'adm' })
        .query(api.people.staffStats, { userId: matt });
      // Forty-nine rows and then the end: the record is whole, and the entry was never recorded.
      // Fifty: the entry may lie past the walk.
      expect(s).toMatchObject({ staffSince: null, tenureCapped: capped });
    }
  });

  test('the lanes and a lane page with every queue at its cap, every row at its heaviest', async () => {
    const t = await setup();
    await seed(t, 'adm', 'admin');
    const filer = await seed(t, 'filer', 'member');
    const people: Id<'profiles'>[] = [];
    for (let i = 0; i < 40; i++) people.push(await seed(t, `p${i}`, 'member'));
    await t.run(async (ctx) => {
      for (const status of ['open', 'reviewing'] as const) {
        for (let i = 0; i <= 200; i++) {
          await ctx.db.insert('contentFlags', {
            flaggerId: filer,
            targetType: 'report',
            targetId: `r${status}${i}`,
            reason: 'spam',
            note: 'n'.repeat(1_000),
            status,
            subjectUserId: people[i % people.length] as Id<'profiles'>,
            createdAt: T0 - i,
          });
        }
      }
      for (const status of ['open', 'in_progress'] as const) {
        for (let i = 0; i <= 50; i++) {
          await ctx.db.insert('supportTickets', {
            userId: people[i % people.length] as Id<'profiles'>,
            clerkUserId: 'x',
            category: 'account',
            status,
            body: 'b'.repeat(5_000),
            createdAt: T0 - i,
          });
        }
      }
    });
    const a = t.withIdentity({ subject: 'adm' });
    const { lanes } = await a.query(api.people.lanes, {});
    expect(lanes.find((l) => l.lane === 'flagged')?.reasons).toEqual(['flags_capped']);
    expect(lanes.find((l) => l.lane === 'appeals')?.reasons).toEqual(['tickets_capped']);
    const page = await a.query(api.people.listPage, { lane: 'flagged', pageSize: 100 });
    expect(page.rows.length).toBe(40);
    expect(page.partial).toBe(true);
  });
});
