/**
 * The People reads at their maximum supported input, every row on its most expensive branch, under
 * Convex's real transaction limits — bytes, documents and database calls. Nothing may throw: a read
 * that runs out of budget returns what it has and says `capped`.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
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
    expect(s?.overturned).toEqual({ count: 1_999, capped: false });
  });

  test('a full week of takedowns whose verdicts others reversed: the budget stops it and says capped', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', 'moderator');
    const adm = await seed(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      // Three reads a row (its verdict, the row that ended it, that row's chain): past the calls a
      // transaction allows well before the last row.
      for (let i = 0; i < 1_300; i++) {
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
    expect(s?.decisions.thisWeek.count).toBe(1_300);
    expect(s?.overturned?.capped).toBe(true);
    expect(s?.overturned?.count).toBeGreaterThan(0);
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

  test('before the undo-chain backfill, the undo figures say they may be short; the backfill places old chains', async () => {
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
    expect(before?.decisions.undoneByOthers).toEqual({ count: 0, capped: true });
    await t.mutation(internal.peopleJobs.backfillUndoChains, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    const after = await t
      .withIdentity({ subject: 'adm' })
      .query(api.people.staffStats, { userId: matt });
    expect(after?.decisions.undoneByOthers).toEqual({ count: 1, capped: false });
  });
});
