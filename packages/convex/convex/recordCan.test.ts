/**
 * **A lever's `can` says yes exactly when its write lands** (B01-4h, D267's one rule). For any history
 * of hides, removals, restores, undos, overturns, keeps and the author's deletions over a person's
 * Report, Post (and its two Reports), comment and hazard, every item is probed with every lever —
 * Restore, Hide again, Overturn, Keep on the record — and with a removal (the write's other takedown):
 * `recordCan` over the item's facts, read here from its documents, answers yes ⇔ the write lands
 * (each write run and rolled back); the item pane's `can` is that same answer; and a refusal is the
 * write's own sentence. Pinned histories, then pinned seeds plus one random seed, logged.
 */

import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import {
  type RecordAction,
  type RecordFacts,
  type RecordLevers,
  recordActorRefusal,
  recordCan,
  recordFactsOf,
  takedownRefusal,
} from './lib/recordRules';
import {
  keepOnRecordImpl,
  overturnVerdictImpl,
  planPostRestore,
  RESTORE_DEFAULT_REASON,
  setContentStatus,
} from './moderation';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 16, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const NOTIF_PREFS = {
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
};

type Kind = 'report' | 'post' | 'comment' | 'hazard';
interface Item {
  kind: Kind;
  id: string;
}

async function world() {
  const t = convexTest(schema, modules);
  const profile = (subject: string, role: 'member' | 'moderator') =>
    t.run(async (ctx) => {
      const id = await ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: subject,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: T0 - 400 * 86_400_000,
      });
      await refreshPersonRow(ctx, id);
      return id;
    });
  const rob = await profile('rob', 'member');
  const kate = await profile('kate', 'member');
  const matt = await profile('matt', 'moderator');
  const items = await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts', 'withdrawals'] as const) {
      await markReady(ctx, b);
    }
    const waterBodyId = await ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: T0,
    });
    const report = (authorId: Id<'profiles'>) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [{ type: 'black_ice' as const }],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      });
    const r0 = await report(rob);
    const m0 = await report(rob);
    const m1 = await report(rob);
    const p = await ctx.db.insert('posts', {
      authorId: rob,
      reportIds: [m0, m1],
      photoIds: [],
      latestSkateEndTime: T0,
      moderationStatus: 'visible',
      createdAt: T0,
      updatedAt: T0,
    });
    for (const id of [m0, m1]) await ctx.db.patch(id, { postId: p });
    await ctx.db.patch(rob, { reportCount: 3 });
    const on = await report(kate);
    const c0 = await ctx.db.insert('comments', {
      reportId: on,
      authorId: rob,
      body: 'Learn to read a thermometer.',
      moderationStatus: 'visible' as const,
      source: 'native' as const,
      createdAt: T0,
    } as never);
    const h0 = await ctx.db.insert('hazards', {
      waterBodyId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
      createdByUserId: rob,
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: T0,
      lastConfirmedAt: T0,
      confirmCount: 0,
      goneCount: 0,
      createdAt: T0,
    });
    return [
      { kind: 'report', id: r0 },
      { kind: 'post', id: p },
      { kind: 'report', id: m0 },
      { kind: 'report', id: m1 },
      { kind: 'comment', id: c0 },
      { kind: 'hazard', id: h0 },
    ] as Item[];
  });
  return {
    t,
    matt,
    items,
    mod: t.withIdentity({ subject: 'matt' }),
    author: t.withIdentity({ subject: 'rob' }),
  };
}
type W = Awaited<ReturnType<typeof world>>;

