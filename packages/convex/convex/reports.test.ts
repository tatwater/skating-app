import geospatial from '@convex-dev/geospatial/test'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

function convexTestWithGeo() {
  const t = convexTest(schema, modules)
  geospatial.register(t)
  return t
}

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  followedPostedNearby: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  newFollower: true,
  reportRated: true,
  contentFlagResolved: true,
}

/** Seed a provisioned profile; `requireFollowApproval` true = a locked/private (minor-like) account. */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  requireFollowApproval = false,
) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      requireFollowApproval,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  )
  return t.withIdentity({ subject })
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
}

/** Seed a canonical water body and return its id + centroid. */
async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'osm/1') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        name: 'Lake Morey',
        type: 'lake',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  })
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  )
  if (!body) throw new Error('seed failed')
  return { id: body._id, centroid: body.centroid }
}

const SKATE_TIME = Date.UTC(2026, 0, 10)

describe('reports.create', () => {
  test('requires authentication', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    await expect(
      t.mutation(api.reports.create, { waterBodyId: id, skateTime: SKATE_TIME }),
    ).rejects.toThrow(/not authenticated/i)
  })

  test('creates a native, visible report and defaults point to the body centroid', async () => {
    const t = convexTestWithGeo()
    const { id, centroid } = await seedBody(t)
    const asUser = await seedUser(t, 'clerk_a')

    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      iceTypes: ['black_ice'],
      notes: '  glassy  ',
    })
    const report = await t.run((ctx) => ctx.db.get(reportId))
    expect(report?.source).toBe('native')
    expect(report?.moderationStatus).toBe('visible')
    expect(report?.point).toEqual(centroid) // no put-in pin → centroid
    expect(report?.notes).toBe('glassy') // normalized (trimmed)
    expect(report?.reportTime).toBeGreaterThan(0)
    expect(report?.visibility).toBe('public') // public profile → default public (D41)
  })

  test('stores a fully-populated report (all optional sections)', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asUser = await seedUser(t, 'clerk_a')
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'public',
      iceTypes: ['black_ice'],
      surfaceTags: ['glass'],
      skateQuality: 'great',
      iceThickness: { readings: [{ valueCm: 12, method: 'measured' }] },
      snowCoverCm: 2,
      conditions: { airTempC: -6, sky: 'clear' },
      notes: 'perfect',
      point: { lat: 0.5, lng: 0.5 },
    })
    const r = await t.run((ctx) => ctx.db.get(reportId))
    expect(r?.skateQuality).toBe('great')
    expect(r?.iceThickness?.readings[0]?.valueCm).toBe(12)
    expect(r?.snowCoverCm).toBe(2)
    expect(r?.conditions?.source).toBe('user') // defaulted (D19)
    expect(r?.conditions?.sky).toBe('clear')
  })

  test('honors a dropped put-in pin as the report point', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asUser = await seedUser(t, 'clerk_a')
    const point = { lat: 0.4, lng: 0.6 }
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      point,
    })
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.point).toEqual(point)
  })

  test('clamps a locked/minor account away from public (D41)', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asLocked = await seedUser(t, 'clerk_minor', true)
    // Default visibility for a locked profile is followers — and public is refused outright.
    await expect(
      asLocked.mutation(api.reports.create, {
        waterBodyId: id,
        skateTime: SKATE_TIME,
        visibility: 'public',
      }),
    ).rejects.toThrow(/invalid_report/i)

    const okId = await asLocked.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
    })
    expect((await t.run((ctx) => ctx.db.get(okId)))?.visibility).toBe('followers')
  })

  test('rejects an invalid report at the server boundary (D37)', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asUser = await seedUser(t, 'clerk_a')
    await expect(
      asUser.mutation(api.reports.create, {
        waterBodyId: id,
        skateTime: SKATE_TIME + 400 * 24 * 60 * 60 * 1000, // absurdly future
      }),
    ).rejects.toThrow(/invalid_report/i)
  })

  test('attaches to the surviving body when the target was merged (D36)', async () => {
    const t = convexTestWithGeo()
    const loser = await seedBody(t, 'osm/loser')
    const survivor = await seedBody(t, 'osm/survivor')
    await t.run((ctx) =>
      ctx.db.patch(loser.id, { dedupStatus: 'merged', mergedIntoId: survivor.id }),
    )
    const asUser = await seedUser(t, 'clerk_a')
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: loser.id,
      skateTime: SKATE_TIME,
    })
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.waterBodyId).toEqual(survivor.id)
  })

  test('refuses a report on a removed (unlisted) body', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    await t.run((ctx) => ctx.db.patch(id, { removedAt: Date.now() }))
    const asUser = await seedUser(t, 'clerk_a')
    await expect(
      asUser.mutation(api.reports.create, { waterBodyId: id, skateTime: SKATE_TIME }),
    ).rejects.toThrow(/not found/i)
  })

  test('rejects a photo the author does not own', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asOwner = await seedUser(t, 'clerk_owner')
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])))
    const photoId = await asOwner.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    })
    const asOther = await seedUser(t, 'clerk_other')
    await expect(
      asOther.mutation(api.reports.create, {
        waterBodyId: id,
        skateTime: SKATE_TIME,
        photoIds: [photoId],
      }),
    ).rejects.toThrow(/not owned/i)
  })
})

