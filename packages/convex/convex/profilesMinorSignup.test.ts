import { isMinor, RISK_ACK_VERSION } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

/**
 * The under-18 protections at sign-up, with the age gate held open.
 *
 * D294 raised the minimum to 18, so `upsertFromClerk` can no longer be handed a minor and its
 * "force a minor private" branches are unreachable in production. They are kept on purpose:
 * lowering the minimum again must be the constant plus policy work, never a silent public
 * profile for a 17-year-old. This suite stands in for that future by replacing only the gate
 * (`meetsMinimumAge`), and proves the branches still do what D13/D41 decided. The real gate is
 * tested in `profiles.test.ts` and `@skating/core`'s `age.test.ts`.
 */
vi.mock('@skating/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skating/core')>()),
  meetsMinimumAge: () => true,
}));

const modules = import.meta.glob('./**/*.*s');

const withAck = <T extends object>(args: T) => ({ riskAckVersion: RISK_ACK_VERSION, ...args });

// Born Jan 1, relative to the current year, so the ages hold whenever the suite runs.
const nowYear = new Date().getUTCFullYear();
const ADULT_DOB = Date.UTC(nowYear - 40, 0, 1);
const MINOR_DOB = Date.UTC(nowYear - 17, 0, 1);

describe('profiles.upsertFromClerk, were the minimum age lowered below 18 (D13/D41, D294)', () => {
  test('a minor is provisioned with a private profile', async () => {
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

  test('a re-run of onboarding forces a minor back to private', async () => {
    const t = convexTest(schema, modules);
    const asTeen = t.withIdentity({ subject: 'clerk_teen' });
    const id = await asTeen.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: MINOR_DOB }),
    );
    // A row that somehow reads public (a hand edit, a bug) is closed again by the next sync.
    await t.run((ctx) => ctx.db.patch(id, { profileVisibility: 'public' }));
    await asTeen.mutation(
      api.profiles.upsertFromClerk,
      withAck({ displayName: 'Teen', username: 'teen', dateOfBirth: MINOR_DOB }),
    );
    expect((await asTeen.query(api.profiles.current, {}))?.profileVisibility).toBe('private');
  });

  test('a minor who reaches adulthood keeps their private profile', async () => {
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
});
