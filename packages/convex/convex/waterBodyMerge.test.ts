/**
 * Phase 7 dedup merge (D36) + user-body reject (D37). Verifies the merge re-points every child to the
 * survivor, soft-tombstones the loser, and audits; and that reject flips a pending user body unlisted.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

const POLY = {
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
const BBOX = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
const CENTROID = { lat: 0.5, lng: 0.5 };

async function seedMod(t: ReturnType<typeof convexTest>, subject = 'mod') {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'moderator',
      status: 'active',
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

function seedBody(
  t: ReturnType<typeof convexTest>,
  name: string,
  opts: {
    source?: 'osm' | 'user';
    dedupStatus?: 'clean' | 'suspected_duplicate';
    reviewStatus?: 'pending';
  } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      type: 'lake',
      source: opts.source ?? 'osm',
      polygon: POLY,
      bbox: BBOX,
      centroid: CENTROID,
      dedupStatus: opts.dedupStatus ?? 'clean',
      ...(opts.reviewStatus ? { reviewStatus: opts.reviewStatus } : {}),
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

describe('waterBodies.merge (D36)', () => {
  test('re-points children, tombstones the loser, and audits with counts', async () => {
    const t = harness();
    const mod = await seedMod(t);
    const survivor = await seedBody(t, 'Official Pond');
    const loser = await seedBody(t, 'Dup Pond', {
      source: 'user',
      dedupStatus: 'suspected_duplicate',
    });
    const author = await seedMod(t, 'author').then(() =>
      t.run((ctx) =>
        ctx.db
          .query('profiles')
          .withIndex('by_username', (q) => q.eq('username', 'author'))
          .unique(),
      ),
    );
    const authorId = author?._id as Id<'profiles'>;

    // A report, a hazard, and a bounty all pointing at the loser.
    const { reportId, hazardId, bountyId } = await t.run(async (ctx) => {
      const reportId = await ctx.db.insert('reports', {
        authorId,
        waterBodyId: loser,
        point: CENTROID,
        skateEndTime: Date.now(),
        reportTime: Date.now(),
        source: 'native',
        iceTypes: ['black_ice'],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const hazardId = await ctx.db.insert('hazards', {
        waterBodyId: loser,
        type: 'open_water',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [0.5, 0.5] },
        radiusMeters: 30,
        bbox: BBOX,
        createdByUserId: authorId,
        photoIds: [],
        status: 'active',
        moderationStatus: 'visible',
        firstReportedAt: Date.now(),
        lastConfirmedAt: Date.now(),
        confirmCount: 0,
        goneCount: 0,
        createdAt: Date.now(),
      });
      const bountyId = await ctx.db.insert('bounties', {
        requesterId: authorId,
        waterBodyId: loser,
        windowHours: 48,
        status: 'open',
        rewardPoints: 10,
        fulfillingReportIds: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000,
      });
      return { reportId, hazardId, bountyId };
    });

    const returned = await mod.mutation(api.waterBodies.merge, {
      survivorId: survivor,
      loserId: loser,
      reason: 'same pond',
    });
    expect(returned).toBe(survivor);

    // Children now point at the survivor.
    const after = await t.run(async (ctx) => ({
      report: await ctx.db.get(reportId),
      hazard: await ctx.db.get(hazardId),
      bounty: await ctx.db.get(bountyId),
      loser: await ctx.db.get(loser),
    }));
    expect(after.report?.waterBodyId).toBe(survivor);
    expect(after.hazard?.waterBodyId).toBe(survivor);
    expect(after.bounty?.waterBodyId).toBe(survivor);
    // Loser is tombstoned and points at the survivor.
    expect(after.loser?.dedupStatus).toBe('merged');
    expect(after.loser?.mergedIntoId).toBe(survivor);

    // A deep link to the loser now resolves to the survivor (read follows the chain).
    const resolved = await mod.query(api.waterBodies.get, { waterBodyId: loser });
    expect(resolved?.available).toBe(true);
    if (resolved?.available) expect(resolved.body._id).toBe(survivor);

    const audit = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    const mergeRow = audit.find((a) => a.action === 'merge_waterbody');
    expect(mergeRow?.metadata?.repointed).toMatchObject({ reports: 1, hazards: 1, bounties: 1 });
  });

  test('re-points put-ins and favorites, collapsing a user who favorited both bodies', async () => {
    const t = harness();
    const mod = await seedMod(t);
    const survivor = await seedBody(t, 'Official Pond');
    const loser = await seedBody(t, 'Dup Pond', {
      source: 'user',
      dedupStatus: 'suspected_duplicate',
    });

    const { officialPutIn, hiddenPutIn, onlyLoserFav, bothFav } = await t.run(async (ctx) => {
      const userA = await ctx.db
        .query('profiles')
        .withIndex('by_username', (q) => q.eq('username', 'mod'))
        .unique();
      const aId = userA?._id as Id<'profiles'>;
      const officialPutIn = await ctx.db.insert('putIns', {
        waterBodyId: loser,
        coord: CENTROID,
        source: 'official',
        status: 'visible',
        createdAt: Date.now(),
      });
      // A moderator-suppressed coord: stranding this un-hides a put-in they deliberately killed.
      const hiddenPutIn = await ctx.db.insert('putIns', {
        waterBodyId: loser,
        coord: CENTROID,
        source: 'derived',
        status: 'hidden',
        createdAt: Date.now(),
      });
      // This user favorited only the loser → the row moves.
      const onlyLoserFav = await ctx.db.insert('waterBodyFavorites', {
        userId: aId,
        waterBodyId: loser,
        createdAt: Date.now(),
      });
      // This one favorited BOTH → the loser row is dropped, not duplicated.
      const bothUser = await ctx.db.insert('profiles', {
        clerkUserId: 'both',
        displayName: 'both',
        username: 'both',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: {
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
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: Date.now(),
      });
      const bothFav = await ctx.db.insert('waterBodyFavorites', {
        userId: bothUser,
        waterBodyId: loser,
        createdAt: Date.now(),
      });
      await ctx.db.insert('waterBodyFavorites', {
        userId: bothUser,
        waterBodyId: survivor,
        createdAt: Date.now(),
      });
      return { officialPutIn, hiddenPutIn, onlyLoserFav, bothFav };
    });

    await mod.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });

    const after = await t.run(async (ctx) => ({
      officialPutIn: await ctx.db.get(officialPutIn),
      hiddenPutIn: await ctx.db.get(hiddenPutIn),
      onlyLoserFav: await ctx.db.get(onlyLoserFav),
      bothFav: await ctx.db.get(bothFav),
      stranded: await ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', loser))
        .collect(),
    }));
    expect(after.officialPutIn?.waterBodyId).toBe(survivor);
    expect(after.hiddenPutIn?.waterBodyId).toBe(survivor);
    expect(after.onlyLoserFav?.waterBodyId).toBe(survivor);
    expect(after.bothFav).toBeNull(); // collapsed into the existing survivor favorite
    expect(after.stranded).toHaveLength(0);

    const audit = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    const mergeRow = audit.find((a) => a.action === 'merge_waterbody');
    expect(mergeRow?.metadata?.repointed).toMatchObject({
      putIns: 2,
      favorites: 1,
      favoritesDeduped: 1,
    });
  });

  test('rejects merging a body into itself and re-merging a tombstone', async () => {
    const t = harness();
    const mod = await seedMod(t);
    const a = await seedBody(t, 'A');
    const b = await seedBody(t, 'B');
    await expect(
      mod.mutation(api.waterBodies.merge, { survivorId: a, loserId: a }),
    ).rejects.toThrow(/into itself/);
    await mod.mutation(api.waterBodies.merge, { survivorId: a, loserId: b });
    await expect(
      mod.mutation(api.waterBodies.merge, { survivorId: a, loserId: b }),
    ).rejects.toThrow(/already merged/);
  });

  test('a member cannot merge', async () => {
    const t = harness();
    const a = await seedBody(t, 'A');
    const b = await seedBody(t, 'B');
    await expect(
      t.mutation(api.waterBodies.merge, { survivorId: a, loserId: b }),
    ).rejects.toThrow();
  });
});

describe('waterBodies.reject (D37)', () => {
  test('flips a pending user body to rejected + unlisted, audited', async () => {
    const t = harness();
    const mod = await seedMod(t);
    const body = await seedBody(t, 'Bogus Pond', { source: 'user', reviewStatus: 'pending' });
    await mod.mutation(api.waterBodies.reject, { waterBodyId: body, reason: 'not a real lake' });
    const after = await t.run((ctx) => ctx.db.get(body));
    expect(after?.reviewStatus).toBe('rejected');
    // Unlisted → the detail read reports it unavailable rather than rendering it.
    const read = await mod.query(api.waterBodies.get, { waterBodyId: body });
    expect(read?.available).toBe(false);
    const audit = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(audit.some((a) => a.action === 'reject_waterbody')).toBe(true);
  });

  test('only a pending user body can be rejected', async () => {
    const t = harness();
    const mod = await seedMod(t);
    const canonical = await seedBody(t, 'OSM Lake', { source: 'osm' });
    await expect(mod.mutation(api.waterBodies.reject, { waterBodyId: canonical })).rejects.toThrow(
      /user-created/,
    );
  });
});
