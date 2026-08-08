import { isMinor, RISK_ACK_VERSION } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

// Vite-glob of every function module, handed to convex-test (required in a monorepo
// where the convex dir isn't the Vite project root).
const modules = import.meta.glob('./**/*.*s');

// Every provisioning call must carry a current assumption-of-risk acknowledgment (D45);
// this fills the version so each test only spells out what it's actually exercising. The
// acceptance *time* is stamped server-side, so it's not an argument.
const withAck = <T extends object>(args: T) => ({
  riskAckVersion: RISK_ACK_VERSION,
  ...args,
});

// Dates of birth relative to the current year, so age math (which uses Date.now()) is
// stable regardless of when the suite runs. Born Jan 1 → the age holds all year.
const nowYear = new Date().getUTCFullYear();
const ADULT_DOB = Date.UTC(nowYear - 40, 0, 1); // ~40 → adult
const MINOR_DOB = Date.UTC(nowYear - 17, 0, 1); // 17 → minor
const UNDER_16_DOB = Date.UTC(nowYear - 10, 0, 1); // 10 → under the hard 16 gate

describe('profiles.upsertFromClerk', () => {
  test('throws when unauthenticated', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
      ),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('provisions a member profile from the Clerk identity with sane defaults', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });

    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );

    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?._id).toEqual(id);
    expect(profile?.clerkUserId).toBe('clerk_ada');
    expect(profile?.dateOfBirth).toBe(ADULT_DOB);
    expect(profile?.role).toBe('member');
    expect(profile?.status).toBe('active');
    expect(profile?.reputationPoints).toBe(0);
    expect(profile?.driveTimePrefMinutes).toBe(60);
    expect(profile?.profileVisibility).toBe('public');
    expect(profile?.notificationPrefs.hazardConfirmation).toBe(true);
  });

  test('records a current, server-stamped assumption-of-risk acknowledgment (D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });

    const before = Date.now();
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );

    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.riskAckVersion).toBe(RISK_ACK_VERSION);
    // Stamped by the server at write time (never a client-supplied clock), so it lands
    // within the window of this call rather than being any injectable value.
    expect(profile?.riskAckAt).toBeGreaterThanOrEqual(before);
    expect(profile?.riskAckAt).toBeLessThanOrEqual(Date.now());
  });

  test('rejects a stale or missing risk acknowledgment (D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
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
    ).rejects.toThrow(/assumption-of-risk/i);
    // No profile should have been provisioned.
    expect(await asAda.query(api.profiles.current, {})).toBeNull();
  });

  test('preserves the recorded acceptance time across a same-version re-sync (D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );
    // Pin a known acceptance time, then re-sync with the SAME version: the original must
    // be kept (only a version bump re-stamps), and never restamped to "now".
    const pinnedAt = Date.UTC(2020, 0, 1);
    await t.run((ctx) => ctx.db.patch(id, { riskAckAt: pinnedAt }));
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );

    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.riskAckAt).toBe(pinnedAt);
  });

  test('re-acking after a version bump re-stamps the acceptance time (D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );
    // Simulate a stale acceptance under an older version (as if RISK_ACK_VERSION was bumped).
    await t.run((ctx) =>
      ctx.db.patch(id, { riskAckVersion: '1970-01-01', riskAckAt: Date.UTC(2020, 0, 1) }),
    );

    const before = Date.now();
    // Accepting the current version again re-stamps the time server-side.
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );

    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.riskAckVersion).toBe(RISK_ACK_VERSION);
    expect(profile?.riskAckAt).toBeGreaterThanOrEqual(before);
  });

  test('is idempotent — a second call patches the same profile', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });

    const first = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );
    const second = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT_DOB }),
    );

    expect(second).toEqual(first);
    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.displayName).toBe('Ada Lovelace');

    const rows = await t.run((ctx) => ctx.db.query('profiles').collect());
    expect(rows).toHaveLength(1);
  });

  test('rejects an under-16 date of birth (hard 16+ gate, D41)', async () => {
    const t = convexTest(schema, modules);
    const asKid = t.withIdentity({ subject: 'clerk_kid' });
    await expect(
      asKid.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Kid', username: 'kid', dateOfBirth: UNDER_16_DOB }),
      ),
    ).rejects.toThrow(/16 years old/i);
    // No profile should have been provisioned.
    expect(await asKid.query(api.profiles.current, {})).toBeNull();
  });

  test('rejects a username already held by another user', async () => {
    const t = convexTest(schema, modules);
    await t
      .withIdentity({ subject: 'clerk_a' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'A', username: 'ada', dateOfBirth: ADULT_DOB }),
      );
    await expect(
      t
        .withIdentity({ subject: 'clerk_b' })
        .mutation(
          api.profiles.upsertFromClerk,
          withAck({ displayName: 'B', username: 'ada', dateOfBirth: ADULT_DOB }),
        ),
    ).rejects.toThrow(/already taken/i);
  });

  test('re-upsert keeping your own username is allowed', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );
    await expect(
      asAda.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ada L', username: 'ada', dateOfBirth: ADULT_DOB }),
      ),
    ).resolves.toBeDefined();
  });

  test('minors default to a private profile (D13/D41)', async () => {
    const t = convexTest(schema, modules);
    const asTeen = t.withIdentity({ subject: 'clerk_teen' });

    await asTeen.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: MINOR_DOB }),
    );

    const profile = await asTeen.query(api.profiles.current, {});
    expect(profile && isMinor(profile.dateOfBirth, Date.now())).toBe(true);
    expect(profile?.profileVisibility).toBe('private');
  });

  test('a minor who reaches adulthood keeps their private profile (D13/D41)', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: 'clerk_grows' });
    // Provisioned as a minor → forced private.
    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: MINOR_DOB }),
    );
    const asMinor = await asUser.query(api.profiles.current, {});
    expect(asMinor && isMinor(asMinor.dateOfBirth, Date.now())).toBe(true);
    expect(asMinor?.profileVisibility).toBe('private');

    // Reaching adulthood (here an adult DOB on the next sync) must NOT auto-widen the
    // private profile they held as a minor — it persists until they make it public themselves (D13).
    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: ADULT_DOB }),
    );
    const grown = await asUser.query(api.profiles.current, {});
    expect(grown && isMinor(grown.dateOfBirth, Date.now())).toBe(false);
    expect(grown?.profileVisibility).toBe('private');
  });

  test('an inactive account cannot rename or squat a username via the upsert (D37)', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: 'clerk_banned' });
    const id = await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Real Name', username: 'realname', dateOfBirth: ADULT_DOB }),
    );
    await t.run((ctx) => ctx.db.patch(id, { status: 'banned' }));

    // App-launch sync with changed fields is a no-op for an inactive account.
    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Evasion Name', username: 'newhandle', dateOfBirth: ADULT_DOB }),
    );
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile?.displayName).toBe('Real Name');
    expect(profile?.username).toBe('realname');

    // The attempted handle was never reserved — an active user can still claim it.
    const asOther = t.withIdentity({ subject: 'clerk_other' });
    await expect(
      asOther.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Other', username: 'newhandle', dateOfBirth: ADULT_DOB }),
      ),
    ).resolves.toBeDefined();
  });

  test('a deleted account keeps its scrubbed PII on re-sync (D33)', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: 'clerk_deleted' });
    const id = await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Jane Doe', username: 'jane', dateOfBirth: ADULT_DOB }),
    );
    // Simulate the D33 deletion scrub.
    await t.run((ctx) => ctx.db.patch(id, { status: 'deleted', displayName: 'deleted user' }));

    await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Jane Doe', username: 'jane', dateOfBirth: ADULT_DOB }),
    );
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile?.displayName).toBe('deleted user');
  });

  test('rejects a malformed or empty username (D37 trust boundary)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    for (const username of ['ab', '', 'ada lovelace', '_ada']) {
      await expect(
        asAda.mutation(
          api.profiles.upsertFromClerk,
          withAck({ displayName: 'Ada', username, dateOfBirth: ADULT_DOB }),
        ),
      ).rejects.toThrow(/username must be/i);
    }
    expect(await asAda.query(api.profiles.current, {})).toBeNull();
  });

  test('rejects a blank display name (D37 trust boundary)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await expect(
      asAda.mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: '   ', username: 'ada', dateOfBirth: ADULT_DOB }),
      ),
    ).rejects.toThrow(/display name is required/i);
    expect(await asAda.query(api.profiles.current, {})).toBeNull();
  });

  test('stores the normalized username + display name', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: '  Ada   Lovelace ', username: 'ADA_99', dateOfBirth: ADULT_DOB }),
    );
    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.username).toBe('ada_99');
    expect(profile?.displayName).toBe('Ada Lovelace');
  });

  test('username uniqueness is case-insensitive', async () => {
    const t = convexTest(schema, modules);
    await t
      .withIdentity({ subject: 'clerk_a' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'A', username: 'Ada', dateOfBirth: ADULT_DOB }),
      );
    await expect(
      t
        .withIdentity({ subject: 'clerk_b' })
        .mutation(
          api.profiles.upsertFromClerk,
          withAck({ displayName: 'B', username: 'ADA', dateOfBirth: ADULT_DOB }),
        ),
    ).rejects.toThrow(/already taken/i);
  });
});

