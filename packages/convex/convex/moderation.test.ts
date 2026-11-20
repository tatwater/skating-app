import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { RESTORE_ALREADY_UP } from './lib/recordRules';
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

describe('moderation.listFlags target context', () => {
  type TargetKind = Doc<'contentFlags'>['targetType'];

  test('presents every target kind with its own summary, attribution and moderation status', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const reportId = await seedReport(t, author.id);
    const note = 'x'.repeat(101);
    await t.run(async (ctx) => {
      const report = await ctx.db.get(reportId);
      if (!report) throw new Error('Expected the seeded report');
      const now = report.createdAt;
      await ctx.db.patch(reportId, { notes: `  ${note}  `, moderationStatus: 'hidden' });
      // A mapped body's creator must not be presented as the subject of an access claim.
      await ctx.db.patch(report.waterBodyId, { createdByUserId: author.id });
      const postId = await ctx.db.insert('posts', {
        authorId: author.id,
        reportIds: [reportId],
        photoIds: [],
        title: 'Trip title',
        body: 'Not the title',
        latestSkateEndTime: now,
        moderationStatus: 'visible',
        createdAt: now,
        updatedAt: now,
      });
      const commentId = await ctx.db.insert('comments', {
        reportId,
        authorId: author.id,
        body: '  Reply text  ',
        source: 'native',
        moderationStatus: 'removed',
        createdAt: now,
      });
      const hazardId = await ctx.db.insert('hazards', {
        waterBodyId: report.waterBodyId,
        type: 'open_water',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [0.5, 0.5] },
        radiusMeters: 40,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        status: 'active',
        moderationStatus: 'hidden',
        healingState: 'none',
        confirmCount: 0,
        goneCount: 0,
        snowHidden: false,
        photoIds: [],
        createdByUserId: author.id,
        createdAt: now,
        firstReportedAt: now,
        lastConfirmedAt: now,
      });
      const photoId = await ctx.db.insert('photos', {
        storageId: 'unused-full-blob',
        thumbStorageId: 'unused-thumb-blob',
        uploaderId: author.id,
        placeOnMap: false,
        createdAt: now,
      });
      const alertId = await ctx.db.insert('accessAlerts', {
        targetType: 'put_in',
        waterBodyId: report.waterBodyId,
        reason: 'not_plowed',
        kind: 'blocker',
        createdByUserId: author.id,
        createdAt: now,
        season: 2026,
        status: 'official',
        confirmCount: 0,
        denyCount: 0,
      });
      const targets = {
        report: reportId,
        post: postId,
        comment: commentId,
        hazard: hazardId,
        photo: photoId,
        accessAlert: alertId,
        waterbody: report.waterBodyId,
        user: author.id,
      } satisfies Record<TargetKind, string>;
      for (const targetType of Object.keys(targets) as TargetKind[]) {
        await ctx.db.insert('contentFlags', {
          flaggerId: mod.id,
          targetType,
          targetId: targets[targetType],
          reason: 'spam',
          status: 'open',
          createdAt: now,
        });
      }
    });

    const { standard } = await mod.as.query(api.moderation.listFlags, {});
    const attributed = {
      exists: true,
      author: { userId: author.id, username: 'author', displayName: 'author' },
    };
    expect(
      Object.fromEntries(standard.map(({ targetType, target }) => [targetType, target])),
    ).toEqual({
      report: { ...attributed, summary: `${note.slice(0, 100)}…`, moderationStatus: 'hidden' },
      post: { ...attributed, summary: 'Trip title', moderationStatus: 'visible' },
      comment: { ...attributed, summary: 'Reply text', moderationStatus: 'removed' },
      hazard: { ...attributed, summary: 'Hazard: open_water', moderationStatus: 'hidden' },
      photo: { ...attributed, summary: 'Photo' },
      accessAlert: { ...attributed, summary: 'Access alert: not_plowed' },
      waterbody: { exists: true, author: null, summary: 'Lake: Lake Morey' },
      user: { ...attributed, summary: 'User: @author' },
    });
  });

  test('keeps invalid and deleted targets distinct from an existing target with a missing author', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const author = await seedUser(t, 'author');
    const present = await seedReport(t, author.id);
    const deleted = await seedReport(t, author.id);
    await t.run(async (ctx) => {
      await ctx.db.delete(deleted);
      await ctx.db.delete(author.id);
      for (const targetId of [mod.id, deleted, present]) {
        await ctx.db.insert('contentFlags', {
          flaggerId: mod.id,
          targetType: 'report',
          targetId,
          reason: 'spam',
          status: 'open',
          createdAt: Date.now(),
        });
      }
    });

    const { standard } = await mod.as.query(api.moderation.listFlags, {});
    const targets = new Map(standard.map(({ targetId, target }) => [targetId, target]));
    const notFound = { exists: false, author: null, summary: '(deleted)' };
    expect(targets.get(mod.id)).toEqual(notFound);
    expect(targets.get(deleted)).toEqual(notFound);
    expect(targets.get(present)).toEqual({
      exists: true,
      author: null,
      summary: 'Ice report',
      moderationStatus: 'visible',
    });
  });
});

