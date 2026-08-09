/**
 * Phase 7 dedup merge (D36) + user-body reject (D37). Verifies the merge re-points every child to the
 * survivor, soft-tombstones the loser, and audits; and that reject flips a pending user body unlisted.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
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
      searchText: name,
      type: 'lakePond',
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

describe('waterBodies.retireAbsorbedBodies — the half of the merge the upsert never did (N7-3)', () => {
  /** A body with the catalogue identity the ETL keys on. */
  function seedKeyed(
    t: ReturnType<typeof convexTest>,
    name: string,
    externalId: string,
    opts: { dedupStatus?: 'clean' | 'merged'; mergedIntoId?: Id<'waterBodies'> } = {},
  ) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name,
        searchText: name,
        type: 'lakePond',
        source: 'osm' as const,
        externalId,
        polygon: POLY,
        bbox: BBOX,
        centroid: CENTROID,
        dedupStatus: opts.dedupStatus ?? ('clean' as const),
        ...(opts.mergedIntoId ? { mergedIntoId: opts.mergedIntoId } : {}),
        createdAt: Date.now(),
      }),
    ) as Promise<Id<'waterBodies'>>;
  }
  const ref = (externalId: string) => ({ source: 'osm', externalId });

  test('folds the absorbed row into its survivor, and never deletes it', async () => {
    // The real fixture: OSM published this wetland as a relation AND its own outer way, D136's lane
    // collapsed them, and `importCanonical` — an upsert — left the absorbed row in the corpus.
    const t = harness();
    const survivor = await seedKeyed(t, 'Mud Pond Swamp', 'way/235156742');
    const absorbed = await seedKeyed(t, 'Mud Pond Swamp', 'relation/3165273');

    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/235156742'), absorbed: ref('relation/3165273') }],
      apply: true,
    });
    expect(res.retired).toBe(1);
    expect(res.applied).toBe(true);

    const row = await t.run((ctx) => ctx.db.get(absorbed));
    // Tombstoned, NOT deleted — a deep link to the retired duplicate still resolves to the survivor.
    expect(row).not.toBeNull();
    expect(row?.dedupStatus).toBe('merged');
    expect(row?.mergedIntoId).toBe(survivor);
  });

  test('changes nothing without --apply', async () => {
    // Dry by default, like `prune-floor`. This is the campaign's second pass that can take a body
    // off the map.
    const t = harness();
    await seedKeyed(t, 'Survivor', 'way/1');
    const absorbed = await seedKeyed(t, 'Absorbed', 'way/2');

    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/1'), absorbed: ref('way/2') }],
    });
    expect(res.applied).toBe(false);
    expect(res.retired).toBe(1); // it reports what it WOULD do
    expect((await t.run((ctx) => ctx.db.get(absorbed)))?.dedupStatus).toBe('clean');
  });

  test('carries the absorbed row’s content to the survivor rather than stranding it', async () => {
    // The reason this never deletes. A report on a duplicate row is a real skater's observation.
    const t = harness();
    const survivor = await seedKeyed(t, 'Survivor', 'way/1');
    const absorbed = await seedKeyed(t, 'Absorbed', 'way/2');
    await seedMod(t, 'skater');
    const authorId = (
      await t.run((ctx) =>
        ctx.db
          .query('profiles')
          .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'skater'))
          .unique(),
      )
    )?._id as Id<'profiles'>;
    const reportId = await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId: absorbed,
        point: CENTROID,
        skateEndTime: Date.now(),
        reportTime: Date.now(),
        source: 'native' as const,
        iceTypes: ['black_ice' as const],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/1'), absorbed: ref('way/2') }],
      apply: true,
    });
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.waterBodyId).toBe(survivor);
  });

  test('is idempotent — re-running a campaign must not walk a merge chain', async () => {
    const t = harness();
    await seedKeyed(t, 'Survivor', 'way/1');
    await seedKeyed(t, 'Absorbed', 'way/2');
    const pairs = [{ survivor: ref('way/1'), absorbed: ref('way/2') }];

    const first = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs,
      apply: true,
    });
    expect(first.retired).toBe(1);
    const second = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs,
      apply: true,
    });
    expect(second.retired).toBe(0);
    expect(second.skipped['already merged']).toBe(1);
  });

  test('an absent absorbed row is the steady state, not an error', async () => {
    // Expected on every re-run: an earlier pass retired it, or it was never a row at all.
    const t = harness();
    await seedKeyed(t, 'Survivor', 'way/1');
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/1'), absorbed: ref('way/never-existed') }],
      apply: true,
    });
    expect(res.retired).toBe(0);
    expect(res.skipped['absorbed row does not exist']).toBe(1);
  });

  test('refuses when the survivor is missing, rather than stranding the content', async () => {
    // The one outcome worse than a duplicate: retiring a row with nowhere to re-point its reports.
    const t = harness();
    const absorbed = await seedKeyed(t, 'Absorbed', 'way/2');
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/gone'), absorbed: ref('way/2') }],
      apply: true,
    });
    expect(res.retired).toBe(0);
    expect(res.skipped['survivor not in the corpus']).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(absorbed)))?.dedupStatus).toBe('clean');
  });

  test('refuses to merge a row into itself', async () => {
    const t = harness();
    await seedKeyed(t, 'Solo', 'way/1');
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/1'), absorbed: ref('way/1') }],
      apply: true,
    });
    expect(res.retired).toBe(0);
    expect(res.skipped['survivor and absorbed are the same row']).toBe(1);
  });

  test('refuses a survivor that is itself a tombstone, keeping the chain one hop', async () => {
    const t = harness();
    const canonical = await seedKeyed(t, 'Canonical', 'way/1');
    await seedKeyed(t, 'Already merged', 'way/2', {
      dedupStatus: 'merged',
      mergedIntoId: canonical,
    });
    await seedKeyed(t, 'Absorbed', 'way/3');
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/2'), absorbed: ref('way/3') }],
      apply: true,
    });
    expect(res.retired).toBe(0);
    expect(res.skipped['survivor is itself merged']).toBe(1);
  });

  test('names what it retired, because a deletion nobody can look up is unauditable', async () => {
    const t = harness();
    await seedKeyed(t, 'Survivor', 'way/1');
    await seedKeyed(t, 'Mud Pond Swamp', 'way/2');
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/1'), absorbed: ref('way/2') }],
      apply: true,
    });
    expect(res.samples[0]).toEqual({
      absorbed: 'osm:way/2',
      into: 'osm:way/1',
      name: 'Mud Pond Swamp',
    });
  });

  test('audits with no actor, because the system acted and no human did', async () => {
    // Precedent: N5c/D80's auto-merge. Naming a moderator who never clicked would be worse than an
    // honest absence, and "no actor" already renders as "automatic".
    const t = harness();
    await seedKeyed(t, 'Survivor', 'way/1');
    const absorbed = await seedKeyed(t, 'Absorbed', 'way/2');
    await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [{ survivor: ref('way/1'), absorbed: ref('way/2') }],
      campaignId: 'n7-3-20260809',
      apply: true,
    });
    const action = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'waterbody').eq('targetId', absorbed))
        .unique(),
    );
    expect(action?.action).toBe('merge_waterbody');
    expect(action?.actorId).toBeUndefined();
    expect(action?.reason).toContain('n7-3-20260809');
  });
});
