/**
 * The way in's server (D295–D298, B03 §9.5): the reading, the acceptance that creates, re-introduces
 * or re-accepts, Know Before You Go and its season rule, the welcome steps, the receipt, and the two
 * retention sweeps. Every clock is pinned (D243); nothing here reads the wall clock.
 */

import {
  CONSENT_REFUSAL_MESSAGES,
  type ConsentRefusalCode,
  DELETED_DISPLAY_NAME,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_EARLY_MS,
  KNOW_BEFORE_YOU_GO_REPEAT_MS,
  KNOW_BEFORE_YOU_GO_SHA256,
  knowBeforeYouGoDue,
  meetsMinimumAge,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  TERMS,
  TERMS_SHA256,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { CONSENT_SWEEP_PAGE, LOOKUP_CAP, READING_TTL_MS } from './consent';
import { NOTIFICATION_PREF_DEFAULTS } from './lib/enums';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** Tuesday 24 November 2026, 15:00 UTC — the build's own day, pinned. */
const T0 = Date.UTC(2026, 10, 24, 15, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ADULT_DOB = Date.UTC(1990, 5, 15);

const TERMS_CLAIM = { termsVersion: TERMS.version, termsHash: TERMS_SHA256 };
const PRIVACY_CLAIM = {
  privacyVersion: PRIVACY_NOTICE_VERSION,
  privacyHash: PRIVACY_NOTICE_SHA256,
};
const QUESTIONS_CLAIM = { version: KNOW_BEFORE_YOU_GO.version, hash: KNOW_BEFORE_YOU_GO_SHA256 };
const ACCOUNT = { displayName: '  Ada   Lovelace ', username: 'Ada_L', dateOfBirth: ADULT_DOB };

function harness(now = T0) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  return convexTest(schema, modules);
}

type T = ReturnType<typeof harness>;

beforeEach(() => {
  // The two actions the acceptance schedules run in the teardown drain: keep them offline.
  vi.stubEnv('CLERK_SECRET_KEY', '');
  vi.stubEnv('RESEND_API_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A signed-in caller with a token that carries an email (`null`: a token without one). */
function caller(t: T, subject = 'user_ada', email: string | null = 'ada@example.test') {
  return t.withIdentity({ subject, ...(email !== null ? { email } : {}) });
}

/** Open the terms and reach their end, as the reader does. */
async function readToEnd(
  as: ReturnType<T['withIdentity']>,
  via: 'inline' | 'fullscreen' = 'inline',
) {
  await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
  await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via });
}

function accept(
  as: ReturnType<T['withIdentity']>,
  extra: Partial<{
    account: typeof ACCOUNT;
    userAgent: string;
    clientSessionId: string;
    termsHash: string;
    privacyHash: string;
  }> = {},
) {
  return as.mutation(api.consent.acceptTerms, {
    ...TERMS_CLAIM,
    ...PRIVACY_CLAIM,
    surface: 'web',
    ...extra,
  });
}

/** A profile row as the fixtures elsewhere write one: an account from before the terms existed. */
async function existingProfile(
  t: T,
  subject: string,
  extra: Partial<Doc<'profiles'>> = {},
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: 'Bea Old-Timer',
      username: subject.replace('user_', ''),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
      dateOfBirth: ADULT_DOB,
      // The retired acknowledgment (D45), as an account from before the terms carries it.
      riskAckVersion: '2026-07-11',
      riskAckAt: T0 - 100 * DAY,
      reputationPoints: 12,
      role: 'member',
      status: 'active',
      createdAt: T0 - 100 * DAY,
      ...extra,
    }),
  );
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConvexError);
  return (err as ConvexError<{ code?: string; message?: string }>).data;
}

async function expectRefusal(promise: Promise<unknown>, code: ConsentRefusalCode) {
  expect(await refusal(promise)).toEqual({ code, message: CONSENT_REFUSAL_MESSAGES[code] });
}

const records = (t: T) => t.run((ctx) => ctx.db.query('consentRecords').collect());
const readings = (t: T) => t.run((ctx) => ctx.db.query('termsReadings').collect());
const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

/** A season-watch row as `imageryIngest.recordSeasonOpen` writes one. */
function seasonRow(season: string, detectedAt: number) {
  return {
    season,
    opensOn: '2026-11-10',
    openedBy: ['sentinel'],
    winterFrom: null,
    sitesSampled: 3,
    detectedAt,
  };
}

