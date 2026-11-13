/**
 * An author's deletion is final (D248, founder ruling 2026-11-13): "Any author-deleted content should
 * not be able to come back, no moderator should be able to restore it." No restore, Post choice or
 * undo brings back a Post, Report or Comment its author deleted, nor anything inside a Post its author
 * deleted; a comment's deletion is on the record like a Report's; and deleting something a moderator
 * already removed still registers as the author's withdrawal.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  AUTHOR_DELETED_ALREADY,
  AUTHOR_DELETED_RESTORE,
  AUTHOR_DELETED_UNDO,
} from './lib/authorDeletion';
import { revertPostVerdict } from './moderation';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
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

async function seedReport(t: ReturnType<typeof convexTest>, authorId: Id<'profiles'>) {
  const now = Date.now();
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
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
            [1, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: now,
    }),
  );
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: now,
      reportTime: now,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/** A Post over `n` fresh Reports by `authorId`, in the shape `posts.create` writes. */
async function seedPost(t: ReturnType<typeof convexTest>, authorId: Id<'profiles'>, n: number) {
  const reportIds: Id<'reports'>[] = [];
  for (let i = 0; i < n; i++) reportIds.push(await seedReport(t, authorId));
  const now = Date.now();
  const postId = await t.run((ctx) =>
    ctx.db.insert('posts', {
      authorId,
      reportIds,
      photoIds: [],
      latestSkateEndTime: now,
      moderationStatus: 'visible',
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const id of reportIds) await t.run((ctx) => ctx.db.patch(id, { postId }));
  await t.run((ctx) => ctx.db.patch(authorId, { reportCount: n }));
  return { postId, reportIds };
}

type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules);
  const author = await seedUser(t, 'a');
  const mod = await seedUser(t, 'mod', 'moderator');
  const set = (
    targetType: 'post' | 'report' | 'comment',
    targetId: string,
    status: 'visible' | 'hidden' | 'removed',
  ) =>
    mod.as.mutation(api.moderation.setModerationStatus, {
      targetType,
      targetId,
      status,
      reason: `${status} ${targetType}`,
    });
  const comment = (reportId: Id<'reports'>) =>
    author.as.mutation(api.comments.create, { reportId, body: 'you are all idiots' });
  return { t, author, mod, set, comment };
}

const statusOf = async (t: T, id: Id<'reports'> | Id<'posts'> | Id<'comments'>) =>
  (await t.run((ctx) => ctx.db.get(id)))?.moderationStatus;
const deletedAt = async (t: T, id: Id<'reports'> | Id<'posts'> | Id<'comments'>) =>
  (await t.run((ctx) => ctx.db.get(id)))?.authorDeletedAt;
async function newestOn(t: T, targetType: string, targetId: string) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}
const literally = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

