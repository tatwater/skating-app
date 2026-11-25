/**
 * **The Corpus tasks' one writer, under random histories** (B01-7a). Random sequences of the source
 * events — a campaign asserting and dropping reasons (`class-dissent` among them) with its evidence
 * changed or not, a settle by each decision and its reopen, merges and their unmerges, removes and
 * restores, a hard delete — and after every step:
 *
 * - every live 7a question (a `name-conflict` or `class-conflict` on a body neither merged, removed
 *   nor deleted) is the member of exactly one open task, keyed as its fields give;
 * - no task is keyed by a reason 7a doesn't file, and no open task lacks its question;
 * - every count row equals its tally;
 * - the drift repair finds nothing.
 *
 * `CORPUS_PROPERTY_RUNS` scales the runs (the report runs it at 20×).
 */

import { REVIEW_REASONS, type ReviewReason } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { bodyTaskDrift, CORPUS_TASK_LANES_6A, laneCountDrift } from './lib/corpusTaskRepair';
import {
  CORPUS_TASK_REASONS,
  countKeysOf,
  liveReasons,
  reopenTask,
  settleReason,
  taskKeyOf,
} from './lib/corpusTasks';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const RUNS = Math.max(1, Number(process.env.CORPUS_PROPERTY_RUNS ?? 1));

afterEach(() => {
  vi.useRealTimers();
});

const PREFS = {
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
};

const square = (x: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
      [x, 0],
    ],
  ],
});

/** The three catalog records the campaigns re-send: A, B and L (the one merged or deleted). */
const BODIES = ['osm/A', 'osm/B', 'osm/L'] as const;
const DRAWN: ReviewReason[] = ['class-conflict', 'name-conflict', 'class-dissent'];
/** Evidence variants a campaign sends: the same claims, or each changed. */
const NAME_VARIANTS = [
  [
    { source: 'nhd' as const, value: 'The Basin' },
    { source: 'osm' as const, value: 'Lake Auburn' },
  ],
  [
    { source: 'nhd' as const, value: 'The Basin', sources: ['nhd' as const, 'osm' as const] },
    { source: 'osm' as const, value: 'Lake Auburn' },
  ],
  [
    { source: 'nhd' as const, value: 'The Basim' },
    { source: 'osm' as const, value: 'Lake Auburn' },
  ],
];
const CLASS_VARIANTS = [
  [
    { source: 'nhd' as const, value: 'wetland' as const, token: 'nhd:fcode=46600' },
    { source: 'osm' as const, value: 'lakePond' as const, token: 'osm:water=pond' },
  ],
  undefined,
  [
    { source: 'nhd' as const, value: 'lakePond' as const, token: 'nhd:fcode=39004' },
    { source: 'osm' as const, value: 'bay' as const, token: 'osm:water=bay' },
  ],
];

type Ev =
  | { k: 'campaign'; b: number; reasons: boolean[]; names: number; classes: number }
  | { k: 'settle'; b: number; lane: number; decision: number }
  | { k: 'reopen'; i: number }
  | { k: 'merge'; loser: number; survivor: number }
  | { k: 'unmerge'; i: number }
  | { k: 'remove'; b: number }
  | { k: 'restore'; b: number }
  | { k: 'hardDelete'; b: number };

const ev: fc.Arbitrary<Ev> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant('campaign' as const),
      b: fc.nat(2),
      reasons: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      names: fc.nat(2),
      classes: fc.nat(2),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant('settle' as const),
      b: fc.nat(2),
      lane: fc.nat(1),
      decision: fc.nat(2),
    }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('reopen' as const), i: fc.nat(10) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('merge' as const),
      loser: fc.nat(2),
      survivor: fc.nat(2),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('unmerge' as const), i: fc.nat(4) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('remove' as const), b: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('restore' as const), b: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('hardDelete' as const), b: fc.nat(2) }) },
);

type Who = { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
type World = { t: T; mod: Who; admin: Who; merges: Id<'moderationActions'>[] };

async function person(t: T, subject: string, role: 'moderator' | 'admin'): Promise<Who> {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

function record(b: number, reasons: ReviewReason[], names: number, classes: number) {
  const externalId = BODIES[b] as string;
  const x = b * 3;
  const claims = CLASS_VARIANTS[classes];
  return {
    source: 'osm' as const,
    states: ['VT'],
    externalId,
    osmId: externalId,
    name: 'The Basin',
    type: 'lakePond' as const,
    polygon: square(x),
    bbox: { minLat: 0, minLng: x, maxLat: 1, maxLng: x + 1 },
    centroid: { lat: 0.5, lng: x + 0.5 },
    surfaceAreaSqM: 1_000_000 + b,
    ...(reasons.length > 0 ? { reviewReasons: reasons } : {}),
    nameClaims: NAME_VARIANTS[names],
    ...(claims !== undefined ? { classClaims: claims } : {}),
    classRefusals: [{ source: 'osm' as const, token: 'osm:natural=water' }],
  };
}

async function world(): Promise<World> {
  const t = harness();
  const mod = await person(t, 'user_m0', 'moderator');
  const admin = await person(t, 'user_admin', 'admin');
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [0, 1, 2].map((b) => record(b, DRAWN, 0, 0)),
  });
  return { t, mod, admin, merges: [] };
}