describe('watchAnchor', () => {
  test('null before any season has opened', async () => {
    const t = harness();
    expect(await t.query(api.consent.watchAnchor, {})).toBeNull();
  });

  test("the newest live row's detectedAt, with its label; a superseded row never anchors", async () => {
    const t = harness();
    const admin = await existingProfile(t, 'user_admin');
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2025-26', T0 - 380 * DAY));
      await ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2024-25', T0 - 740 * DAY));
      // This winter's opening was reset: postponed, so it is not the anchor.
      await ctx.db.insert('imageryIngestSeasonsSuperseded', {
        ...seasonRow('winter-2026-27', T0 - 5 * DAY),
        supersededAt: T0 - 4 * DAY,
        supersededBy: admin,
      });
    });
    expect(await t.query(api.consent.watchAnchor, {})).toEqual({
      season: 'winter-2025-26',
      label: 'Winter 2025–26',
      openedAt: T0 - 380 * DAY,
    });
  });

  test('a row whose key is not a season label still anchors, under its own key', async () => {
    const t = harness();
    await t.run((ctx) => ctx.db.insert('imageryIngestSeasons', seasonRow('winter-x', T0)));
    expect(await t.query(api.consent.watchAnchor, {})).toEqual({
      season: 'winter-x',
      label: 'winter-x',
      openedAt: T0,
    });
  });
});

describe('the reading', () => {
  test('needs a signed-in identity', async () => {
    const t = harness();
    await expect(
      t.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test('opening stamps once: a second open keeps the first openedAt', async () => {
    const t = harness();
    const as = caller(t);
    await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'android' });
    vi.setSystemTime(T0 + 60_000);
    await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
    const [reading, ...more] = await readings(t);
    expect(more).toEqual([]);
    expect(reading).toMatchObject({
      clerkUserId: 'user_ada',
      termsVersion: TERMS.version,
      openedAt: T0,
      surface: 'android',
    });
    expect(reading?.reachedEndAt).toBeUndefined();
  });

  test('the end is stamped once, with the reader it was reached in', async () => {
    const t = harness();
    const as = caller(t);
    await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
    vi.setSystemTime(T0 + 90_000);
    await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'fullscreen' });
    vi.setSystemTime(T0 + 120_000);
    await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' });
    expect(await readings(t)).toMatchObject([
      { openedAt: T0, reachedEndAt: T0 + 90_000, reachedEndVia: 'fullscreen' },
    ]);
  });

  test('a banned or finalizing account gains no reading: one written after `erase` would outlive it', async () => {
    const t = harness();
    for (const status of ['banned', 'deleting'] as const) {
      const subject = `user_${status}`;
      await existingProfile(t, subject, { status });
      const as = caller(t, subject);
      await expect(
        as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' }),
      ).rejects.toThrow(/not active/i);
      await t.run((ctx) =>
        ctx.db.insert('termsReadings', {
          clerkUserId: subject,
          termsVersion: TERMS.version,
          openedAt: T0 - 60_000,
          surface: 'web',
        }),
      );
      await expect(
        as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' }),
      ).rejects.toThrow(/not active/i);
    }
    expect((await readings(t)).every((r) => r.reachedEndAt === undefined)).toBe(true);
    // Suspended and pending-deletion accounts still read (their acceptance refuses on its own).
    await existingProfile(t, 'user_susp', { status: 'suspended', suspendedUntil: T0 + DAY });
    await readToEnd(caller(t, 'user_susp'));
  });

  test('other words are refused, and the end needs an opening', async () => {
    const t = harness();
    const as = caller(t);
    await expectRefusal(
      as.mutation(api.consent.openTerms, {
        termsVersion: '2020-01-01',
        termsHash: TERMS_SHA256,
        surface: 'web',
      }),
      'terms_changed',
    );
    await expectRefusal(
      as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, termsHash: 'f00', via: 'inline' }),
      'terms_changed',
    );
    await expectRefusal(
      as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' }),
      'terms_not_opened',
    );
  });
});

