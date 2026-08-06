/**
 * Phase 7 admin queue queries (D37) — role gates, the flag priority lane, the raw-number admin gate,
 * and that reads resolve their context. Seeds profiles directly so role/status can be set precisely.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

type Role = 'member' | 'moderator' | 'admin';
type Status = Doc<'profiles'>['status'];

async function seedProfile(
  t: ReturnType<typeof convexTest>,
  subject: string,
  opts: {
    role?: Role;
    status?: Status;
    visibility?: 'public' | 'private';
    reputationPoints?: number;
    contradictionCount?: number;
    displayName?: string;
  } = {},
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: opts.displayName ?? subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: opts.visibility ?? 'public',
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
      reputationPoints: opts.reputationPoints ?? 0,
      ...(opts.contradictionCount !== undefined
        ? { contradictionCount: opts.contradictionCount }
        : {}),
      role: opts.role ?? 'member',
      status: opts.status ?? 'active',
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'profiles'>>;
}

const as = (t: ReturnType<typeof convexTest>, subject: string) => t.withIdentity({ subject });

describe('moderation.listFlags (priority lane, D3/D37)', () => {
  test('a member cannot read the queue', async () => {
    const t = harness();
    await seedProfile(t, 'member');
    await expect(as(t, 'member').query(api.moderation.listFlags, {})).rejects.toThrow(/moderator/);
  });

  test('unsafe_false_report lands in the priority lane; spam in standard', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const accused = await seedProfile(t, 'accused');
    const flagger = await seedProfile(t, 'flagger');
    await t.run(async (ctx) => {
      await ctx.db.insert('contentFlags', {
        flaggerId: flagger,
        targetType: 'user',
        targetId: accused,
        reason: 'unsafe_false_report',
        status: 'open',
        createdAt: Date.now() - 1000,
      });
      await ctx.db.insert('contentFlags', {
        flaggerId: flagger,
        targetType: 'user',
        targetId: accused,
        reason: 'spam',
        status: 'open',
        createdAt: Date.now(),
      });
    });

    const queue = await as(t, 'mod').query(api.moderation.listFlags, {});
    expect(queue.priority).toHaveLength(1);
    expect(queue.priority[0]?.reason).toBe('unsafe_false_report');
    // Context resolves the accused user as the target subject.
    expect(queue.priority[0]?.target.summary).toContain('@accused');
    expect(queue.priority[0]?.flagger?.username).toBe('flagger');
    expect(queue.standard).toHaveLength(1);
    expect(queue.standard[0]?.reason).toBe('spam');
  });

  test('resolved flags are excluded from the queue', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const flagger = await seedProfile(t, 'flagger');
    const accused = await seedProfile(t, 'accused');
    await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: flagger,
        targetType: 'user',
        targetId: accused,
        reason: 'spam',
        status: 'dismissed',
        createdAt: Date.now(),
      }),
    );
    const queue = await as(t, 'mod').query(api.moderation.listFlags, {});
    expect(queue.priority).toHaveLength(0);
    expect(queue.standard).toHaveLength(0);
  });
});

describe('profiles.getAdmin (raw-number admin gate, D50)', () => {
  test('a moderator sees perms + contradictionCount but NOT the raw trust number', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const user = await seedProfile(t, 'user', { reputationPoints: 42, contradictionCount: 3 });
    const view = await as(t, 'mod').query(api.profiles.getAdmin, { userId: user });
    expect(view?.contradictionCount).toBe(3);
    expect(view?.canPostComments).toBe(true);
    expect(view?.reputationPoints).toBeUndefined();
  });

  test('an admin sees the raw reputationPoints number', async () => {
    const t = harness();
    await seedProfile(t, 'admin', { role: 'admin' });
    const user = await seedProfile(t, 'user', { reputationPoints: 42 });
    const view = await as(t, 'admin').query(api.profiles.getAdmin, { userId: user });
    expect(view?.reputationPoints).toBe(42);
  });

  test('a member cannot read the admin detail', async () => {
    const t = harness();
    await seedProfile(t, 'member');
    const user = await seedProfile(t, 'user');
    await expect(as(t, 'member').query(api.profiles.getAdmin, { userId: user })).rejects.toThrow(
      /moderator/,
    );
  });
});

describe('admin.userSearch (finds non-public accounts, D37)', () => {
  test('finds a suspended, private user by exact handle', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    await seedProfile(t, 'baddie', { status: 'suspended', visibility: 'private' });
    const hits = await as(t, 'mod').query(api.admin.userSearch, { query: '@baddie' });
    expect(hits.map((h) => h.username)).toContain('baddie');
    expect(hits.find((h) => h.username === 'baddie')?.status).toBe('suspended');
  });

  test('a member cannot search users', async () => {
    const t = harness();
    await seedProfile(t, 'member');
    await expect(as(t, 'member').query(api.admin.userSearch, { query: 'x' })).rejects.toThrow(
      /moderator/,
    );
  });
});

describe('support.list (admin-only inbox, D37 PII)', () => {
  test('a moderator cannot read the support inbox', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    await expect(as(t, 'mod').query(api.support.list, {})).rejects.toThrow(/admin/);
  });

  test('an admin reads tickets, newest first, filterable by status', async () => {
    const t = harness();
    await seedProfile(t, 'admin', { role: 'admin' });
    const user = await seedProfile(t, 'reporter');
    await t.run(async (ctx) => {
      await ctx.db.insert('supportTickets', {
        userId: user,
        category: 'bug',
        body: 'crash on launch',
        status: 'open',
        createdAt: Date.now(),
      });
      await ctx.db.insert('supportTickets', {
        userId: user,
        category: 'account',
        body: 'please reinstate me',
        status: 'resolved',
        createdAt: Date.now() - 1000,
      });
    });
    const all = await as(t, 'admin').query(api.support.list, {});
    expect(all).toHaveLength(2);
    const open = await as(t, 'admin').query(api.support.list, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toBe('crash on launch');
    expect(open[0]?.submitter?.username).toBe('reporter');
  });
});

describe('waterBodies.listDedupCandidates (D36 queue)', () => {
  test('returns suspected duplicates with resolved candidate names; empty otherwise', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const poly = {
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
    };
    const bbox = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
    const centroid = { lat: 0.5, lng: 0.5 };
    const { dup, survivor } = await t.run(async (ctx) => {
      const survivor = await ctx.db.insert('waterBodies', {
        name: 'Official Pond',
        type: 'lakePond',
        source: 'osm',
        polygon: poly,
        bbox,
        centroid,
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
      const dup = await ctx.db.insert('waterBodies', {
        name: 'Pond (user drawn)',
        type: 'lakePond',
        source: 'user',
        polygon: poly,
        bbox,
        centroid,
        dedupStatus: 'suspected_duplicate',
        duplicateCandidateIds: [survivor],
        createdAt: Date.now(),
      });
      return { dup, survivor };
    });

    const queue = await as(t, 'mod').query(api.waterBodies.listDedupCandidates, {});
    expect(queue).toHaveLength(1);
    expect(queue[0]?.body._id).toBe(dup);
    expect(queue[0]?.candidates).toEqual([{ id: survivor, name: 'Official Pond' }]);
  });
});
