/**
 * A moderator's verdict belongs to the person (D248, founder ruling 2026-11-13): "If a user was being
 * rude and their post/comment got restricted by a moderator, they shouldn't be able to delete their
 * comment and thereby remove evidence of their bad behavior, which would influence future penalties."
 * Each verdict records whose content it was; it stands until a moderator reverses it (a restore, an
 * undo, an overturn), never by the author's deletion; a Post's cascade and a derived Post hide are
 * not verdicts; the backfill rebuilds exactly what the live writers keep.
 */

import type { FunctionReturnType } from 'convex/server';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { AUTHOR_DELETED_OVERTURN } from './lib/authorDeletion';
import { OVERTURN_NOT_DELETED, OVERTURN_NOTHING_STANDING } from './moderation';
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
  // Convex's real per-transaction limits, enforced: what passes here fits a deployment.
  const t = convexTest({ schema, modules, transactionLimits: true });
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
  const standing = (userId = author.id) =>
    t.run((ctx) =>
      ctx.db
        .query('contentVerdicts')
        .withIndex('by_subject_standing', (q) => q.eq('subjectUserId', userId).eq('standing', true))
        .collect(),
    );
  return { t, author, mod, set, comment, standing };
}

const statusOf = async (t: T, id: Id<'reports'> | Id<'posts'> | Id<'comments'>) =>
  (await t.run((ctx) => ctx.db.get(id)))?.moderationStatus;
