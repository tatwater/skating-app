import {
  CONSENT_REFUSAL_MESSAGES,
  type ConsentRefusalCode,
  DELETED_DISPLAY_NAME,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  TERMS,
  TERMS_SHA256,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { NOTIFICATION_PREF_DEFAULTS } from './lib/enums';
import schema from './schema';

// Vite-glob of every function module, handed to convex-test (required in a monorepo
// where the convex dir isn't the Vite project root).
const modules = import.meta.glob('./**/*.*s');

type Caller = ReturnType<ReturnType<typeof convexTest>['withIdentity']>;
type AccountFields = { displayName: string; username: string; dateOfBirth: number };

const TERMS_CLAIM = { termsVersion: TERMS.version, termsHash: TERMS_SHA256 };

/** The terms opened and read to the end, as the reader stamps them. */
async function readTerms(as: Caller) {
  await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
  await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' });
}

/** *Record acceptance*, with the Account step's fields when there are any. */
function acceptTerms(as: Caller, account?: AccountFields) {
  return as.mutation(api.consent.acceptTerms, {
    ...TERMS_CLAIM,
    privacyVersion: PRIVACY_NOTICE_VERSION,
    privacyHash: PRIVACY_NOTICE_SHA256,
    surface: 'web',
    ...(account !== undefined ? { account } : {}),
  });
}

/**
 * **The way in** (D298): the terms read to the end, then accepted with the Account step's fields —
 * the one path that creates (or re-introduces) a profile. Returns the profile's id.
 */
async function onboard(as: Caller, account: AccountFields): Promise<Id<'profiles'>> {
  await readTerms(as);
  await acceptTerms(as, account);
  const profile = await as.query(api.profiles.current, {});
  if (profile === null) throw new Error('the acceptance made no profile');
  return profile._id;
}

/** A refusal's code (`ConvexError({ code, message })`), with core's words checked. */
async function refusedWith(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConvexError);
  const data = (err as ConvexError<{ code?: string; message?: string }>).data;
  if (typeof data === 'object' && data !== null && data.code !== undefined) {
    if (data.code in CONSENT_REFUSAL_MESSAGES && data.code !== 'username_cooldown') {
      expect(data.message).toBe(CONSENT_REFUSAL_MESSAGES[data.code as ConsentRefusalCode]);
    }
    return data.code;
  }
  return undefined;
}

// Dates of birth relative to the current year, so age math (which uses Date.now()) is
// stable regardless of when the suite runs. Born Jan 1 → the age holds all year.
const nowYear = new Date().getUTCFullYear();
const ADULT_DOB = Date.UTC(nowYear - 40, 0, 1); // ~40 → adult
const MINOR_DOB = Date.UTC(nowYear - 17, 0, 1); // 17 → minor, and under the hard 18 gate (D294)

/**
 * **What `profiles.upsertFromClerk` held, through the acceptance that replaced it** (D295, D298).
 * `upsertFromClerk` was the onboarding write until B03 §9; `consent.acceptTerms` is now the only
 * thing that creates or re-introduces a profile, so every guarantee the old suite pinned is pinned
 * here against it: the defaults, the server's stamps, the 18+ gate, the name and username rules, the
 * Clerk mirrors (onboarding is the first of the three places a claim is written), the inactive and
 * deleted rows left untouched, the People row. Clocks pinned (D243).
 */
