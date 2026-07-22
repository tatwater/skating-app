import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

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

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = await t.run((ctx) =>
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
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

describe('blocks.block', () => {
  test('requires authentication', async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedUser(t, 'a');
    await expect(t.mutation(api.blocks.block, { targetUserId: id })).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test('rejects blocking yourself', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await seedUser(t, 'a');
    await expect(as.mutation(api.blocks.block, { targetUserId: id })).rejects.toThrow(
      /cannot block yourself/i,
    );
  });

  test('creates a block row and is idempotent on re-block', async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const first = await a.as.mutation(api.blocks.block, { targetUserId: b.id });
    const second = await a.as.mutation(api.blocks.block, { targetUserId: b.id });
    expect(first).toBe(second);
    const rows = await t.run((ctx) => ctx.db.query('blocks').collect());
    expect(rows).toHaveLength(1);
  });
});

describe('blocks.unblock', () => {
  test('removes the block and is a no-op when absent', async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    await a.as.mutation(api.blocks.block, { targetUserId: b.id });
    await a.as.mutation(api.blocks.unblock, { targetUserId: b.id });
    expect(await t.run((ctx) => ctx.db.query('blocks').collect())).toHaveLength(0);
    // Idempotent — unblocking again doesn't throw.
    await expect(a.as.mutation(api.blocks.unblock, { targetUserId: b.id })).resolves.toBeNull();
  });

  test('only removes the caller’s own edge, not one placed on them', async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    await b.as.mutation(api.blocks.block, { targetUserId: a.id }); // b blocks a
    await a.as.mutation(api.blocks.unblock, { targetUserId: b.id }); // a tries to unblock b — no edge
    expect(await t.run((ctx) => ctx.db.query('blocks').collect())).toHaveLength(1);
  });
});

describe('blocks.myBlocks', () => {
  test('lists the users the caller blocked, newest first, with attribution', async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const c = await seedUser(t, 'c');
    await a.as.mutation(api.blocks.block, { targetUserId: b.id });
    await a.as.mutation(api.blocks.block, { targetUserId: c.id });
    const list = await a.as.query(api.blocks.myBlocks, {});
    expect(list.map((r) => r.userId)).toEqual([c.id, b.id]); // newest first
    expect(list[0]).toMatchObject({ username: 'c', displayName: 'c' });
  });
});

describe('blocks.blockedUserIds', () => {
  test('unions both directions — outgoing AND incoming blocks (D32)', async () => {
    const t = convexTest(schema, modules);
    const me = await seedUser(t, 'me');
    const iBlocked = await seedUser(t, 'iBlocked');
    const blockedMe = await seedUser(t, 'blockedMe');
    const unrelated = await seedUser(t, 'unrelated');
    await me.as.mutation(api.blocks.block, { targetUserId: iBlocked.id }); // outgoing
    await blockedMe.as.mutation(api.blocks.block, { targetUserId: me.id }); // incoming

    const ids = await me.as.query(api.blocks.blockedUserIds, {});
    expect([...ids].sort()).toEqual([iBlocked.id, blockedMe.id].sort());
    expect(ids).not.toContain(unrelated.id);
  });
});
