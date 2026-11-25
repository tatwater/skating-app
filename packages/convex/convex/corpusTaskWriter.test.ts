/**
 * **The Corpus tasks' one writer** (B01-7a, `lib/corpusTasks.ts`): filing, refreshing, leaving,
 * settling and reopening a task, each with the counts equal to their tallies after it.
 */

import { type ReviewReason, reviewEvidence, UNRECORDED_EVIDENCE } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import type { Doc, Id } from './_generated/dataModel';
import {
  CORPUS_TASK_REASONS,
  corpusTaskBatch,
  corpusTasksPending,
  countKeysOf,
  leaveBodyTasks,
  leaveTask,
  NO_SUCH_TASK,
  readTaskCount,
  reopenTask,
  settleReason,
  syncBodyTasks,
  TASK_DECIDED,
  TASK_LEFT,
  taskKeyOf,
  taskLockRefusal,
  taskToDecide,
} from './lib/corpusTasks';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.UTC(2026, 10, 24, 12);

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72, 44],
      [-72, 44.01],
      [-71.99, 44.01],
      [-71.99, 44],
      [-72, 44],
    ],
  ],
};

const NAME_CLAIMS = [
  { source: 'nhd' as const, value: 'The Basin' },
  { source: 'osm' as const, value: 'Lake Auburn' },
];
const CLASS_CLAIMS = [
  { source: 'nhd' as const, value: 'wetland' as const, token: 'nhd:fcode=46600' },
  { source: 'osm' as const, value: 'lakePond' as const, token: 'osm:water=pond' },
];

async function moderator(t: T, name = 'Casey Example'): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: `clerk_${name}`,
      displayName: name,
      username: name.toLowerCase().replace(/\W/g, ''),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
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
      role: 'moderator',
      status: 'active',
      createdAt: NOW,
    }),
  );
}

async function body(
  t: T,
  extra: Partial<Doc<'waterBodies'>> & { reviewReasons?: ReviewReason[] } = {},
): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'The Basin',
      searchText: 'The Basin Lake Auburn',
      type: 'lakePond',
      source: 'osm',
      polygon: SQUARE,
      bbox: { minLat: 44, minLng: -72, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44.005, lng: -71.995 },
      surfaceAreaSqM: 900_000,
      dedupStatus: 'clean',
      createdAt: NOW,
      displayScore: 0.6,
      nameClaims: NAME_CLAIMS,
      classClaims: CLASS_CLAIMS,
      ...extra,
      ...(extra.reviewReasons ? { reviewReason: primary(extra.reviewReasons) } : {}),
    }),
  );
}

function primary(reasons: ReviewReason[]): ReviewReason | undefined {
  const order: ReviewReason[] = [
    'duplicate-candidate',
    'same-source-duplicate',
    'bay-without-parent',
    'class-dissent',
    'class-conflict',
    'name-conflict',
  ];
  return order.find((r) => reasons.includes(r));
}

async function action(t: T, actorId: Id<'profiles'>, bodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('moderationActions', {
      actorId,
      action: 'settle_review_reason',
      targetType: 'waterbody',
      targetId: bodyId,
      reason: 'Settled from its lane.',
      createdAt: NOW,
    }),
  );
}

const sync = (t: T, id: Id<'waterBodies'>, now = NOW) =>
  t.run((ctx) => syncBodyTasks(ctx, id, { now }));

const tasksOf = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('corpusTasks')
      .withIndex('by_body_status', (q) => q.eq('waterBodyId', id))
      .collect(),
  );

const openTask = async (t: T, id: Id<'waterBodies'>, reason: ReviewReason) =>
  (await tasksOf(t, id)).find(
    (task) => task.status === 'open' && task.key === `reason:${reason}:${id}`,
  );

