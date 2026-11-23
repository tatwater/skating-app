/**
 * **The operator mail opens the flag's own Inbox item** (B01-5e: `/admin/flags` retired). A safety
 * flag filed by a person, and the contradiction pattern's automatic flag, each mail a link to
 * `/admin/inbox?item=flag:<its id>`.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
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

describe('the operator mail’s link', () => {
  test('a safety flag mails its own Inbox item', async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { author, reportId } = await t.run(async (ctx) => {
      const author = await ctx.db.insert('profiles', {
        clerkUserId: 'author',
        displayName: 'author Test-Person',
        username: 'author',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member' as const,
        status: 'active' as const,
        createdAt: now,
      });
      await ctx.db.insert('profiles', {
        clerkUserId: 'flagger',
        displayName: 'flagger Real',
        username: 'flagger',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member' as const,
        status: 'active' as const,
        createdAt: now,
      });
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
        createdAt: now,
      });
      const reportId = await ctx.db.insert('reports', {
        authorId: author,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: now,
        reportTime: now,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: now,
        updatedAt: now,
      });
      return { author, reportId };
    });
    void author;
    const flagId = await t.withIdentity({ subject: 'flagger' }).mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: reportId,
      reason: 'unsafe_false_report',
    });
    const mails = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((f) =>
        f.name.includes('operatorAlerts'),
      ),
    );
    expect(mails.map((m) => (m.args[0] as { deepLinkPath: string }).deepLinkPath)).toEqual([
      `/admin/inbox?item=flag:${flagId}`,
    ]);
  });
});