type Op =
  | { op: 'hide' | 'remove' | 'restore' | 'overturn' | 'keep' | 'delete'; i: number }
  | { op: 'undo' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      op: fc.constantFrom(
        'hide' as const,
        'remove' as const,
        'restore' as const,
        'overturn' as const,
        'keep' as const,
        'delete' as const,
      ),
      i: fc.integer({ min: 0, max: 5 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant<Op>({ op: 'undo' }) },
);

const attempt = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

async function step(w: W, op: Op): Promise<void> {
  vi.advanceTimersByTime(1_000);
  if (op.op === 'undo') {
    const newest = await w.t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .order('desc')
        .collect()
        .then((rows) => rows.find((r) => r.actorId !== undefined && r.action !== 'author_delete')),
    );
    if (newest) await attempt(w.mod.mutation(api.undo.run, { actionId: newest._id }));
    return;
  }
  const item = w.items[op.i] as Item;
  const target = { targetType: item.kind, targetId: item.id };
  switch (op.op) {
    case 'hide':
    case 'remove':
    case 'restore': {
      const status = op.op === 'hide' ? 'hidden' : op.op === 'remove' ? 'removed' : 'visible';
      await attempt(
        w.mod.mutation(api.moderation.setModerationStatus, {
          ...target,
          status,
          ...(status !== 'visible' ? { reason: op.op } : {}),
        }),
      );
      return;
    }
    case 'overturn':
      await attempt(w.mod.mutation(api.moderation.overturnVerdict, target));
      return;
    case 'keep':
      await attempt(w.mod.mutation(api.moderation.keepOnRecord, { ...target, reason: 'kept' }));
      return;
    case 'delete':
      // The clients delete Reports, comments and hazards — never a whole Post.
      if (item.kind === 'report') {
        await attempt(
          w.author.mutation(api.reports.remove, { reportId: item.id as Id<'reports'> }),
        );
      } else if (item.kind === 'comment') {
        await attempt(
          w.author.mutation(api.comments.remove, { commentId: item.id as Id<'comments'> }),
        );
      } else if (item.kind === 'hazard') {
        await attempt(
          w.author.mutation(api.hazardWithdrawal.withdraw, { hazardId: item.id as Id<'hazards'> }),
        );
      }
      return;
  }
}

/**
 * The item's facts, read from its documents here — the item, the decision standing on it, and for a
 * Post its Reports and the restore's plan — the model the reads and the writes are held to.
 */
async function factsOf(ctx: MutationCtx, item: Item): Promise<RecordFacts> {
  const doc = (await ctx.db.get(item.id as Id<'reports'>)) as
    | Doc<'reports'>
    | Doc<'posts'>
    | Doc<'comments'>
    | Doc<'hazards'>
    | null;
  const standing = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_target_standing', (q) =>
      q.eq('targetType', item.kind).eq('targetId', item.id).eq('standing', true),
    )
    .collect();
  const held = standing[0]?.kind ?? null;
  let members: Parameters<typeof recordFactsOf>[3];
  if (item.kind === 'post' && doc !== null) {
    const post = doc as Doc<'posts'>;
    const reports = await Promise.all(post.reportIds.map((id) => ctx.db.get(id)));
    const plan = await planPostRestore(ctx, post, {});
    members = {
      everyWithdrawn: reports.every((r) => r === null || r.authorDeletedAt !== undefined),
      plan: { visibleAfter: plan.visibleAfter, choosable: plan.choosable },
      up: reports.filter((r) => r?.moderationStatus === 'visible').length,
    };
  }
  return recordFactsOf(item.kind, doc, held, members);
}

type Probe = RecordAction | 'remove';
const PROBES: Probe[] = ['restore', 'hideAgain', 'overturn', 'keep', 'remove'];

/** The write a lever (or a removal) runs, as the sheet sends it. */
function writeOf(item: Item, probe: Probe) {
  const target = { targetType: item.kind, targetId: item.id };
  return (ctx: MutationCtx, actor: Doc<'profiles'>): Promise<unknown> => {
    switch (probe) {
      case 'restore':
        return setContentStatus(ctx, actor, {
          ...target,
          status: 'visible',
          reason: RESTORE_DEFAULT_REASON,
          reasonDefaulted: true,
        });
      case 'hideAgain':
        return setContentStatus(ctx, actor, { ...target, status: 'hidden', reason: 'again' });
      case 'remove':
        return setContentStatus(ctx, actor, { ...target, status: 'removed', reason: 'worse' });
      case 'overturn':
        return overturnVerdictImpl(ctx, actor, target);
      case 'keep':
        return keepOnRecordImpl(ctx, actor, { ...target, reason: 'kept' });
    }
  };
}

const ROLLBACK = 'probe';

/**
 * Each item's facts, and for each probe whether its write lands and why not — every write run inside
 * one transaction that is then thrown away, so nothing it wrote survives the probe.
 */