/** Every count row equals its tally over the stored tasks, and no tally lacks its row. */
async function expectCountsTally(t: T): Promise<Map<string, number>> {
  const { tasks, counts } = await t.run(async (ctx) => ({
    tasks: await ctx.db.query('corpusTasks').collect(),
    counts: await ctx.db.query('corpusTaskCounts').collect(),
  }));
  const tally = new Map<string, number>();
  for (const task of tasks) {
    for (const key of countKeysOf(task)) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const stored = new Map<string, number>();
  for (const row of counts) {
    expect(stored.has(row.key), `one row per key: ${row.key}`).toBe(false);
    stored.set(row.key, row.count);
  }
  for (const key of new Set([...tally.keys(), ...stored.keys()])) {
    expect(stored.get(key) ?? 0, key).toBe(tally.get(key) ?? 0);
  }
  return tally;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConvexError) return String(e.data);
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('filing', () => {
  test('one open task per 7a reason, none for class-dissent or the rest', async () => {
    const t = harness();
    const id = await body(t, {
      reviewReasons: ['class-conflict', 'name-conflict', 'class-dissent', 'bay-without-parent'],
    });
    expect(await sync(t, id)).toEqual({ filed: 2, refreshed: 0, left: 0 });
    const tasks = await tasksOf(t, id);
    expect(tasks.map((task) => task.key).sort()).toEqual(
      [`reason:class-conflict:${id}`, `reason:name-conflict:${id}`].sort(),
    );
    const byLane = Object.fromEntries(tasks.map((task) => [task.lane, task]));
    expect(byLane.nameConflicts).toMatchObject({
      kind: 'reason',
      status: 'open',
      facet: 'different',
      rankKey: -0.6,
      filedAt: NOW,
      refreshedAt: NOW,
      subjectId: id,
    });
    expect(byLane.classConflicts).toMatchObject({ facet: 'wetlandOrLake', rankKey: -0.6 });
    const tally = await expectCountsTally(t);
    expect(Object.fromEntries(tally)).toEqual({
      'open:nameConflicts': 1,
      'open:nameConflicts:different': 1,
      'open:classConflicts': 1,
      'open:classConflicts:wetlandOrLake': 1,
    });
  });

  test('a class conflict with no claims stored files under notRecorded, and a body with no score ranks at 0', async () => {
    const t = harness();
    const id = await body(t, {
      reviewReasons: ['class-conflict'],
      classClaims: undefined,
      displayScore: undefined,
    });
    await sync(t, id);
    expect(await openTask(t, id, 'class-conflict')).toMatchObject({
      facet: 'notRecorded',
      rankKey: 0,
    });
    expect(await t.run((ctx) => readTaskCount(ctx, 'open:classConflicts:notRecorded'))).toBe(1);
    expect(await t.run((ctx) => readTaskCount(ctx, 'open:classConflicts:otherPairs'))).toBe(0);
    await expectCountsTally(t);
  });

  test('is idempotent: a second sync writes nothing', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] });
    await sync(t, id);
    const before = await tasksOf(t, id);
    expect(await sync(t, id, NOW + 1000)).toEqual({ filed: 0, refreshed: 0, left: 0 });
    expect(await tasksOf(t, id)).toEqual(before);
    await expectCountsTally(t);
  });

  test('never on a merged or removed body', async () => {
    const t = harness();
    const survivor = await body(t);
    const merged = await body(t, { reviewReasons: ['name-conflict'], mergedIntoId: survivor });
    const removed = await body(t, { reviewReasons: ['name-conflict'], removedAt: NOW });
    const dormant = await body(t, {
      reviewReasons: ['name-conflict'],
      dormant: { since: NOW, reason: 'inactive' },
    });
    expect(await sync(t, merged)).toEqual({ filed: 0, refreshed: 0, left: 0 });
    expect(await sync(t, removed)).toEqual({ filed: 0, refreshed: 0, left: 0 });
    expect(await sync(t, dormant)).toEqual({ filed: 1, refreshed: 0, left: 0 });
    await expectCountsTally(t);
  });

  test('a body with no reasons, or no name claims stored, files what it carries', async () => {
    const t = harness();
    const quiet = await body(t);
    expect(await sync(t, quiet)).toEqual({ filed: 0, refreshed: 0, left: 0 });
    const bare = await body(t, { reviewReasons: ['name-conflict'], nameClaims: undefined });
    await sync(t, bare);
    expect((await openTask(t, bare, 'name-conflict'))?.facet).toBe('different');
    await expectCountsTally(t);
  });

  test('every 7a reason has a lane: name conflicts and class conflicts', () => {
    expect([...CORPUS_TASK_REASONS]).toEqual(['class-conflict', 'name-conflict']);
  });
});

