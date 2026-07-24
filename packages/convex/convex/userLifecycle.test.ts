/**
 * Phase 7 user-lifecycle + posting-permission + role mutations (D37/D57). Covers the role gates, the
 * self/admin safety guards, the status patches, the audit-row-written invariant, and that a suspension
 * is enforced by the Convex gate (`requireProfile`) with no Clerk dependency.
 */
import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

type Role = 'member' | 'moderator' | 'admin';

async function seed(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role = 'member',
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'profiles'>>;
}

const as = (t: ReturnType<typeof convexTest>, subject: string) => t.withIdentity({ subject });
const actionsFor = async (t: ReturnType<typeof convexTest>, userId: Id<'profiles'>) => {
  const rows = await t.run((ctx) => ctx.db.query('moderationActions').collect());
  return rows.filter((r) => r.targetType === 'user' && r.targetId === userId);
};

describe('moderation.banUser', () => {
  test('a moderator bans a member — status + reason + one audit row', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'bad');
    await as(t, 'mod').mutation(api.moderation.banUser, { userId: target, reason: 'abuse' });

    const after = await t.run((ctx) => ctx.db.get(target));
    expect(after?.status).toBe('banned');
    expect(after?.statusReason).toBe('abuse');
    const actions = await actionsFor(t, target);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('ban');
  });

  test('a member cannot ban anyone', async () => {
    const t = harness();
    await seed(t, 'member');
    const target = await seed(t, 'bad');
    await expect(
      as(t, 'member').mutation(api.moderation.banUser, { userId: target, reason: 'x' }),
    ).rejects.toThrow(/moderator/);
  });

  test('a moderator cannot ban themselves or an admin', async () => {
    const t = harness();
    const modId = await seed(t, 'mod', 'moderator');
    const adminId = await seed(t, 'boss', 'admin');
    await expect(
      as(t, 'mod').mutation(api.moderation.banUser, { userId: modId, reason: 'x' }),
    ).rejects.toThrow(/your own account/);
    await expect(
      as(t, 'mod').mutation(api.moderation.banUser, { userId: adminId, reason: 'x' }),
    ).rejects.toThrow(/admin/);
  });

  test('a blank reason is rejected', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'bad');
    await expect(
      as(t, 'mod').mutation(api.moderation.banUser, { userId: target, reason: '  ' }),
    ).rejects.toThrow(/reason is required/);
  });
});

describe('moderation.suspendUser / unbanUser', () => {
  test('suspend sets the window and the Convex gate blocks the user until it lapses', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'bad');
    const until = Date.now() + 60 * 60 * 1000;
    await as(t, 'mod').mutation(api.moderation.suspendUser, {
      userId: target,
      reason: 'cooling off',
      suspendedUntil: until,
    });
    const after = await t.run((ctx) => ctx.db.get(target));
    expect(after?.status).toBe('suspended');
    expect(after?.suspendedUntil).toBe(until);
    // The gate bites: a suspended user can't take an authored action (requireProfile throws) — even
    // though reads still work. No Clerk call was needed for any of this.
    await expect(as(t, 'bad').query(api.profiles.current, {})).resolves.toBeTruthy(); // read is fine
    await expect(as(t, 'bad').mutation(api.profiles.updateProfile, { bio: 'hi' })).rejects.toThrow(
      /suspended/,
    );
  });

  test('a suspension end in the past is rejected', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'bad');
    await expect(
      as(t, 'mod').mutation(api.moderation.suspendUser, {
        userId: target,
        reason: 'x',
        suspendedUntil: Date.now() - 1000,
      }),
    ).rejects.toThrow(/future/);
  });

  test('unban returns the account to active and clears the window', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'bad');
    await as(t, 'mod').mutation(api.moderation.banUser, { userId: target, reason: 'abuse' });
    await as(t, 'mod').mutation(api.moderation.unbanUser, { userId: target, reason: 'appeal ok' });
    const after = await t.run((ctx) => ctx.db.get(target));
    expect(after?.status).toBe('active');
    expect(after?.suspendedUntil).toBeUndefined();
    expect(after?.statusReason).toBeUndefined();
    const actions = await actionsFor(t, target);
    expect(actions.map((a) => a.action).sort()).toEqual(['ban', 'unban']);
  });
});

describe('moderation.setPostingPermission (D57)', () => {
  test('flips a single right and audits the direction', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'noisy');
    await as(t, 'mod').mutation(api.moderation.setPostingPermission, {
      userId: target,
      permission: 'comments',
      allowed: false,
      reason: 'toxic in threads',
    });
    const after = await t.run((ctx) => ctx.db.get(target));
    expect(after?.canPostComments).toBe(false);
    // Their report right is untouched — the whole point of the lever.
    expect(after?.canPostReports).toBeUndefined();
    const actions = await actionsFor(t, target);
    expect(actions[0]?.action).toBe('set_posting_permission');
    expect(actions[0]?.metadata).toMatchObject({ permission: 'comments', allowed: false });
  });
});

describe('admin.grantRole / revokeRole (admin-only, D37)', () => {
  test('an admin grants and revokes a role, each audited', async () => {
    const t = harness();
    await seed(t, 'boss', 'admin');
    const target = await seed(t, 'helper');
    await as(t, 'boss').mutation(api.admin.grantRole, {
      userId: target,
      role: 'moderator',
      reason: 'trusted',
    });
    expect((await t.run((ctx) => ctx.db.get(target)))?.role).toBe('moderator');
    await as(t, 'boss').mutation(api.admin.revokeRole, { userId: target, reason: 'stepped down' });
    expect((await t.run((ctx) => ctx.db.get(target)))?.role).toBe('member');
    const actions = await actionsFor(t, target);
    expect(actions.map((a) => a.action).sort()).toEqual(['grant_role', 'revoke_role']);
  });

  test('a moderator cannot grant roles', async () => {
    const t = harness();
    await seed(t, 'mod', 'moderator');
    const target = await seed(t, 'helper');
    await expect(
      as(t, 'mod').mutation(api.admin.grantRole, {
        userId: target,
        role: 'admin',
        reason: 'x',
      }),
    ).rejects.toThrow(/admin/);
  });

  test('an admin cannot revoke their own role (lockout guard)', async () => {
    const t = harness();
    const bossId = await seed(t, 'boss', 'admin');
    await expect(
      as(t, 'boss').mutation(api.admin.revokeRole, { userId: bossId, reason: 'x' }),
    ).rejects.toThrow(/your own role/);
  });

  test('an admin cannot demote themselves via grantRole (the revoke guard, back door)', async () => {
    const t = harness();
    const bossId = await seed(t, 'boss', 'admin');
    await expect(
      as(t, 'boss').mutation(api.admin.grantRole, {
        userId: bossId,
        role: 'moderator',
        reason: 'oops',
      }),
    ).rejects.toThrow(/your own role/);
    expect((await t.run((ctx) => ctx.db.get(bossId)))?.role).toBe('admin');
  });
});
