import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
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

/** The newest audit row on a target. */
async function newestOn(
  t: ReturnType<typeof convexTest>,
  targetType: 'report' | 'post' | 'user',
  targetId: string,
) {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').order('desc').collect());
  const row = rows.find((r) => r.targetType === targetType && r.targetId === targetId);
  if (!row) throw new Error(`no audit row on ${targetType} ${targetId}`);
  return row;
}

describe('undo: content (D226)', () => {
  test('a hide undoes to visible, with the count and an audit row that names what it undid', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    await t.run((ctx) => ctx.db.patch(author.id, { reportCount: 1 }));

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'second unsafe claim',
    });
    const hide = await newestOn(t, 'report', reportId);
    expect(hide?.action).toBe('hide');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(0);

    // Giving it back asks no reason (D226).
    await mod.as.mutation(api.undo.run, { actionId: hide._id });
    expect(await statusOf(t, reportId)).toBe('visible');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(1);
    const undoRow = await newestOn(t, 'report', reportId);
    expect(undoRow?.action).toBe('restore');
    expect(undoRow?.undoesActionId).toBe(hide._id);
    expect(undoRow?.reason).toMatch(/second unsafe claim/);

    await expect(mod.as.mutation(api.undo.run, { actionId: hide._id })).rejects.toThrow(
      /already been undone/i,
    );
  });

  test('undoing the undo takes it away again, so it asks a reason', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'removed',
      reason: 'duplicate',
    });
    const remove = await newestOn(t, 'report', reportId);
    await mod.as.mutation(api.undo.run, { actionId: remove._id });
    const restore = await newestOn(t, 'report', reportId);

    await expect(mod.as.mutation(api.undo.run, { actionId: restore._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, {
      actionId: restore._id,
      reason: 'it was a duplicate after all',
    });
    expect(await statusOf(t, reportId)).toBe('removed');
  });

  test('undoing the removal of a hidden item leaves it hidden — it never publishes it', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const set = (status: 'hidden' | 'removed', reason: string) =>
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status,
        reason,
      });
    await set('hidden', 'unsafe claim');
    await set('removed', 'and a duplicate');
    const remove = await newestOn(t, 'report', reportId);

    await mod.as.mutation(api.undo.run, { actionId: remove._id });
    expect(await statusOf(t, reportId)).toBe('hidden');
  });

  test('undoing a hide of a removed item puts the removal back, and asks why like any removal', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    for (const status of ['removed', 'hidden'] as const) {
      await mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status,
        reason: status,
      });
    }
    const hide = await newestOn(t, 'report', reportId);

    await expect(mod.as.mutation(api.undo.run, { actionId: hide._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: hide._id, reason: 'removed was right' });
    expect(await statusOf(t, reportId)).toBe('removed');
  });

  test('a takedown that changed nothing has nothing to undo', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    for (const reason of ['unsafe claim', 'still unsafe']) {
      await mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status: 'hidden',
        reason,
      });
    }
    const second = await newestOn(t, 'report', reportId);
    await expect(mod.as.mutation(api.undo.run, { actionId: second._id })).rejects.toThrow(
      /already hidden/i,
    );
    expect(await statusOf(t, reportId)).toBe('hidden');
  });

  test('a later action on the same item overtakes the undo', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const other = await seedUser(t, 'mod2', 'moderator');
    const reportId = await seedReport(t, author.id);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'first look',
    });
    const hide = await newestOn(t, 'report', reportId);
    await other.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'removed',
      reason: 'worse than that',
    });

    await expect(mod.as.mutation(api.undo.run, { actionId: hide._id })).rejects.toThrow(
      /changed this since/i,
    );
    const history = await mod.as.query(api.moderation.listActions, {
      targetType: 'report',
      targetId: reportId,
    });
    const hideView = history.find((r) => r.id === hide._id);
    expect(hideView?.undo.state).toBe('overtaken');
    expect(history[0]?.undo).toEqual({ state: 'available', needsReason: false });
  });

  test('a Post undoes with its members; a member row the cascade wrote is undone on the Post', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'hidden',
      reason: 'the whole outing was a false claim',
    });
    const member = await newestOn(t, 'report', firstOf(reportIds));
    const memberView = (
      await mod.as.query(api.moderation.listActions, {
        targetType: 'report',
        targetId: firstOf(reportIds),
      })
    )[0];
    expect(memberView?.undo).toEqual({
      state: 'unavailable',
      why: expect.stringMatching(/on the Post/),
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: member._id })).rejects.toThrow(
      /on the Post/,
    );

    const postHide = await newestOn(t, 'post', postId);
    await mod.as.mutation(api.undo.run, { actionId: postHide._id });
    expect(await statusOf(t, postId)).toBe('visible');
    for (const id of reportIds) expect(await statusOf(t, id)).toBe('visible');
  });

  test("a Post's removal undoes with the members it removed — not only the ones a hide took", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'removed',
      reason: 'doxxing in the photos',
    });
    for (const id of reportIds) expect(await statusOf(t, id)).toBe('removed');

    const postRemove = await newestOn(t, 'post', postId);
    await mod.as.mutation(api.undo.run, { actionId: postRemove._id });
    expect(await statusOf(t, postId)).toBe('visible');
    for (const id of reportIds) expect(await statusOf(t, id)).toBe('visible');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(2);
  });

  describe("a Post's takedown undoes each member it moved to that member's own prior status", () => {
    async function setup(n: number) {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'a');
      const mod = await seedUser(t, 'mod', 'moderator');
      const post = await seedPost(t, author.id, n);
      const set = (
        targetType: 'post' | 'report',
        targetId: string,
        status: 'visible' | 'hidden' | 'removed',
      ) =>
        mod.as.mutation(api.moderation.setModerationStatus, {
          targetType,
          targetId,
          status,
          reason: `${status} ${targetType}`,
        });
      const reportCount = async () => (await t.run((ctx) => ctx.db.get(author.id)))?.reportCount;
      return { t, mod, ...post, set, reportCount };
    }

    test('the removal of a hidden Post undoes to hidden and gives back the Report it removed', async () => {
      // Greptile on #108: hide a Post, restore one Report on its own, remove the still-hidden Post.
      const { t, mod, postId, reportIds, set, reportCount } = await setup(2);
      const [r1, r2] = reportIds as [Id<'reports'>, Id<'reports'>];
      await set('post', postId, 'hidden');
      await set('report', r1, 'visible');
      await set('post', postId, 'removed');
      expect(await statusOf(t, r1)).toBe('removed');

      const removal = await newestOn(t, 'post', postId);
      await mod.as.mutation(api.undo.run, { actionId: removal._id });
      expect(await statusOf(t, postId)).toBe('hidden');
      expect(await statusOf(t, r1)).toBe('visible');
      expect(await statusOf(t, r2)).toBe('hidden');
      expect(await reportCount()).toBe(1);
      // The Report's newest row is the undo's, written for the Post — not a stranded removal.
      const back = await newestOn(t, 'report', r1);
      expect([back.action, back.metadata.cascadedFromPostId]).toEqual(['restore', postId]);
    });

    test('a takedown that changed only the members is undoable for them', async () => {
      const { t, mod, postId, reportIds, set } = await setup(2);
      const r1 = firstOf(reportIds);
      await set('post', postId, 'hidden');
      await set('report', r1, 'visible');
      await set('post', postId, 'hidden'); // the Post was hidden already; R1 was not
      expect(await statusOf(t, r1)).toBe('hidden');

      const rehide = await newestOn(t, 'post', postId);
      await mod.as.mutation(api.undo.run, { actionId: rehide._id });
      expect(await statusOf(t, postId)).toBe('hidden');
      expect(await statusOf(t, r1)).toBe('visible');
    });

    test('one undo puts each member back where it was — one visible, one hidden', async () => {
      const { t, mod, postId, reportIds, set, reportCount } = await setup(3);
      const [r1, r2, r3] = reportIds as [Id<'reports'>, Id<'reports'>, Id<'reports'>];
      await set('post', postId, 'hidden'); // R1, R2, R3 hidden by the Post
      await set('report', r1, 'visible'); // R1 given back on its own
      await set('report', r2, 'visible');
      await set('report', r2, 'hidden'); // R2 hidden on its own merits
      await set('post', postId, 'removed'); // takes R1 down; R2 and R3 were not visible

      const removal = await newestOn(t, 'post', postId);
      await mod.as.mutation(api.undo.run, { actionId: removal._id });
      expect([
        await statusOf(t, postId),
        await statusOf(t, r1),
        await statusOf(t, r2),
        await statusOf(t, r3),
      ]).toEqual(['hidden', 'visible', 'hidden', 'hidden']);
      expect(await reportCount()).toBe(1);
    });

    test('a member a moderator has acted on since keeps that decision', async () => {
      const { t, mod, postId, reportIds, set } = await setup(2);
      const r1 = firstOf(reportIds);
      await set('post', postId, 'hidden');
      const hide = await newestOn(t, 'post', postId);
      await set('report', r1, 'removed'); // a later decision on R1 alone
      await mod.as.mutation(api.undo.run, { actionId: hide._id });
      expect(await statusOf(t, postId)).toBe('visible');
      expect(await statusOf(t, r1)).toBe('removed');
      expect(await statusOf(t, reportIds[1] as Id<'reports'>)).toBe('visible');
    });

    test('a member hidden again on its own keeps that decision, though its status never moved', async () => {
      const { t, mod, postId, reportIds, set } = await setup(2);
      const [r1, r2] = reportIds as [Id<'reports'>, Id<'reports'>];
      await set('post', postId, 'hidden');
      const hide = await newestOn(t, 'post', postId);
      await set('report', r1, 'hidden'); // the same status, but a decision on R1 alone
      await mod.as.mutation(api.undo.run, { actionId: hide._id });
      expect([await statusOf(t, postId), await statusOf(t, r1), await statusOf(t, r2)]).toEqual([
        'visible',
        'hidden',
        'visible',
      ]);
    });

    test('undoing that undo takes the member down again, so it asks why', async () => {
      const { t, mod, postId, reportIds, set } = await setup(2);
      const r1 = firstOf(reportIds);
      await set('post', postId, 'hidden');
      await set('report', r1, 'visible');
      await set('post', postId, 'hidden');
      const rehide = await newestOn(t, 'post', postId);
      await mod.as.mutation(api.undo.run, { actionId: rehide._id });
      const undo = await newestOn(t, 'post', postId);
      expect(undo.undoesActionId).toBe(rehide._id);

      // The Post is hidden either way; it is R1 the redo takes away.
      await expect(mod.as.mutation(api.undo.run, { actionId: undo._id })).rejects.toThrow(
        /needs a reason/i,
      );
      await mod.as.mutation(api.undo.run, { actionId: undo._id, reason: 'R1 was part of it' });
      expect(await statusOf(t, postId)).toBe('hidden');
      expect(await statusOf(t, r1)).toBe('hidden');
    });

    test('a Post row from before the record still undoes through the cascade', async () => {
      const { t, mod, postId, reportIds, set } = await setup(2);
      await set('post', postId, 'removed');
      const removal = await newestOn(t, 'post', postId);
      await t.run((ctx) =>
        ctx.db.patch(removal._id, { metadata: { priorStatus: 'visible', newStatus: 'removed' } }),
      );
      await mod.as.mutation(api.undo.run, { actionId: removal._id });
      expect(await statusOf(t, postId)).toBe('visible');
      for (const id of reportIds) expect(await statusOf(t, id)).toBe('visible');
    });
  });

  test("a moderator's own restore of a removed Post still leaves its removed members removed", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 1);
    for (const status of ['removed', 'visible'] as const) {
      await mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'post',
        targetId: postId,
        status,
        reason: status === 'removed' ? 'doxxing' : 'the photo is gone',
      });
    }
    expect(await statusOf(t, firstOf(reportIds))).toBe('removed');
  });

  test('an operator on their way out is not offered an undo the server would refuse', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'spam',
    });
    const hide = await newestOn(t, 'report', reportId);
    await t.run((ctx) => ctx.db.patch(mod.id, { deletionRequestedAt: Date.now() }));
    const [view] = await mod.as.query(api.moderation.listActions, {
      targetType: 'report',
      targetId: reportId,
    });
    expect(view?.undo).toEqual({ state: 'unavailable', why: expect.stringMatching(/deleted/) });
    await expect(mod.as.mutation(api.undo.run, { actionId: hide._id })).rejects.toThrow();
  });

  test('a member cannot undo; neither can someone without the capability', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const member = await seedUser(t, 'm');
    const reportId = await seedReport(t, author.id);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'spam',
    });
    const hide = await newestOn(t, 'report', reportId);
    await expect(member.as.mutation(api.undo.run, { actionId: hide._id })).rejects.toThrow(
      /requires moderator/i,
    );
  });
});