describe('moderation.setModerationStatus', () => {
  test('rejects a non-moderator', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const member = await seedUser(t, 'm');
    const reportId = await seedReport(t, author.id);
    await expect(
      member.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status: 'hidden',
        reason: 'spam',
      }),
    ).rejects.toThrow(/requires moderator/i);
  });

  test('requires a reason', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status: 'hidden',
        reason: '   ',
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  test('adjusts the author’s reportCount on hide → restore, and no-ops an unchanged status', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    // Seed the counter as if the (directly-seeded) report had been created through the API.
    await t.run((ctx) => ctx.db.patch(author.id, { reportCount: 1 }));
    const countOf = async () => (await t.run((ctx) => ctx.db.get(author.id)))?.reportCount;

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'spam',
    });
    expect(await countOf()).toBe(0); // visible → hidden decrements

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'visible',
      reason: 'appeal upheld',
    });
    expect(await countOf()).toBe(1); // restore increments

    // Visible → visible changes nothing, so it writes nothing (B01-4d: a restore needs no reason, so
    // a second press would otherwise write a second row) — refused in the record's words.
    const rows = async () =>
      (await t.run((ctx) => ctx.db.query('moderationActions').collect())).length;
    const before = await rows();
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId: reportId,
        status: 'visible',
        reason: 'reaffirm',
      }),
    ).rejects.toThrow(RESTORE_ALREADY_UP);
    expect(await countOf()).toBe(1);
    expect(await rows()).toBe(before);
  });

  test('hides a report and writes exactly one hide audit row; restore writes one restore row', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'hidden',
      reason: 'dangerously false',
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('hidden');
    const afterHide = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(afterHide).toHaveLength(1);
    expect(afterHide[0]).toMatchObject({
      action: 'hide',
      targetType: 'report',
      targetId: reportId,
    });
    expect(afterHide[0]?.metadata).toMatchObject({ priorStatus: 'visible', newStatus: 'hidden' });

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'visible',
      reason: 'appeal upheld',
    });
    const all = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(all).toHaveLength(2);
    expect(all[1]?.action).toBe('restore');
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.moderationStatus).toBe('visible');
  });
});

