/**
 * Phase 7 admin queue queries (D37) — role gates, the flag priority lane, the raw-number admin gate,
 * and that reads resolve their context. Seeds profiles directly so role/status can be set precisely.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
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

/**
 * The dedup queue (D36, regrouped for the N7 corpus).
 *
 * Every test here is about the queue being **one card per decision**. The reconciliation pass flags
 * both ends of a duplicate group, so a queue that counts rows shows a moderator twice as much work
 * as exists, in pairs they cannot tell apart — and, before the flag-clearing below, half of those
 * cards could never be cleared at all.
 */
describe('waterBodies.listDedupCandidates (D36 queue)', () => {
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

  type NewBody = Omit<Doc<'waterBodies'>, '_id' | '_creationTime'>;
  const seedBody = (ctx: MutationCtx, doc: Partial<NewBody> & Pick<NewBody, 'name'>) =>
    ctx.db.insert('waterBodies', {
      searchText: doc.name,
      type: 'lakePond',
      source: 'osm',
      polygon: poly,
      bbox,
      centroid,
      dedupStatus: 'clean',
      createdAt: Date.now(),
      ...doc,
    });

  test('returns one group per decision, naming a clean candidate that carries no flag of its own', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const { dup, survivor } = await t.run(async (ctx) => {
      const survivor = await seedBody(ctx, { name: 'Official Pond' });
      const dup = await seedBody(ctx, {
        name: 'Pond (user drawn)',
        source: 'user',
        dedupStatus: 'suspected_duplicate',
        duplicateCandidateIds: [survivor],
      });
      return { dup, survivor };
    });

    const queue = await as(t, 'mod').query(api.waterBodies.listDedupCandidates, {});
    expect(queue.total).toBe(1);
    expect(queue.flaggedRows).toBe(1);
    expect(queue.groups[0]?.members.map((m) => m._id).sort()).toEqual([dup, survivor].sort());
    // The heavy fields never ride the list payload — that's what `getDedupGroup` is for.
    expect(queue.groups[0]?.members[0]).not.toHaveProperty('polygon');
  });

  test('folds a mutually-flagged pair into ONE card, not two', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    await t.run(async (ctx) => {
      const a = await seedBody(ctx, { name: 'Duncan Lake', dedupStatus: 'near_certain' });
      const b = await seedBody(ctx, { name: 'Duncan Lake', dedupStatus: 'near_certain' });
      await ctx.db.patch(a, { duplicateCandidateIds: [b] });
      await ctx.db.patch(b, { duplicateCandidateIds: [a] });
    });

    const queue = await as(t, 'mod').query(api.waterBodies.listDedupCandidates, {});
    expect(queue.total).toBe(1);
    expect(queue.flaggedRows).toBe(2);
    expect(queue.groups[0]?.members).toHaveLength(2);
  });

  test('a merge clears the flag at the other end, so the card cannot come back forever', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const { a, b } = await t.run(async (ctx) => {
      const a = await seedBody(ctx, { name: 'Lovell Lake', dedupStatus: 'near_certain' });
      const b = await seedBody(ctx, { name: 'Lovell Lake', dedupStatus: 'near_certain' });
      await ctx.db.patch(a, { duplicateCandidateIds: [b] });
      await ctx.db.patch(b, { duplicateCandidateIds: [a] });
      return { a, b };
    });

    await as(t, 'mod').mutation(api.waterBodies.merge, { survivorId: a, loserId: b });

    const survivor = await t.run((ctx) => ctx.db.get(a));
    expect(survivor?.dedupStatus).toBe('clean');
    expect(survivor?.duplicateCandidateIds).toBeUndefined();
    const queue = await as(t, 'mod').query(api.waterBodies.listDedupCandidates, {});
    expect(queue.total).toBe(0);
  });

  test('a survivor with another live candidate stays flagged after a merge', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const { a, b } = await t.run(async (ctx) => {
      const a = await seedBody(ctx, { name: 'Mud Pond', dedupStatus: 'near_certain' });
      const b = await seedBody(ctx, { name: 'Mud Pond', dedupStatus: 'near_certain' });
      const c = await seedBody(ctx, { name: 'Mud Pond', dedupStatus: 'near_certain' });
      await ctx.db.patch(a, { duplicateCandidateIds: [b, c] });
      await ctx.db.patch(b, { duplicateCandidateIds: [a, c] });
      await ctx.db.patch(c, { duplicateCandidateIds: [a, b] });
      return { a, b };
    });

    await as(t, 'mod').mutation(api.waterBodies.merge, { survivorId: a, loserId: b });

    const survivor = await t.run((ctx) => ctx.db.get(a));
    expect(survivor?.dedupStatus).toBe('near_certain');
    expect(survivor?.duplicateCandidateIds).toHaveLength(1);
  });

  test('dismissing a group clears both flags, leaves both bodies standing, and is audited', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const { a, b } = await t.run(async (ctx) => {
      const a = await seedBody(ctx, { name: 'North Bay', dedupStatus: 'near_certain' });
      const b = await seedBody(ctx, { name: 'Moosehead Lake', dedupStatus: 'near_certain' });
      await ctx.db.patch(a, { duplicateCandidateIds: [b] });
      await ctx.db.patch(b, { duplicateCandidateIds: [a] });
      return { a, b };
    });

    const cleared = await as(t, 'mod').mutation(api.waterBodies.dismissDuplicates, {
      waterBodyIds: [a, b],
      reason: 'A bay and its parent, not a duplicate',
    });

    expect(cleared).toBe(2);
    const rows = await t.run(async (ctx) => [await ctx.db.get(a), await ctx.db.get(b)]);
    expect(rows.map((r) => r?.dedupStatus)).toEqual(['clean', 'clean']);
    // Not a delete: both rows survive with their merge pointers untouched.
    expect(rows.every((r) => r?.mergedIntoId === undefined)).toBe(true);
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((x) => x.action)).toContain('dismiss_duplicate');

    const queue = await as(t, 'mod').query(api.waterBodies.listDedupCandidates, {});
    expect(queue.total).toBe(0);
  });

  test('getDedupGroup carries the outlines, the overlap, and what is attached to each row', async () => {
    const t = harness();
    await seedProfile(t, 'mod', { role: 'moderator' });
    const { a, b } = await t.run(async (ctx) => {
      const a = await seedBody(ctx, { name: 'Long Pond', dedupStatus: 'near_certain' });
      const b = await seedBody(ctx, {
        name: 'Long Pond',
        dedupStatus: 'near_certain',
        surfaceAreaSqM: 1000,
      });
      await ctx.db.patch(a, { duplicateCandidateIds: [b], surfaceAreaSqM: 2000 });
      await ctx.db.patch(b, { duplicateCandidateIds: [a] });
      return { a, b };
    });

    const detail = await as(t, 'mod').query(api.waterBodies.getDedupGroup, {
      waterBodyIds: [a, b],
    });
    expect(detail.members).toHaveLength(2);
    expect(detail.members[0]?.polygon).toEqual(poly);
    expect(detail.members[0]?.attachments.reports).toEqual({ n: 0, atLeast: false });
    // Identical outlines, so the overlap is total and the stored areas are what disagree.
    expect(detail.pairs[0]?.iou).toBeCloseTo(1, 5);
    expect(detail.pairs[0]?.centroidDistanceM).toBe(0);
    expect(detail.pairs[0]?.areaRatio).toBe(2);
  });
});