describe('reports.listByWaterBody (visibility, D13)', () => {
  test('sorts by skate time desc, filters by viewer, excludes non-visible', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asAuthor = await seedUser(t, 'clerk_author')

    // Two public (different skate times) + one just_me + one hidden.
    const older = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME - 1000,
      visibility: 'public',
    })
    const newer = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'public',
    })
    const priv = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'just_me',
    })
    const hidden = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'public',
    })
    await t.run((ctx) => ctx.db.patch(hidden, { moderationStatus: 'hidden' }))

    // A different viewer sees only the two public reports, newest skate time first.
    const asViewer = await seedUser(t, 'clerk_viewer')
    const seen = await asViewer.query(api.reports.listByWaterBody, { waterBodyId: id })
    expect(seen.map((r) => r._id)).toEqual([newer, older])

    // The author additionally sees their own just_me report.
    const byAuthor = await asAuthor.query(api.reports.listByWaterBody, { waterBodyId: id })
    expect(byAuthor.map((r) => r._id).sort()).toEqual([newer, older, priv].sort())

    // An unauthenticated caller (no profile) still sees only the public reports.
    const anon = await t.query(api.reports.listByWaterBody, { waterBodyId: id })
    expect(anon.map((r) => r._id)).toEqual([newer, older])
  })
})

describe('reports.get (single, visibility-checked)', () => {
  test('hides a just_me report from a non-author but shows it to the author', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asAuthor = await seedUser(t, 'clerk_author')
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'just_me',
    })
    const asOther = await seedUser(t, 'clerk_other')
    expect(await asOther.query(api.reports.get, { reportId })).toBeNull()
    expect((await asAuthor.query(api.reports.get, { reportId }))?._id).toEqual(reportId)
  })

  test('returns null for a missing report; shows a public report to an anon viewer', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asAuthor = await seedUser(t, 'clerk_author')
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'public',
    })
    await t.run((ctx) => ctx.db.delete(reportId))
    expect(await t.query(api.reports.get, { reportId })).toBeNull() // missing

    const live = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      visibility: 'public',
    })
    expect((await t.query(api.reports.get, { reportId: live }))?._id).toEqual(live) // anon sees public
  })
})

describe('reports.update (author-only LWW, D25)', () => {
  async function seedReport(t: ReturnType<typeof convexTest>) {
    const { id } = await seedBody(t)
    const asAuthor = await seedUser(t, 'clerk_author')
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
      skateQuality: 'good',
      notes: 'ok',
    })
    return { asAuthor, reportId }
  }

  test('a non-author cannot edit', async () => {
    const t = convexTestWithGeo()
    const { reportId } = await seedReport(t)
    const asOther = await seedUser(t, 'clerk_other')
    await expect(
      asOther.mutation(api.reports.update, { reportId, skateTime: SKATE_TIME, notes: 'hacked' }),
    ).rejects.toThrow(/only the author/i)
  })

  test('re-validates on edit (rejects an invalid change)', async () => {
    const t = convexTestWithGeo()
    const { asAuthor, reportId } = await seedReport(t)
    await expect(
      asAuthor.mutation(api.reports.update, {
        reportId,
        skateTime: SKATE_TIME,
        snowCoverCm: -5, // invalid
      }),
    ).rejects.toThrow(/invalid_report/i)
  })

  test('a missing report throws', async () => {
    const t = convexTestWithGeo()
    const { id } = await seedBody(t)
    const asAuthor = await seedUser(t, 'clerk_author')
    // A well-formed report id created then deleted → a dangling reference.
    const reportId = await asAuthor.mutation(api.reports.create, {
      waterBodyId: id,
      skateTime: SKATE_TIME,
    })
    await t.run((ctx) => ctx.db.delete(reportId))
    await expect(
      asAuthor.mutation(api.reports.update, { reportId, skateTime: SKATE_TIME }),
    ).rejects.toThrow(/not found/i)
  })

  test('the author edits, replacing content and bumping updatedAt', async () => {
    const t = convexTestWithGeo()
    const { asAuthor, reportId } = await seedReport(t)
    const before = await t.run((ctx) => ctx.db.get(reportId))
    await asAuthor.mutation(api.reports.update, {
      reportId,
      skateTime: SKATE_TIME,
      surfaceTags: ['glass'],
      // omit skateQuality + notes → LWW clears them
    })
    const after = await t.run((ctx) => ctx.db.get(reportId))
    expect(after?.surfaceTags).toEqual(['glass'])
    expect(after?.skateQuality).toBeUndefined()
    expect(after?.notes).toBeUndefined()
    expect(after?.updatedAt ?? 0).toBeGreaterThanOrEqual(before?.updatedAt ?? 0)
  })
})