describe('profiles.acceptCurrentRiskAck', () => {
  test('throws when unauthenticated', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('throws for an authenticated identity with no provisioned profile', async () => {
    const t = convexTest(schema, modules);
    const asGhost = t.withIdentity({ subject: 'clerk_ghost' });
    await expect(
      asGhost.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('refreshes a stale acknowledgment without touching other fields (D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    const id = await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT_DOB }),
    );
    // Simulate a stale acceptance under an older version (as if RISK_ACK_VERSION was bumped).
    await t.run((ctx) =>
      ctx.db.patch(id, { riskAckVersion: '1970-01-01', riskAckAt: Date.UTC(2020, 0, 1) }),
    );

    const before = Date.now();
    await asAda.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION });

    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.riskAckVersion).toBe(RISK_ACK_VERSION);
    expect(profile?.riskAckAt).toBeGreaterThanOrEqual(before);
    // The profile fields the user never re-entered are preserved as-is.
    expect(profile?.displayName).toBe('Ada Lovelace');
    expect(profile?.username).toBe('ada');
    expect(profile?.dateOfBirth).toBe(ADULT_DOB);
  });

  test('rejects a stale/non-current version (forces a fresh client build, D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await asAda.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB }),
    );
    await expect(
      asAda.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: '1970-01-01' }),
    ).rejects.toThrow(/assumption-of-risk/i);
  });

  test('a banned account cannot re-ack its way back in (D37)', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: 'clerk_banned' });
    const id = await asUser.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Real Name', username: 'realname', dateOfBirth: ADULT_DOB }),
    );
    await t.run((ctx) => ctx.db.patch(id, { status: 'banned' }));
    await expect(
      asUser.mutation(api.profiles.acceptCurrentRiskAck, { riskAckVersion: RISK_ACK_VERSION }),
    ).rejects.toThrow(/not active/i);
  });
});