describe('undo: people (D226)', () => {
  test('a ban undoes to active; the lift that undid it can itself be undone, with a reason', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const user = await seedUser(t, 'u');
    await mod.as.mutation(api.moderation.banUser, { userId: user.id, reason: 'harassment' });
    const ban = await newestOn(t, 'user', user.id);

    await mod.as.mutation(api.undo.run, { actionId: ban._id });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('active');
    const lift = await newestOn(t, 'user', user.id);
    expect(lift?.action).toBe('unban');
    expect(lift?.undoesActionId).toBe(ban._id);

    await expect(mod.as.mutation(api.undo.run, { actionId: lift._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, { actionId: lift._id, reason: 'the ban stands' });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('banned');
  });

  test('a suspension that replaced a ban undoes back to the ban', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const user = await seedUser(t, 'u');
    await mod.as.mutation(api.moderation.banUser, { userId: user.id, reason: 'harassment' });
    await mod.as.mutation(api.moderation.suspendUser, {
      userId: user.id,
      reason: 'softened on appeal',
      suspendedUntil: Date.now() + 3 * 86_400_000,
    });
    const suspend = await newestOn(t, 'user', user.id);
    await expect(mod.as.mutation(api.undo.run, { actionId: suspend._id })).rejects.toThrow(
      /needs a reason/i,
    );
    await mod.as.mutation(api.undo.run, {
      actionId: suspend._id,
      reason: 'the appeal was withdrawn',
    });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('banned');
  });

  test("a ban that replaced a suspension undoes to the suspension, and lifts the ban's Clerk lock", async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const user = await seedUser(t, 'u');
    const until = Date.now() + 3 * 86_400_000;
    await mod.as.mutation(api.moderation.suspendUser, {
      userId: user.id,
      reason: 'cooling off',
      suspendedUntil: until,
    });
    await mod.as.mutation(api.moderation.banUser, { userId: user.id, reason: 'kept at it' });
    const ban = await newestOn(t, 'user', user.id);
    await mod.as.mutation(api.undo.run, { actionId: ban._id, reason: 'the ban was too much' });

    const after = await t.run((ctx) => ctx.db.get(user.id));
    expect(after?.status).toBe('suspended');
    expect(after?.suspendedUntil).toBe(until);
    // A suspension never holds a Clerk lock, so the ban's has to go, or the person stays locked out
    // of sign-in after the window ends.
    const locks = (
      await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    ).filter((f) => f.name.includes('clerkAdmin'));
    expect(locks.map((f) => (f.args[0] as { banned: boolean }).banned)).toEqual([true, false]);
  });

  test('a lift recorded before undo existed says so', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const user = await seedUser(t, 'u');
    const actionId = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'unban',
        targetType: 'user',
        targetId: user.id,
        reason: 'old lift',
        createdAt: Date.now(),
      }),
    );
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      /before undo existed/i,
    );
  });

  test('a restricted right undoes to allowed with no reason; a bounty limit undoes to the global cap', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const user = await seedUser(t, 'u');
    await mod.as.mutation(api.moderation.setPostingPermission, {
      userId: user.id,
      permission: 'comments',
      allowed: false,
      reason: 'name-calling',
    });
    const restrict = await newestOn(t, 'user', user.id);
    await mod.as.mutation(api.undo.run, { actionId: restrict._id });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.canPostComments).toBe(true);

    await mod.as.mutation(api.moderation.setBountyPostLimit, {
      userId: user.id,
      limit: 0,
      reason: 'bounty spam',
    });
    const limit = await newestOn(t, 'user', user.id);
    await mod.as.mutation(api.undo.run, { actionId: limit._id });
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.activeBountyPostLimit).toBeUndefined();
  });
});

describe('undo: the toast (D226)', () => {
  test("offers your own last action for ten seconds, and not someone else's", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'a');
      const mod = await seedUser(t, 'mod', 'moderator');
      const other = await seedUser(t, 'mod2', 'moderator');
      const reportId = await seedReport(t, author.id);
      await mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status: 'hidden',
        reason: 'spam',
      });
      const mine = await mod.as.query(api.undo.latestOwn, {
        targetType: 'report',
        targetId: reportId,
      });
      expect(mine?.action).toBe('hide');
      expect(mine?.undo.state).toBe('available');
      expect(
        await other.as.query(api.undo.latestOwn, { targetType: 'report', targetId: reportId }),
      ).toBeNull();

      vi.advanceTimersByTime(11_000);
      expect(
        await mod.as.query(api.undo.latestOwn, { targetType: 'report', targetId: reportId }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