async function newestOn(t: T, targetType: string, targetId: string) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}
/** The whole record, every page of it, as the People page will read it. */
async function readRecord(
  as: ReturnType<ReturnType<typeof convexTest>['withIdentity']>,
  userId: Id<'profiles'>,
) {
  type Verdict = FunctionReturnType<typeof api.contentRecord.personVerdicts>['page'][number];
  type Withdrawal = FunctionReturnType<typeof api.contentRecord.personWithdrawals>['page'][number];
  const verdicts: Verdict[] = [];
  for (let cursor: string | null = null; ; ) {
    const page: { page: Verdict[]; isDone: boolean; continueCursor: string } = await as.query(
      api.contentRecord.personVerdicts,
      { userId, cursor },
    );
    verdicts.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  const deleted: Withdrawal[] = [];
  for (const kind of ['post', 'report', 'comment', 'hazard', 'accessAlert'] as const) {
    for (let cursor: string | null = null; ; ) {
      const page: { page: Withdrawal[]; isDone: boolean; continueCursor: string } = await as.query(
        api.contentRecord.personWithdrawals,
        { userId, kind, cursor },
      );
      deleted.push(...page.page);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  deleted.sort((a, b) => b.deletedAt - a.deletedAt);
  return { verdicts, deleted };
}

const literally = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The backfill, rebuilding the record from the audit log alone, lands where the live writers did. */
async function expectBackfillAgrees(t: T) {
  const snapshot = async () =>
    (await t.run((ctx) => ctx.db.query('contentVerdicts').collect()))
      .map((v) => `${v.actionId} ${v.kind} ${v.standing} ${v.endedByActionId ?? '-'}`)
      .sort();
  const live = await snapshot();
  await t.run(async (ctx) => {
    for (const v of await ctx.db.query('contentVerdicts').collect()) await ctx.db.delete(v._id);
  });
  await runBackfill(t);
  expect(await snapshot()).toEqual(live);
}

/** The verdict backfill, run to its end: the walk and every item's replay, each its own job. */
async function runBackfill(
  t: T,
  args: { pageSize?: number; clocks?: boolean } = { clocks: false },
) {
  const real = !vi.isFakeTimers();
  if (real) vi.useFakeTimers({ now: Date.now() });
  await t.mutation(internal.contentRecord.backfillVerdicts, args);
  await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
  if (real) vi.useRealTimers();
}

describe('a verdict belongs to the person', () => {
  test("survives the author's deletion, and an overturn ends it without bringing anything back", async () => {
    const { t, author, mod, set, comment, standing } = await setup();
    const commentId = await comment(await seedReport(t, author.id));
    await set('comment', commentId, 'hidden');
    await author.as.mutation(api.comments.remove, { commentId });
    expect(await standing()).toHaveLength(1);

    const record = await readRecord(mod.as, author.id);
    expect(record.verdicts).toEqual([
      expect.objectContaining({
        targetId: commentId,
        kind: 'hidden',
        content: expect.objectContaining({ text: 'you are all idiots' }),
        authorDeletedAt: expect.any(Number),
      }),
    ]);
    expect(record.deleted.map((d) => d.targetId)).toEqual([commentId]);

    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'comment',
      targetId: commentId,
      reason: 'appeal upheld',
    });
    expect(await standing()).toHaveLength(0);
    expect(await statusOf(t, commentId)).toBe('removed');
  });

  test('a verdict can be recorded on content its author already deleted, and only an overturn ends it', async () => {
    const { t, author, mod, set, comment, standing } = await setup();
    const commentId = await comment(await seedReport(t, author.id));
    await author.as.mutation(api.comments.remove, { commentId });
    await set('comment', commentId, 'hidden'); // reached us through support after the delete
    expect(await statusOf(t, commentId)).toBe('removed');
    expect(await standing()).toHaveLength(1);
    const verdict = await newestOn(t, 'comment', commentId);
    await expect(mod.as.mutation(api.undo.run, { actionId: verdict._id })).rejects.toThrow(
      literally(AUTHOR_DELETED_OVERTURN),
    );
    // Overturned, the comment stays deleted and the record is clear.
    await mod.as.mutation(api.moderation.overturnVerdict, {
      targetType: 'comment',
      targetId: commentId,
      reason: 'the complaint was mistaken',
    });
    expect(await standing()).toHaveLength(0);
    expect(await statusOf(t, commentId)).toBe('removed');
    await expectBackfillAgrees(t);
  });

  test('a restore or an undo ends a verdict; a later verdict supersedes; a cascade is not one', async () => {
    const { t, author, mod, set, standing } = await setup();
    const reportId = await seedReport(t, author.id);
    await set('report', reportId, 'hidden');
    await set('report', reportId, 'removed');
    expect((await standing()).map((v) => v.kind)).toEqual(['removed']);
    await set('report', reportId, 'visible');
    expect(await standing()).toHaveLength(0);

    const { postId } = await seedPost(t, author.id, 3);
    await set('post', postId, 'hidden'); // one verdict, not four
    expect((await standing()).map((v) => v.targetType)).toEqual(['post']);
    const hide = await newestOn(t, 'post', postId);
    await mod.as.mutation(api.undo.run, { actionId: hide._id });
    expect(await standing()).toHaveLength(0);
  });

  test('a Report a moderator chose to bring back with its Post leaves the record; the undo puts it back', async () => {
    const { t, author, mod, set, standing } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    const [a, b] = reportIds as [Id<'reports'>, Id<'reports'>];
    await set('report', a, 'hidden');
    await set('report', b, 'hidden'); // the Post is hidden by derivation: no verdict of its own
    expect(await statusOf(t, postId)).toBe('hidden');
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'visible',
      reason: 'appeal',
      withReportIds: [a],
    });
    expect((await standing()).map((v) => v.targetId)).toEqual([b]);

    const restore = await newestOn(t, 'post', postId);
    await mod.as.mutation(api.undo.run, { actionId: restore._id, reason: 'not yet' });
    expect(await statusOf(t, postId)).toBe('hidden');
    // Each Report's own verdict again, and none on the Post, which no moderator decided.
    expect((await standing()).map((v) => v.targetId as string).sort()).toEqual([a, b].sort());
    await expectBackfillAgrees(t);
  });

  test("undoing a Report's removal under its Post's hide puts no verdict of its own on the record", async () => {
    const { t, author, mod, set, standing } = await setup();
    const { postId, reportIds } = await seedPost(t, author.id, 1);
    const [r] = reportIds as [Id<'reports'>];
    await set('post', postId, 'hidden');
    await set('report', r, 'removed');
    const removal = await newestOn(t, 'report', r);
    await mod.as.mutation(api.undo.run, { actionId: removal._id, reason: 'went too far' });
    expect(await statusOf(t, r)).toBe('hidden');
    expect((await standing()).map((v) => v.targetType)).toEqual(['post']);
    await expectBackfillAgrees(t);
  });

  test('undoing a restore puts back the verdict it ended, and the redo ends it again', async () => {
    const { t, author, mod, set, standing } = await setup();
    const reportId = await seedReport(t, author.id);
    await set('report', reportId, 'removed');
    await set('report', reportId, 'visible');
    await mod.as.mutation(api.undo.run, {
      actionId: (await newestOn(t, 'report', reportId))._id,
      reason: 'it was right',
    });
    expect((await standing()).map((v) => v.kind)).toEqual(['removed']);
    await mod.as.mutation(api.undo.run, {
      actionId: (await newestOn(t, 'report', reportId))._id,
      reason: 'no, it was not',
    });
    expect(await standing()).toHaveLength(0);
    await expectBackfillAgrees(t);
  });

  test('overturn is only for content its author deleted, and only with a verdict standing', async () => {
    const { t, author, mod, comment } = await setup();
    const commentId = await comment(await seedReport(t, author.id));
    const overturn = () =>
      mod.as.mutation(api.moderation.overturnVerdict, {
        targetType: 'comment',
        targetId: commentId,
        reason: 'x',
      });
    await expect(overturn()).rejects.toThrow(literally(OVERTURN_NOT_DELETED));
    await author.as.mutation(api.comments.remove, { commentId });
    await expect(overturn()).rejects.toThrow(literally(OVERTURN_NOTHING_STANDING));
  });

  test('the record reads each kind of content, and lists what the person deleted newest first', async () => {
    const { t, author, mod, set } = await setup();
    const reportId = await seedReport(t, author.id);
    await t.run((ctx) => ctx.db.patch(reportId, { notes: 'thin by the inlet' }));
    const { postId, reportIds } = await seedPost(t, author.id, 1);
    await t.run((ctx) => ctx.db.patch(postId, { title: 'Morey 12/6', body: 'go early' }));
    const report = await t.run((ctx) => ctx.db.get(reportId));
    if (!report) throw new Error('expected the report');
    const hazardId = await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: report.waterBodyId,
        type: 'pressure_ridge' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        radiusMeters: 30,
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        createdByUserId: author.id,
        description: 'north bay',
        photoIds: [],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        firstReportedAt: Date.now(),
        lastConfirmedAt: Date.now(),
        confirmCount: 0,
        goneCount: 0,
        createdAt: Date.now(),
      }),
    );
    await set('report', reportId, 'hidden');
    await set('post', postId, 'removed');
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'hazard',
      targetId: hazardId,
      status: 'hidden',
      reason: 'a duplicate',
    });
    await author.as.mutation(api.posts.remove, { postId });

    const record = await readRecord(mod.as, author.id);
    const byType = Object.fromEntries(record.verdicts.map((v) => [v.targetType, v]));
    expect(byType.report?.content).toEqual(expect.objectContaining({ text: 'thin by the inlet' }));
    expect(byType.post?.content).toEqual(
      expect.objectContaining({ title: 'Morey 12/6', text: 'go early' }),
    );
    expect(byType.post?.authorDeletedAt).toEqual(expect.any(Number));
    expect(byType.hazard?.content).toEqual(
      expect.objectContaining({ title: 'pressure_ridge', text: 'north bay' }),
    );
    expect(byType.hazard?.reason).toBe('a duplicate');
    expect(record.deleted.map((d) => d.targetId).sort()).toEqual([postId, ...reportIds].sort());
  });

  test('the record is staff-only', async () => {
    const { author } = await setup();
    await expect(
      author.as.query(api.contentRecord.personVerdicts, { userId: author.id }),
    ).rejects.toThrow();
  });
});