describe('an author deletion is final', () => {
  test('a Report, a Comment and a Post its author deleted are refused by restore, and by any verdict', async () => {
    const { t, author, set, comment } = await setup();
    const reportId = await seedReport(t, author.id);
    const commentId = await comment(reportId);
    const { postId } = await seedPost(t, author.id, 1);
    await author.as.mutation(api.comments.remove, { commentId });
    await author.as.mutation(api.reports.remove, { reportId });
    await author.as.mutation(api.posts.remove, { postId });
    // The comment's deletion is on the record now, like a Report's or a Post's.
    expect((await newestOn(t, 'comment', commentId)).action).toBe('author_delete');
    for (const [type, id] of [
      ['report', reportId],
      ['comment', commentId],
      ['post', postId],
    ] as const) {
      await expect(set(type, id, 'visible')).rejects.toThrow(literally(AUTHOR_DELETED_RESTORE));
      // A takedown is still a moderator's decision on the record — the content doesn't move.
      await set(type, id, 'hidden');
      expect(await statusOf(t, id)).toBe('removed');
      expect(await newestOn(t, type, id)).toMatchObject({
        action: 'hide',
        metadata: { onAuthorDeleted: true, priorStatus: 'removed', newStatus: 'removed' },
      });
    }
  });

  test("everything inside a Post its author deleted stays down, a moderator's earlier removal included", async () => {
    const { t, author, mod, set } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    const [r1, r2] = reportIds as [Id<'reports'>, Id<'reports'>];
    await set('report', r1, 'removed');
    await author.as.mutation(api.posts.remove, { postId });
    for (const id of [r1, r2]) {
      expect(await deletedAt(t, id)).toBeDefined();
      await expect(set('report', id, 'visible')).rejects.toThrow(literally(AUTHOR_DELETED_RESTORE));
    }
    // Choosing the member a moderator removed before the author deleted the Post is no way back.
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'post',
        targetId: postId,
        status: 'visible',
        reason: 'appeal',
        withReportIds: [r1],
      }),
    ).rejects.toThrow(literally(AUTHOR_DELETED_RESTORE));
    const choices = await mod.as.query(api.moderation.postRestoreChoices, { postId });
    expect(choices?.restorable).toBe(false);
  });

  test('an undo that would bring it back is refused', async () => {
    const { t, author, mod, set, comment } = await setup();
    const commentId = await comment(await seedReport(t, author.id));
    await set('comment', commentId, 'hidden');
    const hide = await newestOn(t, 'comment', commentId);
    const { postId } = await seedPost(t, author.id, 1);
    await set('post', postId, 'hidden');
    const postHide = await newestOn(t, 'post', postId);
    await author.as.mutation(api.comments.remove, { commentId });
    await author.as.mutation(api.posts.remove, { postId });
    // The author's own rows are newer, so the engine sees each takedown as overtaken.
    for (const row of [hide, postHide]) {
      await expect(mod.as.mutation(api.undo.run, { actionId: row._id })).rejects.toThrow(
        'Something changed this since',
      );
    }
    expect(await statusOf(t, commentId)).toBe('removed');
    expect(await statusOf(t, postId)).toBe('removed');

    // A withdrawal stamped with no row of its own (a backfilled comment) doesn't overtake the
    // takedown, and the undo itself refuses.
    const other = await comment(await seedReport(t, author.id));
    await set('comment', other, 'hidden');
    const otherHide = await newestOn(t, 'comment', other);
    await t.run((ctx) => ctx.db.patch(other, { authorDeletedAt: Date.now() }));
    // History reads the stamp too, so it never offers the undo it would refuse.
    const offered = await mod.as.query(api.undo.latestOwn, {
      targetType: 'comment',
      targetId: other,
    });
    expect(offered?.undo).toEqual({ state: 'unavailable', why: AUTHOR_DELETED_UNDO });
    await expect(mod.as.mutation(api.undo.run, { actionId: otherHide._id })).rejects.toThrow(
      literally(AUTHOR_DELETED_UNDO),
    );
    expect(await statusOf(t, other)).toBe('hidden');
  });

  test("a Post verdict's undo leaves a Post its author deleted as it is, whatever it put back to", async () => {
    const { t, author, mod, set } = await setup();
    const { postId } = await seedPost(t, author.id, 1);
    await set('post', postId, 'hidden');
    await set('post', postId, 'removed');
    const removal = await newestOn(t, 'post', postId);
    // Stamped with no row of its own (a backfill), so the removal is still the last word on it.
    await t.run((ctx) => ctx.db.patch(postId, { authorDeletedAt: Date.now() }));
    await expect(
      t.run(async (ctx) => {
        const actor = await ctx.db.get(mod.id);
        if (!actor) throw new Error('no moderator');
        await revertPostVerdict(ctx, actor, { row: removal, reason: 'x' });
      }),
    ).rejects.toThrow(AUTHOR_DELETED_ALREADY);
    expect(await statusOf(t, postId)).toBe('removed');
  });

  test("deleting content a moderator already removed registers as the author's withdrawal", async () => {
    const { t, author, set, comment } = await setup();
    const reportId = await seedReport(t, author.id);
    const commentId = await comment(reportId);
    await set('report', reportId, 'removed');
    await set('comment', commentId, 'removed');
    await author.as.mutation(api.reports.remove, { reportId });
    await author.as.mutation(api.comments.remove, { commentId });
    for (const [type, id] of [
      ['report', reportId],
      ['comment', commentId],
    ] as const) {
      expect(await deletedAt(t, id)).toBeDefined();
      expect((await newestOn(t, type, id)).action).toBe('author_delete');
    }
  });
});

