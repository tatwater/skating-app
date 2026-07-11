import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

type Role = 'member' | 'moderator' | 'admin'
type Status = 'active' | 'suspended' | 'banned' | 'deleted'

const SAMPLE_BODY = {
  name: 'Lake Morey',
  type: 'lake' as const,
  polygon: {
    type: 'Polygon',
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
}

/** Seed a provisioned profile with a given role/status and return an identity-scoped tester. */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role = 'member',
  status: Status = 'active',
  suspendedUntil?: number,
) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      requireFollowApproval: false,
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        followedPostedNearby: true,
        hazardConfirmation: true,
        bountyFulfilled: true,
        newFollower: true,
        reportRated: true,
        contentFlagResolved: true,
      },
      minAge16Attested: true,
      isMinor: false,
      reputationPoints: 0,
      role,
      status,
      ...(suspendedUntil !== undefined ? { suspendedUntil } : {}),
      createdAt: Date.now(),
    }),
  )
  return t.withIdentity({ subject })
}

describe('waterBodies.create', () => {
  test('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)
    await expect(t.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /not authenticated/i,
    )
  })

  test('rejects a banned account (status gate, D37)', async () => {
    const t = convexTest(schema, modules)
    const asBanned = await seedUser(t, 'clerk_banned', 'member', 'banned')
    await expect(asBanned.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /not active/i,
    )
  })

  test('rejects an account under active suspension (D37)', async () => {
    const t = convexTest(schema, modules)
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000
    const asSuspended = await seedUser(t, 'clerk_susp', 'member', 'suspended', future)
    await expect(asSuspended.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /suspended/i,
    )
  })

  test('allows an account whose suspension has lapsed (D37)', async () => {
    const t = convexTest(schema, modules)
    const past = Date.now() - 1000
    const asLapsed = await seedUser(t, 'clerk_lapsed', 'member', 'suspended', past)
    await expect(asLapsed.mutation(api.waterBodies.create, SAMPLE_BODY)).resolves.toBeDefined()
  })

  test('a member creates a pending, user-sourced body attributed to them', async () => {
    const t = convexTest(schema, modules)
    const asMember = await seedUser(t, 'clerk_member')

    const id = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
    const body = await t.run((ctx) => ctx.db.get(id))

    expect(body?.source).toBe('user')
    expect(body?.reviewStatus).toBe('pending')
    expect(body?.dedupStatus).toBe('clean')
    expect(body?.name).toBe('Lake Morey')
  })
})

describe('waterBodies.approve (role gating + audit log, D37)', () => {
  async function seedPendingBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    const asMember = await seedUser(t, 'clerk_member')
    return asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
  }

  test('a member cannot approve', async () => {
    const t = convexTest(schema, modules)
    const bodyId = await seedPendingBody(t)
    const asMember = t.withIdentity({ subject: 'clerk_member' })
    await expect(
      asMember.mutation(api.waterBodies.approve, { waterBodyId: bodyId }),
    ).rejects.toThrow(/moderator/i)
  })

  test('a moderator approves and writes exactly one audit row', async () => {
    const t = convexTest(schema, modules)
    const bodyId = await seedPendingBody(t)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')

    const returned = await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })
    expect(returned).toEqual(bodyId)

    const body = await t.run((ctx) => ctx.db.get(bodyId))
    expect(body?.reviewStatus).toBe('approved')

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(1)
    expect(actions[0]?.action).toBe('approve_waterbody')
    expect(actions[0]?.targetType).toBe('waterbody')
    expect(actions[0]?.targetId).toBe(bodyId)
  })

  test('an admin may also approve (role precedence)', async () => {
    const t = convexTest(schema, modules)
    const bodyId = await seedPendingBody(t)
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin')

    await expect(
      asAdmin.mutation(api.waterBodies.approve, { waterBodyId: bodyId }),
    ).resolves.toEqual(bodyId)
  })

  test('cannot approve a body that is not pending (no rejection-reversal, no dup audit)', async () => {
    const t = convexTest(schema, modules)
    const bodyId = await seedPendingBody(t)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')

    await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })
    // Second approve on the now-approved body must be rejected.
    await expect(asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })).rejects.toThrow(
      /not pending/i,
    )

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(1) // exactly one audit row, not two
  })

  test('cannot approve a canonical (non-user) body', async () => {
    const t = convexTest(schema, modules)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    const canonicalId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/123',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      }),
    )
    await expect(
      asMod.mutation(api.waterBodies.approve, { waterBodyId: canonicalId }),
    ).rejects.toThrow(/user-created/i)
  })

  test('approving a missing body throws', async () => {
    const t = convexTest(schema, modules)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    // Create then delete to obtain a well-formed but dangling id.
    const bodyId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'user',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      })
      await ctx.db.delete(id)
      return id
    })
    await expect(asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })).rejects.toThrow(
      /not found/i,
    )
  })
})

describe('waterBodies.listPendingReview', () => {
  test('a member cannot read the review queue', async () => {
    const t = convexTest(schema, modules)
    const asMember = await seedUser(t, 'clerk_member')
    await expect(asMember.query(api.waterBodies.listPendingReview, {})).rejects.toThrow(
      /moderator/i,
    )
  })

  test('a moderator sees pending bodies but not approved ones', async () => {
    const t = convexTest(schema, modules)
    const asMember = await seedUser(t, 'clerk_member')
    const pendingId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
    const otherId = await asMember.mutation(api.waterBodies.create, {
      ...SAMPLE_BODY,
      name: 'Joes Pond',
    })

    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: otherId })

    const queue = await asMod.query(api.waterBodies.listPendingReview, {})
    expect(queue).toHaveLength(1)
    expect(queue[0]?._id).toEqual(pendingId)
  })
})