describe('profiles.current', () => {
  test('returns null when unauthenticated', async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.profiles.current, {})).toBeNull();
  });

  test('returns null for an authenticated identity with no provisioned profile', async () => {
    const t = convexTest(schema, modules);
    const asGhost = t.withIdentity({ subject: 'clerk_ghost' });
    expect(await asGhost.query(api.profiles.current, {})).toBeNull();
  });
});

describe('profiles.publicByIds', () => {
  test('returns username + displayName keyed by id, deduped, missing ids absent', async () => {
    const t = convexTest(schema, modules);
    const ada = await t
      .withIdentity({ subject: 'clerk_ada' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT_DOB }),
      );
    const bob = await t
      .withIdentity({ subject: 'clerk_bob' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Bob', username: 'bob', dateOfBirth: ADULT_DOB }),
      );
    // A valid id for a profile that no longer exists — simply omitted from the result.
    const ghost = await t
      .withIdentity({ subject: 'clerk_ghost' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Ghost', username: 'ghost', dateOfBirth: ADULT_DOB }),
      );
    await t.run((ctx) => ctx.db.delete(ghost));

    const result = await t.query(api.profiles.publicByIds, { profileIds: [ada, bob, ada, ghost] });
    // Fresh accounts (0 points, just created) carry the cosmetic `new` trust class (D50).
    expect(result[ada]).toEqual({
      username: 'ada',
      displayName: 'Ada Lovelace',
      trustClass: 'new',
    });
    expect(result[bob]).toEqual({ username: 'bob', displayName: 'Bob', trustClass: 'new' });
    expect(result[ghost]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(2);
  });
});

/** Provision an adult profile via the real mutation path and return its id + identity handle. */
async function provision(
  t: ReturnType<typeof convexTest>,
  subject: string,
  username: string,
  dob = ADULT_DOB,
) {
  const as = t.withIdentity({ subject });
  const id = await as.mutation(
    api.profiles.upsertFromClerk,
    withAck({ displayName: username, username, dateOfBirth: dob }),
  );
  return { id, as };
}

describe('profiles.updateProfile (D13/D41)', () => {
  test('an adult can edit bio + town and toggle visibility', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await provision(t, 'clerk_a', 'ada');
    await as.mutation(api.profiles.updateProfile, {
      bio: '  loves black ice  ',
      homeTownLabel: '  Norwich,   VT ',
      profileVisibility: 'private',
    });
    const p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.bio).toBe('loves black ice'); // normalized
    expect(p?.homeTownLabel).toBe('Norwich, VT');
    expect(p?.profileVisibility).toBe('private');
  });

  test('clearing bio/town removes the field', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await provision(t, 'clerk_a', 'ada');
    await as.mutation(api.profiles.updateProfile, { bio: 'hi', homeTownLabel: 'Stowe' });
    await as.mutation(api.profiles.updateProfile, { bio: '', homeTownLabel: '   ' });
    const p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.bio).toBeUndefined();
    expect(p?.homeTownLabel).toBeUndefined();
  });

  test('a minor cannot set their profile public (D41)', async () => {
    const t = convexTest(schema, modules);
    // Minors provision as private; upsert forces it. updateProfile must refuse public.
    const { as } = await provision(t, 'clerk_teen', 'teen', MINOR_DOB);
    await expect(
      as.mutation(api.profiles.updateProfile, { profileVisibility: 'public' }),
    ).rejects.toThrow(/private profile/i);
  });

  test('rejects an over-long bio', async () => {
    const t = convexTest(schema, modules);
    const { as } = await provision(t, 'clerk_a', 'ada');
    await expect(as.mutation(api.profiles.updateProfile, { bio: 'a'.repeat(501) })).rejects.toThrow(
      /too long/i,
    );
  });
});