describe('the backfills', () => {
  afterEach(() => vi.useRealTimers());

  test('stamp what its author withdrew before the stamp existed, across pages, and only that', async () => {
    vi.useFakeTimers();
    const { t, author, mod } = await setup();
    const withdrawn = await seedReport(t, author.id);
    const restoredSince = await seedReport(t, author.id);
    const restoreUndone = await seedReport(t, author.id);
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    const emptied = await seedPost(t, author.id, 1);
    const reportId = await seedReport(t, author.id);
    const authorsComment = await t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: 'gone',
        source: 'native' as const,
        moderationStatus: 'removed' as const,
        createdAt: Date.now(),
      }),
    );
    const modsComment = await t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: 'taken down',
        source: 'native' as const,
        moderationStatus: 'removed' as const,
        createdAt: Date.now(),
      }),
    );
    const at = Date.now() - 5000;
    await t.run(async (ctx) => {
      // `restoredSince` came back and was taken down again on a moderator's own verdict;
      // `restoreUndone` came back and the restore was undone, so it is down as its author left it.
      for (const id of [withdrawn, restoredSince, restoreUndone, ...emptied.reportIds])
        await ctx.db.patch(id, { moderationStatus: 'removed' });
      for (const id of [postId, ...reportIds, emptied.postId])
        await ctx.db.patch(id, { moderationStatus: 'removed' });
      const row = (
        targetType: 'report' | 'post' | 'comment',
        targetId: string,
        action: 'author_delete' | 'restore' | 'remove',
        offset = 0,
        extra: {
          metadata?: Record<string, unknown>;
          undoesActionId?: Id<'moderationActions'>;
        } = {},
      ) =>
        ctx.db.insert('moderationActions', {
          actorId: action === 'author_delete' ? author.id : mod.id,
          action,
          targetType,
          targetId,
          reason: action,
          createdAt: at + offset,
          ...extra,
        });
      await row('report', withdrawn, 'author_delete');
      await row('report', restoredSince, 'author_delete');
      await row('report', restoredSince, 'restore', 1000); // a moderator brought it back, pre-D248
      await row('report', restoredSince, 'remove', 2000); // and took it down again, on its merits
      await row('report', restoreUndone, 'author_delete');
      const restore = await row('report', restoreUndone, 'restore', 1000);
      await row('report', restoreUndone, 'remove', 2000, { undoesActionId: restore });
      await row('post', postId, 'author_delete');
      // The Post its last Report's deletion emptied: the author deleted the Report, not the Post.
      const [last] = emptied.reportIds as [Id<'reports'>];
      await row('report', last, 'author_delete');
      await row('post', emptied.postId, 'author_delete', 0, {
        metadata: { priorStatus: 'visible', newStatus: 'removed', derivedFromReportId: last },
      });
      await row('comment', modsComment, 'remove');
    });

    await t.mutation(internal.authorDeletions.backfillFromAudit, { pageSize: 1 });
    await t.mutation(internal.authorDeletions.backfillCommentDeletions, { pageSize: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(internal.authorDeletions.backfillFromAudit, {}); // twice is once
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await deletedAt(t, withdrawn)).toBe(at);
    expect(await deletedAt(t, restoredSince)).toBeUndefined();
    expect(await deletedAt(t, restoreUndone)).toBe(at);
    expect(await deletedAt(t, emptied.reportIds[0] as Id<'reports'>)).toBe(at);
    expect(await deletedAt(t, emptied.postId)).toBeUndefined();
    for (const id of [postId, ...reportIds]) expect(await deletedAt(t, id)).toBe(at);
    expect(await deletedAt(t, authorsComment)).toBeDefined();
    expect(await deletedAt(t, modsComment)).toBeUndefined();
  });
});

