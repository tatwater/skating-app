import { isMinor, RISK_ACK_VERSION } from '@skating/core'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'

// Vite-glob of every function module, handed to convex-test (required in a monorepo
// where the convex dir isn't the Vite project root).
const modules = import.meta.glob('./**/*.*s')

// Every provisioning call must carry a current assumption-of-risk acknowledgment (D45);
// this fills the version so each test only spells out what it's actually exercising. The
// acceptance *time* is stamped server-side, so it's not an argument.
const withAck = <T extends object>(args: T) => ({
  riskAckVersion: RISK_ACK_VERSION,
  ...args,
})

// Dates of birth relative to the current year, so age math (which uses Date.now()) is
// stable regardless of when the suite runs. Born Jan 1 → the age holds all year.
const nowYear = new Date().getUTCFullYear()
const ADULT_DOB = Date.UTC(nowYear - 40, 0, 1) // ~40 → adult
const MINOR_DOB = Date.UTC(nowYear - 17, 0, 1) // 17 → minor
const UNDER_16_DOB = Date.UTC(nowYear - 10, 0, 1) // 10 → under the hard 16 gate

describe('profiles.upsertFromClerk', () => {
  test('throws when unauthenticated', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
      ),
    ).rejects.toThrow(/not authenticated/i)
  })

  test('provisions a member profile from the Clerk identity with sane defaults', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })

    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )

    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?._id).toEqual(id)
    expect(profile?.clerkUserId).toBe('clerk_ada')
    expect(profile?.dateOfBirth).toBe(ADULT_DOB)
    expect(profile?.role).toBe('member')
    expect(profile?.status).toBe('active')
    expect(profile?.reputationPoints).toBe(0)
    expect(profile?.driveTimePrefMinutes).toBe(60)
    expect(profile?.profileVisibility).toBe('public')
    expect(profile?.notificationPrefs.hazardConfirmation).toBe(true)
  })

  test('records a current, server-stamped assumption-of-risk acknowledgment (D45)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })

    const before = Date.now()
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )

    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.riskAckVersion).toBe(RISK_ACK_VERSION)
    // Stamped by the server at write time (never a client-supplied clock), so it lands
    // within the window of this call rather than being any injectable value.
    expect(profile?.riskAckAt).toBeGreaterThanOrEqual(before)
    expect(profile?.riskAckAt).toBeLessThanOrEqual(Date.now())
  })

  test('rejects a stale or missing risk acknowledgment (D45)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    await expect(
      asAda.mutation(
        api.profiles.upsertFromClerk,
        withAck({
          displayName: 'Ada',
          username: 'ada',
          dateOfBirth: ADULT_DOB,
          riskAckVersion: '1970-01-01', // not the current version
        }),
      ),
    ).rejects.toThrow(/assumption-of-risk/i)
    // No profile should have been provisioned.
    expect(await asAda.query(api.profiles.current, {})).toBeNull()
  })

  test('preserves the recorded acceptance time across a same-version re-sync (D45)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )
    // Pin a known acceptance time, then re-sync with the SAME version: the original must
    // be kept (only a version bump re-stamps), and never restamped to "now".
    const pinnedAt = Date.UTC(2020, 0, 1)
    await t.run((ctx) => ctx.db.patch(id, { riskAckAt: pinnedAt }))
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )

    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.riskAckAt).toBe(pinnedAt)
  })

  test('re-acking after a version bump re-stamps the acceptance time (D45)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )
    // Simulate a stale acceptance under an older version (as if RISK_ACK_VERSION was bumped).
    await t.run((ctx) =>
      ctx.db.patch(id, { riskAckVersion: '1970-01-01', riskAckAt: Date.UTC(2020, 0, 1) }),
    )

    const before = Date.now()
    // Accepting the current version again re-stamps the time server-side.
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )

    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.riskAckVersion).toBe(RISK_ACK_VERSION)
    expect(profile?.riskAckAt).toBeGreaterThanOrEqual(before)
  })

  test('is idempotent — a second call patches the same profile', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })

    const first = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )
    const second = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT_DOB }),
    )

    expect(second).toEqual(first)
    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.displayName).toBe('Ada Lovelace')

    const rows = await t.run((ctx) => ctx.db.query('profiles').collect())
    expect(rows).toHaveLength(1)
  })

  test('rejects an under-16 date of birth (hard 16+ gate, D41)', async () => {
    const t = convexTest(schema, modules)
    const asKid = t.withIdentity({ subject: 'clerk_kid' })
    await expect(
      asKid.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Kid', username: 'kid', dateOfBirth: UNDER_16_DOB }),
      ),
    ).rejects.toThrow(/16 years old/i)
    // No profile should have been provisioned.
    expect(await asKid.query(api.profiles.current, {})).toBeNull()
  })

  test('rejects a username already held by another user', async () => {
    const t = convexTest(schema, modules)
    await t
      .withIdentity({ subject: 'clerk_a' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'A', username: 'ada', dateOfBirth: ADULT_DOB }),
      )
    await expect(
      t
        .withIdentity({ subject: 'clerk_b' })
        .mutation(
          api.profiles.upsertFromClerk,
          withAck({ displayName: 'B', username: 'ada', dateOfBirth: ADULT_DOB }),
        ),
    ).rejects.toThrow(/already taken/i)
  })

  test('re-upsert keeping your own username is allowed', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )
    await expect(
      asAda.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ada L', username: 'ada', dateOfBirth: ADULT_DOB }),
      ),
    ).resolves.toBeDefined()
  })

  test('minors default to a private profile (D13/D41)', async () => {
    const t = convexTest(schema, modules)
    const asTeen = t.withIdentity({ subject: 'clerk_teen' })

    await asTeen.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: MINOR_DOB }),
    )

    const profile = await asTeen.query(api.profiles.current, {})
    expect(profile && isMinor(profile.dateOfBirth, Date.now())).toBe(true)
    expect(profile?.profileVisibility).toBe('private')
  })

  test('a minor who reaches adulthood keeps their private profile (D13/D41)', async () => {
    const t = convexTest(schema, modules)
    const asUser = t.withIdentity({ subject: 'clerk_grows' })
    // Provisioned as a minor → forced private.
    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: MINOR_DOB }),
    )
    const asMinor = await asUser.query(api.profiles.current, {})
    expect(asMinor && isMinor(asMinor.dateOfBirth, Date.now())).toBe(true)
    expect(asMinor?.profileVisibility).toBe('private')

    // Reaching adulthood (here an adult DOB on the next sync) must NOT auto-widen the
    // private profile they held as a minor — it persists until they make it public themselves (D13).
    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: ADULT_DOB }),
    )
    const grown = await asUser.query(api.profiles.current, {})
    expect(grown && isMinor(grown.dateOfBirth, Date.now())).toBe(false)
    expect(grown?.profileVisibility).toBe('private')
  })

  test('an inactive account cannot rename or squat a username via the upsert (D37)', async () => {
    const t = convexTest(schema, modules)
    const asUser = t.withIdentity({ subject: 'clerk_banned' })
    const id = await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Real Name', username: 'realname', dateOfBirth: ADULT_DOB }),
    )
    await t.run((ctx) => ctx.db.patch(id, { status: 'banned' }))

    // App-launch sync with changed fields is a no-op for an inactive account.
    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Evasion Name', username: 'newhandle', dateOfBirth: ADULT_DOB }),
    )
    const profile = await t.run((ctx) => ctx.db.get(id))
    expect(profile?.displayName).toBe('Real Name')
    expect(profile?.username).toBe('realname')

    // The attempted handle was never reserved — an active user can still claim it.
    const asOther = t.withIdentity({ subject: 'clerk_other' })
    await expect(
      asOther.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Other', username: 'newhandle', dateOfBirth: ADULT_DOB }),
      ),
    ).resolves.toBeDefined()
  })

  test('a deleted account keeps its scrubbed PII on re-sync (D33)', async () => {
    const t = convexTest(schema, modules)
    const asUser = t.withIdentity({ subject: 'clerk_deleted' })
    const id = await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Jane Doe', username: 'jane', dateOfBirth: ADULT_DOB }),
    )
    // Simulate the D33 deletion scrub.
    await t.run((ctx) => ctx.db.patch(id, { status: 'deleted', displayName: 'deleted user' }))

    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Jane Doe', username: 'jane', dateOfBirth: ADULT_DOB }),
    )
    const profile = await t.run((ctx) => ctx.db.get(id))
    expect(profile?.displayName).toBe('deleted user')
  })

  test('rejects a malformed or empty username (D37 trust boundary)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    for (const username of ['ab', '', 'ada lovelace', '_ada']) {
      await expect(
        asAda.mutation(
          api.profiles.upsertFromClerk,
          withAck({ displayName: 'Ada', username, dateOfBirth: ADULT_DOB }),
        ),
      ).rejects.toThrow(/username must be/i)
    }
    expect(await asAda.query(api.profiles.current, {})).toBeNull()
  })

  test('rejects a blank display name (D37 trust boundary)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    await expect(
      asAda.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: '   ', username: 'ada', dateOfBirth: ADULT_DOB }),
      ),
    ).rejects.toThrow(/display name is required/i)
    expect(await asAda.query(api.profiles.current, {})).toBeNull()
  })

  test('stores the normalized username + display name', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: '  Ada   Lovelace ', username: 'ADA_99', dateOfBirth: ADULT_DOB }),
    )
    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.username).toBe('ada_99')
    expect(profile?.displayName).toBe('Ada Lovelace')
  })

  test('username uniqueness is case-insensitive', async () => {
    const t = convexTest(schema, modules)
    await t
      .withIdentity({ subject: 'clerk_a' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'A', username: 'Ada', dateOfBirth: ADULT_DOB }),
      )
    await expect(
      t
        .withIdentity({ subject: 'clerk_b' })
        .mutation(
          api.profiles.upsertFromClerk,
          withAck({ displayName: 'B', username: 'ADA', dateOfBirth: ADULT_DOB }),
        ),
    ).rejects.toThrow(/already taken/i)
  })
})

