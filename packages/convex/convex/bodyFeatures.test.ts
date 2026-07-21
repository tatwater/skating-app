import geospatial from '@convex-dev/geospatial/test'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

function harness() {
  const t = convexTest(schema, modules)
  geospatial.register(t)
  geospatial.register(t, 'adminAreasGeo')
  return t
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
}

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
  )
  return { id, as: t.withIdentity({ subject }) }
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
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
      createdAt: Date.now(),
    }),
  )
}

const POINT = { type: 'Point' as const, coordinates: [0.5, 0.5] }

const LINE = {
  type: 'LineString' as const,
  coordinates: [
    [0.4, 0.4],
    [0.6, 0.6],
  ],
}

/** A member-authored hazard, the realistic input to a promotion (admins promote others' pins). */
async function seedHazard(t: ReturnType<typeof convexTest>, waterBodyId: Id<'waterBodies'>) {
  const author = await seedUser(t, 'hazard-author')
  return author.as.mutation(api.hazards.create, {
    waterBodyId,
    type: 'pressure_ridge' as const,
    geometryKind: 'point_radius' as const,
    geometry: POINT,
    radiusMeters: 25,
  })
}

/** A polyline-traced ridge — the true shape of a `pressure_ridge`, and the case promote regressed on. */
async function seedLineHazard(t: ReturnType<typeof convexTest>, waterBodyId: Id<'waterBodies'>) {
  const author = await seedUser(t, 'ridge-author')
  return author.as.mutation(api.hazards.create, {
    waterBodyId,
    type: 'pressure_ridge' as const,
    geometryKind: 'line' as const,
    geometry: LINE,
    bufferMeters: 15,
  })
}

describe('bodyFeatures.create', () => {
  test('creates an active feature with a derived bbox', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)

    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'spring_current',
      geometry: POINT,
      radiusMeters: 30,
      reason: 'known spring',
    })

    const feature = await t.run((ctx) => ctx.db.get(id))
    expect(feature?.active).toBe(true)
    expect(feature?.type).toBe('spring_current')
    expect(feature?.bbox.maxLat).toBeGreaterThan(0.5)
  })

  test('requires the admin role', async () => {
    const t = harness()
    const member = await seedUser(t, 'member')
    const mod = await seedUser(t, 'mod', 'moderator')
    const waterBodyId = await seedBody(t)
    const args = {
      waterBodyId,
      type: 'spring_current' as const,
      geometry: POINT,
      reason: 'x',
    }

    await expect(member.as.mutation(api.bodyFeatures.create, args)).rejects.toThrow(/admin/)
    // Body features are permanent, unconfirmable claims about a lake — a moderator hiding a bad post
    // is a different kind of authority from asserting a lake is permanently dangerous here.
    await expect(mod.as.mutation(api.bodyFeatures.create, args)).rejects.toThrow(/admin/)
  })

  test('rejects a point geometry with no radius', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    // A point with no radius is an under-specified feature — it would reach turf/buffer as a bogus
    // zero-area polygon. The shared shape gate must reject it rather than store junk.
    await expect(
      admin.as.mutation(api.bodyFeatures.create, {
        waterBodyId,
        type: 'constriction',
        geometry: POINT,
        reason: 'narrow channel',
      }),
    ).rejects.toThrow(/geometry/)
  })

  test('requires a non-blank reason', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)

    await expect(
      admin.as.mutation(api.bodyFeatures.create, {
        waterBodyId,
        type: 'spring_current',
        geometry: POINT,
        reason: '   ',
      }),
    ).rejects.toThrow(/reason is required/)
  })
})

describe('bodyFeatures.listForBody', () => {
  test('returns active features and omits demoted ones', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'bridge_narrows',
      geometry: POINT,
      radiusMeters: 20,
      reason: 'narrows under the bridge',
    })

    expect(await admin.as.query(api.bodyFeatures.listForBody, { waterBodyId })).toHaveLength(1)

    await admin.as.mutation(api.bodyFeatures.demote, {
      bodyFeatureId: id,
      reason: 'mismarked',
    })
    expect(await admin.as.query(api.bodyFeatures.listForBody, { waterBodyId })).toHaveLength(0)
  })

  test('is readable without authentication — a known hazard is public safety info', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'gas_hole',
      geometry: POINT,
      radiusMeters: 10,
      reason: 'marsh gas over the delta',
    })

    expect(await t.query(api.bodyFeatures.listForBody, { waterBodyId })).toHaveLength(1)
  })
})