describe('profiles.getPublicProfile (D13)', () => {
  test('returns the full public payload with no PII, incl. visible report history', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await provision(t, 'clerk_a', 'ada');
    await as.mutation(api.profiles.updateProfile, {
      bio: 'ADK skater',
      homeTownLabel: 'Norwich, VT',
    });

    // Seed a visible + a hidden report so counts/history reflect moderation.
    const waterBodyId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Morey',
        searchText: 'Lake Morey',
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
    const mkReport = (moderationStatus: 'visible' | 'hidden') => {
      const now = Date.now();
      return t.run((ctx) =>
        ctx.db.insert('reports', {
          authorId: id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: now,
          reportTime: now,
          source: 'native' as const,
          iceTypes: ['black_ice' as const],
          surfaceTags: [],
          photoIds: [],
          moderationStatus,
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        }),
      );
    };
    await mkReport('visible');
    await mkReport('hidden');
    // The displayed #reports/#comments are the maintained counters, NOT this bounded history window —
    // patch counters that exceed the seeded rows to prove the payload reads the counter, not the list.
    await t.run((ctx) => ctx.db.patch(id, { reportCount: 7, commentCount: 3 }));

    const profile = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(profile).not.toBeNull();
    if (!profile || profile.private) throw new Error('expected public profile');
    expect(profile.bio).toBe('ADK skater');
    expect(profile.homeTownLabel).toBe('Norwich, VT');
    // The raw trust number is admin-only (D50) — omitted from the payload for an ordinary/anonymous
    // viewer so it never leaves the deployment; the class chip is the only public signal.
    expect(profile.reputationPoints).toBeUndefined();
    expect(profile.reportCount).toBe(7); // the maintained counter, not the window length
    expect(profile.commentCount).toBe(3);
    expect(profile.reports).toHaveLength(1); // history still the visible window (1 visible report)
    expect(profile.reports[0]?.waterBodyName).toBe('Lake Morey');
    // No PII leaks in the payload.
    expect(JSON.stringify(profile)).not.toContain('dateOfBirth');
    expect(JSON.stringify(profile)).not.toContain('homeCoord');

    // A moderator/admin viewer DOES receive the raw number (the admin-only surface, D50).
    const modId = await t
      .withIdentity({ subject: 'clerk_mod' })
      .mutation(
        api.profiles.upsertFromClerk,
        withAck({ displayName: 'Mod', username: 'mod', dateOfBirth: ADULT_DOB }),
      );
    await t.run((ctx) => ctx.db.patch(modId, { role: 'moderator' }));
    const modView = await t
      .withIdentity({ subject: 'clerk_mod' })
      .query(api.profiles.getPublicProfile, { username: 'ada' });
    if (!modView || modView.private) throw new Error('expected public profile');
    expect(modView.reputationPoints).toBe(0);
  });

  test('a private profile returns name + avatar only to others', async () => {
    const t = convexTest(schema, modules);
    const { as } = await provision(t, 'clerk_a', 'ada');
    await as.mutation(api.profiles.updateProfile, { bio: 'secret', profileVisibility: 'private' });
    await provision(t, 'clerk_v', 'viewer');

    const seen = await t
      .withIdentity({ subject: 'clerk_v' })
      .query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(seen).toMatchObject({ private: true, username: 'ada', displayName: 'ada' });
    expect(JSON.stringify(seen)).not.toContain('secret'); // bio not exposed
  });

  test('owner sees their own private profile in full', async () => {
    const t = convexTest(schema, modules);
    const { as } = await provision(t, 'clerk_a', 'ada');
    await as.mutation(api.profiles.updateProfile, { bio: 'mine', profileVisibility: 'private' });
    const own = await as.query(api.profiles.getPublicProfile, { username: 'ada' });
    if (!own || own.private) throw new Error('owner should see full profile');
    expect(own.bio).toBe('mine');
    expect(own.isSelf).toBe(true);
  });

  test('a bidirectional block hides the profile both ways (D32)', async () => {
    const t = convexTest(schema, modules);
    const a = await provision(t, 'clerk_a', 'ada');
    const b = await provision(t, 'clerk_b', 'bob');
    await a.as.mutation(api.blocks.block, { targetUserId: b.id });
    // a can't see b…
    expect(await a.as.query(api.profiles.getPublicProfile, { username: 'bob' })).toBeNull();
    // …and b can't see a (block hides both directions).
    expect(await b.as.query(api.profiles.getPublicProfile, { username: 'ada' })).toBeNull();
  });

  test('a deleted account is not found', async () => {
    const t = convexTest(schema, modules);
    const { id } = await provision(t, 'clerk_a', 'ada');
    await t.run((ctx) => ctx.db.patch(id, { status: 'deleted' }));
    expect(await t.query(api.profiles.getPublicProfile, { username: 'ada' })).toBeNull();
  });
});