describe('moderation.setModerationStatus (post target, A10 / D186)', () => {
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
    // The seeded rows are `visible`, so the author's counter should say so.
    await t.run((ctx) => ctx.db.patch(authorId, { reportCount: n }));
    return { postId, reportIds };
  }
  const statusOf = async (t: ReturnType<typeof convexTest>, id: Id<'reports'> | Id<'posts'>) =>
    (await t.run((ctx) => ctx.db.get(id)))?.moderationStatus;

  test('hiding a Post hides every visible member, each with its own audit row naming the cascade', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'hidden',
      reason: 'spam',
    });
    expect(await statusOf(t, postId)).toBe('hidden');
    for (const id of reportIds) expect(await statusOf(t, id)).toBe('hidden');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(0);
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((a) => [a.targetType, a.action])).toEqual([
      ['report', 'hide'],
      ['report', 'hide'],
      ['post', 'hide'],
    ]);
    expect(actions[0]?.metadata).toMatchObject({ cascadedFromPostId: postId });
  });

  test('restoring a Post brings back only the members its hide took down', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 3);
    const [own, cascaded, removed] = reportIds;
    if (!own || !cascaded || !removed) throw new Error('seed');
    // One member hidden on its own merits first, one removed outright after the cascade.
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: own,
      status: 'hidden',
      reason: 'false thickness',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'hidden',
      reason: 'under review',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: removed,
      status: 'removed',
      reason: 'harassment in the note',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'visible',
      reason: 'review done',
    });
    expect(await statusOf(t, postId)).toBe('visible');
    expect(await statusOf(t, cascaded)).toBe('visible');
    expect(await statusOf(t, own)).toBe('hidden');
    expect(await statusOf(t, removed)).toBe('removed');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(1);
  });

  test('hiding the last visible member hides the Post — stored, so the feed gate stays in-index', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    const [first, second] = reportIds;
    if (!first || !second) throw new Error('seed');
    const hide = (targetId: Id<'reports'>) =>
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'report',
        targetId,
        status: 'hidden',
        reason: 'wrong lake',
      });
    await hide(first);
    expect(await statusOf(t, postId)).toBe('visible');
    await hide(second);
    expect(await statusOf(t, postId)).toBe('hidden');
    const derived = (await t.run((ctx) => ctx.db.query('moderationActions').collect())).filter(
      (a) => a.targetType === 'post',
    );
    expect(derived).toHaveLength(1);
    expect(derived[0]?.metadata).toMatchObject({ derivedFromReportId: second });

    // Restoring a member of a Post hidden that way restores the Post; a Post a moderator hid on
    // its own would not come back this way.
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: first,
      status: 'visible',
      reason: 'right lake after all',
    });
    expect(await statusOf(t, postId)).toBe('visible');
    expect(await statusOf(t, second)).toBe('hidden');
  });

  test('a Post a moderator hid does not come back when a member is restored', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 1);
    const only = reportIds[0];
    if (!only) throw new Error('seed');
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: only,
      status: 'hidden',
      reason: 'first the report',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'hidden',
      reason: 'then the post, on its own merits',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: only,
      status: 'visible',
      reason: 'the report was fine',
    });
    expect(await statusOf(t, only)).toBe('visible');
    expect(await statusOf(t, postId)).toBe('hidden');
  });

  test('hiding one member leaves the Post and re-keys its sort on the visible rest', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const { postId, reportIds } = await seedPost(t, author.id, 2);
    const [older, newer] = reportIds;
    if (!older || !newer) throw new Error('seed');
    const t1 = Date.now() - 3_600_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(older, { skateEndTime: t1 });
      await ctx.db.patch(newer, { skateEndTime: t1 + 1_800_000 });
      await ctx.db.patch(postId, { latestSkateEndTime: t1 + 1_800_000 });
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: newer,
      status: 'hidden',
      reason: 'wrong lake',
    });
    expect(await statusOf(t, postId)).toBe('visible');
    expect((await t.run((ctx) => ctx.db.get(postId)))?.latestSkateEndTime).toBe(t1);
    // The last visible member going leaves the key alone and hides the Post itself.
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: older,
      status: 'hidden',
      reason: 'wrong lake too',
    });
    expect((await t.run((ctx) => ctx.db.get(postId)))?.latestSkateEndTime).toBe(t1);
    expect(await statusOf(t, postId)).toBe('hidden');
  });
});

describe('moderation.setModerationStatus (comment target)', () => {
  test('hides a comment and rejects a non-existent target', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'yo' });

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'comment',
      targetId: commentId,
      status: 'removed',
      reason: 'harassment',
    });
    expect((await t.run((ctx) => ctx.db.get(commentId)))?.moderationStatus).toBe('removed');

    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'comment',
        targetId: 'bogus-id',
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow(/target not found/i);
  });
});

/** Make every queued notification due and flush it — the settle window (A08 / D169), fast-forwarded. */
async function flushAllDue(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('notificationQueue').collect()) {
      await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    }
  });
  await t.mutation(internal.notifications.flushNotificationQueue, {});
  return t.run((ctx) => ctx.db.query('notifications').collect());
}

