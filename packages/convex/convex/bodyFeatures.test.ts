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

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
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
      createdAt: Date.now(),
    }),
  );
}

const POINT = { type: 'Point' as const, coordinates: [0.5, 0.5] };

const LINE = {
  type: 'LineString' as const,
  coordinates: [
    [0.4, 0.4],
    [0.6, 0.6],
  ],
};

/** A member-authored hazard, the realistic input to a promotion (admins promote others' pins). */
async function seedHazard(t: ReturnType<typeof convexTest>, waterBodyId: Id<'waterBodies'>) {
  const author = await seedUser(t, 'hazard-author');
  return author.as.mutation(api.hazards.create, {
    waterBodyId,
    type: 'pressure_ridge' as const,
    geometryKind: 'point_radius' as const,
    geometry: POINT,
    radiusMeters: 25,
  });
}

/** A polyline-traced ridge — the true shape of a `pressure_ridge`, and the case promote regressed on. */
async function seedLineHazard(t: ReturnType<typeof convexTest>, waterBodyId: Id<'waterBodies'>) {
  const author = await seedUser(t, 'ridge-author');
  return author.as.mutation(api.hazards.create, {
    waterBodyId,
    type: 'pressure_ridge' as const,
    geometryKind: 'line' as const,
    geometry: LINE,
    bufferMeters: 15,
  });
}

describe('bodyFeatures.create', () => {
  test('creates an active feature with a derived bbox', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);

    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'spring_current',
      geometry: POINT,
      radiusMeters: 30,
      reason: 'known spring',
    });

    const feature = await t.run((ctx) => ctx.db.get(id));
    expect(feature?.active).toBe(true);
    expect(feature?.type).toBe('spring_current');
    expect(feature?.bbox.maxLat).toBeGreaterThan(0.5);
  });

  test('requires the moderator role (D37 refined 2026-07-23)', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    const mod = await seedUser(t, 'mod', 'moderator');
    const waterBodyId = await seedBody(t);
    const args = {
      waterBodyId,
      type: 'spring_current' as const,
      geometry: POINT,
      radiusMeters: 30,
      reason: 'x',
    };

    await expect(member.as.mutation(api.bodyFeatures.create, args)).rejects.toThrow(/moderator/);
    // Promote/demote moved into the moderator content toolkit (D37 refinement): a mod working a
    // recurring-hazard pin can graduate it without escalating to an admin.
    await expect(mod.as.mutation(api.bodyFeatures.create, args)).resolves.toBeTruthy();
  });

  test('rejects a point geometry with no radius', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    // A point with no radius is an under-specified feature — it would reach turf/buffer as a bogus
    // zero-area polygon. The shared shape gate must reject it rather than store junk.
    await expect(
      admin.as.mutation(api.bodyFeatures.create, {
        waterBodyId,
        type: 'constriction',
        geometry: POINT,
        reason: 'narrow channel',
      }),
    ).rejects.toThrow(/geometry/);
  });

  test('names the missing radius when point_radius is explicit', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    // An admin who explicitly asked for point_radius but forgot the radius gets the actual missing
    // field, not the generic "invalid geometry" from the shape gate.
    await expect(
      admin.as.mutation(api.bodyFeatures.create, {
        waterBodyId,
        type: 'constriction',
        geometryKind: 'point_radius',
        geometry: POINT,
        reason: 'narrow channel',
      }),
    ).rejects.toThrow(/radiusMeters is required/);
  });

  test('requires a non-blank reason', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);

    await expect(
      admin.as.mutation(api.bodyFeatures.create, {
        waterBodyId,
        type: 'spring_current',
        geometry: POINT,
        reason: '   ',
      }),
    ).rejects.toThrow(/reason is required/);
  });
});