describe('bodyFeatures.promote', () => {
  test('graduates a recurring hazard and supersedes (never archives) the source', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedHazard(t, waterBodyId)

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      note: 'reforms here every year',
      reason: 'recurs annually',
    })

    const feature = await t.run((ctx) => ctx.db.get(featureId))
    expect(feature?.promotedFromHazardId).toBe(hazardId)
    expect(feature?.type).toBe('recurring_pressure_ridge')
    expect(feature?.active).toBe(true)

    // The hazard survives with its history, photos and confirmations intact — and its LIFECYCLE status
    // is untouched. Promotion supersedes via a separate axis so it can never read as the community
    // clearing the hazard (D3); it just stops rendering because the feature carries the warning now.
    const hazard = await t.run((ctx) => ctx.db.get(hazardId))
    expect(hazard).not.toBeNull()
    expect(hazard?.status).toBe('active')
    expect(hazard?.promotedToFeatureId).toBe(featureId)

    // And it drops out of the map read path in favour of the feature.
    const listed = await admin.as.query(api.hazards.listForBody, { waterBodyId })
    expect(listed).toHaveLength(0)
  })

  // The regression this whole schema change fixed: a polyline-traced recurring ridge — the flagship
  // D53 promotion target — must promote, carrying its line geometry and buffer, not throw.
  test('promotes a line-geometry ridge, preserving its primitive and buffer', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedLineHazard(t, waterBodyId)

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'reforms here annually',
    })

    const feature = await t.run((ctx) => ctx.db.get(featureId))
    expect(feature?.geometryKind).toBe('line')
    expect(feature?.bufferMeters).toBe(15)
    expect(feature?.geometry).toMatchObject({ type: 'LineString' })
    // Its footprint bbox matches the source hazard's (same shape + buffer, just a different table).
    const hazard = await t.run((ctx) => ctx.db.get(hazardId))
    expect(feature?.bbox).toEqual(hazard?.bbox)
  })

  // A promoted hazard must be off *every* user surface, not just the map list — a deep link to it
  // resolves to nothing and it can't be confirmed (the feature carries the warning now).
  test('a promoted hazard is not gettable or confirmable', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const skater = await seedUser(t, 'skater')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedHazard(t, waterBodyId)

    await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    })

    expect(await skater.as.query(api.hazards.get, { hazardId })).toBeNull()
    await expect(
      skater.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'still_there',
        via: 'app_open_nearby',
      }),
    ).rejects.toThrow(/not found/i)
  })

  test('demoting the feature un-supersedes the source hazard so it returns intact', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedHazard(t, waterBodyId)

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    })
    await admin.as.mutation(api.bodyFeatures.demote, {
      bodyFeatureId: featureId,
      reason: 'not actually recurring',
    })

    const hazard = await t.run((ctx) => ctx.db.get(hazardId))
    expect(hazard?.promotedToFeatureId).toBeUndefined()
    expect(hazard?.status).toBe('active')
    const listed = await admin.as.query(api.hazards.listForBody, { waterBodyId })
    expect(listed).toHaveLength(1)
    // ...and it's gettable again.
    expect(await admin.as.query(api.hazards.get, { hazardId })).not.toBeNull()
  })

  test('carries the hazard geometry across unchanged', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedHazard(t, waterBodyId)
    const hazard = await t.run((ctx) => ctx.db.get(hazardId))

    const featureId = await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs',
    })

    const feature = await t.run((ctx) => ctx.db.get(featureId))
    // A promoted ridge must not shift or resize just because it changed tables.
    expect(feature?.geometry).toEqual(hazard?.geometry)
    expect(feature?.bbox).toEqual(hazard?.bbox)
  })

  test('requires the admin role', async () => {
    const t = harness()
    const member = await seedUser(t, 'member')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedHazard(t, waterBodyId)

    await expect(
      member.as.mutation(api.bodyFeatures.promote, {
        hazardId,
        type: 'recurring_pressure_ridge',
        reason: 'x',
      }),
    ).rejects.toThrow(/admin/)
  })

  test('writes an audit row naming the source hazard', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const hazardId = await seedHazard(t, waterBodyId)

    await admin.as.mutation(api.bodyFeatures.promote, {
      hazardId,
      type: 'recurring_pressure_ridge',
      reason: 'recurs annually',
    })

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      action: 'promote_body_feature',
      targetType: 'bodyFeature',
      reason: 'recurs annually',
      metadata: { hazardId },
    })
  })
})

describe('bodyFeatures.demote', () => {
  test('is reversible — flips active off rather than deleting', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'constriction',
      geometry: POINT,
      radiusMeters: 15,
      reason: 'narrow channel',
    })

    await admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: 'wrong spot' })

    const feature = await t.run((ctx) => ctx.db.get(id))
    expect(feature).not.toBeNull()
    expect(feature?.active).toBe(false)
  })

  test('writes an audit row', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const waterBodyId = await seedBody(t)
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'constriction',
      geometry: POINT,
      radiusMeters: 15,
      reason: 'narrow channel',
    })

    await admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: 'mismarked' })

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions.map((a) => a.action)).toEqual(['promote_body_feature', 'demote_body_feature'])
  })

  test('requires the admin role and a reason', async () => {
    const t = harness()
    const admin = await seedUser(t, 'admin', 'admin')
    const member = await seedUser(t, 'member')
    const waterBodyId = await seedBody(t)
    const id = await admin.as.mutation(api.bodyFeatures.create, {
      waterBodyId,
      type: 'constriction',
      geometry: POINT,
      radiusMeters: 15,
      reason: 'narrow channel',
    })

    await expect(
      member.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: 'x' }),
    ).rejects.toThrow(/admin/)
    await expect(
      admin.as.mutation(api.bodyFeatures.demote, { bodyFeatureId: id, reason: '' }),
    ).rejects.toThrow(/reason is required/)
  })
})