async function probe(w: W, item: Item) {
  const out = new Map<Probe, { landed: boolean; why: string | null }>();
  let facts: RecordFacts | undefined;
  let viewer: Doc<'profiles'> | undefined;
  for (const p of PROBES) {
    try {
      await w.t.run(async (ctx) => {
        viewer = (await ctx.db.get(w.matt)) as Doc<'profiles'>;
        facts = await factsOf(ctx, item);
        let why: string | null = null;
        try {
          await writeOf(item, p)(ctx, viewer);
        } catch (e) {
          why = e instanceof ConvexError ? String(e.data) : (e as Error).message;
        }
        throw new ConvexError({ [ROLLBACK]: why === null ? 'landed' : why });
      });
    } catch (e) {
      const data = (e as ConvexError<Record<string, string>>).data?.[ROLLBACK];
      if (data === undefined) throw e;
      out.set(p, { landed: data === 'landed', why: data === 'landed' ? null : data });
    }
  }
  return { facts: facts as RecordFacts, viewer: viewer as Doc<'profiles'>, out };
}

async function holds(w: W): Promise<void> {
  for (const item of w.items) {
    const { facts, viewer, out } = await probe(w, item);
    for (const p of PROBES) {
      const result = out.get(p) as { landed: boolean; why: string | null };
      const why =
        p === 'remove'
          ? (recordActorRefusal(viewer, facts) ?? takedownRefusal(facts, 'removed'))
          : null;
      const can = p === 'remove' ? null : recordCan(viewer, facts, p);
      // A Post's restore that needs a choice is offered with one; sent without, it is refused.
      const yes = can !== null ? can.ok && can.needsChoice !== true : why === null;
      expect({ item: item.kind, probe: p, facts, landed: result.landed }).toEqual({
        item: item.kind,
        probe: p,
        facts,
        landed: yes,
      });
      // Refused, in the rule's own words.
      if (!result.landed && can !== null && !can.ok) expect(result.why).toBe(can.why);
      if (!result.landed && why !== null) expect(result.why).toBe(why);
    }
    // The pane's lever is the same answer over the same facts.
    const pane = await w.mod.query(api.contentRecord.item, {
      targetType: item.kind,
      targetId: item.id,
    });
    for (const [action, can] of Object.entries((pane?.can ?? {}) as RecordLevers)) {
      expect(can, `${item.kind}: the pane's ${action}`).toEqual(
        recordCan(viewer, facts, action as RecordAction),
      );
    }
  }
}

async function history(ops: Op[]): Promise<void> {
  vi.setSystemTime(T0);
  const w = await world();
  for (const op of ops) await step(w, op);
  await holds(w);
}

/** The states the rule turns on, reached once each (0 r0 · 1 the Post · 2, 3 its Reports). */
const PINNED: Op[][] = [
  // A hide of its own holds it: Hide again changes nothing; a removal still does.
  [{ op: 'hide', i: 0 }],
  // A Post hidden, one Report brought back on its own: hiding the Post again takes that one down.
  [
    { op: 'hide', i: 1 },
    { op: 'restore', i: 2 },
  ],
  // A Post hidden with every Report down too: hiding it again changes nothing.
  [
    { op: 'hide', i: 1 },
    { op: 'hide', i: 2 },
  ],
  // A Report its Post's hide took down, undecided: hiding it is a new decision.
  [{ op: 'hide', i: 1 }],
  // Deleted by its author, then kept: nothing more to take down; an overturn ends it.
  [
    { op: 'delete', i: 0 },
    { op: 'hide', i: 0 },
  ],
  // A removed Post: its Reports' own removals are new decisions; an undo between.
  [{ op: 'remove', i: 1 }, { op: 'undo' }, { op: 'remove', i: 3 }],
];

const SEEDS = [3, 20261116, Math.floor(Math.random() * 2 ** 31)];

describe('can says yes ⇔ the write lands', () => {
  test.each(PINNED.map((ops, i): [number, Op[]] => [i, ops]))('pinned history %i', (_, ops) =>
    history(ops),
  );
  test.each(SEEDS)('seed %i', async (seed) => {
    console.log(`recordCan seed ${seed}`);
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 6 }), history), {
      seed,
      numRuns: 2,
    });
  });
});
