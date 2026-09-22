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
      skateQuality: 'good' as const,
      notes: 'The live note.',
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
}

describe('contentRevisions.listForTarget (D205)', () => {
  test('is moderator-only — the hidden button is the nicety, this is the boundary', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const member = await seedUser(t, 'm');
    const reportId = await seedReport(t, author.id);
    await expect(
      member.as.query(api.contentRevisions.listForTarget, {
        targetType: 'report',
        targetId: reportId,
      }),
    ).rejects.toThrow(/moderator/i);
    // Not even the author, whose own copy is in their data export (D62).
    await expect(
      author.as.query(api.contentRevisions.listForTarget, {
        targetType: 'report',
        targetId: reportId,
      }),
    ).rejects.toThrow(/moderator/i);
  });

  test('serves the snapshots oldest first, with the live block to compare the last one against', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    // Inserted newest first, so the ordering is the query's doing and not the table's.
    await t.run(async (ctx) => {
      await ctx.db.insert('contentRevisions', {
        targetType: 'report',
        targetId: reportId,
        authorId: author.id,
        snapshot: { notes: 'The second note.', skateQuality: 'fair' },
        replacedAt: 2000,
      });
      await ctx.db.insert('contentRevisions', {
        targetType: 'report',
        targetId: reportId,
        authorId: author.id,
        snapshot: { notes: 'The first note.', skateQuality: 'poor' },
        replacedAt: 1000,
      });
    });

    const result = await mod.as.query(api.contentRevisions.listForTarget, {
      targetType: 'report',
      targetId: reportId,
    });
    expect(result.revisions.map((r) => r.replacedAt)).toEqual([1000, 2000]);
    expect(result.revisions[0]?.authorUsername).toBe('a');
    expect(result.live).toMatchObject({ notes: 'The live note.', skateQuality: 'good' });
    // The live block is the content only — never the stamps, which are the server's (D205).
    expect(result.live).not.toHaveProperty('authorId');
    expect(result.live).not.toHaveProperty('moderationStatus');
  });

  test('a row that has never been edited comes back empty rather than missing', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const result = await mod.as.query(api.contentRevisions.listForTarget, {
      targetType: 'report',
      targetId: reportId,
    });
    expect(result.revisions).toEqual([]);
    expect(result.editedAt).toBeUndefined();
  });

  test('serves a Post’s words too', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    const postId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('posts', {
        authorId: author.id,
        title: 'Now',
        body: 'The live story.',
        reportIds: [reportId],
        photoIds: [],
        latestSkateEndTime: Date.now(),
        moderationStatus: 'visible' as const,
        editedAt: 3000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert('contentRevisions', {
        targetType: 'post',
        targetId: id,
        authorId: author.id,
        snapshot: { title: 'Then', body: 'The first story.' },
        replacedAt: 3000,
      });
      return id;
    });

    const result = await mod.as.query(api.contentRevisions.listForTarget, {
      targetType: 'post',
      targetId: postId,
    });
    expect(result.live).toEqual({ title: 'Now', body: 'The live story.' });
    expect(result.editedAt).toBe(3000);
    expect(result.revisions[0]?.snapshot).toEqual({ title: 'Then', body: 'The first story.' });
  });

  test('refuses a target that is no longer there', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    await t.run((ctx) => ctx.db.delete(reportId));
    await expect(
      mod.as.query(api.contentRevisions.listForTarget, {
        targetType: 'report',
        targetId: reportId,
      }),
    ).rejects.toThrow(/no longer there/i);
  });
});

describe('contentRevisions.countForTarget', () => {
  test('counts the edits, and is moderator-only like the list', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const member = await seedUser(t, 'm');
    const mod = await seedUser(t, 'mod', 'moderator');
    const reportId = await seedReport(t, author.id);
    expect(
      await mod.as.query(api.contentRevisions.countForTarget, {
        targetType: 'report',
        targetId: reportId,
      }),
    ).toBe(0);
    await t.run((ctx) =>
      ctx.db.insert('contentRevisions', {
        targetType: 'report',
        targetId: reportId,
        authorId: author.id,
        snapshot: { notes: 'Before.' },
        replacedAt: 1000,
      }),
    );
    expect(
      await mod.as.query(api.contentRevisions.countForTarget, {
        targetType: 'report',
        targetId: reportId,
      }),
    ).toBe(1);
    await expect(
      member.as.query(api.contentRevisions.countForTarget, {
        targetType: 'report',
        targetId: reportId,
      }),
    ).rejects.toThrow(/moderator/i);
  });
});