describe('onboarding through consent.acceptTerms (the guarantees upsertFromClerk held)', () => {
  /** Tuesday 24 November 2026, 15:00 UTC. */
  const T0 = Date.UTC(2026, 10, 24, 15);
  const ADULT = Date.UTC(1986, 0, 1);
  const SEVENTEEN = Date.UTC(2009, 0, 1);
  const TEN = Date.UTC(2016, 0, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('throws when unauthenticated', async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.consent.acceptTerms, {
        ...TERMS_CLAIM,
        privacyVersion: PRIVACY_NOTICE_VERSION,
        privacyHash: PRIVACY_NOTICE_SHA256,
        surface: 'web',
        account: { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT },
      }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('provisions a member profile from the Clerk identity with sane defaults', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    const id = await onboard(asAda, { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT });
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile).toMatchObject({
      clerkUserId: 'clerk_ada',
      dateOfBirth: ADULT,
      role: 'member',
      status: 'active',
      reputationPoints: 0,
      reportCount: 0,
      commentCount: 0,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIFICATION_PREF_DEFAULTS,
    });
    // Stamped by the server as the acceptance lands (the harness's clock may tick within it).
    expect(profile?.createdAt).toBeGreaterThanOrEqual(T0);
    expect(profile?.createdAt).toBe(profile?.termsAcceptedAt);
  });

  test('stamps the acceptance on the server, never from the client (was the risk acknowledgment, D45)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await readTerms(asAda);
    vi.setSystemTime(T0 + 5_000);
    await acceptTerms(asAda, { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT });
    const profile = await asAda.query(api.profiles.current, {});
    expect(profile).toMatchObject({ termsVersion: TERMS.version, termsAcceptedAt: T0 + 5_000 });
    // The retired acknowledgment is never written again (D295): the schema keeps it, unread.
    expect(profile?.riskAckVersion).toBeUndefined();
    expect(profile?.riskAckAt).toBeUndefined();
  });

  test('rejects words other than the current terms, and provisions nothing', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await readTerms(asAda);
    const stale = asAda.mutation(api.consent.acceptTerms, {
      termsVersion: '1970-01-01',
      termsHash: TERMS_SHA256,
      privacyVersion: PRIVACY_NOTICE_VERSION,
      privacyHash: PRIVACY_NOTICE_SHA256,
      surface: 'web',
      account: { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT },
    });
    expect(await refusedWith(stale)).toBe('terms_changed');
    expect(await asAda.query(api.profiles.current, {})).toBeNull();
  });

  test('a second acceptance keeps the one row and its first record as it was', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    const id = await onboard(asAda, { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT });
    // A live account brings no Account fields: it can't re-run onboarding to rename itself.
    await readTerms(asAda);
    expect(
      await refusedWith(
        acceptTerms(asAda, { displayName: 'Ada Lovelace', username: 'ada', dateOfBirth: ADULT }),
      ),
    ).toBe('account_unexpected');
    vi.setSystemTime(T0 + 60_000);
    await acceptTerms(asAda);
    const rows = await t.run((ctx) => ctx.db.query('profiles').collect());
    expect(rows.map((r) => r._id)).toEqual([id]);
    expect(rows[0]).toMatchObject({ displayName: 'Ada', termsAcceptedAt: T0 + 60_000 });
    const records = await t.run((ctx) => ctx.db.query('consentRecords').collect());
    expect(records.map((r) => r.context)).toEqual(['first_run', 'version_change']);
    expect(records[1]?.recordedAt).toBe(T0 + 60_000);
    // The first record's stamp is its own, untouched by the second (each acceptance is a record).
    expect(records[0]?.recordedAt).toBeLessThan(T0 + 60_000);
  });

  test('rejects an under-18 date of birth (hard 18+ gate, D41/D294)', async () => {
    const t = convexTest(schema, modules);
    // A 17-year-old, whom D41's 16 admitted read-only, and a child: neither gets an account.
    for (const [subject, dateOfBirth] of [
      ['clerk_teen', SEVENTEEN],
      ['clerk_kid', TEN],
    ] as const) {
      const asYoung = t.withIdentity({ subject });
      await readTerms(asYoung);
      expect(
        await refusedWith(
          acceptTerms(asYoung, { displayName: 'Young', username: subject, dateOfBirth }),
        ),
      ).toBe('underage');
      expect(await asYoung.query(api.profiles.current, {})).toBeNull();
    }
    expect(await t.run((ctx) => ctx.db.query('profiles').collect())).toHaveLength(0);
  });

  test('an under-18 row from before the 18+ gate cannot re-run onboarding (D294)', async () => {
    const t = convexTest(schema, modules);
    // The row D41's 16 would have written, as a live account and as a canceled deletion's.
    for (const [subject, emptied] of [
      ['clerk_teen', false],
      ['clerk_teen_back', true],
    ] as const) {
      const as = t.withIdentity({ subject });
      const id = await t.run((ctx) =>
        ctx.db.insert('profiles', {
          clerkUserId: subject,
          displayName: emptied ? DELETED_DISPLAY_NAME : 'teen',
          username: subject.replace('clerk_', ''),
          dateOfBirth: SEVENTEEN,
          driveTimePrefMinutes: 60,
          profileVisibility: 'private',
          notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: T0 - 400 * 24 * 60 * 60 * 1000,
        }),
      );
      await readTerms(as);
      const again = { displayName: 'Teen Again', username: 'teen_again', dateOfBirth: SEVENTEEN };
      expect(await refusedWith(acceptTerms(as, again))).toBe(
        emptied ? 'underage' : 'account_unexpected',
      );
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row?.displayName).toBe(emptied ? DELETED_DISPLAY_NAME : 'teen');
      expect(row?.profileVisibility).toBe('private');
    }
  });

  test('rejects a username already held by another user, case-insensitively', async () => {
    const t = convexTest(schema, modules);
    await onboard(t.withIdentity({ subject: 'clerk_a' }), {
      displayName: 'A',
      username: 'Ada',
      dateOfBirth: ADULT,
    });
    const asB = t.withIdentity({ subject: 'clerk_b' });
    await readTerms(asB);
    for (const username of ['ada', 'ADA']) {
      expect(
        await refusedWith(acceptTerms(asB, { displayName: 'B', username, dateOfBirth: ADULT })),
      ).toBe('username_taken');
    }
    expect(await asB.query(api.profiles.current, {})).toBeNull();
  });

  test('re-introducing a canceled deletion under its own username is no rename', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    const id = await onboard(asAda, { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT });
    await t.run((ctx) =>
      ctx.db.patch(id, { displayName: DELETED_DISPLAY_NAME, usernameChangedAt: T0 - 1000 }),
    );
    await readTerms(asAda);
    await acceptTerms(asAda, { displayName: 'Ada L', username: 'ada', dateOfBirth: ADULT });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      displayName: 'Ada L',
      username: 'ada',
      // Not a rename: the cooldown neither refused it nor restarted.
      usernameChangedAt: T0 - 1000,
    });
  });

  test('an inactive or deleted account cannot rename, squat a username or un-scrub (D37, D33)', async () => {
    const t = convexTest(schema, modules);
    for (const [subject, status] of [
      ['clerk_banned', 'banned'],
      ['clerk_deleted', 'deleted'],
    ] as const) {
      const as = t.withIdentity({ subject, email: `${status}@example.test` });
      const id = await onboard(as, {
        displayName: 'Real Name',
        username: `real_${status}`,
        dateOfBirth: ADULT,
      });
      // Simulate the moderation, or the D33 scrub.
      await t.run((ctx) =>
        ctx.db.patch(id, {
          status,
          ...(status === 'deleted' ? { displayName: 'deleted user', email: undefined } : {}),
        }),
      );
      // A reading as one left from before the gate closed (a locked-out caller can't open one now).
      await t.run((ctx) =>
        ctx.db.insert('termsReadings', {
          clerkUserId: subject,
          termsVersion: TERMS.version,
          openedAt: T0 - 60_000,
          reachedEndAt: T0 - 30_000,
          reachedEndVia: 'inline',
          surface: 'web',
        }),
      );
      await expect(acceptTerms(as)).rejects.toThrow(/not active/i);
      await expect(
        acceptTerms(as, { displayName: 'Evasion', username: `new_${status}`, dateOfBirth: ADULT }),
      ).rejects.toThrow(/not active/i);
      const profile = await t.run((ctx) => ctx.db.get(id));
      expect(profile?.displayName).toBe(status === 'deleted' ? 'deleted user' : 'Real Name');
      expect(profile?.username).toBe(`real_${status}`);
      expect(profile?.email).toBe(status === 'deleted' ? undefined : `${status}@example.test`);
    }
    // The attempted handles were never reserved: an active user can still claim them.
    await onboard(t.withIdentity({ subject: 'clerk_other' }), {
      displayName: 'Other',
      username: 'new_banned',
      dateOfBirth: ADULT,
    });
  });

  test('rejects a malformed or empty username, and a blank name (D37 trust boundary)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await readTerms(asAda);
    for (const username of ['ab', '', 'ada lovelace', '_ada']) {
      expect(
        await refusedWith(acceptTerms(asAda, { displayName: 'Ada', username, dateOfBirth: ADULT })),
      ).toBe('username_invalid');
    }
    expect(
      await refusedWith(
        acceptTerms(asAda, { displayName: '   ', username: 'ada', dateOfBirth: ADULT }),
      ),
    ).toBe('name_invalid');
    expect(await asAda.query(api.profiles.current, {})).toBeNull();
  });

  test('stores the normalized username + display name', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await onboard(asAda, {
      displayName: '  Ada   Lovelace ',
      username: 'ADA_99',
      dateOfBirth: ADULT,
    });
    const profile = await asAda.query(api.profiles.current, {});
    expect(profile?.username).toBe('ada_99');
    expect(profile?.displayName).toBe('Ada Lovelace');
  });

  test('mirrors the Clerk claims it is given: the email and the avatar (first of three writers)', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({
      subject: 'clerk_ada',
      email: 'ada@example.test',
      pictureUrl: 'https://img.clerk.com/ada',
    });
    const id = await onboard(asAda, { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      email: 'ada@example.test',
      profileImageUrl: 'https://img.clerk.com/ada',
    });
    // An avatar URL past the cap is not stored: the person shows initials, and the row still lands.
    const asLong = t.withIdentity({
      subject: 'clerk_long',
      pictureUrl: `https://img.clerk.com/${'x'.repeat(5000)}`,
    });
    const longId = await onboard(asLong, {
      displayName: 'Lo',
      username: 'longpic',
      dateOfBirth: ADULT,
    });
    expect((await t.run((ctx) => ctx.db.get(longId)))?.profileImageUrl).toBeUndefined();
    // No claims: no mirrors, and nothing invented.
    const bareId = await onboard(t.withIdentity({ subject: 'clerk_bare' }), {
      displayName: 'Bare',
      username: 'bare',
      dateOfBirth: ADULT,
    });
    const bare = await t.run((ctx) => ctx.db.get(bareId));
    expect(bare?.email).toBeUndefined();
    expect(bare?.profileImageUrl).toBeUndefined();
  });

  test('re-introducing refreshes the mirrors from present claims and leaves unmapped ones alone', async () => {
    const t = convexTest(schema, modules);
    const id = await onboard(t.withIdentity({ subject: 'clerk_back' }), {
      displayName: 'Back',
      username: 'back',
      dateOfBirth: ADULT,
    });
    // A canceled deletion's emptied row, with a mirror the deletion happened to leave.
    await t.run((ctx) =>
      ctx.db.patch(id, {
        displayName: DELETED_DISPLAY_NAME,
        profileVisibility: 'private',
        email: 'kept@example.test',
        profileImageUrl: 'https://img.clerk.com/old',
      }),
    );
    // A token with an over-long avatar and no email claim.
    const asBack = t.withIdentity({
      subject: 'clerk_back',
      pictureUrl: `https://img.clerk.com/${'x'.repeat(5000)}`,
    });
    await readTerms(asBack);
    await acceptTerms(asBack, { displayName: 'Back Again', username: 'back', dateOfBirth: ADULT });
    const profile = await t.run((ctx) => ctx.db.get(id));
    // The unmapped email stays; a claim present but past the cap clears the old avatar.
    expect(profile?.email).toBe('kept@example.test');
    expect(profile?.profileImageUrl).toBeUndefined();
    // And the People row follows the re-introduced name.
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', id))
        .first(),
    );
    expect(row?.displayName).toBe('Back Again');
  });
});

