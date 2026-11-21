/**
 * **The withdrawal rows are what the items say, after any history** (B01-4m, D282). For any sequence
 * of withdrawals (a Report, a Post, a comment, a hazard deleted; an alert retracted by its author),
 * decisions (hide, remove, a moderator's retraction kept as evidence, keep on the record), restores,
 * overturns, undos, erasure, the content record's replay and the withdrawals backfill — across every
 * kind — each item has a `contentWithdrawals` row exactly when it is its author's withdrawal and not
 * erased, and its stored `held` always equals what the Deleted list asked of each row before this
 * build: whether a standing verdict on that item exists (`contentVerdicts.by_target_standing`). Read
 * here from the raw rows, never through `lib/withdrawals`. The backfill run over a database the live
 * writers kept writes nothing.
 *
 * Pinned seeds, plus one random seed, logged.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { syncWithdrawalById } from './lib/withdrawals';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 18, 12);

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

type Kind = 'report' | 'post' | 'comment' | 'hazard' | 'accessAlert';
interface Item {
  kind: Kind;
  id: string;
}
const TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
  accessAlert: 'accessAlerts',
} as const;

async function world() {
  const t = convexTest(schema, modules);
  const profile = (subject: string, role: 'member' | 'moderator') =>
    t.run(async (ctx) => {
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
        createdAt: T0 - 400 * DAY,
      });
      await refreshPersonRow(ctx, id);
      return id;
    });
  const rob = await profile('rob', 'member');
  const kate = await profile('kate', 'member');
  await profile('matt', 'moderator');
  const items = await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts', 'withdrawals'] as const) {
      await markReady(ctx, b);
    }
    const waterBodyId = await ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: T0,
    });
    const report = (authorId: Id<'profiles'>) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      });
    const r0 = await report(rob);
    // A Post of two of rob's Reports: its delete withdraws the Post and both members.
    const m0 = await report(rob);
    const m1 = await report(rob);
    const p0 = await ctx.db.insert('posts', {
      authorId: rob,
      reportIds: [m0, m1],
      photoIds: [],
      title: 'Opening weekend',
      latestSkateEndTime: T0,
      moderationStatus: 'visible' as const,
      createdAt: T0,
      updatedAt: T0,
    });
    for (const m of [m0, m1]) await ctx.db.patch(m, { postId: p0 });
    const on = await report(kate);
    const c0 = await ctx.db.insert('comments', {
      reportId: on,
      authorId: rob,
      body: 'Learn to read a thermometer.',
      moderationStatus: 'visible' as const,
      source: 'native' as const,
      createdAt: T0,
    } as never);
    // A reply under it, so its erasure leaves a shell (stamped, but no longer rob's to list).
    await ctx.db.insert('comments', {
      reportId: on,
      parentCommentId: c0,
      authorId: kate,
      body: 'Says you.',
      moderationStatus: 'visible' as const,
      source: 'native' as const,
      createdAt: T0,
    } as never);
    const h0 = await ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
      createdByUserId: rob,
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: T0,
      lastConfirmedAt: T0,
      confirmCount: 0,
      goneCount: 0,
      createdAt: T0,
    });
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 0.5, lng: 0.5 },
      source: 'official' as const,
      status: 'visible' as const,
      createdAt: T0,
    } as never);
    const a0 = await ctx.db.insert('accessAlerts', {
      targetType: 'put_in' as const,
      putInId,
      waterBodyId,
      reason: 'not_plowed' as const,
      kind: 'blocker' as const,
      createdByUserId: rob,
      createdAt: T0,
      season: 2026,
      expiresAt: T0 + 30 * DAY,
      status: 'active' as const,
      confirmCount: 0,
      denyCount: 0,
    } as never);
    return [
      { kind: 'report', id: r0 },
      { kind: 'post', id: p0 },
      { kind: 'report', id: m0 },
      { kind: 'comment', id: c0 },
      { kind: 'hazard', id: h0 },
      { kind: 'accessAlert', id: a0 },
      { kind: 'report', id: m1 },
    ] as Item[];
  });
  return {
    t,
    rob,
    items,
    mod: t.withIdentity({ subject: 'matt' }),
    author: t.withIdentity({ subject: 'rob' }),
  };
}

type W = Awaited<ReturnType<typeof world>>;

type Op =
  | { op: 'withdraw' | 'hide' | 'remove' | 'restore' | 'overturn' | 'keep'; i: number }
  | { op: 'undo' }
  | { op: 'erase' }
  | { op: 'replay' }
  | { op: 'backfill' };

const ITEMS = 7;
/**
 * An item, biased toward a few — a Report, the comment and the alert — so a run's operations land on
 * the same item often enough to withdraw, decide on and erase it in one history.
 */
const itemArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 3, 5) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: ITEMS - 1 }) },
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  // Withdrawals as often as decisions: a history needs one before the rows have anything to say.
  { weight: 4, arbitrary: fc.record({ op: fc.constant('withdraw' as const), i: itemArb }) },
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constantFrom(
        'hide' as const,
        'remove' as const,
        'restore' as const,
        'overturn' as const,
        'keep' as const,
      ),
      i: itemArb,
    }),
  },
  { weight: 2, arbitrary: fc.constant<Op>({ op: 'undo' }) },
  { weight: 2, arbitrary: fc.constant<Op>({ op: 'erase' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ op: 'replay' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ op: 'backfill' }) },
);

/** Run a write the history may ask for even where it is refused: the refusal is the history's. */
async function attempt(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // Refused: the history goes on.
  }
}

/** Every scheduled job to its end (the replay's passes, a Post's member clocks, the eraser's). */
const settle = (w: W) => w.t.finishAllScheduledFunctions(vi.runAllTimers);

async function step(w: W, op: Op): Promise<void> {
  vi.advanceTimersByTime(1_000);
  switch (op.op) {
    case 'erase':
      vi.advanceTimersByTime(31 * DAY);
      await w.t.mutation(internal.erasure.eraseDue, {});
      await settle(w);
      return;
    case 'replay':
      // The content record rebuilt from the audit log, alone: every verdict it rewrites moves `held`.
      await w.t.mutation(internal.peopleJobs.backfillVerdicts, { alone: true });
      await settle(w);
      return;
    case 'backfill': {
      // Over rows the live writers kept, the backfill finds nothing to write.
      await w.t.mutation(internal.peopleJobs.backfillWithdrawals, { alone: true });
      await settle(w);
      const pending = await w.t.query(internal.peopleJobs.preparation, {});
      expect(pending.backfills.find((b) => b.backfill === 'withdrawals')).toMatchObject({
        ready: true,
        running: false,
      });
      return;
    }
    case 'undo': {
      const newest = await w.t.run((ctx) =>
        ctx.db
          .query('moderationActions')
          .order('desc')
          .collect()
          .then((rows) =>
            rows.find((r) => r.actorId !== undefined && r.action !== 'author_delete'),
          ),
      );
      if (newest) await attempt(w.mod.mutation(api.undo.run, { actionId: newest._id }));
      await settle(w);
      return;
    }
  }
  const item = w.items[op.i] as Item;
  const target = { targetType: item.kind, targetId: item.id };
  switch (op.op) {
    case 'withdraw':
      await attempt(
        item.kind === 'report'
          ? w.author.mutation(api.reports.remove, { reportId: item.id as Id<'reports'> })
          : item.kind === 'post'
            ? w.author.mutation(api.posts.remove, { postId: item.id as Id<'posts'> })
            : item.kind === 'comment'
              ? w.author.mutation(api.comments.remove, { commentId: item.id as Id<'comments'> })
              : item.kind === 'hazard'
                ? w.author.mutation(api.hazardWithdrawal.withdraw, {
                    hazardId: item.id as Id<'hazards'>,
                  })
                : w.author.mutation(api.accessAlerts.retract, {
                    accessAlertId: item.id as Id<'accessAlerts'>,
                  }),
      );
      break;
    case 'hide':
    case 'remove':
      await attempt(
        item.kind === 'accessAlert'
          ? // An alert's one verdict: a moderator's retraction kept on one its author retracted.
            w.mod.mutation(api.accessAlerts.retract, {
              accessAlertId: item.id as Id<'accessAlerts'>,
              reason: 'a pattern of bad claims',
            })
          : w.mod.mutation(api.moderation.setModerationStatus, {
              targetType: item.kind,
              targetId: item.id,
              status: op.op === 'hide' ? 'hidden' : 'removed',
              reason: op.op,
            }),
      );
      break;
    case 'restore':
      if (item.kind !== 'accessAlert') {
        await attempt(
          w.mod.mutation(api.moderation.setModerationStatus, {
            targetType: item.kind,
            targetId: item.id,
            status: 'visible',
          }),
        );
      }
      break;
    case 'overturn':
      await attempt(w.mod.mutation(api.moderation.overturnVerdict, target));
      break;
    case 'keep':
      await attempt(w.mod.mutation(api.moderation.keepOnRecord, { ...target, reason: 'kept' }));
      break;
  }
  await settle(w);
}