describe('profiles.searchProfiles (D13)', () => {
  test('finds public profiles by name and excludes private ones', async () => {
    const t = convexTest(schema, modules);
    await provision(t, 'clerk_a', 'ada'); // displayName 'ada', public
    const b = await provision(t, 'clerk_b', 'bob');
    await b.as.mutation(api.profiles.updateProfile, { profileVisibility: 'private' });

    const forAda = await t.query(api.profiles.searchProfiles, { query: 'ada' });
    expect(forAda.map((r) => r.username)).toContain('ada');
    const forBob = await t.query(api.profiles.searchProfiles, { query: 'bob' });
    expect(forBob).toHaveLength(0); // private → not searchable
  });

  test('empty query returns nothing', async () => {
    const t = convexTest(schema, modules);
    await provision(t, 'clerk_a', 'ada');
    expect(await t.query(api.profiles.searchProfiles, { query: '   ' })).toHaveLength(0);
  });

  test('excludes profiles the viewer has blocked', async () => {
    const t = convexTest(schema, modules);
    const a = await provision(t, 'clerk_a', 'ada');
    const b = await provision(t, 'clerk_b', 'bob');
    await a.as.mutation(api.blocks.block, { targetUserId: b.id });
    const results = await a.as.query(api.profiles.searchProfiles, { query: 'bob' });
    expect(results).toHaveLength(0);
  });
});

