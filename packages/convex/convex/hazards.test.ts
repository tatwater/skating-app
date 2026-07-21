import geospatial from '@convex-dev/geospatial/test'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

/** `reports.create` resolves a place label through the adminAreas geospatial index. */
function harness() {
  const t = convexTest(schema, modules)
  geospatial.register(t)
  geospatial.register(t, 'adminAreasGeo')
  return t
}

/** A photo row backed by real stored blobs, so `storage.getUrl` resolves. */
async function seedPhoto(t: ReturnType<typeof convexTest>, uploaderId: Id<'profiles'>) {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['full'])))
  const thumbStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['thumb'])))
  return t.run((ctx) =>
    ctx.db.insert('photos', {
      storageId,
      thumbStorageId,
      uploaderId,
      placeOnMap: false,
      createdAt: Date.now(),
    }),
  )
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

const ADULT_DOB = Date.UTC(1990, 0, 1)
const MINOR_DOB = Date.UTC(2015, 0, 1)

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  overrides: { role?: 'member' | 'moderator' | 'admin'; dateOfBirth?: number } = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: overrides.dateOfBirth ?? ADULT_DOB,
      reputationPoints: 0,
      role: overrides.role ?? ('member' as const),
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

function createArgs(waterBodyId: Id<'waterBodies'>, overrides = {}) {
  return {
    waterBodyId,
    type: 'open_water' as const,
    geometryKind: 'point_radius' as const,
    geometry: POINT,
    radiusMeters: 40,
    ...overrides,
  }
}

describe('hazards.create', () => {
  test('creates a hazard with derived bbox and initial lifecycle state', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)

    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId))
    const hazard = await t.run((ctx) => ctx.db.get(hazardId))

    expect(hazard?.type).toBe('open_water')
    expect(hazard?.status).toBe('active')
    expect(hazard?.moderationStatus).toBe('visible')
    expect(hazard?.confirmCount).toBe(0)
    expect(hazard?.goneCount).toBe(0)
    expect(hazard?.originReportId).toBeUndefined()
    // The bbox is of the *footprint* (point grown by its radius), not the bare point.
    expect(hazard?.bbox.maxLat).toBeGreaterThan(0.5)
    expect(hazard?.bbox.minLat).toBeLessThan(0.5)
  })

  test('fills the type-aware radius default when the client omits one', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)

    const hazardId = await user.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { type: 'drilled_hole', radiusMeters: undefined }),
    )
    const hazard = await t.run((ctx) => ctx.db.get(hazardId))
    // A drilled hole is metres across, not tens of metres.
    expect(hazard?.radiusMeters).toBe(5)
  })

  test('rejects a degenerate geometry rather than storing an invisible hazard', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)

    await expect(
      user.as.mutation(
        api.hazards.create,
        createArgs(waterBodyId, {
          geometryKind: 'line',
          geometry: { type: 'LineString', coordinates: [[0.5, 0.5]] },
          radiusMeters: undefined,
        }),
      ),
    ).rejects.toThrow(/Invalid hazard geometry/)
  })

  test('requires authentication', async () => {
    const t = harness()
    const waterBodyId = await seedBody(t)
    await expect(t.mutation(api.hazards.create, createArgs(waterBodyId))).rejects.toThrow(
      /Not authenticated/,
    )
  })

  // Minors are read-only (D41) — a hazard is public safety content.
  test('rejects minors', async () => {
    const t = harness()
    const minor = await seedUser(t, 'minor', { dateOfBirth: MINOR_DOB })
    const waterBodyId = await seedBody(t)
    await expect(minor.as.mutation(api.hazards.create, createArgs(waterBodyId))).rejects.toThrow(
      /under 18/,
    )
  })

  test('rejects a photo the author does not own', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const stranger = await seedUser(t, 'stranger')
    const waterBodyId = await seedBody(t)
    const photoId = await seedPhoto(t, stranger.id)

    await expect(
      author.as.mutation(api.hazards.create, createArgs(waterBodyId, { photoIds: [photoId] })),
    ).rejects.toThrow(/not owned/)
  })
})

describe('hazards.listForBody', () => {
  test('derives freshness and provisional status at read time', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    await user.as.mutation(api.hazards.create, createArgs(waterBodyId))

    const [hazard] = await user.as.query(api.hazards.listForBody, { waterBodyId })
    expect(hazard?.freshness).toBe('fresh')
    expect(hazard?.provisional).toBe(true) // nobody else has confirmed it yet
  })

  // Dropping stale hazards would make "unconfirmed lately" indistinguishable from "gone" (D3).
  test('still returns stale hazards, annotated rather than filtered', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId))
    // open_water goes stale after 72h.
    await t.run((ctx) =>
      ctx.db.patch(hazardId, { lastConfirmedAt: Date.now() - 100 * 60 * 60 * 1000 }),
    )

    const [hazard] = await user.as.query(api.hazards.listForBody, { waterBodyId })
    expect(hazard?.freshness).toBe('stale')
  })

  test('hides moderator-hidden hazards', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId))
    await t.run((ctx) => ctx.db.patch(hazardId, { moderationStatus: 'hidden' }))

    expect(await user.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(0)
  })

  test('excludes archived hazards by default and includes them on request', async () => {
    const t = harness()
    const user = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await user.as.mutation(api.hazards.create, createArgs(waterBodyId))
    await t.run((ctx) => ctx.db.patch(hazardId, { status: 'archived' }))

    expect(await user.as.query(api.hazards.listForBody, { waterBodyId })).toHaveLength(0)
    expect(
      await user.as.query(api.hazards.listForBody, { waterBodyId, includeArchived: true }),
    ).toHaveLength(1)
  })
})

