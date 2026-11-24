/**
 * The consent record across a deletion and in the export (D297, B03 §9.11): finalization's `consent`
 * stage severs each record and dates its purge six calendar years on (29 February lands on 1 March),
 * `erase` takes the unaccepted readings, the tombstone clears the profile's five fields, nothing
 * earlier touches a record, and the person's own export carries their records without the email,
 * the Clerk subject or the profile id.
 */

import {
  CONSENT_RETENTION_YEARS,
  consentPurgeAt,
  DELETION_GRACE_MS,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_SHA256,
  TERMS,
  TERMS_SHA256,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { NOTIFICATION_PREF_DEFAULTS } from './lib/enums';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 10, 24, 15);
const DAY = 24 * 60 * 60 * 1000;
const DOB = Date.UTC(1990, 0, 1);

type T = ReturnType<typeof convexTest>;

function harness(now = T0): T {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv('CLERK_SECRET_KEY', '');
  vi.stubEnv('RESEND_API_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function person(t: T, subject: string): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Person`,
      username: subject,
      email: `${subject}@example.test`,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
      dateOfBirth: DOB,
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: T0 - 400 * DAY,
      termsVersion: TERMS.version,
      termsAcceptedAt: T0 - 300 * DAY,
      knowBeforeYouGoAt: T0 - 300 * DAY,
      knowBeforeYouGoVersion: KNOW_BEFORE_YOU_GO.version,
      welcomeStep: 'profile',
    }),
  );
}

async function recordsOf(t: T, profileId: Id<'profiles'>, subject: string, n: number) {
  return t.run(async (ctx) => {
    const ids: Id<'consentRecords'>[] = [];
    for (let i = 0; i < n; i++) {
      const terms = i % 2 === 0;
      ids.push(
        await ctx.db.insert('consentRecords', {
          kind: terms ? 'terms' : 'questions',
          profileId,
          clerkUserId: subject,
          identity: {
            fullName: `${subject} Person`,
            email: `${subject}@example.test`,
            dateOfBirth: DOB,
          },
          version: terms ? TERMS.version : KNOW_BEFORE_YOU_GO.version,
          contentHash: terms ? TERMS_SHA256 : KNOW_BEFORE_YOU_GO_SHA256,
          context: 'first_run',
          recordedAt: T0 - (300 - i) * DAY,
          ...(terms
            ? {
                openedAt: T0 - 301 * DAY,
                reachedEndAt: T0 - 301 * DAY + 1,
                reachedEndVia: 'inline' as const,
              }
            : { season: 'winter-2025-26' }),
          surface: { value: 'web', source: 'client_reported' },
          userAgent: { value: 'Mozilla/5.0', source: 'client_reported' },
          ipStatus: 'captured',
          ip: {
            address: '192.0.2.1',
            source: 'clerk_session_activity',
            match: 'client_session',
            fetchedAt: T0 - 300 * DAY,
          },
        }),
      );
    }
    return ids;
  });
}