describe('profiles.backfillNotificationPrefs', () => {
  // The positive branch (patching a row that lacks `reportCommented`) can't be exercised under
  // convex-test: schema validation forbids writing a row missing a required pref key, so every
  // seeded profile already has it. We assert the run is a safe no-op — profiles provisioned through
  // the mutation path already carry `reportCommented: true` via `DEFAULT_NOTIFICATION_PREFS`.
  test('is a no-op when every profile already has the key', async () => {
    const t = convexTest(schema, modules);
    await provision(t, 'clerk_a', 'ada');
    await provision(t, 'clerk_b', 'bob');
    const res = await t.mutation(internal.profiles.backfillNotificationPrefs, {});
    expect(res).toMatchObject({ patched: 0, total: 2, isDone: true }); // paginated (N1)
    const p = await t.withIdentity({ subject: 'clerk_a' }).query(api.profiles.current, {});
    expect(p?.notificationPrefs.reportCommented).toBe(true); // default-on (D16)
  });
});

// --- Phase 4: drive-time home, feed-filter prefs, notification prefs ---

/** Provision an adult profile and return an identity-bound test client. */
async function provisionAdult(t: ReturnType<typeof convexTest>, subject = 'clerk_p4') {
  const asUser = t.withIdentity({ subject });
  await asUser.mutation(
    api.profiles.upsertFromClerk,
    withAck({ displayName: 'P4', username: subject, dateOfBirth: ADULT_DOB }),
  );
  return asUser;
}

describe('profiles.setHome', () => {
  test('stores the private home coord and schedules an isochrone recompute', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await asUser.mutation(api.profiles.setHome, { homeCoord: { lat: 44, lng: -72 } });
    const p = await asUser.query(api.profiles.current, {});
    expect(p?.homeCoord).toEqual({ lat: 44, lng: -72 });
    // A recompute is scheduled (the action itself — ORS + storeBands — is covered in isochrones.test).
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.some((f) => f.name.includes('isochrones'))).toBe(true);
  });

  test('clears the home when passed no coord', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await asUser.mutation(api.profiles.setHome, { homeCoord: { lat: 44, lng: -72 } });
    await asUser.mutation(api.profiles.setHome, {});
    const p = await asUser.query(api.profiles.current, {});
    expect(p?.homeCoord).toBeUndefined();
  });

  test('rejects an invalid coordinate', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await expect(
      asUser.mutation(api.profiles.setHome, { homeCoord: { lat: 200, lng: 0 } }),
    ).rejects.toThrow(/not valid/i);
  });
});