describe('the backfill', () => {
  afterEach(() => vi.useRealTimers());

  test('build the record from the audit log, across pages, and then start the erasure clocks', async () => {
    vi.useFakeTimers();
    const { t, author, mod, standing } = await setup();
    const reportId = await seedReport(t, author.id);
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'removed' }));
    const kept = await seedReport(t, author.id);
    const legacyComment = await t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: 'gone',
        source: 'native' as const,
        moderationStatus: 'removed' as const,
        createdAt: Date.now(),
      }),
    );
    await t.run(async (ctx) => {
      // A hide from before verdicts were kept, still standing; one later reversed; a cascade row;
      // and an author deletion from before the stamp.
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'hide',
        targetType: 'report',
        targetId: kept,
        reason: 'old hide',
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: Date.now() - 3000,
      });
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'hide',
        targetType: 'report',
        targetId: reportId,
        reason: 'reversed',
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: Date.now() - 2000,
      });
      await ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'restore',
        targetType: 'report',
        targetId: reportId,
        reason: 'my mistake',
        metadata: { priorStatus: 'hidden', newStatus: 'visible' },
        createdAt: Date.now() - 1000,
      });
      await ctx.db.insert('moderationActions', {
        actorId: author.id,
        action: 'author_delete',
        targetType: 'report',
        targetId: reportId,
        reason: 'Deleted by the author',
        createdAt: Date.now() - 500,
      });
    });

    await t.mutation(internal.authorDeletions.backfillFromAudit, { pageSize: 1 });
    await t.mutation(internal.authorDeletions.backfillCommentDeletions, { pageSize: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(internal.contentRecord.backfillVerdicts, { pageSize: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Twice is the same as once.
    await t.mutation(internal.contentRecord.backfillVerdicts, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await standing()).map((v) => v.targetId)).toEqual([kept]);
    const all = await t.run((ctx) => ctx.db.query('contentVerdicts').collect());
    expect(all).toHaveLength(2);
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.authorDeletedAt).toBeDefined();
    expect((await t.run((ctx) => ctx.db.get(legacyComment)))?.authorDeletedAt).toBeDefined();
    // The chain ran on into the clocks: the withdrawn rows are counting, the held one is not.
    expect((await t.run((ctx) => ctx.db.get(legacyComment)))?.eraseAt).toBeDefined();
  });

  test('bring rows an earlier build wrote to what the history says', async () => {
    const { t, author, set, standing } = await setup();
    const reportId = await seedReport(t, author.id);
    await set('report', reportId, 'hidden');
    await set('report', reportId, 'visible');
    const [hide, restore] = (
      await t.run((ctx) => ctx.db.query('moderationActions').collect())
    ).filter((r) => r.targetId === reportId);
    if (!hide || !restore) throw new Error('expected a hide and a restore');
    await t.run(async (ctx) => {
      // The hide left standing, and a verdict minted for the restore — neither is what the rules make.
      const rows = await ctx.db.query('contentVerdicts').collect();
      for (const row of rows) await ctx.db.patch(row._id, { standing: true, endedAt: undefined });
      const at = Date.now();
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: author.id,
        targetType: 'report',
        targetId: reportId,
        actionId: restore._id,
        kind: 'hidden',
        at,
        standing: false,
      });
      // The system's rows never move a verdict, and a person's discipline is not content.
      await ctx.db.insert('moderationActions', {
        action: 'hide',
        targetType: 'report',
        targetId: reportId,
        reason: 'auto',
        createdAt: at,
      });
      await ctx.db.insert('moderationActions', {
        actorId: hide.actorId,
        action: 'ban',
        targetType: 'user',
        targetId: author.id,
        reason: 'abuse',
        createdAt: at,
      });
    });
    await runBackfill(t);
    const all = await t.run((ctx) => ctx.db.query('contentVerdicts').collect());
    expect(all.map((v) => [v.actionId, v.standing, v.endedByActionId])).toEqual([
      [hide._id, false, restore._id],
    ]);
    expect(await standing()).toHaveLength(0);
  });
});