describe('profiles.syncFromClerk', () => {
  const onboardAda = (t: ReturnType<typeof convexTest>, subject: string) =>
    onboard(t.withIdentity({ subject }), {
      displayName: 'Ada',
      username: 'ada',
      dateOfBirth: ADULT_DOB,
    });

  test('is a no-op without an identity or a profile', async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(api.profiles.syncFromClerk, {})).toBeNull();
    expect(
      await t.withIdentity({ subject: 'clerk_nobody' }).mutation(api.profiles.syncFromClerk, {}),
    ).toBeNull();
  });

  test('backfills the email and avatar mirrors a profile onboarded without them', async () => {
    const t = convexTest(schema, modules);
    // Onboarded from a token that carried neither claim — every pre-A08 profile on dev.
    const id = await onboardAda(t, 'clerk_ada');
    expect((await t.run((ctx) => ctx.db.get(id)))?.email).toBeUndefined();

    await t
      .withIdentity({ subject: 'clerk_ada', email: 'ada@example.com', pictureUrl: 'https://img/1' })
      .mutation(api.profiles.syncFromClerk, {});
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile?.email).toBe('ada@example.com');
    expect(profile?.profileImageUrl).toBe('https://img/1');
  });

  test('follows a changed Clerk email — the case the sender’s cached fallback cannot', async () => {
    const t = convexTest(schema, modules);
    const id = await onboardAda(t, 'clerk_ada');
    await t.run((ctx) => ctx.db.patch(id, { email: 'old@example.com' }));

    await t
      .withIdentity({ subject: 'clerk_ada', email: 'new@example.com' })
      .mutation(api.profiles.syncFromClerk, {});
    expect((await t.run((ctx) => ctx.db.get(id)))?.email).toBe('new@example.com');
  });

  test('an unmapped claim leaves the mirror alone rather than clearing it', async () => {
    const t = convexTest(schema, modules);
    const id = await onboardAda(t, 'clerk_ada');
    await t.run((ctx) =>
      ctx.db.patch(id, { email: 'ada@example.com', profileImageUrl: 'https://img/1' }),
    );

    await t.withIdentity({ subject: 'clerk_ada' }).mutation(api.profiles.syncFromClerk, {});
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile?.email).toBe('ada@example.com');
    expect(profile?.profileImageUrl).toBe('https://img/1');
  });

  test('a still-cached pre-change token cannot roll the webhook’s newer address back', async () => {
    // Clerk caches a template token for about a minute; a remount in that window runs this sync
    // on claims from *before* the change the webhook already applied. The `updated_at` claim is
    // what tells the two apart.
    const t = convexTest(schema, modules);
    const id = await onboardAda(t, 'clerk_ada');
    const t1 = 1_700_000_000_000;
    await t.mutation(internal.profiles.applyClerkMirrors, {
      clerkUserId: 'clerk_ada',
      email: 'new@example.com',
      updatedAt: t1 + 5_000,
    });
    // The stale token, three accepted spellings of the claim, all older than the webhook's stamp.
    for (const updatedAt of [
      String(t1),
      new Date(t1).toISOString(),
      String(Math.floor(t1 / 1000)),
    ]) {
      await t
        .withIdentity({ subject: 'clerk_ada', email: 'old@example.com', updatedAt })
        .mutation(api.profiles.syncFromClerk, {});
      expect((await t.run((ctx) => ctx.db.get(id)))?.email).toBe('new@example.com');
    }
    // A fresh token, minted after the change, agrees with the webhook and may write.
    await t
      .withIdentity({
        subject: 'clerk_ada',
        email: 'newer@example.com',
        updatedAt: String(t1 + 9_000),
      })
      .mutation(api.profiles.syncFromClerk, {});
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      email: 'newer@example.com',
      clerkUpdatedAt: t1 + 9_000,
    });
    // A token with no stamp (an older template) applies as before and leaves the stamp alone.
    await t
      .withIdentity({ subject: 'clerk_ada', email: 'unstamped@example.com' })
      .mutation(api.profiles.syncFromClerk, {});
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      email: 'unstamped@example.com',
      clerkUpdatedAt: t1 + 9_000,
    });
  });

  test('never un-scrubs a ghost or an inactive account (D62 / D33)', async () => {
    const t = convexTest(schema, modules);
    const withClaims = {
      subject: 'clerk_ada',
      email: 'ada@example.com',
      pictureUrl: 'https://img/1',
    };
    const id = await onboardAda(t, 'clerk_ada');

    // A pending deletion: `status` stays active on purpose, the mirrors are cleared at the request.
    await t.run((ctx) =>
      ctx.db.patch(id, {
        deletionRequestedAt: Date.now(),
        email: undefined,
        profileImageUrl: undefined,
      }),
    );
    expect(await t.withIdentity(withClaims).mutation(api.profiles.syncFromClerk, {})).toBeNull();
    let profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile?.email).toBeUndefined();
    expect(profile?.profileImageUrl).toBeUndefined();

    // A suspension: no identity edits while inactive, as the acceptance refuses one too.
    await t.run((ctx) =>
      ctx.db.patch(id, {
        deletionRequestedAt: undefined,
        status: 'suspended',
        suspendedUntil: Date.now() + 60_000,
      }),
    );
    expect(await t.withIdentity(withClaims).mutation(api.profiles.syncFromClerk, {})).toBeNull();
    profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile?.email).toBeUndefined();
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
    const ada = await onboard(t.withIdentity({ subject: 'clerk_ada' }), {
      displayName: 'Ada Lovelace',
      username: 'ada',
      dateOfBirth: ADULT_DOB,
    });
    const bob = await onboard(t.withIdentity({ subject: 'clerk_bob' }), {
      displayName: 'Bob',
      username: 'bob',
      dateOfBirth: ADULT_DOB,
    });
    // A valid id for a profile that no longer exists — simply omitted from the result.
    const ghost = await onboard(t.withIdentity({ subject: 'clerk_ghost' }), {
      displayName: 'Ghost',
      username: 'ghost',
      dateOfBirth: ADULT_DOB,
    });
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
  const id = await onboard(as, { displayName: username, username, dateOfBirth: dob });
  return { id, as };
}