describe('acceptTerms: a new account', () => {
  test('creates the profile with the defaults, the terms fields and the Home step', async () => {
    const t = harness();
    const as = t.withIdentity({
      subject: 'user_ada',
      email: 'ada@example.test',
      pictureUrl: 'https://img.clerk.com/ada',
    });
    await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
    vi.setSystemTime(T0 + 45_000);
    await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' });
    vi.setSystemTime(T0 + 60_000);
    const { recordId } = await accept(as, {
      account: ACCOUNT,
      userAgent: `  Mozilla/5.0 ${'x'.repeat(600)}`,
      clientSessionId: 'sess_abc123',
    });

    const profile = await as.query(api.profiles.current, {});
    expect(profile).toMatchObject({
      clerkUserId: 'user_ada',
      displayName: 'Ada Lovelace',
      username: 'ada_l',
      email: 'ada@example.test',
      profileImageUrl: 'https://img.clerk.com/ada',
      dateOfBirth: ADULT_DOB,
      profileVisibility: 'public',
      role: 'member',
      status: 'active',
      reputationPoints: 0,
      createdAt: T0 + 60_000,
      termsVersion: TERMS.version,
      termsAcceptedAt: T0 + 60_000,
      welcomeStep: 'home',
    });
    expect(profile?.knowBeforeYouGoAt).toBeUndefined();
    expect(profile?.riskAckVersion).toBeUndefined();

    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record).toMatchObject({
      kind: 'terms',
      profileId: profile?._id,
      clerkUserId: 'user_ada',
      identity: { fullName: 'Ada Lovelace', email: 'ada@example.test', dateOfBirth: ADULT_DOB },
      version: TERMS.version,
      contentHash: TERMS_SHA256,
      privacyVersion: PRIVACY_NOTICE_VERSION,
      privacyHash: PRIVACY_NOTICE_SHA256,
      context: 'first_run',
      openedAt: T0,
      reachedEndAt: T0 + 45_000,
      reachedEndVia: 'inline',
      recordedAt: T0 + 60_000,
      surface: { value: 'web', source: 'client_reported' },
      ipStatus: 'pending',
      copyEmail: { status: 'pending' },
    });
    // Client-reported, trimmed and capped at 512 characters.
    expect(record?.userAgent?.source).toBe('client_reported');
    expect(record?.userAgent?.value).toHaveLength(512);
    expect(record?.userAgent?.value.startsWith('Mozilla/5.0')).toBe(true);
    // The reading is consumed; its stamps live on in the record.
    expect(await readings(t)).toEqual([]);
    // The People row exists.
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', profile?._id as Id<'profiles'>))
        .first(),
    );
    expect(row?.username).toBe('ada_l');
  });

  test('schedules the IP capture and the emailed copy, with the session hints', async () => {
    const t = harness();
    const as = t.withIdentity({ subject: 'user_ada', sid: 'sess_fromtoken' });
    await readToEnd(as);
    const { recordId } = await accept(as, { account: ACCOUNT, clientSessionId: 'sess_client' });
    const jobs = (await scheduled(t)).filter((j) => j.state.kind === 'pending');
    expect(jobs.map((j) => [j.name, j.args[0]])).toEqual(
      expect.arrayContaining([
        [
          'consent:captureIp',
          {
            recordId,
            clerkUserId: 'user_ada',
            tokenSessionId: 'sess_fromtoken',
            clientSessionId: 'sess_client',
          },
        ],
        ['consent:sendTermsCopy', { recordId, clerkUserId: 'user_ada' }],
      ]),
    );
  });

  test('a session id that is not one is dropped before it can reach a request path', async () => {
    const t = harness();
    const as = caller(t);
    await readToEnd(as);
    const { recordId } = await accept(as, { account: ACCOUNT, clientSessionId: '../users/x' });
    const capture = (await scheduled(t)).find((j) => j.name === 'consent:captureIp');
    expect(capture?.args[0]).toEqual({ recordId, clerkUserId: 'user_ada' });
  });

  test('no email on the token: the record waits for the copy to find one', async () => {
    const t = harness();
    const as = caller(t, 'user_ada', null);
    await readToEnd(as);
    const { recordId } = await accept(as, { account: ACCOUNT, userAgent: '   ' });
    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record?.identity).toEqual({ fullName: 'Ada Lovelace', dateOfBirth: ADULT_DOB });
    // An empty user agent is no user agent.
    expect(record?.userAgent).toBeUndefined();
  });

  test('every refusal before a row exists', async () => {
    const t = harness();
    const as = caller(t);
    await expect(
      t.mutation(api.consent.acceptTerms, { ...TERMS_CLAIM, ...PRIVACY_CLAIM, surface: 'web' }),
    ).rejects.toThrow(/not authenticated/i);
    await expectRefusal(accept(as, { account: ACCOUNT }), 'terms_not_read');
    await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
    await expectRefusal(accept(as, { account: ACCOUNT }), 'terms_not_read');
    await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' });
    await expectRefusal(accept(as, { account: ACCOUNT, termsHash: 'nope' }), 'terms_changed');
    await expectRefusal(accept(as, { account: ACCOUNT, privacyHash: 'nope' }), 'terms_changed');
    await expectRefusal(accept(as), 'account_required');
    await expectRefusal(
      accept(as, { account: { ...ACCOUNT, dateOfBirth: Date.UTC(2010, 0, 1) } }),
      'underage',
    );
    await expectRefusal(
      accept(as, { account: { ...ACCOUNT, displayName: '   ' } }),
      'name_invalid',
    );
    await expectRefusal(
      accept(as, { account: { ...ACCOUNT, username: 'a!' } }),
      'username_invalid',
    );
    // Nothing was written by any of them, and the reading is still there to accept with.
    expect(await records(t)).toEqual([]);
    expect(await as.query(api.profiles.current, {})).toBeNull();
    expect(await readings(t)).toHaveLength(1);
  });

  test('a username free at Account but taken by Terms is refused, and the reading survives', async () => {
    const t = harness();
    const as = caller(t);
    await readToEnd(as);
    expect(
      (await as.query(api.profiles.usernameAvailable, { username: ACCOUNT.username })).available,
    ).toBe(true);
    // Someone else takes it between the two steps.
    const bob = caller(t, 'user_bob', 'bob@example.test');
    await readToEnd(bob);
    await accept(bob, { account: { ...ACCOUNT, displayName: 'Bob' } });

    await expectRefusal(accept(as, { account: ACCOUNT }), 'username_taken');
    expect(await as.query(api.profiles.current, {})).toBeNull();
    // Back at Account with another name, the same reading carries the acceptance.
    await accept(as, { account: { ...ACCOUNT, username: 'ada_2' } });
    expect((await as.query(api.profiles.current, {}))?.username).toBe('ada_2');
  });

  test('the 18+ gate through this mutation is exactly core’s rule at the server’s clock (D294)', async () => {
    // A birthday within three days of the 18th, either side, at any hour of the server's day.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -3, max: 3 }),
        fc.integer({ min: 0, max: 23 }),
        async (days, hour) => {
          const now = Date.UTC(2026, 10, 24, hour);
          const dob = Date.UTC(2008, 10, 24 + days);
          const t = harness(now);
          const as = caller(t);
          await readToEnd(as);
          const outcome = await accept(as, { account: { ...ACCOUNT, dateOfBirth: dob } }).then(
            () => 'accepted',
            (e: unknown) => (e as ConvexError<{ code: string }>).data.code,
          );
          expect(outcome).toBe(meetsMinimumAge(dob, now) ? 'accepted' : 'underage');
        },
      ),
      { numRuns: 25 },
    );
  });

  test('the 18th birthday itself: refused until noon UTC, accepted after (D294)', async () => {
    const dob = Date.UTC(2008, 10, 24);
    for (const [hour, expected] of [
      [11, 'underage'],
      [12, 'accepted'],
    ] as const) {
      const t = harness(Date.UTC(2026, 10, 24, hour));
      const as = caller(t);
      await readToEnd(as);
      const outcome = await accept(as, { account: { ...ACCOUNT, dateOfBirth: dob } }).then(
        () => 'accepted',
        (e: unknown) => (e as ConvexError<{ code: string }>).data.code,
      );
      expect(outcome).toBe(expected);
    }
  });
});