describe('refreshing', () => {
  test('a facet that moved moves the task and its counts', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['class-conflict'] });
    await sync(t, id);
    await t.run((ctx) =>
      ctx.db.patch(id, {
        classClaims: [
          { source: 'nhd', value: 'lakePond' },
          { source: 'osm', value: 'bay' },
        ],
      }),
    );
    expect(await sync(t, id, NOW + 5)).toEqual({ filed: 0, refreshed: 1, left: 0 });
    expect(await openTask(t, id, 'class-conflict')).toMatchObject({
      facet: 'otherPairs',
      refreshedAt: NOW + 5,
      filedAt: NOW,
    });
    const tally = await expectCountsTally(t);
    expect(tally.get('open:classConflicts:wetlandOrLake')).toBeUndefined();
    expect(tally.get('open:classConflicts:otherPairs')).toBe(1);
  });

  test('a rank that moved moves the task, not its counts', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['name-conflict'] });
    await sync(t, id);
    await t.run((ctx) => ctx.db.patch(id, { displayScore: 0.9 }));
    expect(await sync(t, id)).toEqual({ filed: 0, refreshed: 1, left: 0 });
    expect((await openTask(t, id, 'name-conflict'))?.rankKey).toBe(-0.9);
    await expectCountsTally(t);
  });

  test('a body passed in is not read again', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['name-conflict'] });
    const outcome = await t.run(async (ctx) => {
      const doc = (await ctx.db.get(id)) as Doc<'waterBodies'>;
      await ctx.db.patch(id, { reviewReasons: undefined });
      return syncBodyTasks(ctx, id, { body: doc, now: NOW });
    });
    expect(outcome.filed).toBe(1);
  });
});

describe('leaving', () => {
  test('a reason the campaign stopped asserting leaves notAsserted, and the other stays', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] });
    await sync(t, id);
    await t.run((ctx) =>
      ctx.db.patch(id, { reviewReasons: ['class-conflict'], reviewReason: 'class-conflict' }),
    );
    expect(await sync(t, id, NOW + 9)).toEqual({ filed: 0, refreshed: 0, left: 1 });
    const name = (await tasksOf(t, id)).find((task) => task.lane === 'nameConflicts');
    expect(name).toMatchObject({ status: 'left', leftBecause: 'notAsserted', leftAt: NOW + 9 });
    expect(name?.decidedByUserId).toBeUndefined();
    expect(name?.decision).toBeUndefined();
    expect(await openTask(t, id, 'class-conflict')).toBeDefined();
    await expectCountsTally(t);
  });

  test.each([
    ['merged', (other: Id<'waterBodies'>) => ({ mergedIntoId: other, dedupStatus: 'merged' })],
    ['removed', () => ({ removedAt: NOW })],
  ] as const)('a body %s leaves its tasks by sync', async (because, patch) => {
    const t = harness();
    const other = await body(t);
    const id = await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] });
    await sync(t, id);
    await t.run((ctx) => ctx.db.patch(id, patch(other) as Partial<Doc<'waterBodies'>>));
    expect(await sync(t, id)).toEqual({ filed: 0, refreshed: 0, left: 2 });
    for (const task of await tasksOf(t, id)) {
      expect(task).toMatchObject({ status: 'left', leftBecause: because });
    }
    await expectCountsTally(t);
  });

  test('a deleted body leaves its tasks deleted', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] });
    await sync(t, id);
    await t.run((ctx) => ctx.db.delete(id));
    expect(await sync(t, id)).toEqual({ filed: 0, refreshed: 0, left: 2 });
    for (const task of await tasksOf(t, id)) expect(task.leftBecause).toBe('deleted');
    await expectCountsTally(t);
  });

  test.each(['notAsserted', 'merged', 'removed', 'deleted'] as const)(
    'leaveBodyTasks leaves every open task %s, and no decided one',
    async (because) => {
      const t = harness();
      const mod = await moderator(t);
      const id = await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] });
      await sync(t, id);
      const name = await openTask(t, id, 'name-conflict');
      const actionId = await action(t, mod, id);
      await t.run(async (ctx) =>
        settleReason(
          ctx,
          { task: name as Doc<'corpusTasks'>, decision: 'kept', actionId, actorId: mod },
          { now: NOW },
        ),
      );
      await t.run((ctx) => leaveBodyTasks(ctx, id, because, { now: NOW + 1 }));
      const tasks = await tasksOf(t, id);
      expect(tasks.find((task) => task.lane === 'classConflicts')).toMatchObject({
        status: 'left',
        leftBecause: because,
      });
      expect(tasks.find((task) => task.lane === 'nameConflicts')?.status).toBe('decided');
      await expectCountsTally(t);
    },
  );

  test('a second open task on one key (drift) leaves, and the first stays', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['name-conflict'] });
    await sync(t, id);
    const first = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = first;
      await ctx.db.insert('corpusTasks', rest);
    });
    expect(await sync(t, id)).toEqual({ filed: 0, refreshed: 0, left: 1 });
    const open = (await tasksOf(t, id)).filter((task) => task.status === 'open');
    expect(open.map((task) => task._id)).toEqual([first._id]);
  });
});