/** The rows each item should have, from the raw documents and verdicts — and the rows there are. */
async function holds(w: W) {
  const { want, have } = await w.t.run(async (ctx) => {
    const want: Record<string, { withdrawnAt: number; held: boolean } | null> = {};
    for (const item of w.items) {
      const doc = (await ctx.db.get(item.id as Id<(typeof TABLE)[Kind]>)) as
        | (Doc<(typeof TABLE)[Kind]> & {
            authorDeletedAt?: number;
            erasedAt?: number;
            retractedAt?: number;
            retractedByUserId?: Id<'profiles'>;
            createdByUserId?: Id<'profiles'>;
            status?: string;
          })
        | null;
      const at =
        doc === null
          ? undefined
          : item.kind === 'accessAlert'
            ? doc.status === 'retracted' && doc.retractedByUserId === doc.createdByUserId
              ? doc.retractedAt
              : undefined
            : doc.erasedAt === undefined
              ? doc.authorDeletedAt
              : undefined;
      const standing = await ctx.db
        .query('contentVerdicts')
        .withIndex('by_target_standing', (q) =>
          q.eq('targetType', item.kind).eq('targetId', item.id).eq('standing', true),
        )
        .first();
      want[item.id] = at === undefined ? null : { withdrawnAt: at, held: standing !== null };
    }
    const have: Record<string, { withdrawnAt: number; held: boolean } | null> = {};
    for (const item of w.items) have[item.id] = null;
    for (const row of await ctx.db.query('contentWithdrawals').collect()) {
      expect(row.subjectUserId, 'a row is on its author’s record').toBe(w.rob);
      expect(row.targetId in have, 'a row names one of the items').toBe(true);
      expect(have[row.targetId], 'one row an item').toBeNull();
      have[row.targetId] = { withdrawnAt: row.withdrawnAt, held: row.held };
    }
    return { want, have };
  });
  expect(have).toEqual(want);
}

const SEEDS = [1, 42, 20261120, Math.floor(Math.random() * 2 ** 31)];

async function history(ops: Op[]): Promise<void> {
  vi.setSystemTime(T0);
  const w = await world();
  for (const op of ops) {
    await step(w, op);
    await holds(w);
  }
}

/**
 * The histories worth pinning: a withdrawal held then overturned; a decision then the withdrawal (it
 * arrives held); a keep then its undo; a Post's delete (three rows) and a hide of the Post (the Post
 * held, its members not); an alert retracted, kept as evidence, then overturned; erasure of a shell;
 * a replay over a moved record.
 */
const PINNED: Op[][] = [
  [
    { op: 'withdraw', i: 0 },
    { op: 'hide', i: 0 },
    { op: 'overturn', i: 0 },
  ],
  [{ op: 'hide', i: 3 }, { op: 'withdraw', i: 3 }, { op: 'undo' }],
  [{ op: 'withdraw', i: 4 }, { op: 'keep', i: 4 }, { op: 'undo' }, { op: 'backfill' }],
  [{ op: 'withdraw', i: 1 }, { op: 'hide', i: 1 }, { op: 'remove', i: 2 }, { op: 'replay' }],
  [{ op: 'withdraw', i: 5 }, { op: 'hide', i: 5 }, { op: 'overturn', i: 5 }, { op: 'erase' }],
  [{ op: 'withdraw', i: 3 }, { op: 'erase' }, { op: 'backfill' }],
];

describe('the withdrawal rows over any history (B01-4m)', () => {
  test.each(PINNED.map((ops, i): [number, Op[]] => [i, ops]))('pinned history %i', (_, ops) =>
    history(ops),
  );
  test.each(SEEDS)('seed %i', async (seed) => {
    console.log(`withdrawalRows seed ${seed}`);
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), history), {
      seed,
      numRuns: 30,
    });
  });
});

describe('the content record’s replay moves `held` (B01-4m)', () => {
  test('a decision only the audit log knows of: the replay stands it up, and the row is held', async () => {
    const w = await world();
    const comment = w.items[3] as Item;
    await w.author.mutation(api.comments.remove, { commentId: comment.id as Id<'comments'> });
    const rowOf = () =>
      w.t.run((ctx) =>
        ctx.db
          .query('contentWithdrawals')
          .withIndex('by_target', (q) => q.eq('targetType', 'comment').eq('targetId', comment.id))
          .first(),
      );
    expect(await rowOf()).toMatchObject({ held: false });
    // A moderator's hide recorded before the content record existed: no verdict row yet.
    await w.t.run(async (ctx) => {
      const matt = await ctx.db
        .query('profiles')
        .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'matt'))
        .first();
      await ctx.db.insert('moderationActions', {
        actorId: matt?._id,
        action: 'hide',
        targetType: 'comment',
        targetId: comment.id,
        reason: 'hostile',
        metadata: { priorStatus: 'removed', newStatus: 'hidden', onAuthorDeleted: true },
        createdAt: Date.now(),
      });
    });
    await step(w, { op: 'replay' });
    expect(await rowOf()).toMatchObject({ held: true });
    await holds(w);
  });
});

