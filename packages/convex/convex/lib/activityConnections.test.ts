/**
 * The one place third-party credentials enter the database (PR #29 review).
 *
 * These tests are deliberately written against a **non-Strava provider**. The gate they pin was
 * originally a Strava-shaped fix, and the reason it moved here is that `activityConnections` is
 * provider-generic: the next integration writes the same rows from its own file, and would have
 * hand-rolled its own insert without ever meeting the rule. Testing through Garmin is how that stays
 * a property of the table rather than a property of Strava — `strava.test.ts` still covers the two
 * real-world races end to end.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import type { Doc, Id } from '../_generated/dataModel';
import schema from '../schema';
import { canConnectAccount, storeActivityConnection } from './activityConnections';

const modules = import.meta.glob('../**/*.*s');

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

/** From the column, not a copy of it — a new status value shows up here without an edit. */
type Status = Doc<'profiles'>['status'];

async function seedUser(t: ReturnType<typeof convexTest>, subject: string, status: Status) {
  return (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status,
      createdAt: T0,
    }),
  )) as Id<'profiles'>;
}

const TOKENS = {
  externalUserId: 'garmin-999',
  accessToken: 'access',
  refreshToken: 'refresh',
  tokenExpiresAt: T0 + 21_600_000,
  scopes: ['activity:write'],
};

async function store(t: ReturnType<typeof convexTest>, userId: Id<'profiles'>) {
  return t.run((ctx) =>
    storeActivityConnection(ctx, { userId, provider: 'garmin' as const, ...TOKENS }),
  );
}

describe('storeActivityConnection', () => {
  test('stores a connection for an ordinary account', async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, 'skater', 'active');

    expect(await store(t, userId)).toEqual({ stored: true });
    const rows = await t.run((ctx) => ctx.db.query('activityConnections').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('garmin');
    expect(rows[0]?.accessToken).toBe('access');
  });

  test('re-connecting replaces the tokens in place and keeps the original date', async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, 'skater', 'active');
    await store(t, userId);
    const first = (await t.run((ctx) => ctx.db.query('activityConnections').collect()))[0];

    await t.run((ctx) =>
      storeActivityConnection(ctx, {
        userId,
        provider: 'garmin' as const,
        ...TOKENS,
        accessToken: 'access-2',
      }),
    );

    const rows = await t.run((ctx) => ctx.db.query('activityConnections').collect());
    expect(rows).toHaveLength(1); // upserted on (user, provider), not accumulated
    expect(rows[0]?.accessToken).toBe('access-2');
    expect(rows[0]?.connectedAt).toBe(first?.connectedAt); // "connected since" means the first time
  });

  /**
   * The rule the whole module exists for. `requireProfile` cannot enforce it: this write is always
   * reached from an action holding a bare `userId`, and D62's erase pass over this table runs exactly
   * once with nothing rescanning it — so a refused write is the only thing standing between a
   * finalizing account and live credentials that outlive it.
   */
  test.each([
    ['deleting'],
    ['deleted'],
  ] as const)('refuses to write credentials for a %s account', async (status) => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, 'leaver', status);

    expect(await store(t, userId)).toEqual({ stored: false });
    expect(await t.run((ctx) => ctx.db.query('activityConnections').collect())).toHaveLength(0);
  });

  /**
   * Moderation states are deliberately *not* in that list. A ban is reversible and its gate belongs at
   * the surfaces a banned user can reach; deletion is the only state that makes the row itself wrong.
   * Stated as a test so nobody "tightens" this into `status !== 'active'` and quietly breaks a
   * suspended skater's watch sync.
   */
  test.each([
    ['suspended'],
    ['banned'],
  ] as const)('still writes for a %s account — moderation is not deletion', async (status) => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, 'moderated', status);

    expect(await store(t, userId)).toEqual({ stored: true });
    expect(await t.run((ctx) => ctx.db.query('activityConnections').collect())).toHaveLength(1);
  });

  test('canConnectAccount answers false for a profile that is gone entirely', async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, 'ghost', 'active');
    await t.run((ctx) => ctx.db.delete(userId));

    expect(await t.run((ctx) => canConnectAccount(ctx, userId))).toBe(false);
  });
});