describe('moderation.resolveFlag — content_flag_resolved (A08 §2.3)', () => {
  test('tells a person who filed a flag the verdict, and nothing else', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const flagId = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });
    expect((await t.run((ctx) => ctx.db.get(flagId)))?.origin).toBe('user');

    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'actioned',
      reason: 'hid the report',
    });
    const notes = await flushAllDue(t);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.userId).toBe(flagger.id);
    expect(notes[0]?.type).toBe('content_flag_resolved');
    // Verdict only: no target, no moderator, no reason.
    expect(Object.keys(notes[0]?.payload as object).sort()).toEqual(
      ['coalesceKey', 'flagId', 'kind', 'resolution'].sort(),
    );
    expect(notes[0]?.payload).toMatchObject({ resolution: 'actioned' });
  });

  test('an auto-filed flag notifies nobody — its flaggerId never filed a report', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const rater = await seedUser(t, 'r');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    // The shape `ratings.maybeAutoFlag` writes: a system reason, a real person as `flaggerId`.
    const flagId = await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: rater.id,
        targetType: 'report',
        targetId: reportId,
        reason: 'auto_low_quality',
        status: 'open',
        origin: 'auto',
        createdAt: Date.now(),
      }),
    );
    // …and a row from before `origin` existed, which must read as auto.
    const legacyId = await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: rater.id,
        targetType: 'report',
        targetId: reportId,
        reason: 'spam',
        status: 'open',
        createdAt: Date.now(),
      }),
    );
    for (const id of [flagId, legacyId]) {
      await mod.as.mutation(api.moderation.resolveFlag, {
        flagId: id,
        resolution: 'dismissed',
        reason: 'fine',
      });
    }
    expect(await flushAllDue(t)).toHaveLength(0);
  });
});

describe('moderation.resolveFlag', () => {
  test('dismiss writes a dismiss_flag audit row and requires a reason', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const flagId = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });

    await expect(
      mod.as.mutation(api.moderation.resolveFlag, { flagId, resolution: 'dismissed', reason: ' ' }),
    ).rejects.toThrow(/reason is required/i);

    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'dismissed',
      reason: 'not a real issue',
    });
    expect((await t.run((ctx) => ctx.db.get(flagId)))?.status).toBe('dismissed');
    const audits = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(audits[0]?.action).toBe('dismiss_flag');
  });

  test('sets the flag status + resolver and writes exactly one audit row', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const flagId = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });

    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'actioned',
      reason: 'hid the report',
    });
    const flag = await t.run((ctx) => ctx.db.get(flagId));
    expect(flag?.status).toBe('actioned');
    expect(flag?.resolvedByUserId).toBe(mod.id);
    expect(flag?.resolvedAt).toBeGreaterThan(0);

    const audits = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'resolve_flag', targetType: 'contentFlag' });
  });

  test('counts the disposition by flag reason — the enforcement funnel’s last stage (Phase 07-2)', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);

    const upheld = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: upheld,
      resolution: 'actioned',
      reason: 'genuinely dangerous',
    });

    const otherReport = await seedReport(t, author.id);
    const dismissed = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: otherReport,
      reason: 'auto_low_quality',
    });
    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId: dismissed,
      resolution: 'dismissed',
      reason: 'fine, just unpopular',
    });

    // Keyed by reason, not just by outcome: that's what turns a workload stat into a tuning signal —
    // mostly-dismissed `auto_low_quality` indicts AUTO_LOW_QUALITY_NET_UNHELPFUL, and mostly-dismissed
    // `unsafe_false_report` indicts CONTRADICTION_FLAG_THRESHOLD.
    const rows = await t.run((ctx) =>
      ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) => q.eq('metric', 'flag_dispositions'))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toEqual({
      'unsafe_false_report:actioned': 1,
      'auto_low_quality:dismissed': 1,
    });
  });

  test('re-resolving a terminal flag is rejected — no second audit row or double-counted disposition', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const flagId = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });

    await mod.as.mutation(api.moderation.resolveFlag, {
      flagId,
      resolution: 'actioned',
      reason: 'genuinely dangerous',
    });

    // A stale queue view re-submits the same flag — now under the opposite outcome.
    await expect(
      mod.as.mutation(api.moderation.resolveFlag, {
        flagId,
        resolution: 'dismissed',
        reason: 'changed my mind',
      }),
    ).rejects.toThrow(/already been resolved/i);

    // The first ruling stands; nothing was written twice or recorded under both outcomes.
    expect((await t.run((ctx) => ctx.db.get(flagId)))?.status).toBe('actioned');
    const audits = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(audits).toHaveLength(1);
    const rows = await t.run((ctx) =>
      ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) => q.eq('metric', 'flag_dispositions'))
        .collect(),
    );
    expect(rows[0]?.meta).toEqual({ 'unsafe_false_report:actioned': 1 });
  });
});
