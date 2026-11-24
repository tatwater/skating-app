import {
  DELETED_DISPLAY_NAME,
  isMinor,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  TERMS,
  TERMS_SHA256,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

/**
 * The under-18 protections at sign-up, with the age gate held open.
 *
 * D294 raised the minimum to 18, so `consent.acceptTerms` — the way in since B03 §9, as
 * `upsertFromClerk` was before it — can no longer be handed a minor, and its "force a minor
 * private" branches are unreachable in production. They are kept on purpose: lowering the minimum
 * again must be the constant plus policy work, never a silent public profile for a 17-year-old.
 * This suite stands in for that future by replacing only the gate (`meetsMinimumAge`), and proves
 * the branches still do what D13/D41 decided. The real gate is tested in `consent.test.ts`,
 * `profiles.test.ts` and `@skating/core`'s `age.test.ts`.
 */
vi.mock('@skating/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skating/core')>()),
  meetsMinimumAge: () => true,
}));

const modules = import.meta.glob('./**/*.*s');

/** Tuesday 24 November 2026, 15:00 UTC, pinned (D243). */
const T0 = Date.UTC(2026, 10, 24, 15);
const ADULT_DOB = Date.UTC(1986, 0, 1);
const MINOR_DOB = Date.UTC(2009, 0, 1);

type Caller = ReturnType<ReturnType<typeof convexTest>['withIdentity']>;
const TERMS_CLAIM = { termsVersion: TERMS.version, termsHash: TERMS_SHA256 };

/** The terms read to the end, then accepted with the Account step's fields. */
async function onboard(as: Caller, dateOfBirth: number, username = 'teen') {
  await as.mutation(api.consent.openTerms, { ...TERMS_CLAIM, surface: 'web' });
  await as.mutation(api.consent.reachTermsEnd, { ...TERMS_CLAIM, via: 'inline' });
  await as.mutation(api.consent.acceptTerms, {
    ...TERMS_CLAIM,
    privacyVersion: PRIVACY_NOTICE_VERSION,
    privacyHash: PRIVACY_NOTICE_SHA256,
    surface: 'web',
    account: { displayName: 'Teen', username, dateOfBirth },
  });
  const profile = await as.query(api.profiles.current, {});
  if (profile === null) throw new Error('the acceptance made no profile');
  return profile;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('consent.acceptTerms, were the minimum age lowered below 18 (D13/D41, D294)', () => {
  test('a minor is provisioned with a private profile', async () => {
    const t = convexTest(schema, modules);
    const profile = await onboard(t.withIdentity({ subject: 'clerk_teen' }), MINOR_DOB);
    expect(isMinor(profile.dateOfBirth, T0)).toBe(true);
    expect(profile.profileVisibility).toBe('private');
  });

  test('re-introducing a minor forces them back to private', async () => {
    const t = convexTest(schema, modules);
    const asTeen = t.withIdentity({ subject: 'clerk_teen' });
    const { _id: id } = await onboard(asTeen, MINOR_DOB);
    // A canceled deletion's emptied row that somehow reads public (a hand edit, a bug) is
    // closed again when onboarding re-runs on it.
    await t.run((ctx) =>
      ctx.db.patch(id, { displayName: DELETED_DISPLAY_NAME, profileVisibility: 'public' }),
    );
    const again = await onboard(asTeen, MINOR_DOB);
    expect(again._id).toBe(id);
    expect(again.profileVisibility).toBe('private');
  });

  test('a minor who reaches adulthood keeps their private profile', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: 'clerk_grows' });
    // Provisioned as a minor → forced private.
    const { _id: id } = await onboard(asUser, MINOR_DOB);
    // Re-introduced with an adult date of birth (a canceled deletion's next onboarding) must NOT
    // auto-widen the private profile they held as a minor — it persists until they make it public
    // themselves (D13), as any re-introduced account keeps its visibility (D298).
    await t.run((ctx) => ctx.db.patch(id, { displayName: DELETED_DISPLAY_NAME }));
    const grown = await onboard(asUser, ADULT_DOB);
    expect(isMinor(grown.dateOfBirth, T0)).toBe(false);
    expect(grown.profileVisibility).toBe('private');
  });
});
