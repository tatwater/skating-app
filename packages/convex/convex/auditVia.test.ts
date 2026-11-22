/**
 * The `via` marker (D256): a write a person makes through a script keeps the person as the actor and
 * records the script's name, from the caller's identity, on the audit row.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' | 'admin') {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject === 'founder' ? 'Teagan Atwater' : subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        hazardConfirmation: true,
        bountyAnswered: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: false,
        greatReportNearby: false,
        moderatorDecision: false,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
}

const rowsOn = (t: T, userId: Id<'profiles'>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('moderationActions').collect()).filter(
      (r) => r.targetType === 'user' && r.targetId === userId,
    ),
  );

describe('via — what a person made a write through (D256)', () => {
  test('a write made through a script keeps the person as actor and records the script', async () => {
    const t = convexTest(schema, modules);
    const founder = await seedUser(t, 'founder', 'admin');
    const member = await seedUser(t, 'member', 'member');
    const script = t.withIdentity({ subject: 'founder', via: 'seed-destinations' });

    await script.mutation(api.admin.grantRole, { userId: member, role: 'moderator', reason: 'x' });
    const [row] = await rowsOn(t, member);
    expect(row).toMatchObject({ actorId: founder, action: 'grant_role', via: 'seed-destinations' });

    const [view] = await t
      .withIdentity({ subject: 'founder' })
      .query(api.moderation.listActions, { targetType: 'user', targetId: member });
    expect(view?.via).toBe('seed-destinations');
    expect(view?.actor?.displayName).toBe('Teagan Atwater');
  });

  test('a write from a signed-in session records none', async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, 'founder', 'admin');
    const member = await seedUser(t, 'member', 'member');
    await t
      .withIdentity({ subject: 'founder' })
      .mutation(api.admin.grantRole, { userId: member, role: 'moderator', reason: 'x' });
    const [row] = await rowsOn(t, member);
    expect(row?.via).toBeUndefined();
    const [view] = await t
      .withIdentity({ subject: 'founder' })
      .query(api.moderation.listActions, { targetType: 'user', targetId: member });
    expect(view).not.toHaveProperty('via');
  });

  test('a name that fails the rule is dropped, never stored, and the write still lands', async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, 'founder', 'admin');
    for (const [i, bad] of ['Seed Destinations', 'x'.repeat(41), '', '<script>', 42].entries()) {
      const member = await seedUser(t, `member-${i}`, 'member');
      await t
        .withIdentity({ subject: 'founder', via: bad as string })
        .mutation(api.admin.grantRole, { userId: member, role: 'moderator', reason: 'x' });
      const [row] = await rowsOn(t, member);
      expect(row?.action).toBe('grant_role');
      expect(row?.via).toBeUndefined();
    }
  });

  test('its undo behaves as any other, and the undo row carries the undoer’s own marker or none', async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, 'founder', 'admin');
    const member = await seedUser(t, 'member', 'member');
    await t
      .withIdentity({ subject: 'founder', via: 'seed-destinations' })
      .mutation(api.admin.grantRole, { userId: member, role: 'moderator', reason: 'x' });
    const [grant] = await rowsOn(t, member);
    if (!grant) throw new Error('no grant row');

    await t
      .withIdentity({ subject: 'founder' })
      .mutation(api.undo.run, { actionId: grant._id, reason: 'not yet' });
    const rows = await rowsOn(t, member);
    const undo = rows.find((r) => r.undoesActionId === grant._id);
    expect(undo?.actorId).toBe(grant.actorId);
    expect(undo?.via).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(member)))?.role).toBe('member');
  });
});