/** A refusal (a ConvexError) changes nothing and is part of the history; anything else is a bug. */
async function attempt(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (!(e instanceof ConvexError)) throw e;
  }
}

const bodyOf = (t: T, b: number) =>
  t.run((ctx) =>
    ctx.db
      .query('waterBodies')
      .withIndex('by_external_id', (q) =>
        q.eq('source', 'osm').eq('externalId', BODIES[b] as string),
      )
      .first(),
  );

const pick = <X>(xs: readonly X[], i: number): X | undefined =>
  xs.length === 0 ? undefined : xs[i % xs.length];

async function apply(w: World, e: Ev): Promise<void> {
  const { t } = w;
  switch (e.k) {
    case 'campaign': {
      const reasons = DRAWN.filter((_, i) => e.reasons[i]);
      const ordered = REVIEW_REASONS.filter((r) => reasons.includes(r));
      await t.mutation(internal.waterBodies.importCanonical, {
        bodies: [record(e.b, ordered, e.names, e.classes)],
      });
      return;
    }
    case 'settle': {
      const body = await bodyOf(t, e.b);
      if (!body) return;
      const lane = (['nameConflicts', 'classConflicts'] as const)[e.lane] as 'nameConflicts';
      await t.run(async (ctx) => {
        const task = (
          await ctx.db
            .query('corpusTasks')
            .withIndex('by_body_status', (q) => q.eq('waterBodyId', body._id).eq('status', 'open'))
            .collect()
        ).find((x) => x.lane === lane);
        if (!task) return;
        const actionId = await ctx.db.insert('moderationActions', {
          actorId: w.mod.id,
          action: 'settle_review_reason',
          targetType: 'waterbody',
          targetId: body._id,
          reason: 'Settled',
          createdAt: Date.now(),
        });
        const decision = (['kept', 'renamed', 'reclassed'] as const)[e.decision] as 'kept';
        await settleReason(ctx, { task, decision, actionId, actorId: w.mod.id });
      });
      return;
    }
    case 'reopen': {
      await t.run(async (ctx) => {
        const decided = (await ctx.db.query('corpusTasks').collect()).filter(
          (x) => x.decisionActionId !== undefined,
        );
        const task = pick(decided, e.i);
        if (task?.decisionActionId) await reopenTask(ctx, task.decisionActionId);
      });
      return;
    }
    case 'merge': {
      const survivor = await bodyOf(t, e.survivor);
      const loser = await bodyOf(t, e.loser);
      if (!survivor || !loser) return;
      await attempt(async () => {
        const r = await w.mod.as.mutation(api.waterBodies.merge, {
          survivorId: survivor._id,
          loserId: loser._id,
        });
        w.merges.push(r.actionId);
      });
      return;
    }
    case 'unmerge': {
      const actionId = pick(w.merges, e.i);
      if (!actionId) return;
      vi.useFakeTimers();
      await attempt(() => w.mod.as.mutation(api.undo.run, { actionId, reason: 'Not the same' }));
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      vi.useRealTimers();
      return;
    }
    case 'remove': {
      const body = await bodyOf(t, e.b);
      if (!body) return;
      await attempt(() =>
        w.admin.as.mutation(api.waterBodies.remove, { waterBodyId: body._id, reason: 'junk' }),
      );
      return;
    }
    case 'restore': {
      const body = await bodyOf(t, e.b);
      // A removed body merged since can't be restored: `activateBody` throws a plain error for it
      // (no refusal sentence) — outside the tasks, so the history doesn't ask.
      if (!body || body.mergedIntoId !== undefined) return;
      await attempt(() => w.admin.as.mutation(api.waterBodies.restore, { waterBodyId: body._id }));
      return;
    }
    case 'hardDelete': {
      // The incoming-merge resolution: a second row on another body's OSM id is deleted.
      const loser = await bodyOf(t, e.b);
      const survivorB = (e.b + 1) % 3;
      const survivor = await bodyOf(t, survivorB);
      if (!loser || !survivor || survivor.osmId === undefined) return;
      await t.run((ctx) => ctx.db.patch(loser._id, { osmId: survivor.osmId }));
      await attempt(() =>
        t.mutation(internal.waterBodies.resolveIncomingMergeDuplicates, {
          records: [{ externalId: BODIES[survivorB] as string, osmId: survivor.osmId as string }],
          apply: true,
        }),
      );
      // A delete the resolution skipped leaves the row on its own id again.
      const left = await t.run((ctx) => ctx.db.get(loser._id));
      if (left) await t.run((ctx) => ctx.db.patch(loser._id, { osmId: loser.osmId }));
      return;
    }
  }
}

