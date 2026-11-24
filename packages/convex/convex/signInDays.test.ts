/**
 * The per-day sign-in record (B01): `syncFromClerk`, the call every client makes on every open,
 * puts a person's first open of each UTC day on `signInDays`, and nothing else. What is pinned:
 *
 *  - **once a day** — every later open that day, sequential or concurrent, finds the row and writes
 *    nothing, so the table grows by people × days, never by opens;
 *  - **the day is the UTC metric day** — a new row at 00:00 UTC, the same key every metric uses;
 *  - **who counts** — a suspended account signed in; a pending or finished deletion leaves no new
 *    record, and no profile means nothing to record.
 */
import { PRIVACY_NOTICE_SHA256, PRIVACY_NOTICE_VERSION, TERMS, TERMS_SHA256 } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const MIDDAY = Date.UTC(2026, 0, 15, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MIDDAY);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The way in (D298): the terms read to the end, then accepted with the Account step's fields. */
async function onboard(t: ReturnType<typeof convexTest>, subject: string): Promise<Id<'profiles'>> {
  // A minute before the test's clock, so the opens that follow get their own instants (the harness
  // keeps each write's clock after the last one's).
  const at = Date.now();
  vi.setSystemTime(at - 60_000);
  const as = t.withIdentity({ subject });
  const claim = { termsVersion: TERMS.version, termsHash: TERMS_SHA256 };
  await as.mutation(api.consent.openTerms, { ...claim, surface: 'web' });
  await as.mutation(api.consent.reachTermsEnd, { ...claim, via: 'inline' });
  await as.mutation(api.consent.acceptTerms, {
    ...claim,
    privacyVersion: PRIVACY_NOTICE_VERSION,
    privacyHash: PRIVACY_NOTICE_SHA256,
    surface: 'web',
    account: { displayName: subject, username: subject, dateOfBirth: Date.UTC(1986, 0, 1) },
  });
  const profile = await as.query(api.profiles.current, {});
  if (profile === null) throw new Error('the acceptance made no profile');
  vi.setSystemTime(at);
  return profile._id;
}

const open = (t: ReturnType<typeof convexTest>, subject: string) =>
  t.withIdentity({ subject }).mutation(api.profiles.syncFromClerk, {});

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query('signInDays').collect());

describe('the sign-in record', () => {
  test("a day's first open writes one row; every later open that day writes nothing", async () => {
    const t = convexTest(schema, modules);
    const ada = await onboard(t, 'ada');
    await open(t, 'ada');
    vi.setSystemTime(MIDDAY + 3 * 60 * 60 * 1000);
    await open(t, 'ada');
    await open(t, 'ada');

    expect(await rows(t)).toEqual([
      expect.objectContaining({ userId: ada, day: '2026-01-15', firstAt: MIDDAY }),
    ]);
  });

  test('opens racing each other still leave one row', async () => {
    const t = convexTest(schema, modules);
    await onboard(t, 'ada');
    await Promise.all([open(t, 'ada'), open(t, 'ada'), open(t, 'ada'), open(t, 'ada')]);
    expect(await rows(t)).toHaveLength(1);
  });

  test('a new UTC day is a new row, keyed the way every metric day is', async () => {
    const t = convexTest(schema, modules);
    await onboard(t, 'ada');
    vi.setSystemTime(Date.UTC(2026, 0, 15, 23, 59, 59, 999));
    await open(t, 'ada');
    vi.setSystemTime(Date.UTC(2026, 0, 16, 0, 0, 0, 0));
    await open(t, 'ada');

    expect((await rows(t)).map((r) => r.day).sort()).toEqual(['2026-01-15', '2026-01-16']);
  });

  test('one row per person: two people on one day are two rows', async () => {
    const t = convexTest(schema, modules);
    const ada = await onboard(t, 'ada');
    const bea = await onboard(t, 'bea');
    await open(t, 'ada');
    await open(t, 'bea');
    await open(t, 'ada');

    const byDay = await t.run((ctx) =>
      ctx.db
        .query('signInDays')
        .withIndex('by_day', (q) => q.eq('day', '2026-01-15'))
        .collect(),
    );
    expect(byDay.map((r) => r.userId).sort()).toEqual([ada, bea].sort());
  });

  test('a suspended account that opens the app signed in, and is counted', async () => {
    const t = convexTest(schema, modules);
    const ada = await onboard(t, 'ada');
    await t.run((ctx) => ctx.db.patch(ada, { status: 'suspended' }));

    // The mirror gate still turns it away (the return), but the open goes on the record.
    expect(await open(t, 'ada')).toBeNull();
    expect(await rows(t)).toHaveLength(1);
  });

  test('a pending or finished deletion leaves no new record', async () => {
    const t = convexTest(schema, modules);
    const ada = await onboard(t, 'ada');
    const states: Array<{ deletionRequestedAt?: number; status?: 'deleting' | 'deleted' }> = [
      { deletionRequestedAt: MIDDAY },
      { deletionRequestedAt: undefined, status: 'deleting' },
      { status: 'deleted' },
    ];
    for (const patch of states) {
      await t.run((ctx) => ctx.db.patch(ada as Id<'profiles'>, patch));
      await open(t, 'ada');
    }
    expect(await rows(t)).toEqual([]);
  });

  test('no profile, or no identity, records nothing', async () => {
    const t = convexTest(schema, modules);
    await open(t, 'nobody');
    await t.mutation(api.profiles.syncFromClerk, {});
    expect(await rows(t)).toEqual([]);
  });
});