describe('the one writer repairs what it finds (B01-4m)', () => {
  test('a stale row is rewritten, one whose item isn’t withdrawn removed, and a gone item’s row skipped', async () => {
    const w = await world();
    const [report, , member, comment] = w.items as [Item, Item, Item, Item];
    await w.author.mutation(api.reports.remove, { reportId: report.id as Id<'reports'> });
    await w.author.mutation(api.comments.remove, { commentId: comment.id as Id<'comments'> });
    // A row left wrong (as a writer that slipped would leave it), and a row for an item never withdrawn.
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query('contentWithdrawals')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', report.id))
        .first();
      await ctx.db.patch(row?._id as Id<'contentWithdrawals'>, { held: true, withdrawnAt: 1 });
      await ctx.db.insert('contentWithdrawals', {
        subjectUserId: w.rob,
        targetType: 'report',
        targetId: member.id,
        withdrawnAt: T0,
        kindRank: 4,
        targetCreatedAt: T0,
        held: false,
      });
    });
    await w.t.run(async (ctx) => {
      expect(await syncWithdrawalById(ctx, 'report', report.id)).toBe(true);
      expect(await syncWithdrawalById(ctx, 'report', member.id)).toBe(true);
      expect(await syncWithdrawalById(ctx, 'report', member.id)).toBe(false);
    });
    await holds(w);
    // An item gone with its row still there (never left by the eraser): the list passes over it.
    await w.t.run((ctx) => ctx.db.delete(comment.id as Id<'comments'>));
    const page = await w.mod.query(api.contentRecord.personDeleted, { userId: w.rob });
    expect(page.page.map((r) => r.targetId)).toEqual([report.id]);
    expect(page.isDone).toBe(true);
  });

  test('a person with many heavy withdrawals spans passes, each row once', async () => {
    const w = await world();
    const ids = await w.t.run(async (ctx) => {
      const body = (await ctx.db.query('waterBodies').first()) as Doc<'waterBodies'>;
      const out: Id<'reports'>[] = [];
      for (let i = 0; i < 14; i++) {
        out.push(
          await ctx.db.insert('reports', {
            authorId: w.rob,
            waterBodyId: body._id,
            point: { lat: 0.5, lng: 0.5 },
            skateEndTime: T0,
            reportTime: T0,
            source: 'native' as const,
            iceTypes: [],
            surfaceTags: [],
            photoIds: [],
            moderationStatus: 'removed' as const,
            hazardIdsCreated: [],
            authorDeletedAt: T0 - 1_000 + (i % 5),
            createdAt: T0,
            updatedAt: T0,
          }),
        );
      }
      return out;
    });
    await w.t.mutation(internal.peopleJobs.backfillWithdrawals, { alone: true });
    let passes = 1;
    for (;;) {
      const next = (
        await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      ).find((f) => f.state.kind === 'pending' && f.name === 'peopleJobs:backfillWithdrawals');
      if (!next) break;
      await w.t.run((ctx) => ctx.scheduler.cancel(next._id));
      await w.t.mutation(internal.peopleJobs.backfillWithdrawals, next.args[0]);
      passes++;
      expect(passes).toBeLessThan(50);
    }
    // Fourteen whole-document Reports don't fit one pass's budget beside their reads.
    expect(passes).toBeGreaterThan(1);
    const rows = await w.t.run((ctx) => ctx.db.query('contentWithdrawals').collect());
    expect(rows.map((r) => r.targetId).sort()).toEqual([...ids].sort());
  });
});

describe('the backfill repairs stale rows (B01-4m)', () => {
  test('a row whose item is gone, or no longer withdrawn, goes on the next run', async () => {
    const w = await world();
    const [report, , member, comment] = w.items as [Item, Item, Item, Item];
    await w.author.mutation(api.reports.remove, { reportId: report.id as Id<'reports'> });
    await w.author.mutation(api.comments.remove, { commentId: comment.id as Id<'comments'> });
    // Left stale by writes outside the inventory: the comment deleted outright, a row for a Report
    // never withdrawn.
    await w.t.run(async (ctx) => {
      await ctx.db.delete(comment.id as Id<'comments'>);
      await ctx.db.insert('contentWithdrawals', {
        subjectUserId: w.rob,
        targetType: 'report',
        targetId: member.id,
        withdrawnAt: T0,
        kindRank: 4,
        targetCreatedAt: T0,
        held: false,
      });
    });
    await w.t.mutation(internal.peopleJobs.backfillWithdrawals, { alone: true });
    await settle(w);
    const rows = await w.t.run((ctx) => ctx.db.query('contentWithdrawals').collect());
    expect(rows.map((r) => r.targetId)).toEqual([report.id]);
    const prep = await w.t.query(internal.peopleJobs.preparation, {});
    expect(prep.backfills.find((b) => b.backfill === 'withdrawals')).toMatchObject({
      ready: true,
      failed: 0,
    });
  });
});