describe('acceptTerms: an existing row', () => {
  test('an account from before the terms accepts without account fields: returning', async () => {
    const t = harness();
    const id = await existingProfile(t, 'user_bea', { email: 'bea@mirror.test' });
    const as = caller(t, 'user_bea', null);
    await readToEnd(as);
    vi.setSystemTime(T0 + 30_000);
    const { recordId } = await accept(as);
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile).toMatchObject({
      termsVersion: TERMS.version,
      termsAcceptedAt: T0 + 30_000,
      displayName: 'Bea Old-Timer',
      reputationPoints: 12,
    });
    // Never the Home and Profile steps for an existing account.
    expect(profile?.welcomeStep).toBeUndefined();
    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record).toMatchObject({
      context: 'returning',
      profileId: id,
      // The profile's identity, and its mirrored email when the token carries none.
      identity: { fullName: 'Bea Old-Timer', email: 'bea@mirror.test', dateOfBirth: ADULT_DOB },
    });
  });

  test('a bumped terms version is a version_change', async () => {
    const t = harness();
    await existingProfile(t, 'user_bea', { termsVersion: '2026-01-01', termsAcceptedAt: T0 - DAY });
    const as = caller(t, 'user_bea');
    await readToEnd(as);
    const { recordId } = await accept(as);
    expect((await t.run((ctx) => ctx.db.get(recordId)))?.context).toBe('version_change');
  });

  test('account fields for a live row are refused', async () => {
    const t = harness();
    await existingProfile(t, 'user_bea');
    const as = caller(t, 'user_bea');
    await readToEnd(as);
    await expectRefusal(accept(as, { account: ACCOUNT }), 'account_unexpected');
  });

  test("the gate's refusals: banned, being finalized, suspended, and a pending deletion", async () => {
    const t = harness();
    const cases: [string, Partial<Doc<'profiles'>>, RegExp | ConsentRefusalCode][] = [
      ['user_banned', { status: 'banned' }, /not active/i],
      ['user_deleting', { status: 'deleting' }, /not active/i],
      ['user_susp', { status: 'suspended', suspendedUntil: T0 + DAY }, /suspended/i],
      ['user_leaving', { deletionRequestedAt: T0 - DAY }, 'deletion_pending'],
    ];
    for (const [subject, extra, expected] of cases) {
      await existingProfile(t, subject, extra);
      const as = caller(t, subject);
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
      if (typeof expected === 'string') await expectRefusal(accept(as), expected);
      else await expect(accept(as)).rejects.toThrow(expected);
    }
    expect(await records(t)).toEqual([]);
  });

  test("a canceled deletion's emptied row is re-introduced in place, its old records kept", async () => {
    const t = harness();
    const id = await existingProfile(t, 'user_back', {
      displayName: DELETED_DISPLAY_NAME,
      username: 'back',
      profileVisibility: 'private',
      termsVersion: TERMS.version,
      termsAcceptedAt: T0 - 50 * DAY,
      knowBeforeYouGoAt: T0 - 50 * DAY,
    });
    const old = await t.run((ctx) =>
      ctx.db.insert('consentRecords', {
        kind: 'terms',
        profileId: id,
        clerkUserId: 'user_back',
        identity: { fullName: 'Old Name', dateOfBirth: ADULT_DOB },
        version: TERMS.version,
        contentHash: TERMS_SHA256,
        context: 'returning',
        recordedAt: T0 - 50 * DAY,
        surface: { value: 'web', source: 'client_reported' },
        ipStatus: 'unavailable',
        ipUnavailable: 'no_key',
      }),
    );
    const as = caller(t, 'user_back', 'back@example.test');
    await readToEnd(as);
    await expectRefusal(accept(as), 'account_required');
    vi.setSystemTime(T0 + 30_000);
    const { recordId } = await accept(as, {
      account: { displayName: 'Back Again', username: 'back', dateOfBirth: ADULT_DOB },
    });
    const profile = await t.run((ctx) => ctx.db.get(id));
    expect(profile).toMatchObject({
      displayName: 'Back Again',
      username: 'back',
      email: 'back@example.test',
      // Private, as the deletion request left it: someone who asked to be deleted is never made
      // public by a default (D298). The Profile step shows it off; only its switch changes it.
      profileVisibility: 'private',
      welcomeStep: 'home',
      termsAcceptedAt: T0 + 30_000,
      // This season's answers still stand.
      knowBeforeYouGoAt: T0 - 50 * DAY,
    });
    expect(profile?.usernameChangedAt).toBeUndefined();
    const all = await records(t);
    expect(all.map((r) => r._id).sort()).toEqual([old, recordId].sort());
    expect(all.find((r) => r._id === old)?.identity.fullName).toBe('Old Name');
    expect(all.find((r) => r._id === recordId)?.context).toBe('reintroduced');
  });

  test('re-introducing under a new handle is a rename, under the cooldown', async () => {
    const t = harness();
    const id = await existingProfile(t, 'user_back', {
      displayName: DELETED_DISPLAY_NAME,
      username: 'back',
      usernameChangedAt: T0 - DAY,
    });
    const as = caller(t, 'user_back');
    await readToEnd(as);
    const cooled = await refusal(
      accept(as, { account: { displayName: 'B', username: 'fresh', dateOfBirth: ADULT_DOB } }),
    );
    expect(cooled.code).toBe('username_cooldown');
    await t.run((ctx) => ctx.db.patch(id, { usernameChangedAt: T0 - 31 * DAY }));
    vi.setSystemTime(T0 + 30_000);
    await accept(as, { account: { displayName: 'B', username: 'fresh', dateOfBirth: ADULT_DOB } });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      username: 'fresh',
      usernameChangedAt: T0 + 30_000,
    });
  });
});