describe('profiles.setFeedFilterPrefs', () => {
  test('sanitizes and stores the filter blob', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await asUser.mutation(api.profiles.setFeedFilterPrefs, {
      filters: {
        radiusMinutes: 60,
        qualityFloor: 'good',
        iceTypes: ['black_ice', 'junk'],
        bogus: 1,
      },
    });
    const p = await asUser.query(api.profiles.current, {});
    expect(p?.feedFilterPrefs).toEqual({
      radiusMinutes: 60,
      qualityFloor: 'good',
      iceTypes: ['black_ice'],
    });
  });

  test('clears the stored prefs when the sanitized blob is empty', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await asUser.mutation(api.profiles.setFeedFilterPrefs, { filters: { radiusMinutes: 60 } });
    await asUser.mutation(api.profiles.setFeedFilterPrefs, { filters: { nonsense: true } });
    const p = await asUser.query(api.profiles.current, {});
    expect(p?.feedFilterPrefs).toBeUndefined();
  });
});

describe('profiles.setNotificationPrefs', () => {
  test('merges a partial toggle patch and sets the two radii', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await asUser.mutation(api.profiles.setNotificationPrefs, {
      prefs: { nearbyReportDigest: true, greatReportNearby: true },
      allRadiusMinutes: 30,
      greatRadiusMinutes: 60,
    });
    const p = await asUser.query(api.profiles.current, {});
    expect(p?.notificationPrefs.nearbyReportDigest).toBe(true);
    expect(p?.notificationPrefs.favoriteReport).toBe(true); // untouched key preserved
    expect(p?.allRadiusMinutes).toBe(30);
    expect(p?.greatRadiusMinutes).toBe(60);
  });

  test('enforces the great radius ≥ the all radius (X₂ ≥ X₁)', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await expect(
      asUser.mutation(api.profiles.setNotificationPrefs, {
        allRadiusMinutes: 90,
        greatRadiusMinutes: 30,
      }),
    ).rejects.toThrow(/at least the all-reports radius/i);
  });

  test('enforces X₂ ≥ X₁ against the already-stored radius too', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await asUser.mutation(api.profiles.setNotificationPrefs, { allRadiusMinutes: 90 });
    // Now lowering only the great radius below the stored all radius must fail.
    await expect(
      asUser.mutation(api.profiles.setNotificationPrefs, { greatRadiusMinutes: 60 }),
    ).rejects.toThrow(/at least the all-reports radius/i);
  });

  test('rejects a non-band radius value', async () => {
    const t = convexTest(schema, modules);
    const asUser = await provisionAdult(t);
    await expect(
      asUser.mutation(api.profiles.setNotificationPrefs, { allRadiusMinutes: 45 }),
    ).rejects.toThrow(/30, 60, or 90/i);
  });
});

describe('profiles.backfillContributionCounts', () => {
  test('seeds counters from an author’s visible reports + comments, idempotently', async () => {
    const t = convexTest(schema, modules);
    const { id } = await provision(t, 'clerk_a', 'ada');

    const waterBodyId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Lake Morey',
        searchText: 'Lake Morey',
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
    const mkReport = (moderationStatus: 'visible' | 'hidden') => {
      const now = Date.now();
      return t.run((ctx) =>
        ctx.db.insert('reports', {
          authorId: id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: now,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus,
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        }),
      );
    };
    const visibleReport = await mkReport('visible');
    await mkReport('visible');
    await mkReport('hidden'); // excluded from the count
    await t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId: visibleReport,
        authorId: id,
        body: 'nice',
        source: 'native' as const,
        moderationStatus: 'visible' as const,
        createdAt: Date.now(),
      }),
    );

    const res = await t.mutation(internal.profiles.backfillContributionCounts, {});
    expect(res.patched).toBe(1);
    const p = await t.run((ctx) => ctx.db.get(id));
    expect(p?.reportCount).toBe(2); // two visible, hidden excluded
    expect(p?.commentCount).toBe(1);

    // Idempotent — a second run rewrites the same totals and patches nothing.
    expect((await t.mutation(internal.profiles.backfillContributionCounts, {})).patched).toBe(0);
  });
});