async function finalize(t: T, userId: Id<'profiles'>, pageSize?: number) {
  await t.run((ctx) =>
    ctx.db.patch(userId, { deletionRequestedAt: Date.now() - DELETION_GRACE_MS }),
  );
  await t.mutation(internal.accountDeletion.finalizeAccount, {
    userId,
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe('finalization and the consent record', () => {
  test('severs every record of the account, dates its purge six years on, and leaves others alone', async () => {
    const t = harness();
    const leaving = await person(t, 'user_leaving');
    const staying = await person(t, 'user_staying');
    // Five records over a page size of two: the stage continues until every one is severed.
    const mine = await recordsOf(t, leaving, 'user_leaving', 5);
    const theirs = await recordsOf(t, staying, 'user_staying', 2);
    await t.run((ctx) =>
      ctx.db.insert('termsReadings', {
        clerkUserId: 'user_leaving',
        termsVersion: TERMS.version,
        openedAt: T0 - DAY,
        surface: 'web',
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('termsReadings', {
        clerkUserId: 'user_staying',
        termsVersion: TERMS.version,
        openedAt: T0 - DAY,
        surface: 'web',
      }),
    );

    await finalize(t, leaving, 2);

    for (const id of mine) {
      const record = await t.run((ctx) => ctx.db.get(id));
      expect(record?.profileId).toBeUndefined();
      expect(record?.clerkUserId).toBeUndefined();
      expect(record?.severedAt).toBeGreaterThanOrEqual(T0);
      expect(record?.purgeAt).toBe(consentPurgeAt(record?.severedAt as number));
      // The identity snapshot and the evidence stay: that is what the record is for.
      expect(record).toMatchObject({
        identity: {
          fullName: 'user_leaving Person',
          email: 'user_leaving@example.test',
          dateOfBirth: DOB,
        },
        ipStatus: 'captured',
      });
    }
    const purgeYear = new Date(
      (await t.run((ctx) => ctx.db.get(mine[0] as Id<'consentRecords'>)))?.purgeAt as number,
    ).getUTCFullYear();
    expect(purgeYear).toBe(2026 + CONSENT_RETENTION_YEARS);
    for (const id of theirs) {
      const record = await t.run((ctx) => ctx.db.get(id));
      expect(record).toMatchObject({ profileId: staying, clerkUserId: 'user_staying' });
      expect(record?.purgeAt).toBeUndefined();
    }
    // The unaccepted reading went with the account; the other person's stayed.
    const readings = await t.run((ctx) => ctx.db.query('termsReadings').collect());
    expect(readings.map((r) => r.clerkUserId)).toEqual(['user_staying']);
    // The tombstone cleared the five routing fields.
    const tombstone = await t.run((ctx) => ctx.db.get(leaving));
    expect(tombstone?.status).toBe('deleted');
    for (const field of [
      'termsVersion',
      'termsAcceptedAt',
      'knowBeforeYouGoAt',
      'knowBeforeYouGoVersion',
      'welcomeStep',
    ] as const) {
      expect(tombstone?.[field]).toBeUndefined();
    }
    // The purge leaves a severed record until its six years are up, then deletes it.
    expect(await t.mutation(internal.consent.purgeDue, {})).toEqual({ deleted: 0 });
    vi.setSystemTime(consentPurgeAt(T0) + DAY);
    expect(await t.mutation(internal.consent.purgeDue, {})).toEqual({ deleted: mine.length });
    const left = await t.run((ctx) => ctx.db.query('consentRecords').collect());
    expect(left.map((r) => r._id).sort()).toEqual([...theirs].sort());
  });

  test('a finalization on 29 February dates the purge 1 March, six years on', async () => {
    const leapDay = Date.UTC(2028, 1, 29, 9, 30);
    const t = harness(leapDay);
    const leaving = await person(t, 'user_leap');
    const [id] = await recordsOf(t, leaving, 'user_leap', 1);
    await finalize(t, leaving);
    const record = await t.run((ctx) => ctx.db.get(id as Id<'consentRecords'>));
    const severed = new Date(record?.severedAt as number);
    expect([severed.getUTCMonth(), severed.getUTCDate()]).toEqual([1, 29]);
    const purge = new Date(record?.purgeAt as number);
    expect([purge.getUTCFullYear(), purge.getUTCMonth(), purge.getUTCDate()]).toEqual([2034, 2, 1]);
    expect(record?.purgeAt).toBe(consentPurgeAt(record?.severedAt as number));
  });

  test('a pending deletion and a cancel touch no record', async () => {
    const t = harness();
    const id = await person(t, 'user_maybe');
    const [recordId] = await recordsOf(t, id, 'user_maybe', 1);
    const before = await t.run((ctx) => ctx.db.get(recordId as Id<'consentRecords'>));
    const as = t.withIdentity({ subject: 'user_maybe' });
    await as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await as.mutation(api.accountDeletion.cancelDeletion, {});
    expect(await t.run((ctx) => ctx.db.get(recordId as Id<'consentRecords'>))).toEqual(before);
  });
});

describe('the export', () => {
  test("carries the person's records without the email, the Clerk subject or the profile id", async () => {
    const t = harness();
    const id = await person(t, 'user_export');
    const other = await person(t, 'user_other');
    await recordsOf(t, id, 'user_export', 2);
    await recordsOf(t, other, 'user_other', 1);
    const bundle = await t.query(internal.dataExport.collect, { userId: id });
    expect(bundle.consentRecords).toHaveLength(2);
    for (const record of bundle.consentRecords) {
      expect(record).not.toHaveProperty('clerkUserId');
      expect(record).not.toHaveProperty('profileId');
      expect(record.identity).toEqual({ fullName: 'user_export Person', dateOfBirth: DOB });
      expect(JSON.stringify(record)).not.toContain('@example.test');
    }
    const [terms] = bundle.consentRecords.filter((r) => r.kind === 'terms');
    expect(terms).toMatchObject({
      kind: 'terms',
      version: TERMS.version,
      contentHash: TERMS_SHA256,
      context: 'first_run',
      reachedEndVia: 'inline',
      surface: { value: 'web', source: 'client_reported' },
      ip: { address: '192.0.2.1', match: 'client_session' },
    });
    // And the profile's own routing fields ride along with the rest of the profile.
    expect(bundle.profile).toMatchObject({ termsVersion: TERMS.version, welcomeStep: 'profile' });
  });
});