describe('completeKnowBeforeYouGo', () => {
  async function accepted(t: T, subject = 'user_ada') {
    const as = caller(t, subject);
    await readToEnd(as);
    await accept(as, { account: { ...ACCOUNT, username: subject.replace('user_', '') } });
    return as;
  }
  const complete = (as: ReturnType<T['withIdentity']>, claim = QUESTIONS_CLAIM) =>
    as.mutation(api.consent.completeKnowBeforeYouGo, {
      ...claim,
      surface: 'ios',
      userAgent: 'Gli/1.0',
      clientSessionId: 'sess_q',
    });

  test('before any season opens: a record with season null, and the two fields', async () => {
    const t = harness();
    const as = await accepted(t);
    vi.setSystemTime(T0 + 5 * 60_000);
    expect(await complete(as)).toEqual({ season: null });
    const profile = await as.query(api.profiles.current, {});
    expect(profile).toMatchObject({
      knowBeforeYouGoAt: T0 + 5 * 60_000,
      knowBeforeYouGoVersion: KNOW_BEFORE_YOU_GO.version,
    });
    const record = (await records(t)).find((r) => r.kind === 'questions');
    expect(record).toMatchObject({
      kind: 'questions',
      profileId: profile?._id,
      clerkUserId: 'user_ada',
      identity: { fullName: 'Ada Lovelace', email: 'ada@example.test', dateOfBirth: ADULT_DOB },
      version: KNOW_BEFORE_YOU_GO.version,
      contentHash: KNOW_BEFORE_YOU_GO_SHA256,
      context: 'first_run',
      season: null,
      recordedAt: T0 + 5 * 60_000,
      surface: { value: 'ios', source: 'client_reported' },
      userAgent: { value: 'Gli/1.0', source: 'client_reported' },
      ipStatus: 'pending',
    });
    // No copy for the questions; terms-only fields absent.
    expect(record?.copyEmail).toBeUndefined();
    expect(record?.privacyVersion).toBeUndefined();
    const capture = (await scheduled(t)).filter((j) => j.name === 'consent:captureIp');
    expect(capture.map((j) => j.args[0])).toContainEqual({
      recordId: record?._id,
      clerkUserId: 'user_ada',
      clientSessionId: 'sess_q',
    });
  });

  test('with a live season: the season is recorded, and the next answer is a season one', async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2026-27', T0 - 3 * DAY)),
    );
    const as = await accepted(t);
    expect(await complete(as)).toEqual({ season: 'winter-2026-27' });
    vi.setSystemTime(T0 + 400 * DAY);
    expect(await complete(as)).toEqual({ season: 'winter-2026-27' });
    const contexts = (await records(t)).filter((r) => r.kind === 'questions').map((r) => r.context);
    expect(contexts).toEqual(['first_run', 'season']);
  });

  test('a reset season is not the season: the previous live one is recorded', async () => {
    const t = harness();
    const admin = await existingProfile(t, 'user_admin');
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2025-26', T0 - 370 * DAY));
      await ctx.db.insert('imageryIngestSeasonsSuperseded', {
        ...seasonRow('winter-2026-27', T0 - 2 * DAY),
        supersededAt: T0 - DAY,
        supersededBy: admin,
      });
    });
    const as = await accepted(t);
    expect(await complete(as)).toEqual({ season: 'winter-2025-26' });
  });

  test('a second call within 60 s returns the first answer and writes nothing', async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2026-27', T0 - DAY)),
    );
    const as = await accepted(t);
    const first = T0 + 10_000;
    vi.setSystemTime(first);
    await complete(as);
    // The season changes under it — the repeat still answers what the first call recorded.
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2027-28', first + 1)),
    );
    vi.setSystemTime(first + KNOW_BEFORE_YOU_GO_REPEAT_MS - 1);
    expect(await complete(as)).toEqual({ season: 'winter-2026-27' });
    expect((await records(t)).filter((r) => r.kind === 'questions')).toHaveLength(1);
    expect((await as.query(api.profiles.current, {}))?.knowBeforeYouGoAt).toBe(first);
    // At 60 s it is a new completion.
    vi.setSystemTime(first + KNOW_BEFORE_YOU_GO_REPEAT_MS);
    expect(await complete(as)).toEqual({ season: 'winter-2027-28' });
    expect((await records(t)).filter((r) => r.kind === 'questions')).toHaveLength(2);
  });

  test('the terms first, the current questions, and the contributor gate', async () => {
    const t = harness();
    const beaId = await existingProfile(t, 'user_bea');
    const bea = caller(t, 'user_bea');
    await expectRefusal(complete(bea), 'terms_first');
    await t.run((ctx) => ctx.db.patch(beaId, { termsVersion: '2026-01-01' }));
    await expectRefusal(complete(bea), 'terms_first');
    const as = await accepted(t);
    await expectRefusal(complete(as, { ...QUESTIONS_CLAIM, hash: 'beef' }), 'questions_changed');
    await expectRefusal(
      complete(as, { ...QUESTIONS_CLAIM, version: '2020-01-01' }),
      'questions_changed',
    );
    await existingProfile(t, 'user_leaving', {
      termsVersion: TERMS.version,
      deletionRequestedAt: T0 - DAY,
    });
    await expect(complete(caller(t, 'user_leaving'))).rejects.toThrow(/scheduled for deletion/i);
    expect(await complete(caller(t, 'user_nobody')).catch((e: Error) => e.message)).toMatch(
      /not authenticated/i,
    );
  });

  test('the season rule’s 30-day window, as the route reads it after a completion', async () => {
    // Answered 30 days before the opening, to the millisecond: it counts.
    const t = harness(T0 - KNOW_BEFORE_YOU_GO_EARLY_MS - 60_000);
    const as = await accepted(t);
    vi.setSystemTime(T0 - KNOW_BEFORE_YOU_GO_EARLY_MS);
    await complete(as);
    await t.run((ctx) => ctx.db.insert('imageryIngestSeasons', seasonRow('winter-2026-27', T0)));
    const profile = await as.query(api.profiles.current, {});
    const watch = await as.query(api.consent.watchAnchor, {});
    expect(profile?.knowBeforeYouGoAt).toBe(T0 - KNOW_BEFORE_YOU_GO_EARLY_MS);
    expect(knowBeforeYouGoDue(profile?.knowBeforeYouGoAt, watch)).toBeNull();
    // One millisecond earlier would not have.
    expect(knowBeforeYouGoDue((profile?.knowBeforeYouGoAt ?? 0) - 1, watch)).toBe('season');
  });
});