describe('bodyFeatures.listForBody', () => {
  test('returns active features and omits demoted ones', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'bridge_narrows',
      geometry: POINT,
      radiusMeters: 20,
      reason: 'narrows under the bridge',
    });

    expect(await admin.as.query(api.bodyFeatures.listForBody, { waterBodyId })).toHaveLength(1);

    await admin.as.mutation(api.bodyFeatures.demote, {
      bodyFeatureId: id,
      reason: 'mismarked',
    });
    expect(await admin.as.query(api.bodyFeatures.listForBody, { waterBodyId })).toHaveLength(0);
  });

  test('is readable without authentication — a known hazard is public safety info', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'gas_hole',
      geometry: POINT,
      radiusMeters: 10,
      reason: 'marsh gas over the delta',
    });

    expect(await t.query(api.bodyFeatures.listForBody, { waterBodyId })).toHaveLength(1);
  });
});

describe('bodyFeatures.promote', () => {
  test('graduates a recurring hazard and leaves the source sighting standing', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      note: 'reforms here every year',
      reason: 'recurs annually',
    });

    const feature = await t.run((ctx) => ctx.db.get(featureId));
    expect(feature?.promotedFromHazardId).toBe(hazardId);
    expect(feature?.type).toBe('recurring_pressure_ridge');
    expect(feature?.active).toBe(true);

    // The hazard survives with its history, photos and confirmations intact — and its LIFECYCLE status
    // is untouched. Setting `status: archived` here would make a moderator's promotion look like the
    // community clearing the hazard (D3).
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard).not.toBeNull();
    expect(hazard?.status).toBe('active');
    expect(hazard?.promotedToFeatureId).toBe(featureId);

    // **And it stays on the map** (D53 amendment, N5c). A `bodyFeature` is a standing statement about
    // the lake; this row is a sighting a person made on a date. Dropping it here rewrote that date as
    // one on which nobody reported anything — and under cluster promotion it would erase the whole
    // evidence trail the pattern rests on, one click after an operator agreed the pattern was real.
    const listed = await admin.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed.map((h) => h._id)).toEqual([hazardId]);
  });

  test('refuses to promote a hazard that is already promoted', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    });

    // A second promote would strand the first feature: `promotedToFeatureId` only records the latest,
    // so both features go active and demoting the second resurfaces the hazard alongside the orphaned
    // first. The guard blocks it, and the source still points at the one real feature.
    await expect(
      admin.as.mutation(api.bodyFeatures.promote, {
        hazardId,
        type: 'recurring_pressure_ridge',
        reason: 'promoting again by mistake',
      }),
    ).rejects.toThrow(/already promoted/);

    const features = await admin.as.query(api.bodyFeatures.listForBody, { waterBodyId });
    expect(features).toHaveLength(1);
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.promotedToFeatureId).toBe(featureId);
  });

  // The regression this whole schema change fixed: a polyline-traced recurring ridge — the flagship
  // D53 promotion target — must promote, carrying its line geometry and buffer, not throw.
  test('promotes a line-geometry ridge, preserving its primitive and buffer', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedLineHazard(t, waterBodyId);

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'reforms here annually',
    });

    const feature = await t.run((ctx) => ctx.db.get(featureId));
    expect(feature?.geometryKind).toBe('line');
    expect(feature?.bufferMeters).toBe(15);
    expect(feature?.geometry).toMatchObject({ type: 'LineString' });
    // Its footprint bbox matches the source hazard's (same shape + buffer, just a different table).
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(feature?.bbox).toEqual(hazard?.bbox);
  });

  // The D53 amendment (N5c), stated as the behaviour it replaced: a promoted hazard used to be
  // unreachable by permalink and unconfirmable. Both were wrong, and for the same reason — confirming
  // "the ridge is here right now" is a different statement from "ridges form here", and only the first
  // is confirmable at all. The pin is exactly the thing that should still take votes.
  test('a promoted hazard is still gettable and still confirmable', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const skater = await seedUser(t, 'skater');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    });

    const view = await skater.as.query(api.hazards.get, { hazardId });
    expect(view?._id).toBe(hazardId);
    // The drawer's reconciling line: the pin says it is also marked as a standing feature, so the two
    // read as one story rather than two independent warnings about the same ice.
    expect(view?.promotedFeatureType).toBe('recurring_pressure_ridge');

    await skater.as.mutation(api.hazardConfirmations.confirm, {
      hazardId,
      verdict: 'still_there',
      via: 'app_open_nearby',
    });
    const confirmed = await t.run((ctx) => ctx.db.get(hazardId));
    expect(confirmed?.confirmCount).toBe(1);
  });

  test('the drawer line goes away when the feature is demoted, not when the backlink clears', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const skater = await seedUser(t, 'skater');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    });
    await admin.as.mutation(api.bodyFeatures.demote, {
      bodyFeatureId: featureId,
      reason: 'not actually recurring',
    });

    const view = await skater.as.query(api.hazards.get, { hazardId });
    expect(view?._id).toBe(hazardId);
    expect(view?.promotedFeatureType).toBeUndefined();
  });

  test('a promoted hazard leaves the promotion queue but nothing else', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    // The pass looks back a season, so age the sighting into the one that just ended.
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { firstReportedAt: Date.now() - 200 * 24 * 60 * 60 * 1000 }),
    );
    const before = await admin.as.query(api.hazards.listPromotionCandidates, { waterBodyId });
    expect(before.map((c) => c.hazardId)).toContain(hazardId);

    await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    });

    // `listPromotionCandidates` is the one reader that still filters on supersession: the list is a
    // queue of decisions, and there is nothing left to decide about a hazard already promoted.
    const after = await admin.as.query(api.hazards.listPromotionCandidates, { waterBodyId });
    expect(after.map((c) => c.hazardId)).not.toContain(hazardId);
  });

  test('demoting the feature un-supersedes the source hazard so it returns intact', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    });
    await admin.as.mutation(api.bodyFeatures.demote, {
      bodyFeatureId: featureId,
      reason: 'not actually recurring',
    });

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard?.promotedToFeatureId).toBeUndefined();
    expect(hazard?.status).toBe('active');
    const listed = await admin.as.query(api.hazards.listForBody, { waterBodyId });
    expect(listed).toHaveLength(1);
    // ...and it's gettable again.
    expect(await admin.as.query(api.hazards.get, { hazardId })).not.toBeNull();
  });

  test('carries the hazard geometry across unchanged', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);
    const hazard = await t.run((ctx) => ctx.db.get(hazardId));

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs',
    });

    const feature = await t.run((ctx) => ctx.db.get(featureId));
    // A promoted ridge must not shift or resize just because it changed tables.
    expect(feature?.geometry).toEqual(hazard?.geometry);
    expect(feature?.bbox).toEqual(hazard?.bbox);
  });

  test('requires the moderator role', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    await expect(
      member.as.mutation(api.bodyFeatures.promote, {
        hazardId,
        type: 'recurring_pressure_ridge',
        reason: 'x',
      }),
    ).rejects.toThrow(/moderator/);
  });

  test('writes an audit row naming the source hazard', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(t, waterBodyId);

    await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    });

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: 'promote_body_feature',
      targetType: 'bodyFeature',
      reason: 'recurs annually',
      metadata: { hazardId },
    });
  });
});

describe('bodyFeatures.demote', () => {
  test('is reversible — flips active off rather than deleting', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'constriction',
      geometry: POINT,
      radiusMeters: 15,
      reason: 'narrow channel',
    });

    await admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: 'wrong spot' });

    const feature = await t.run((ctx) => ctx.db.get(id));
    expect(feature).not.toBeNull();
    expect(feature?.active).toBe(false);
  });

  test('writes an audit row', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const waterBodyId = await seedBody(t);
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'constriction',
      geometry: POINT,
      radiusMeters: 15,
      reason: 'narrow channel',
    });

    await admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: 'mismarked' });

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((a) => a.action)).toEqual(['promote_body_feature', 'demote_body_feature']);
  });

  test('requires the moderator role and a reason', async () => {
    const t = harness();
    const admin = await seedUser(t, 'admin', 'admin');
    const member = await seedUser(t, 'member');
    const waterBodyId = await seedBody(t);
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'constriction',
      geometry: POINT,
      radiusMeters: 15,
      reason: 'narrow channel',
    });

    await expect(
      member.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: 'x' }),
    ).rejects.toThrow(/moderator/);
    await expect(
      admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: '' }),
    ).rejects.toThrow(/reason is required/);
  });
});
