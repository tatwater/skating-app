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
  moderatorDecision: false,
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
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
      role: 'member' as const,
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

describe('contentFlags.flag', () => {
  test('requires authentication', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const reportId = await seedReport(t, author.id);
    await expect(
      t.mutation(api.contentFlags.flag, {
        targetType: 'report',
        targetId: reportId,
        reason: 'unsafe_false_report',
      }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('rejects a non-existent target', async () => {
    const t = convexTest(schema, modules);
    const flagger = await seedUser(t, 'f');
    await expect(
      flagger.as.mutation(api.contentFlags.flag, {
        targetType: 'report',
        targetId: 'not-a-real-id',
        reason: 'spam',
      }),
    ).rejects.toThrow(/target not found/i);
  });

  test('records a flag (incl. first-class unsafe_false_report) and dedupes to one open flag', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const reportId = await seedReport(t, author.id);

    const first = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
      note: 'thin ice, called great',
    });
    const second = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });
    expect(first).toBe(second); // dedupe: same open flag returned
    const rows = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('unsafe_false_report');
    expect(rows[0]?.status).toBe('open');
  });

  test('a flag on a body queues its library row; a flag on a report does not', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const flagger = await seedUser(t, 'f');
    const reportId = await seedReport(t, author.id);
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Flagged',
        searchText: 'flagged',
        type: 'lakePond',
        source: 'osm',
        polygon: { type: 'Polygon', coordinates: [] },
        bbox: { minLat: 0, minLng: 0, maxLat: 0.01, maxLng: 0.01 },
        centroid: { lat: 0.005, lng: 0.005 },
        dedupStatus: 'clean',
        createdAt: Date.now(),
      }),
    );
    await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });
    const queue = () => t.run((ctx) => ctx.db.query('bodyLibraryQueue').collect());
    expect(await queue()).toHaveLength(0);
    await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: body,
      reason: 'no_public_access',
    });
    expect((await queue()).map((r) => r.waterBodyId)).toEqual([body]);
  });

  test('a flag through a merged-away body’s id lands on its survivor, and dedupes there', async () => {
    const t = convexTest(schema, modules);
    const flagger = await seedUser(t, 'f');
    const lake = (name: string) =>
      t.run((ctx) =>
        ctx.db.insert('waterBodies', {
          name,
          searchText: name,
          type: 'lakePond',
          source: 'osm',
          polygon: { type: 'Polygon', coordinates: [] },
          bbox: { minLat: 0, minLng: 0, maxLat: 0.01, maxLng: 0.01 },
          centroid: { lat: 0.005, lng: 0.005 },
          dedupStatus: 'clean',
          createdAt: Date.now(),
        }),
      );
    const survivor = await lake('Survivor');
    const loser = await lake('Loser');
    await t.run((ctx) => ctx.db.patch(loser, { dedupStatus: 'merged', mergedIntoId: survivor }));
    const flagId = await flagger.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: loser,
      reason: 'no_public_access',
    });
    const row = await t.run((ctx) => ctx.db.get(flagId));
    expect(row?.targetId).toBe(survivor);
    // The same person flagging the survivor itself is the repeat it is.
    expect(
      await flagger.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: survivor,
        reason: 'no_public_access',
      }),
    ).toBe(flagId);
    const queued = await t.run((ctx) => ctx.db.query('bodyLibraryQueue').collect());
    expect(queued.map((r) => r.waterBodyId)).toEqual([survivor]);
  });

  test('two different flaggers each get their own row', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'a');
    const f1 = await seedUser(t, 'f1');
    const f2 = await seedUser(t, 'f2');
    const reportId = await seedReport(t, author.id);
    await f1.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });
    await f2.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'spam',
    });
    expect(await t.run((ctx) => ctx.db.query('contentFlags').collect())).toHaveLength(2);
  });
});
