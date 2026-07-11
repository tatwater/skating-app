import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'

// Vite-glob of every function module, handed to convex-test (required in a monorepo
// where the convex dir isn't the Vite project root).
const modules = import.meta.glob('./**/*.*s')

describe('profiles.upsertFromClerk', () => {
  test('throws when unauthenticated', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.profiles.upsertFromClerk, {
        displayName: 'Ada',
        username: 'ada',
        minAge16Attested: true,
      }),
    ).rejects.toThrow(/not authenticated/i)
  })

  test('provisions a member profile from the Clerk identity with sane defaults', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })

    const id = await asAda.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Ada',
      username: 'ada',
      minAge16Attested: true,
    })

    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?._id).toEqual(id)
    expect(profile?.clerkUserId).toBe('clerk_ada')
    expect(profile?.role).toBe('member')
    expect(profile?.status).toBe('active')
    expect(profile?.reputationPoints).toBe(0)
    expect(profile?.driveTimePrefMinutes).toBe(60)
    expect(profile?.requireFollowApproval).toBe(false)
    expect(profile?.notificationPrefs.hazardConfirmation).toBe(true)
  })

  test('is idempotent — a second call patches the same profile', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })

    const first = await asAda.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Ada',
      username: 'ada',
      minAge16Attested: true,
    })
    const second = await asAda.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Ada Lovelace',
      username: 'ada',
      minAge16Attested: true,
    })

    expect(second).toEqual(first)
    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.displayName).toBe('Ada Lovelace')

    const rows = await t.run((ctx) => ctx.db.query('profiles').collect())
    expect(rows).toHaveLength(1)
  })

  test('rejects an under-16 attestation (hard 16+ gate, D41)', async () => {
    const t = convexTest(schema, modules)
    const asKid = t.withIdentity({ subject: 'clerk_kid' })
    await expect(
      asKid.mutation(api.profiles.upsertFromClerk, {
        displayName: 'Kid',
        username: 'kid',
        minAge16Attested: false,
      }),
    ).rejects.toThrow(/16 years old/i)
    // No profile should have been provisioned.
    expect(await asKid.query(api.profiles.current, {})).toBeNull()
  })

  test('rejects a username already held by another user', async () => {
    const t = convexTest(schema, modules)
    await t.withIdentity({ subject: 'clerk_a' }).mutation(api.profiles.upsertFromClerk, {
      displayName: 'A',
      username: 'ada',
      minAge16Attested: true,
    })
    await expect(
      t.withIdentity({ subject: 'clerk_b' }).mutation(api.profiles.upsertFromClerk, {
        displayName: 'B',
        username: 'ada',
        minAge16Attested: true,
      }),
    ).rejects.toThrow(/already taken/i)
  })

  test('re-upsert keeping your own username is allowed', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    await asAda.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Ada',
      username: 'ada',
      minAge16Attested: true,
    })
    await expect(
      asAda.mutation(api.profiles.upsertFromClerk, {
        displayName: 'Ada L',
        username: 'ada',
        minAge16Attested: true,
      }),
    ).resolves.toBeDefined()
  })

  test('self-attested minors default to follow-approval required (D41)', async () => {
    const t = convexTest(schema, modules)
    const asTeen = t.withIdentity({ subject: 'clerk_teen' })

    await asTeen.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Teen',
      username: 'teen',
      minAge16Attested: true,
      isMinor: true,
    })

    const profile = await asTeen.query(api.profiles.current, {})
    expect(profile?.isMinor).toBe(true)
    expect(profile?.requireFollowApproval).toBe(true)
  })
})

describe('profiles.current', () => {
  test('returns null when unauthenticated', async () => {
    const t = convexTest(schema, modules)
    expect(await t.query(api.profiles.current, {})).toBeNull()
  })

  test('returns null for an authenticated identity with no provisioned profile', async () => {
    const t = convexTest(schema, modules)
    const asGhost = t.withIdentity({ subject: 'clerk_ghost' })
    expect(await asGhost.query(api.profiles.current, {})).toBeNull()
  })
})