describe('advanceWelcome', () => {
  test('home → profile → done; a stale step is a no-op', async () => {
    const t = harness();
    const as = caller(t);
    await readToEnd(as);
    await accept(as, { account: ACCOUNT });
    expect(await as.mutation(api.consent.advanceWelcome, { from: 'profile' })).toEqual({
      welcomeStep: 'home',
    });
    expect(await as.mutation(api.consent.advanceWelcome, { from: 'home' })).toEqual({
      welcomeStep: 'profile',
    });
    expect(await as.mutation(api.consent.advanceWelcome, { from: 'home' })).toEqual({
      welcomeStep: 'profile',
    });
    expect(await as.mutation(api.consent.advanceWelcome, { from: 'profile' })).toEqual({
      welcomeStep: null,
    });
    expect((await as.query(api.profiles.current, {}))?.welcomeStep).toBeUndefined();
    expect(await as.mutation(api.consent.advanceWelcome, { from: 'profile' })).toEqual({
      welcomeStep: null,
    });
  });

  test('the contributor gate', async () => {
    const t = harness();
    await existingProfile(t, 'user_leaving', { deletionRequestedAt: T0, welcomeStep: 'home' });
    await expect(
      caller(t, 'user_leaving').mutation(api.consent.advanceWelcome, { from: 'home' }),
    ).rejects.toThrow(/scheduled for deletion/i);
  });
});

