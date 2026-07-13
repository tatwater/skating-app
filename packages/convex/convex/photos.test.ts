import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

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

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      requireFollowApproval: false,
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

/** Store a throwaway blob and return its storage id (convex-test's in-memory storage). */
async function storeBlob(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.storage.store(new Blob(['img'])))
}

const COORD = { lat: 44.2, lng: -72.5 }
const SKATE = Date.UTC(2026, 0, 10)

describe('photos.generateUploadUrl', () => {
  test('requires authentication', async () => {
    const t = convexTest(schema, modules)
    await expect(t.mutation(api.photos.generateUploadUrl, {})).rejects.toThrow(/not authenticated/i)
  })

  test('returns an upload URL for a signed-in user', async () => {
    const t = convexTest(schema, modules)
    const asUser = await seedUser(t, 'clerk_a')
    expect(typeof (await asUser.mutation(api.photos.generateUploadUrl, {}))).toBe('string')
  })
})

describe('photos.create (D42 coord gate)', () => {
  test('retains coord only when placeOnMap is true', async () => {
    const t = convexTest(schema, modules)
    const asUser = await seedUser(t, 'clerk_a')
    const storageId = await storeBlob(t)
    const thumbStorageId = await storeBlob(t)

    const pinned = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      coord: COORD,
      takenAt: SKATE,
      placeOnMap: true,
    })
    expect((await t.run((ctx) => ctx.db.get(pinned)))?.coord).toEqual(COORD)
  })

  test('drops coord when placeOnMap is false, even if a coord is passed (leak guard)', async () => {
    const t = convexTest(schema, modules)
    const asUser = await seedUser(t, 'clerk_a')
    const storageId = await storeBlob(t)

    const notPinned = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      coord: COORD, // passed, but must be dropped server-side
      placeOnMap: false,
    })
    const photo = await t.run((ctx) => ctx.db.get(notPinned))
    expect(photo?.coord).toBeUndefined()
    expect(photo?.placeOnMap).toBe(false)
  })

  test('requires authentication', async () => {
    const t = convexTest(schema, modules)
    const storageId = await storeBlob(t)
    await expect(
      t.mutation(api.photos.create, { storageId, thumbStorageId: storageId, placeOnMap: false }),
    ).rejects.toThrow(/not authenticated/i)
  })
})

describe('photos.getUrls', () => {
  test('resolves full + thumb serving URLs and echoes safe metadata', async () => {
    const t = convexTest(schema, modules)
    const asUser = await seedUser(t, 'clerk_a')
    const storageId = await storeBlob(t)
    const thumbStorageId = await storeBlob(t)
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      caption: 'north bay',
      coord: COORD,
      placeOnMap: true,
    })
    const [row] = await t.query(api.photos.getUrls, { photoIds: [photoId] })
    expect(row?.photoId).toEqual(photoId)
    expect(typeof row?.url).toBe('string')
    expect(typeof row?.thumbUrl).toBe('string')
    expect(row?.caption).toBe('north bay')
    expect(row?.coord).toEqual(COORD)
  })

  test('skips a missing photo row', async () => {
    const t = convexTest(schema, modules)
    const asUser = await seedUser(t, 'clerk_a')
    const storageId = await storeBlob(t)
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    })
    // Delete the row → getUrls should skip it (returns empty, not throw).
    await t.run((ctx) => ctx.db.delete(photoId))
    expect(await t.query(api.photos.getUrls, { photoIds: [photoId] })).toEqual([])
  })

  test('returns a null URL for a photo whose stored file is gone (guarded)', async () => {
    const t = convexTest(schema, modules)
    const asUser = await seedUser(t, 'clerk_a')
    const storageId = await storeBlob(t)
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    })
    // Delete the underlying blob but keep the row → serving URL resolves to null.
    await t.run((ctx) => ctx.storage.delete(storageId))
    const [row] = await t.query(api.photos.getUrls, { photoIds: [photoId] })
    expect(row?.url).toBeNull()
  })
})