/** What the invariants find wrong: each a sentence, so a failing step names its hole. */
async function invariants(t: T): Promise<string[]> {
  return t.run(async (ctx) => {
    const holes: string[] = [];
    const bodies = await ctx.db.query('waterBodies').collect();
    const tasks = await ctx.db.query('corpusTasks').collect();
    const counts = await ctx.db.query('corpusTaskCounts').collect();
    const open = tasks.filter((x) => x.status === 'open');
    const byId = new Map(bodies.map((b) => [b._id as string, b]));
    for (const body of bodies) {
      const live = liveReasons(body);
      for (const reason of live) {
        const key = taskKeyOf(reason, body._id);
        const n = open.filter((x) => x.key === key).length;
        if (n !== 1) holes.push(`${key}: ${n} open tasks`);
      }
    }
    for (const task of tasks) {
      const reason = task.key.split(':')[1] as ReviewReason;
      if (!(CORPUS_TASK_REASONS as readonly string[]).includes(reason)) {
        holes.push(`${task.key}: keyed by a reason 7a doesn't file`);
      }
      if (task.status !== 'open') continue;
      const body = byId.get(task.waterBodyId) ?? null;
      const live = liveReasons(body as Doc<'waterBodies'> | null);
      if (!live.has(reason as never) || task.key !== taskKeyOf(reason as never, task.waterBodyId)) {
        holes.push(`${task.key}: open without its question`);
      }
    }
    const tally = new Map<string, number>();
    for (const task of tasks) {
      for (const key of countKeysOf(task)) tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const stored = new Map<string, number>();
    for (const row of counts) stored.set(row.key, (stored.get(row.key) ?? 0) + row.count);
    for (const key of new Set([...tally.keys(), ...stored.keys()])) {
      if ((stored.get(key) ?? 0) !== (tally.get(key) ?? 0)) {
        holes.push(`count ${key}: ${stored.get(key) ?? 0}, tally ${tally.get(key) ?? 0}`);
      }
    }
    const visited = new Set<string>([
      ...bodies.map((b) => b._id),
      ...tasks.map((x) => x.waterBodyId),
    ]);
    for (const id of visited) {
      const drift = await bodyTaskDrift(ctx, id as Id<'waterBodies'>);
      if (drift.length > 0) holes.push(`repair finds ${drift.join(',')} on ${id}`);
    }
    for (const lane of CORPUS_TASK_LANES_6A) {
      const drift = await laneCountDrift(ctx, lane);
      if (drift.length > 0) holes.push(`repair finds counts on ${lane}`);
    }
    return holes;
  });
}

async function run(events: Ev[]) {
  const w = await world();
  expect(await invariants(w.t), 'after the first load').toEqual([]);
  for (const [n, e] of events.entries()) {
    await apply(w, e);
    const holes = await invariants(w.t);
    if (holes.length > 0) {
      throw new Error(`after step ${n} (${JSON.stringify(e)}):\n${holes.join('\n')}`);
    }
  }
}

describe('the one writer, under random histories', () => {
  test.each(['first', 'second', 'third', 'fourth'])(
    'after every step, the stored tasks are what the bodies say (%s draw)',
    async () => {
      await fc.assert(fc.asyncProperty(fc.array(ev, { minLength: 8, maxLength: 30 }), run), {
        numRuns: 6 * RUNS,
        endOnFailure: true,
      });
    },
    120_000 * RUNS,
  );
});

describe('the one writer, pinned histories', () => {
  test('a settle held through a campaign, asked again on changed evidence, then its old decision reopened: overtaken', async () => {
    await run([
      { k: 'settle', b: 0, lane: 1, decision: 2 },
      { k: 'campaign', b: 0, reasons: [true, true, true], names: 0, classes: 0 },
      { k: 'campaign', b: 0, reasons: [true, true, true], names: 0, classes: 2 },
      { k: 'reopen', i: 0 },
    ]);
  });

  test('a merged loser settled before the merge, unmerged, then reopened', async () => {
    await run([
      { k: 'settle', b: 2, lane: 0, decision: 1 },
      { k: 'merge', loser: 2, survivor: 0 },
      { k: 'unmerge', i: 0 },
      { k: 'reopen', i: 0 },
      { k: 'campaign', b: 2, reasons: [false, true, false], names: 2, classes: 1 },
    ]);
  });

  test('a removed body re-imported, restored, then hard-deleted', async () => {
    await run([
      { k: 'remove', b: 1 },
      { k: 'campaign', b: 1, reasons: [true, false, true], names: 1, classes: 0 },
      { k: 'restore', b: 1 },
      { k: 'hardDelete', b: 1 },
      { k: 'campaign', b: 1, reasons: [true, true, false], names: 0, classes: 0 },
    ]);
  });
});