describe('deciding', () => {
  async function world(
    reasons: ReviewReason[] = ['class-dissent', 'class-conflict', 'name-conflict'],
  ) {
    const t = harness();
    const mod = await moderator(t);
    const id = await body(t, { reviewReasons: reasons });
    await sync(t, id);
    return { t, mod, id };
  }

  test.each(['kept', 'renamed', 'reclassed'] as const)(
    'the settle (%s) takes the reason off, records its evidence and decides the task',
    async (decision) => {
      const { t, mod, id } = await world();
      const lane = decision === 'reclassed' ? 'class-conflict' : 'name-conflict';
      const task = (await openTask(t, id, lane)) as Doc<'corpusTasks'>;
      const actionId = await action(t, mod, id);
      await t.run((ctx) =>
        settleReason(ctx, { task, decision, actionId, actorId: mod }, { now: NOW + 60_000 }),
      );
      const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
      // In `REVIEW_REASONS` order, as the import writes them.
      const rest = (['class-conflict', 'name-conflict', 'class-dissent'] as const).filter(
        (r) => r !== lane,
      );
      expect(after.reviewReasons).toEqual(rest);
      expect(after.reviewReason).toBe('class-dissent');
      expect(after.reviewSettled).toEqual([
        {
          reason: lane,
          evidence: reviewEvidence(lane, after),
          at: NOW + 60_000,
          actionId,
          // A name Keep records the spelling it kept; a rename is a `user` claim, a reclass no name.
          ...(decision === 'kept' ? { keptName: after.name } : {}),
        },
      ]);
      expect(await t.run((ctx) => ctx.db.get(task._id))).toMatchObject({
        status: 'decided',
        decision,
        decidedAt: NOW + 60_000,
        decidedByUserId: mod,
        decisionActionId: actionId,
      });
      const tally = await expectCountsTally(t);
      expect(tally.get(`open:${task.lane}`)).toBeUndefined();
      // The settle is the queue's: a later sync files nothing back.
      expect(await sync(t, id)).toEqual({ filed: 0, refreshed: 0, left: 0 });
    },
  );

  test('the last reason settled leaves the body with none, and reviewReason absent', async () => {
    const { t, mod, id } = await world(['name-conflict']);
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const actionId = await action(t, mod, id);
    await t.run((ctx) => settleReason(ctx, { task, decision: 'kept', actionId, actorId: mod }));
    const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
    expect(after.reviewReasons).toBeUndefined();
    expect(after.reviewReason).toBeUndefined();
  });

  test('a class settled with no claims stored is settled on unrecorded evidence', async () => {
    const t = harness();
    const mod = await moderator(t);
    const id = await body(t, { reviewReasons: ['class-conflict'], classClaims: undefined });
    await sync(t, id);
    const task = (await openTask(t, id, 'class-conflict')) as Doc<'corpusTasks'>;
    const actionId = await action(t, mod, id);
    await t.run((ctx) => settleReason(ctx, { task, decision: 'kept', actionId, actorId: mod }));
    const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
    expect(after.reviewSettled?.[0]?.evidence).toBe(UNRECORDED_EVIDENCE);
  });

  test('a settle replaces an older entry for the same reason, and keeps the others', async () => {
    const { t, mod, id } = await world(['class-conflict', 'name-conflict']);
    const old = await action(t, mod, id);
    await t.run((ctx) =>
      ctx.db.patch(id, {
        reviewSettled: [
          { reason: 'name-conflict', evidence: 'stale', at: NOW - 1, actionId: old },
          { reason: 'class-dissent', evidence: 'other', at: NOW - 1, actionId: old },
        ],
      }),
    );
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const actionId = await action(t, mod, id);
    await t.run((ctx) => settleReason(ctx, { task, decision: 'kept', actionId, actorId: mod }));
    const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
    expect(after.reviewSettled?.map((s) => [s.reason, s.actionId])).toEqual([
      ['class-dissent', old],
      ['name-conflict', actionId],
    ]);
  });

  test('taskToDecide: the open task, else the lock’s sentence', async () => {
    const { t, mod, id } = await world(['class-conflict', 'name-conflict']);
    const name = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const cls = (await openTask(t, id, 'class-conflict')) as Doc<'corpusTasks'>;
    expect((await t.run((ctx) => taskToDecide(ctx, name._id)))._id).toBe(name._id);

    const actionId = await action(t, mod, id);
    await t.run((ctx) =>
      settleReason(ctx, { task: name, decision: 'renamed', actionId, actorId: mod }),
    );
    expect(await refusal(t.run((ctx) => taskToDecide(ctx, name._id)))).toBe(
      'Decided by Casey Example · renamed',
    );
    // Settling a decided task again is refused the same way, and writes nothing.
    expect(
      await refusal(
        t.run((ctx) => settleReason(ctx, { task: name, decision: 'kept', actionId, actorId: mod })),
      ),
    ).toBe('Decided by Casey Example · renamed');

    await t.run((ctx) => leaveBodyTasks(ctx, id, 'removed'));
    expect(await refusal(t.run((ctx) => taskToDecide(ctx, cls._id)))).toBe(TASK_LEFT.removed);

    await t.run((ctx) => ctx.db.delete(cls._id));
    expect(await refusal(t.run((ctx) => taskToDecide(ctx, cls._id)))).toBe(NO_SUCH_TASK);
  });

  test('the lock without a decider on record says it was decided; a left task without why, that it went away', async () => {
    const { t, id } = await world(['name-conflict']);
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const lock = () =>
      t.run(async (ctx) =>
        taskLockRefusal(ctx, (await ctx.db.get(task._id)) as Doc<'corpusTasks'>),
      );
    await t.run((ctx) => ctx.db.patch(task._id, { status: 'decided', decision: 'kept' }));
    expect(await lock()).toBe(TASK_DECIDED);
    await t.run((ctx) => ctx.db.patch(task._id, { status: 'left' }));
    expect(await lock()).toBe(TASK_LEFT.notAsserted);
  });

  test('leaving a task that is not open writes nothing', async () => {
    const { t, mod, id } = await world(['name-conflict']);
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const actionId = await action(t, mod, id);
    await t.run((ctx) => settleReason(ctx, { task, decision: 'kept', actionId, actorId: mod }));
    const decided = await t.run((ctx) => ctx.db.get(task._id));
    await t.run(async (ctx) =>
      leaveTask(ctx, (await ctx.db.get(task._id)) as Doc<'corpusTasks'>, 'removed'),
    );
    expect(await t.run((ctx) => ctx.db.get(task._id))).toEqual(decided);
    await expectCountsTally(t);
  });

  test('a settle whose reason a drift already took off still records the settle', async () => {
    const { t, mod, id } = await world(['name-conflict']);
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    await t.run((ctx) => ctx.db.patch(id, { reviewReasons: undefined, reviewReason: undefined }));
    const actionId = await action(t, mod, id);
    await t.run((ctx) => settleReason(ctx, { task, decision: 'kept', actionId, actorId: mod }));
    const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
    expect(after.reviewReasons).toBeUndefined();
    expect(after.reviewSettled?.map((s) => s.actionId)).toEqual([actionId]);
    await expectCountsTally(t);
  });

  test('a settle on a deleted body throws, writing nothing', async () => {
    const { t, mod, id } = await world(['name-conflict']);
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const actionId = await action(t, mod, id);
    expect(
      await refusal(
        t.run(async (ctx) => {
          await ctx.db.delete(id);
          await settleReason(ctx, { task, decision: 'kept', actionId, actorId: mod });
        }),
      ),
    ).toBe(TASK_LEFT.deleted);
    expect((await t.run((ctx) => ctx.db.get(task._id)))?.status).toBe('open');
  });
});