describe('profiles.acceptCurrentRiskAck', () => {
  test('throws when unauthenticated', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION }),
    ).rejects.toThrow(/not authenticated/i)
  })

  test('throws for an authenticated identity with no provisioned profile', async () => {
    const t = convexTest(schema, modules)
    const asGhost = t.withIdentity({ subject: 'clerk_ghost' })
    await expect(
      asGhost.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION }),
    ).rejects.toThrow(/not authenticated/i)
  })

  test('refreshes a stale acknowledgment without touching other fields (D45)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT_DOB }),
    )
    // Simulate a stale acceptance under an older version (as if RISK_ACK_VERSION was bumped).
    await t.run((ctx) =>
      ctx.db.patch(id, { riskAckVersion: '1970-01-01', riskAckAt: Date.UTC(2020, 0, 1) }),
    )

    const before = Date.now()
    await asAda.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION })

    const profile = await asAda.query(api.profiles.current, {})
    expect(profile?.riskAckVersion).toBe(RISK_ACK_VERSION)
    expect(profile?.riskAckAt).toBeGreaterThanOrEqual(before)
    // The profile fields the user never re-entered are preserved as-is.
    expect(profile?.displayName).toBe('Ada Lovelace')
    expect(profile?.username).toBe('ada')
    expect(profile?.dateOfBirth).toBe(ADULT_DOB)
  })

  test('rejects a stale/non-current version (forces a fresh client build, D45)', async () => {
    const t = convexTest(schema, modules)
    const asAda = t.withIdentity({ subject: 'clerk_ada' })
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    )
    await expect(
      asAda.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: '1970-01-01' }),
    ).rejects.toThrow(/assumption-of-risk/i)
  })

  test('a banned account cannot re-ack its way back in (D37)', async () => {
    const t = convexTest(schema, modules)
    const asUser = t.withIdentity({ subject: 'clerk_banned' })
    const id = await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Real Name', username: 'realname', dateOfBirth: ADULT_DOB }),
    )
    await t.run((ctx) => ctx.db.patch(id, { status: 'banned' }))
    await expect(
      asUser.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION }),
    ).rejects.toThrow(/not active/i)
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

describe('profiles.publicByIds', () => {
  test('returns username + displayName keyed by id, deduped, missing ids absent', async () => {
    const t = convexTest(schema, modules)
    const ada = await t
      .withIdentity({ subject: 'clerk_ada' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT_DOB }),
      )
    const bob = await t
      .withIdentity({ subject: 'clerk_bob' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Bob', username: 'bob', dateOfBirth: ADULT_DOB }),
      )
    // A valid id for a profile that no longer exists — simply omitted from the result.
    const ghost = await t
      .withIdentity({ subject: 'clerk_ghost' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ghost', username: 'ghost', dateOfBirth: ADULT_DOB }),
      )
    await t.run((ctx) => ctx.db.delete(ghost))

    const result = await t.query(api.profiles.publicByIds, { profileIds: [ada, bob, ada, ghost] })
    expect(result[ada]).toEqual({ username: 'ada', displayName: 'Ada Lovelace' })
    expect(result[bob]).toEqual({ username: 'bob', displayName: 'Bob' })
    expect(result[ghost]).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(2)
  })
})