/**
 * An under-18 account: unreachable through onboarding since D294 raised the minimum to 18, so
 * this is the row D41's 16 would have written, patched in. The protections that key off
 * `isMinor` stay in force for any such row; `profilesMinorSignup.test.ts` proves onboarding
 * still applies them whenever the gate admits a minor.
 */
async function provisionMinor(t: ReturnType<typeof convexTest>, subject: string, username: string) {
  const { id, as } = await provision(t, subject, username);
  await t.run((ctx) => ctx.db.patch(id, { dateOfBirth: MINOR_DOB, profileVisibility: 'private' }));
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
    // A minor's profile is private; updateProfile must refuse public.
    const { as } = await provisionMinor(t, 'clerk_teen', 'teen');
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
      // Inside the one-Report Post every report has (A10 / D186) — the history is Posts now, and a
      // hidden one is hidden at both levels, as moderation leaves it.
      return t.run(async (ctx) => {
        const reportId = await ctx.db.insert('reports', {
          authorId: id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: now,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [{ type: 'black_ice' as const }],
          surfaceTags: [],
          photoIds: [],
          moderationStatus,
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        });
        const postId = await ctx.db.insert('posts', {
          authorId: id,
          reportIds: [reportId],
          photoIds: [],
          latestSkateEndTime: now,
          moderationStatus,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.patch(reportId, { postId });
        return reportId;
      });
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
    expect(profile.posts).toHaveLength(1); // history still the visible window (1 visible Post)
    expect(profile.posts[0]?.reports[0]?.bodyName).toBe('Lake Morey');
    // No PII leaks in the payload.
    expect(JSON.stringify(profile)).not.toContain('dateOfBirth');
    expect(JSON.stringify(profile)).not.toContain('homeCoord');

    // A moderator/admin viewer DOES receive the raw number (the admin-only surface, D50).
    const modId = await onboard(t.withIdentity({ subject: 'clerk_mod' }), {
      displayName: 'Mod',
      username: 'mod',
      dateOfBirth: ADULT_DOB,
    });
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
    expect(res).toMatchObject({ patched: 0, total: 2, isDone: true }); // paginated (A01)
    const p = await t.withIdentity({ subject: 'clerk_a' }).query(api.profiles.current, {});
    expect(p?.notificationPrefs.reportCommented).toBe(true); // default-on (D16)
  });
});