describe('latestTermsReceipt', () => {
  test('null without a profile or an acceptance', async () => {
    const t = harness();
    expect(await caller(t).query(api.consent.latestTermsReceipt, {})).toBeNull();
    await existingProfile(t, 'user_bea');
    expect(await caller(t, 'user_bea').query(api.consent.latestTermsReceipt, {})).toBeNull();
  });

  test("maps the copy's send: pending, sent for accepted and unknown, not_sent for rejected", async () => {
    const t = harness();
    const as = caller(t);
    await readToEnd(as);
    const { recordId } = await accept(as, { account: ACCOUNT });
    expect(await as.query(api.consent.latestTermsReceipt, {})).toEqual({
      email: 'ada@example.test',
      copy: 'pending',
    });
    for (const [status, copy] of [
      ['accepted', 'sent'],
      ['unknown', 'sent'],
      ['rejected', 'not_sent'],
    ] as const) {
      await t.run((ctx) => ctx.db.patch(recordId, { copyEmail: { status, at: T0 } }));
      expect(await as.query(api.consent.latestTermsReceipt, {})).toEqual({
        email: 'ada@example.test',
        copy,
      });
    }
  });

  test('the newest acceptance answers, and a missing address reads null', async () => {
    const t = harness();
    const id = await existingProfile(t, 'user_bea');
    const as = caller(t, 'user_bea', null);
    await readToEnd(as);
    await accept(as);
    expect(await as.query(api.consent.latestTermsReceipt, {})).toEqual({
      email: null,
      copy: 'pending',
    });
    await t.run((ctx) => ctx.db.patch(id, { termsVersion: '2026-01-01', email: 'bea@new.test' }));
    vi.setSystemTime(T0 + DAY);
    await readToEnd(as);
    await accept(as);
    expect((await as.query(api.consent.latestTermsReceipt, {}))?.email).toBe('bea@new.test');
  });
});

describe('the retention sweeps', () => {
  test('pruneReadings deletes readings opened more than 30 days ago, and no others', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const [who, openedAt] of [
        ['old', T0 - READING_TTL_MS - 1],
        ['edge', T0 - READING_TTL_MS],
        ['new', T0 - DAY],
      ] as const) {
        await ctx.db.insert('termsReadings', {
          clerkUserId: who,
          termsVersion: TERMS.version,
          openedAt,
          surface: 'web',
        });
      }
    });
    expect(await t.mutation(internal.consent.pruneReadings, {})).toEqual({ deleted: 1 });
    expect((await readings(t)).map((r) => r.clerkUserId).sort()).toEqual(['edge', 'new']);
  });

  test('pruneReadings goes again at once when its page was full', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < CONSENT_SWEEP_PAGE + 3; i++) {
        await ctx.db.insert('termsReadings', {
          clerkUserId: `u${i}`,
          termsVersion: TERMS.version,
          openedAt: T0 - READING_TTL_MS - 1 - i,
          surface: 'web',
        });
      }
    });
    expect(await t.mutation(internal.consent.pruneReadings, {})).toEqual({
      deleted: CONSENT_SWEEP_PAGE,
    });
    expect((await scheduled(t)).map((j) => j.name)).toContain('consent:pruneReadings');
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await readings(t)).toEqual([]);
  });

  /** A record as finalization leaves one (severed, `purgeAt` set), or live (neither). */
  function recordFixture(purgeAt?: number) {
    return {
      kind: 'terms' as const,
      identity: { fullName: 'X', dateOfBirth: ADULT_DOB },
      version: TERMS.version,
      contentHash: TERMS_SHA256,
      context: 'first_run' as const,
      recordedAt: T0 - 3000 * DAY,
      surface: { value: 'web' as const, source: 'client_reported' as const },
      ipStatus: 'unavailable' as const,
      ...(purgeAt !== undefined ? { severedAt: purgeAt - 2191 * DAY, purgeAt } : {}),
    };
  }

  test('purgeDue deletes due records and never one without purgeAt (the optional-index trap)', async () => {
    const t = harness();
    const ids = await t.run(async (ctx) => ({
      live: await ctx.db.insert('consentRecords', recordFixture()),
      due: await ctx.db.insert('consentRecords', recordFixture(T0 - 1)),
      now: await ctx.db.insert('consentRecords', recordFixture(T0)),
      later: await ctx.db.insert('consentRecords', recordFixture(T0 + 1)),
    }));
    expect(await t.mutation(internal.consent.purgeDue, {})).toEqual({ deleted: 2 });
    const left = (await records(t)).map((r) => r._id).sort();
    expect(left).toEqual([ids.live, ids.later].sort());
  });

  test('purgeDue never loops on a full page its re-check skips whole', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      // Dated but never severed: no writer makes one (the guard), and the re-check keeps it.
      for (let i = 0; i < CONSENT_SWEEP_PAGE; i++) {
        const { severedAt: _s, ...unsevered } = recordFixture(T0 - 1 - i);
        await ctx.db.insert('consentRecords', unsevered);
      }
    });
    expect(await t.mutation(internal.consent.purgeDue, {})).toEqual({ deleted: 0 });
    expect((await scheduled(t)).map((j) => j.name)).not.toContain('consent:purgeDue');
    expect(await records(t)).toHaveLength(CONSENT_SWEEP_PAGE);
  });

  test('purgeDue is bounded, and goes again at once when its page was full', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) await ctx.db.insert('consentRecords', recordFixture());
      for (let i = 0; i < CONSENT_SWEEP_PAGE + 2; i++) {
        await ctx.db.insert('consentRecords', recordFixture(T0 - 1 - i));
      }
    });
    expect(await t.mutation(internal.consent.purgeDue, {})).toEqual({
      deleted: CONSENT_SWEEP_PAGE,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Only the forty live records are left.
    const left = await records(t);
    expect(left).toHaveLength(40);
    expect(left.every((r) => r.purgeAt === undefined)).toBe(true);
  });
});