describe('reopening (the undo)', () => {
  async function settled(decision: 'kept' | 'renamed' = 'kept') {
    const t = harness();
    const mod = await moderator(t);
    const id = await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] });
    await sync(t, id);
    const before = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
    const task = (await openTask(t, id, 'name-conflict')) as Doc<'corpusTasks'>;
    const actionId = await action(t, mod, id);
    await t.run((ctx) => settleReason(ctx, { task, decision, actionId, actorId: mod }));
    return { t, mod, id, before, task, actionId };
  }

  test('puts the body’s queue fields and the task back as they were', async () => {
    const { t, id, before, task, actionId } = await settled();
    expect(await t.run((ctx) => reopenTask(ctx, actionId, { now: NOW + 7 }))).toBe('reopened');
    const after = (await t.run((ctx) => ctx.db.get(id))) as Doc<'waterBodies'>;
    expect(after.reviewReasons).toEqual(before.reviewReasons);
    expect(after.reviewReason).toEqual(before.reviewReason);
    expect(after.reviewSettled).toBeUndefined();
    const reopened = (await t.run((ctx) => ctx.db.get(task._id))) as Doc<'corpusTasks'>;
    expect(reopened).toMatchObject({
      status: 'open',
      facet: task.facet,
      rankKey: task.rankKey,
      filedAt: task.filedAt,
      refreshedAt: NOW + 7,
    });
    for (const field of ['decidedAt', 'decidedByUserId', 'decision', 'decisionActionId'] as const) {
      expect(reopened[field], field).toBeUndefined();
    }
    await expectCountsTally(t);
    // The sync agrees: nothing to file, refresh or leave.
    expect(await sync(t, id)).toEqual({ filed: 0, refreshed: 0, left: 0 });
    // Undone once: a second undo finds no task the row decided.
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('none');
  });

  test('keeps every other reason’s settled entry', async () => {
    const { t, mod, id, actionId } = await settled();
    const other = await action(t, mod, id);
    const dissent = { reason: 'class-dissent' as const, evidence: 'e', at: NOW, actionId: other };
    await t.run(async (ctx) => {
      const b = (await ctx.db.get(id)) as Doc<'waterBodies'>;
      await ctx.db.patch(id, { reviewSettled: [dissent, ...(b.reviewSettled ?? [])] });
    });
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('reopened');
    expect((await t.run((ctx) => ctx.db.get(id)))?.reviewSettled).toEqual([dissent]);
  });

  test('none for a row that decided no task', async () => {
    const { t, mod, id } = await settled();
    const other = await action(t, mod, id);
    expect(await t.run((ctx) => reopenTask(ctx, other))).toBe('none');
  });

  test('overtaken when a campaign asked it again (its entry dropped, a new task open)', async () => {
    const { t, id, actionId } = await settled();
    await t.run((ctx) =>
      ctx.db.patch(id, {
        reviewReasons: ['class-conflict', 'name-conflict'],
        reviewReason: 'class-conflict',
        reviewSettled: undefined,
      }),
    );
    await sync(t, id);
    const snapshot = await t.run(async (ctx) => ({
      body: await ctx.db.get(id),
      tasks: await ctx.db.query('corpusTasks').collect(),
    }));
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('overtaken');
    expect(
      await t.run(async (ctx) => ({
        body: await ctx.db.get(id),
        tasks: await ctx.db.query('corpusTasks').collect(),
      })),
    ).toEqual(snapshot);
    await expectCountsTally(t);
  });

  test('overtaken when a later decision settled it again', async () => {
    const { t, mod, id, actionId } = await settled();
    const later = await action(t, mod, id);
    await t.run(async (ctx) => {
      const b = (await ctx.db.get(id)) as Doc<'waterBodies'>;
      await ctx.db.patch(id, {
        reviewSettled: (b.reviewSettled ?? []).map((s) => ({ ...s, actionId: later })),
      });
    });
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('overtaken');
  });

  test('overtaken when another task on its key is open (drift)', async () => {
    const { t, id, task, actionId } = await settled();
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = task;
      await ctx.db.insert('corpusTasks', rest);
    });
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('overtaken');
    expect(taskKeyOf('name-conflict', id)).toBe(task.key);
  });

  test.each([
    ['merged away', (other: Id<'waterBodies'>) => ({ mergedIntoId: other })],
    ['removed', () => ({ removedAt: NOW })],
  ] as const)('overtaken when the body was %s since', async (_, patch) => {
    const { t, id, actionId } = await settled();
    const other = await body(t);
    await t.run((ctx) => ctx.db.patch(id, patch(other)));
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('overtaken');
  });

  test('overtaken when the body was deleted since', async () => {
    const { t, id, actionId } = await settled();
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('overtaken');
  });

  test('overtaken when the task is no longer decided (drift)', async () => {
    const { t, task, actionId } = await settled();
    await t.run((ctx) => ctx.db.patch(task._id, { status: 'left', leftBecause: 'notAsserted' }));
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('overtaken');
  });

  test('a reopen re-derives the facet from the body as it now stands', async () => {
    const { t, id, actionId } = await settled('renamed');
    // Shown `The Basim` against NHD's `The Basin` (the top catalog that differs): one letter.
    await t.run((ctx) => ctx.db.patch(id, { name: 'The Basim' }));
    expect(await t.run((ctx) => reopenTask(ctx, actionId))).toBe('reopened');
    expect((await openTask(t, id, 'name-conflict'))?.facet).toBe('oneLetter');
    await expectCountsTally(t);
  });
});