describe('the backfill, on old dev data', () => {
  test('a member a moderator hid after its Post was deleted is withdrawn with the Post; one brought back up is left live', async () => {
    const { t, author, mod } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, 3);
    const [cascaded, hiddenAfter, broughtBack] = reportIds as [
      Id<'reports'>,
      Id<'reports'>,
      Id<'reports'>,
    ];
    const at = Date.now() - 5000;
    await t.run(async (ctx) => {
      await ctx.db.patch(postId, { moderationStatus: 'removed' });
      await ctx.db.patch(cascaded, { moderationStatus: 'removed' });
      // Before D248 a moderator could move a member of a deleted Post: one hidden, one restored.
      await ctx.db.patch(hiddenAfter, { moderationStatus: 'hidden' });
      await ctx.db.patch(broughtBack, { moderationStatus: 'visible' });
      await ctx.db.insert('moderationActions', {
        actorId: author.id,
        action: 'author_delete',
        targetType: 'post',
        targetId: postId,
        reason: 'Deleted by the author',
        createdAt: at,
      });
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'hide',
        targetType: 'report',
        targetId: hiddenAfter,
        reason: 'rude',
        metadata: { priorStatus: 'removed', newStatus: 'hidden' },
        createdAt: at + 1000,
      });
    });
    await t.mutation(internal.authorDeletions.backfillFromAudit, {});
    expect(await deletedAt(t, postId)).toBe(at);
    expect(await deletedAt(t, cascaded)).toBe(at);
    expect(await deletedAt(t, hiddenAfter)).toBe(at);
    expect(await deletedAt(t, broughtBack)).toBeUndefined();
    expect(await statusOf(t, broughtBack)).toBe('visible');
  });
});

describe('a history longer than the backfill reads', () => {
  test('is unknown, never "nothing there": the item is left unstamped', async () => {
    const { t, author, mod } = await setup();
    const reportId = await seedReport(t, author.id);
    const commentId = await t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: 'x',
        source: 'native' as const,
        moderationStatus: 'removed' as const,
        createdAt: Date.now(),
      }),
    );
    const at = Date.now() - 1_000_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(reportId, { moderationStatus: 'removed' });
      await ctx.db.insert('moderationActions', {
        actorId: author.id,
        action: 'author_delete',
        targetType: 'report',
        targetId: reportId,
        reason: 'Deleted by the author',
        createdAt: at,
      });
      // A moderator's restore, then more rows than the backfill reads, all after the deletion.
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'restore',
        targetType: 'report',
        targetId: reportId,
        reason: 'before D248',
        createdAt: at + 1,
      });
      for (let i = 0; i <= 100; i++) {
        for (const [targetType, targetId] of [
          ['report', reportId],
          ['comment', commentId],
        ] as const) {
          await ctx.db.insert('moderationActions', {
            actorId: mod.id,
            action: 'dismiss_flag',
            targetType,
            targetId,
            reason: 'noise',
            createdAt: at + 2 + i,
          });
        }
      }
    });
    await t.mutation(internal.authorDeletions.backfillFromAudit, {});
    await t.mutation(internal.authorDeletions.backfillCommentDeletions, {});
    expect(await deletedAt(t, reportId)).toBeUndefined();
    expect(await deletedAt(t, commentId)).toBeUndefined();
  });

  test('one exactly as long as the read is known whole, and answers', async () => {
    const { t, author, mod } = await setup();
    const reportId = await seedReport(t, author.id);
    const commentId = await t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: 'x',
        source: 'native' as const,
        moderationStatus: 'removed' as const,
        createdAt: Date.now(),
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action: 'dismiss_flag',
          targetType: 'comment',
          targetId: commentId,
          reason: 'noise',
          createdAt: Date.now() + i,
        });
      }
    });
    await t.mutation(internal.authorDeletions.backfillCommentDeletions, {});
    // No moderator's word in the whole of it: the removal was the author's.
    expect(await deletedAt(t, commentId)).toBeDefined();
  });
});

describe('the rule holds under any order', () => {
  test('author-deleted content never shows again', async () => {
    type Op = 'delete' | 'hide' | 'remove' | 'restore' | 'undo';
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Op>('delete', 'hide', 'remove', 'restore', 'undo'), {
          minLength: 1,
          maxLength: 8,
        }),
        async (ops) => {
          const { t, author, mod, set, comment } = await setup();
          const commentId = await comment(await seedReport(t, author.id));
          let deleted = false;
          for (const op of ops) {
            try {
              if (op === 'delete') await author.as.mutation(api.comments.remove, { commentId });
              else if (op === 'undo') {
                const row = await newestOn(t, 'comment', commentId).catch(() => null);
                if (row) await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'x' });
              } else {
                await set(
                  'comment',
                  commentId,
                  op === 'hide' ? 'hidden' : op === 'remove' ? 'removed' : 'visible',
                );
              }
            } catch {
              // a refusal is an outcome
            }
            if (op === 'delete') deleted = true;
            if (deleted) expect(await statusOf(t, commentId)).toBe('removed');
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