describe('a history longer than a page', () => {
  afterEach(() => vi.useRealTimers());

  /** `n` audit rows on a Report that move nothing, from `at` on. */
  async function noise(
    t: T,
    modId: Id<'profiles'>,
    reportId: Id<'reports'>,
    n: number,
    at: number,
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert('moderationActions', {
          actorId: modId,
          action: 'dismiss_flag',
          targetType: 'report',
          targetId: reportId,
          reason: 'noise',
          createdAt: at + i,
        });
      }
    });
  }

  test('is replayed whole: a hide its newest rows restored is never put back on the record (Greptile #110)', async () => {
    vi.useFakeTimers();
    const { t, author, mod, standing } = await setup();
    const reportId = await seedReport(t, author.id);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.patch(reportId, {
        moderationStatus: 'removed',
        authorDeletedAt: now - 60 * 86_400_000,
      }),
    );
    // Recorded only as history, before the record existed: an old remove, a long run of rows, then a
    // hide and the restore that reversed it — the restore beyond any fixed read of the newest rows.
    const takedown = (action: 'remove' | 'hide' | 'restore', createdAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action,
          targetType: 'report',
          targetId: reportId,
          reason: action,
          metadata: {
            priorStatus: 'visible',
            newStatus: action === 'restore' ? 'visible' : 'hidden',
          },
          createdAt,
        }),
      );
    await takedown('remove', now - 5000);
    await noise(t, mod.id, reportId, 150, now - 4000);
    await takedown('hide', now - 1000);
    await takedown('restore', now - 500);
    await noise(t, mod.id, reportId, 3, now);
    await runBackfill(t, { pageSize: 7, clocks: false });
    expect(await standing()).toEqual([]);
    const all = await t.run((ctx) => ctx.db.query('contentVerdicts').collect());
    expect(all.map((v) => v.standing)).toEqual([false, false]);
    // Nothing holds what its author deleted, so its clock runs.
    await t.mutation(internal.erasure.backfillClocks, { kind: 'report' });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.eraseAt).toBeDefined();
  });

  test('is replayed whole the other way too: the newest takedown stands, however much follows it', async () => {
    vi.useFakeTimers();
    const { t, author, mod, set, standing } = await setup();
    const reportId = await seedReport(t, author.id);
    await set('report', reportId, 'hidden');
    await noise(t, mod.id, reportId, 120, Date.now() + 1);
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'remove',
        targetType: 'report',
        targetId: reportId,
        reason: 'a second look',
        metadata: { priorStatus: 'hidden', newStatus: 'removed' },
        createdAt: Date.now() + 200,
      }),
    );
    await noise(t, mod.id, reportId, 120, Date.now() + 300);
    await runBackfill(t, { pageSize: 13, clocks: false });
    expect((await standing()).map((v) => [v.targetId, v.kind])).toEqual([[reportId, 'removed']]);
    expect(await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).toHaveLength(2);
  });

  test('never reads past the transaction limit, however heavy every row', async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    // A moderator's reason has no cap but the document's.
    const heavy = 'r'.repeat(1000 * 1024);
    for (let i = 0; i < 40; i++) {
      await t.run((ctx) =>
        ctx.db.insert('moderationActions', {
          actorId: mod.id,
          action: i % 2 === 0 ? 'hide' : 'restore',
          targetType: 'report',
          targetId: reportId,
          reason: heavy,
          metadata: { priorStatus: 'visible', newStatus: 'hidden' },
          createdAt: Date.now() + i,
        }),
      );
    }
    await runBackfill(t, { clocks: false });
    const all = await t.run((ctx) => ctx.db.query('contentVerdicts').collect());
    expect(all).toHaveLength(20);
    expect(all.filter((v) => v.standing)).toEqual([]);
  });
});