describe('the batch', () => {
  test('moves each count row once, by the sum of its moves, and nests', async () => {
    const t = harness();
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await body(t, { reviewReasons: ['class-conflict', 'name-conflict'] }));
    }
    const rowsMidBatch = await t.run(async (ctx) => {
      let rows = -1;
      await corpusTaskBatch(ctx, async () => {
        for (const id of ids.slice(0, 3)) await syncBodyTasks(ctx, id, { now: NOW });
        await corpusTaskBatch(ctx, async () => {
          for (const id of ids.slice(3)) await syncBodyTasks(ctx, id, { now: NOW });
        });
        // Nothing is counted until the outermost batch ends: the nested one owed its moves too.
        rows = (await ctx.db.query('corpusTaskCounts').collect()).length;
      });
      return rows;
    });
    expect(rowsMidBatch).toBe(0);
    const tally = await expectCountsTally(t);
    expect(tally.get('open:nameConflicts')).toBe(6);
    expect(tally.get('open:classConflicts:wetlandOrLake')).toBe(6);
  });

  test('a batch that throws writes no counts of its own (its transaction is the caller’s)', async () => {
    const t = harness();
    const id = await body(t, { reviewReasons: ['name-conflict'] });
    await expect(
      t.run((ctx) =>
        corpusTaskBatch(ctx, async () => {
          await syncBodyTasks(ctx, id);
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    await expectCountsTally(t);
    // The batch is closed: a later sync outside one writes its counts at once.
    await sync(t, id);
    await expectCountsTally(t);
  });
});

describe('pending', () => {
  test('until the backfill’s run row says done', async () => {
    const t = harness();
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(true);
    const run = await t.run((ctx) =>
      ctx.db.insert('corpusTaskJobRuns', {
        job: 'backfill',
        phase: 'reasons',
        cursor: null,
        done: false,
        startedAt: NOW,
        updatedAt: NOW,
      }),
    );
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(true);
    await t.run((ctx) => ctx.db.patch(run, { done: true }));
    expect(await t.run((ctx) => corpusTasksPending(ctx))).toBe(false);
  });
});