describe('hazards.setModeration', () => {
  test('hides a bad pin without touching its lifecycle status', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const mod = await seedUser(t, 'mod', { role: 'moderator' })
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))

    await mod.as.mutation(api.hazards.setModeration, {
      hazardId,
      status: 'hidden',
      reason: 'fake pin',
    })

    const hazard = await t.run((ctx) => ctx.db.get(hazardId))
    expect(hazard?.moderationStatus).toBe('hidden')
    // The two axes are separate on purpose: a moderator hiding a pin must never read as the community
    // clearing a hazard (D3).
    expect(hazard?.status).toBe('active')
  })

  test('writes an audit row', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const mod = await seedUser(t, 'mod', { role: 'moderator' })
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))

    await mod.as.mutation(api.hazards.setModeration, {
      hazardId,
      status: 'hidden',
      reason: 'spam',
    })

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(1)
    expect(actions[0]?.targetType).toBe('hazard')
    expect(actions[0]?.action).toBe('hide')
    expect(actions[0]?.reason).toBe('spam')
  })

  test('requires the moderator role and a non-blank reason', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const mod = await seedUser(t, 'mod', { role: 'moderator' })
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))

    await expect(
      author.as.mutation(api.hazards.setModeration, { hazardId, status: 'hidden', reason: 'x' }),
    ).rejects.toThrow(/moderator/)
    await expect(
      mod.as.mutation(api.hazards.setModeration, { hazardId, status: 'hidden', reason: '  ' }),
    ).rejects.toThrow(/reason is required/)
  })
})

describe('hazards.listBundleCandidates (D55)', () => {
  test("offers the author's own unattached hazards inside the skate window", async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now() + 1000,
    })
    expect(candidates.map((c) => c._id)).toEqual([hazardId])
  })

  test("never offers another skater's hazard", async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const other = await seedUser(t, 'other')
    const waterBodyId = await seedBody(t)
    await other.as.mutation(api.hazards.create, createArgs(waterBodyId))

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now() + 1000,
    })
    expect(candidates).toHaveLength(0)
  })

  test('never offers a hazard already attached to a report', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    })
    expect(reportId).toBeDefined()

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now() + 1000,
    })
    expect(candidates).toHaveLength(0)
  })

  test('excludes hazards outside the skate window', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))
    // Flagged a week before this skate.
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    await t.run((ctx) => ctx.db.patch(hazardId, { firstReportedAt: weekAgo }))

    const candidates = await author.as.query(api.hazards.listBundleCandidates, {
      waterBodyId,
      skateEndTime: Date.now(),
    })
    expect(candidates).toHaveLength(0)
  })
})

describe('reports.create with hazards', () => {
  test('creates in-report hazards stamped with originReportId', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      hazards: [
        {
          type: 'pressure_ridge' as const,
          geometryKind: 'point_radius' as const,
          geometry: POINT,
          radiusMeters: 25,
        },
      ],
    })

    const report = await t.run((ctx) => ctx.db.get(reportId))
    const createdId = report?.hazardIdsCreated[0]
    expect(report?.hazardIdsCreated).toHaveLength(1)
    expect(createdId).toBeDefined()

    if (!createdId) throw new Error('expected an in-report hazard')
    const hazard = await t.run((ctx) => ctx.db.get(createdId))
    expect(hazard?.originReportId).toBe(reportId)
    expect(hazard?.type).toBe('pressure_ridge')
  })

  test("bundles the author's standalone hazards into the report (D55)", async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    })

    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.hazardIdsCreated).toEqual([hazardId])
    const hazard = await t.run((ctx) => ctx.db.get(hazardId))
    expect(hazard?.originReportId).toBe(reportId)
  })

  // Bundling someone else's observation would misattribute it — mis-sourced safety content is a D3
  // problem, so the server re-checks ownership rather than trusting the id list.
  test("silently skips another skater's hazard rather than stealing it", async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const other = await seedUser(t, 'other')
    const waterBodyId = await seedBody(t)
    const foreignId = await other.as.mutation(api.hazards.create, createArgs(waterBodyId))

    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [foreignId],
    })

    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.hazardIdsCreated).toEqual([])
    const hazard = await t.run((ctx) => ctx.db.get(foreignId))
    expect(hazard?.originReportId).toBeUndefined()
  })

  test('does not re-attach a hazard already bound to another report', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const hazardId = await author.as.mutation(api.hazards.create, createArgs(waterBodyId))
    const firstReport = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    })
    const secondReport = await author.as.mutation(api.reports.create, {
      waterBodyId,
      skateEndTime: Date.now(),
      attachHazardIds: [hazardId],
    })

    expect(await t.run((ctx) => ctx.db.get(secondReport))).toMatchObject({ hazardIdsCreated: [] })
    expect(await t.run((ctx) => ctx.db.get(hazardId))).toMatchObject({
      originReportId: firstReport,
    })
  })
})

describe('photos.getHazardUrls', () => {
  test("serves a standalone hazard's photos without needing a report", async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const photoId = await seedPhoto(t, author.id)
    const hazardId = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { photoIds: [photoId] }),
    )

    const photos = await author.as.query(api.photos.getHazardUrls, { hazardId })
    expect(photos).toHaveLength(1)
    expect(photos[0]?.photoId).toBe(photoId)
  })

  test('serves nothing for a moderator-hidden hazard', async () => {
    const t = harness()
    const author = await seedUser(t, 'author')
    const waterBodyId = await seedBody(t)
    const photoId = await seedPhoto(t, author.id)
    const hazardId = await author.as.mutation(
      api.hazards.create,
      createArgs(waterBodyId, { photoIds: [photoId] }),
    )
    await t.run((ctx) => ctx.db.patch(hazardId, { moderationStatus: 'hidden' }))

    expect(await author.as.query(api.photos.getHazardUrls, { hazardId })).toEqual([])
  })
})