describe('the rules hold under any order', () => {
  test('author-deleted content never shows again, and a verdict ends only by a moderator', async () => {
    type Op = 'delete' | 'hide' | 'remove' | 'restore' | 'undo' | 'overturn';
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Op>('delete', 'hide', 'remove', 'restore', 'undo', 'overturn'), {
          minLength: 1,
          maxLength: 8,
        }),
        async (ops) => {
          const { t, author, mod, set, comment, standing } = await setup();
          const commentId = await comment(await seedReport(t, author.id));
          let deleted = false;
          for (const op of ops) {
            const before = (await standing()).length;
            try {
              if (op === 'delete') await author.as.mutation(api.comments.remove, { commentId });
              else if (op === 'hide') await set('comment', commentId, 'hidden');
              else if (op === 'remove') await set('comment', commentId, 'removed');
              else if (op === 'restore') await set('comment', commentId, 'visible');
              else if (op === 'overturn') {
                await mod.as.mutation(api.moderation.overturnVerdict, {
                  targetType: 'comment',
                  targetId: commentId,
                  reason: 'x',
                });
              } else {
                const row = await newestOn(t, 'comment', commentId).catch(() => null);
                if (row) await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'x' });
              }
            } catch {
              // a refusal is an outcome
            }
            if (op === 'delete') deleted = true;
            if (deleted) expect(await statusOf(t, commentId)).not.toBe('visible');
            // The author's own act never ends a verdict.
            if (op === 'delete') expect((await standing()).length).toBe(before);
            expect((await standing()).length).toBeLessThanOrEqual(1);
          }
          // One rule, two answers never: the backfill's replay of this history agrees.
          await expectBackfillAgrees(t);
        },
      ),
      { numRuns: 40 },
    );
  });
});