// --- Phase 04: drive-time home, feed-filter prefs, notification prefs ---

/** Provision an adult profile and return an identity-bound test client. */
async function provisionAdult(t: ReturnType<typeof convexTest>, subject = 'clerk_p4') {
  const asUser = t.withIdentity({ subject });
  await onboard(asUser, { displayName: 'P4', username: subject, dateOfBirth: ADULT_DOB });
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

describe('profiles.setShowPutInDefault', () => {
  test('remembers the report form switch; unset reads as shown', async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity({ subject: 'clerk_ada' });
    await onboard(asAda, { displayName: 'Ada', username: 'ada', dateOfBirth: ADULT_DOB });
    expect((await asAda.query(api.profiles.current, {}))?.showPutInDefault).toBeUndefined();

    await asAda.mutation(api.profiles.setShowPutInDefault, { showPutIn: false });
    expect((await asAda.query(api.profiles.current, {}))?.showPutInDefault).toBe(false);

    await asAda.mutation(api.profiles.setShowPutInDefault, { showPutIn: true });
    expect((await asAda.query(api.profiles.current, {}))?.showPutInDefault).toBe(true);
  });

  test('a ghost has nothing to seed — the mutation is contributor-gated (D62)', async () => {
    const t = convexTest(schema, modules);
    const asGhost = t.withIdentity({ subject: 'clerk_ghost' });
    await onboard(asGhost, { displayName: 'Ghost', username: 'ghost', dateOfBirth: ADULT_DOB });
    await asGhost.mutation(api.accountDeletion.requestDeletion, {});
    await expect(
      asGhost.mutation(api.profiles.setShowPutInDefault, { showPutIn: false }),
    ).rejects.toThrow();
  });
});

