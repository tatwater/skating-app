/**
 * A Post is never stored visible with none of its Reports visible (D186; founder call, 2026-11-13).
 * The one plan both Post writers share — a forward restore and an undo back to visible — decides it
 * before anything is written: a restore that would bring the Post back empty is refused, unless the
 * moderator chooses members to restore with it; an undo is refused and points at Restore. Reports
 * their author deleted never come back through a Post.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  POST_RESTORE_NEEDS_A_CHOICE,
  POST_UNRESTORABLE,
  UNDO_LEAVES_POST_EMPTY,
} from './moderation';
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

const firstOf = <T>(xs: T[]): T => {
  const x = xs[0];
  if (x === undefined) throw new Error('empty');
  return x;
};

const statusOf = async (t: ReturnType<typeof convexTest>, id: Id<'reports'> | Id<'posts'>) =>
  (await t.run((ctx) => ctx.db.get(id)))?.moderationStatus;

type T = ReturnType<typeof convexTest>;

async function setup(n = 2) {
  const t = convexTest(schema, modules);
  const author = await seedUser(t, 'a');
  const mod = await seedUser(t, 'mod', 'moderator');
  const { postId, reportIds } = await seedPost(t, author.id, n);
  const set = (
    targetType: 'post' | 'report',
    targetId: string,
    status: 'visible' | 'hidden' | 'removed',
    withReportIds?: Id<'reports'>[],
  ) =>
    mod.as.mutation(api.moderation.setModerationStatus, {
      targetType,
      targetId,
      status,
      reason: `${status} ${targetType}`,
      ...(withReportIds ? { withReportIds } : {}),
    });
  return { t, author, mod, postId, reportIds, set };
}

const auditCount = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('moderationActions').collect()).length);
async function newestOn(t: T, targetType: 'report' | 'post', targetId: string) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}
const literally = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

describe('a Post restore that would show none of its Reports', () => {
  test('a hidden Post whose Reports were each hidden on their own is refused, and nothing is written', async () => {
    const { t, postId, reportIds, set } = await setup();
    for (const id of reportIds) await set('report', id, 'hidden'); // the last one hides the Post
    expect(await statusOf(t, postId)).toBe('hidden');
    const before = await auditCount(t);

    await expect(set('post', postId, 'visible')).rejects.toThrow(
      literally(POST_RESTORE_NEEDS_A_CHOICE),
    );
    expect(await statusOf(t, postId)).toBe('hidden');
    expect(await auditCount(t)).toBe(before);
  });

  test('a removed Post whose Reports stay removed is refused', async () => {
    const { t, postId, set } = await setup();
    await set('post', postId, 'removed');
    await expect(set('post', postId, 'visible')).rejects.toThrow(
      literally(POST_RESTORE_NEEDS_A_CHOICE),
    );
    expect(await statusOf(t, postId)).toBe('removed');
  });

  test('the partial case is unchanged: one Report coming back is enough', async () => {
    const { t, postId, reportIds, set } = await setup();
    const [r1, r2] = reportIds as [Id<'reports'>, Id<'reports'>];
    await set('post', postId, 'hidden');
    await set('report', r1, 'removed');
    await set('post', postId, 'visible');
    expect([await statusOf(t, postId), await statusOf(t, r1), await statusOf(t, r2)]).toEqual([
      'visible',
      'removed',
      'visible',
    ]);
  });
});

describe('restoring a Post with chosen Reports', () => {
  test('brings the Post and the chosen Reports back, each with a row naming the Post', async () => {
    const { t, postId, reportIds, set } = await setup();
    const [r1, r2] = reportIds as [Id<'reports'>, Id<'reports'>];
    await set('post', postId, 'removed');
    await set('post', postId, 'visible', [r1]);

    expect([await statusOf(t, postId), await statusOf(t, r1), await statusOf(t, r2)]).toEqual([
      'visible',
      'visible',
      'removed',
    ]);
    const memberRow = await newestOn(t, 'report', r1);
    expect(memberRow).toMatchObject({
      action: 'restore',
      metadata: { priorStatus: 'removed', newStatus: 'visible', cascadedFromPostId: postId },
    });
    const postRow = await newestOn(t, 'post', postId);
    expect(postRow.metadata.cascaded).toEqual([{ id: r1, from: 'removed', to: 'visible' }]);
  });

  test('its undo puts the Post and every chosen Report back exactly', async () => {
    const { t, mod, postId, reportIds, set } = await setup(3);
    const [r1, r2, r3] = reportIds as [Id<'reports'>, Id<'reports'>, Id<'reports'>];
    await set('post', postId, 'hidden'); // all three hidden by the Post
    for (const id of reportIds) await set('report', id, 'visible'); // given back one by one…
    await set('report', r1, 'hidden'); // …then each taken down on its own
    await set('report', r2, 'removed');
    await set('report', r3, 'hidden');
    await set('post', postId, 'visible', [r1, r2]);
    expect(await statusOf(t, r3)).toBe('hidden');

    const restore = await newestOn(t, 'post', postId);
    await mod.as.mutation(api.undo.run, { actionId: restore._id, reason: 'not yet' });
    expect([
      await statusOf(t, postId),
      await statusOf(t, r1),
      await statusOf(t, r2),
      await statusOf(t, r3),
    ]).toEqual(['hidden', 'hidden', 'removed', 'hidden']);
  });

  test('refuses a Report that is not in the Post, or is not down', async () => {
    const { t, author, postId, reportIds, set } = await setup();
    const stranger = await seedReport(t, author.id);
    await set('post', postId, 'removed');
    await expect(set('post', postId, 'visible', [stranger])).rejects.toThrow(
      /not part of this post/,
    );
    await set('report', firstOf(reportIds), 'visible');
    await expect(set('post', postId, 'visible', [firstOf(reportIds)])).rejects.toThrow(
      /already visible/,
    );
    await expect(
      set('report', firstOf(reportIds), 'visible', [firstOf(reportIds)]),
    ).rejects.toThrow(/only be chosen when restoring a post/);
  });

  test('refuses a Report its author deleted', async () => {
    const { t, author, postId, reportIds, set } = await setup();
    const [r1, r2] = reportIds as [Id<'reports'>, Id<'reports'>];
    await author.as.mutation(api.reports.remove, { reportId: r1 });
    await set('report', r2, 'removed'); // the Post goes with it
    expect(await statusOf(t, postId)).not.toBe('visible');
    await expect(set('post', postId, 'visible', [r1])).rejects.toThrow(/deleted by its author/);
    await set('post', postId, 'visible', [r2]);
    expect([await statusOf(t, r1), await statusOf(t, r2)]).toEqual(['removed', 'visible']);
  });

  test('a Post whose every Report its author deleted cannot be restored, and the read says so', async () => {
    const { author, mod, postId, set } = await setup();
    await author.as.mutation(api.posts.remove, { postId });
    await expect(set('post', postId, 'visible')).rejects.toThrow(literally(POST_UNRESTORABLE));
    const choices = await mod.as.query(api.moderation.postRestoreChoices, { postId });
    expect(choices?.restorable).toBe(false);
    expect(choices?.members.map((m) => m.standing)).toEqual(['author_deleted', 'author_deleted']);
  });
});

describe('an undo that would show the Post empty', () => {
  test('is refused and points at Restore', async () => {
    const { t, mod, postId, reportIds, set } = await setup(1);
    await set('post', postId, 'hidden');
    const hide = await newestOn(t, 'post', postId);
    await set('report', firstOf(reportIds), 'removed'); // acted on since, on its own
    await expect(mod.as.mutation(api.undo.run, { actionId: hide._id })).rejects.toThrow(
      literally(UNDO_LEAVES_POST_EMPTY),
    );
    expect(await statusOf(t, postId)).toBe('hidden');
  });
});

describe('postRestoreChoices', () => {
  test('says what each member is, why it is down, and whether a plain restore is enough', async () => {
    const { mod, postId, reportIds, set } = await setup(3);
    const [r1, r2, r3] = reportIds as [Id<'reports'>, Id<'reports'>, Id<'reports'>];
    await set('post', postId, 'hidden');
    await set('report', r2, 'removed');
    let choices = await mod.as.query(api.moderation.postRestoreChoices, { postId });
    expect(choices?.plainRestoreBringsBack).toBe(true);
    expect(choices?.members.map((m) => [m.reportId, m.standing])).toEqual([
      [r1, 'returns'],
      [r2, 'choose'],
      [r3, 'returns'],
    ]);
    expect(choices?.members[1]?.down).toMatchObject({
      action: 'remove',
      reason: 'removed report',
      by: { username: 'mod' },
    });
    expect(choices?.members[0]?.waterBodyName).toBe('Lake Morey');

    for (const id of [r1, r3]) await set('report', id, 'removed');
    choices = await mod.as.query(api.moderation.postRestoreChoices, { postId });
    expect(choices?.plainRestoreBringsBack).toBe(false);
    expect(choices?.restorable).toBe(true);
  });

  test('a member cannot read it', async () => {
    const { author, postId } = await setup();
    await expect(author.as.query(api.moderation.postRestoreChoices, { postId })).rejects.toThrow();
  });
});

describe('the rule holds under any order of verdicts, choices and undos', () => {
  test('no Post is ever stored visible with no visible Report', async () => {
    type Op =
      | { kind: 'post'; status: 'visible' | 'hidden' | 'removed'; choose: number[] }
      | { kind: 'report'; i: number; status: 'visible' | 'hidden' | 'removed' }
      | { kind: 'undo' };
    const status = fc.constantFrom('visible' as const, 'hidden' as const, 'removed' as const);
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant('post' as const),
        status,
        choose: fc.subarray([0, 1, 2]),
      }),
      fc.record({
        kind: fc.constant('report' as const),
        i: fc.integer({ min: 0, max: 2 }),
        status,
      }),
      fc.constant({ kind: 'undo' as const }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
        const { t, mod, postId, reportIds, set } = await setup(3);
        for (const o of ops) {
          try {
            if (o.kind === 'post') {
              const chosen = o.choose.map((i) => reportIds[i] as Id<'reports'>);
              await set(
                'post',
                postId,
                o.status,
                o.status === 'visible' && chosen.length ? chosen : undefined,
              );
            } else if (o.kind === 'report') {
              await set('report', reportIds[o.i] as Id<'reports'>, o.status);
            } else {
              const row = await newestOn(t, 'post', postId).catch(() => null);
              if (row) await mod.as.mutation(api.undo.run, { actionId: row._id, reason: 'x' });
            }
          } catch {
            // A refusal is an outcome; the invariant is about what got stored.
          }
          const post = await statusOf(t, postId);
          if (post === 'visible') {
            const statuses = await Promise.all(reportIds.map((id) => statusOf(t, id)));
            expect(statuses).toContain('visible');
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});