describe('the CLI lookups', () => {
  test('by account and by email, newest first, including a severed record', async () => {
    const t = harness();
    const as = caller(t, 'user_ada', 'Ada@Example.test');
    await readToEnd(as);
    const { recordId: first } = await accept(as, { account: ACCOUNT });
    const profile = await as.query(api.profiles.current, {});
    const severed = await t.run((ctx) =>
      ctx.db.insert('consentRecords', {
        kind: 'questions',
        identity: { fullName: 'Ada', email: 'ada@example.test', dateOfBirth: ADULT_DOB },
        version: KNOW_BEFORE_YOU_GO.version,
        contentHash: KNOW_BEFORE_YOU_GO_SHA256,
        context: 'first_run',
        recordedAt: T0 + DAY,
        season: null,
        surface: { value: 'web', source: 'client_reported' },
        ipStatus: 'pending',
        severedAt: T0 + 2 * DAY,
        purgeAt: T0 + 3 * DAY,
      }),
    );
    expect(
      (
        await t.query(internal.consent.recordsFor, { profileId: profile?._id as Id<'profiles'> })
      ).map((r) => r._id),
    ).toEqual([first]);
    expect(
      (await t.query(internal.consent.recordsByEmail, { email: ' Ada@Example.test ' })).map(
        (r) => r._id,
      ),
    ).toEqual([severed, first]);
  });

  test('past the cap, the newest records come back — of either kind, by account and by email', async () => {
    const t = harness();
    const id = await existingProfile(t, 'user_many', { email: 'many@example.test' });
    // Twice the cap, the kinds interleaved in time: the newest LOOKUP_CAP are the top half.
    const total = LOOKUP_CAP * 2;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        const kind = i % 2 === 0 ? ('terms' as const) : ('questions' as const);
        await ctx.db.insert('consentRecords', {
          kind,
          profileId: id,
          clerkUserId: 'user_many',
          identity: { fullName: 'Many', email: 'many@example.test', dateOfBirth: ADULT_DOB },
          version: kind === 'terms' ? TERMS.version : KNOW_BEFORE_YOU_GO.version,
          contentHash: kind === 'terms' ? TERMS_SHA256 : KNOW_BEFORE_YOU_GO_SHA256,
          context: kind === 'terms' ? 'returning' : 'season',
          recordedAt: T0 + i * 1000,
          ...(kind === 'questions' ? { season: null } : {}),
          surface: { value: 'web', source: 'client_reported' },
          ipStatus: 'pending',
        });
      }
    });
    const newest = Array.from({ length: LOOKUP_CAP }, (_, k) => T0 + (total - 1 - k) * 1000);
    const byAccount = await t.query(internal.consent.recordsFor, { profileId: id });
    expect(byAccount.map((r) => r.recordedAt)).toEqual(newest);
    const byEmail = await t.query(internal.consent.recordsByEmail, { email: 'many@example.test' });
    expect(byEmail.map((r) => r.recordedAt)).toEqual(newest);
  });
});
