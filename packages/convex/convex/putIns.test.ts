import { seasonOf, seasonStartMs } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  return t;
}

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
  await t.run((ctx) =>
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
  return t.withIdentity({ subject });
}

const POLYGON = {
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
};

async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'osm/1') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: 'Lake Morey',
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return body._id as Id<'waterBodies'>;
}

const SKATE_TIME = Date.UTC(2026, 0, 10);

describe('putIns.listForBody', () => {
  test('returns [] for an unknown body', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.query(api.putIns.listForBody, { waterBodyId: id })).toEqual([]);
  });

  test('derives a clustered marker snapped to shore from visible report points', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    // Two reports at the centroid (default point) cluster into one marker.
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME + 1 });

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(markers).toHaveLength(1);
    expect(markers[0]?.source).toBe('derived');
    expect(markers[0]?.reportCount).toBe(2);
    // Snapped to the polygon boundary — one coordinate sits on an edge (0 or 1).
    const coord = markers[0]?.coord ?? { lat: 0.5, lng: 0.5 };
    const onEdge = [coord.lat, coord.lng].some((c) => Math.abs(c) < 1e-6 || Math.abs(c - 1) < 1e-6);
    expect(onEdge).toBe(true);
  });

  // The N5a trap, asserted rather than commented: put-ins derive from reports, and reports are the
  // most thoroughly season-scoped read in the app. A bound added here would narrow access points to
  // this winter's with no error and no empty state — losing exactly what the exemption protects.
  test('survives the seasonal reset — where you get on the ice is not a seasonal fact (D63)', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    // Drag the report two seasons back. The lake's list and the feed stop showing it; the access
    // point it revealed does not stop being where you park.
    const twoSeasonsAgo = seasonStartMs(seasonOf(Date.now()) - 2) + 1;
    await t.run((ctx) => ctx.db.patch(reportId, { skateEndTime: twoSeasonsAgo }));

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(markers).toHaveLength(1);
    // …and it says how old it is instead of pretending to be last week (D62 second amendment).
    expect(markers[0]?.lastUsedAt).toBe(twoSeasonsAgo);
  });

  test('excludes reports that opted out of showPutIn (private property)', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      showPutIn: false,
    });
    expect(await t.query(api.putIns.listForBody, { waterBodyId: id })).toEqual([]);
  });

  test('lists official markers first, then derived', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    // Official marker well away from the derived cluster's shore point.
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.9, lng: 0.1 },
    });

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(markers[0]?.source).toBe('official');
    expect(markers.some((m) => m.source === 'derived')).toBe(true);
  });

  test('a moderator hide suppresses a derived coord', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const before = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(before).toHaveLength(1);
    const target = before[0]?.coord ?? { lat: 0.5, lng: 0.5 };

    await asMod.mutation(api.putIns.hide, {
      waterBodyId: id,
      coord: target,
      reason: 'private access',
    });
    const after = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(after).toEqual([]);
  });
});

describe('putIns.setOfficial / hide (auth + audit)', () => {
  test('setOfficial requires a moderator and writes an audit row', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMember = await seedUser(t, 'clerk_member');
    await expect(
      asMember.mutation(api.putIns.setOfficial, { waterBodyId: id, coord: { lat: 0.5, lng: 0 } }),
    ).rejects.toThrow(/moderator/i);

    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.putIns.setOfficial, { waterBodyId: id, coord: { lat: 0.5, lng: 0 } });
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.targetType).toBe('waterbody');
    expect(actions[0]?.action).toBe('set_put_in'); // a dedicated verb, not the misleading 'restore'
  });

  test('hide requires a non-empty reason', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await expect(
      asMod.mutation(api.putIns.hide, {
        waterBodyId: id,
        coord: { lat: 0.5, lng: 0 },
        reason: '  ',
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  test('setOfficial rejects an unknown body', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await t.run((ctx) => ctx.db.delete(id));
    await expect(
      asMod.mutation(api.putIns.setOfficial, { waterBodyId: id, coord: { lat: 0.5, lng: 0 } }),
    ).rejects.toThrow(/not found/i);
  });
});