describe('profiles.getPublicProfile — the history read is bounded in Reports, not only Posts (D13)', () => {
  test('stops at the Post that would take the hydrated members past the budget', async () => {
    const t = convexTest(schema, modules);
    const { id } = await provision(t, 'clerk_prolific', 'prolific');
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
    // Six ten-Report Posts: 60 members against a 50-Report budget. The Post window alone would
    // hydrate all 60; the budget cuts the history at the fifth Post, on a Post boundary.
    const base = Date.UTC(2026, 0, 10);
    const seedPost = (index: number, members: number) =>
      t.run(async (ctx) => {
        const skateEndTime = base + index * 60_000;
        const reportIds = [];
        for (let i = 0; i < members; i++) {
          reportIds.push(
            await ctx.db.insert('reports', {
              authorId: id,
              waterBodyId,
              point: { lat: 0.5, lng: 0.5 },
              skateEndTime,
              reportTime: skateEndTime,
              source: 'native' as const,
              iceTypes: [{ type: 'black_ice' as const }],
              surfaceTags: [],
              photoIds: [],
              moderationStatus: 'visible' as const,
              hazardIdsCreated: [],
              createdAt: skateEndTime,
              updatedAt: skateEndTime,
            }),
          );
        }
        const postId = await ctx.db.insert('posts', {
          authorId: id,
          reportIds,
          photoIds: [],
          latestSkateEndTime: skateEndTime,
          moderationStatus: 'visible' as const,
          createdAt: skateEndTime,
          updatedAt: skateEndTime,
        });
        for (const reportId of reportIds) await ctx.db.patch(reportId, { postId });
      });
    for (let i = 0; i < 6; i++) await seedPost(i, 10);

    const profile = await t.query(api.profiles.getPublicProfile, { username: 'prolific' });
    if (!profile || profile.private) throw new Error('expected public profile');
    expect(profile.posts).toHaveLength(5);
    expect(profile.posts.reduce((n, p) => n + p.reports.length, 0)).toBe(50);
    // Newest first: the oldest Post is the one left out.
    expect(profile.posts[0]?.latestSkateEndTime).toBe(base + 5 * 60_000);
    expect(profile.posts.at(-1)?.latestSkateEndTime).toBe(base + 1 * 60_000);
  });
});
