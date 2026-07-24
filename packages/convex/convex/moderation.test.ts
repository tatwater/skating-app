import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
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
      type: 'lake' as const,
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
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
}

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

    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportId,
      status: 'visible',
      reason: 'reaffirm',
    });
    expect(await countOf()).toBe(1); // visible → visible is a no-op for the counter
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

  test('counts the disposition by flag reason — the enforcement funnel’s last stage (Phase 7b)', async () => {
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
});
