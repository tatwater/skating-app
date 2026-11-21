/**
 * Two runs of the same chained job, alive at once (B01 §5.7, `lib/peopleRuns`). For each of the six
 * chained People jobs — the five backfills, the lapsed-suspension sweep, its daily retry — a property
 * drives run A (whose passes are delayed) and run B (a recovery, or the next cron tick, started once
 * the old run reads as stalled) through arbitrary interleavings of their passes, with failures and
 * items added mid-run. It holds that a superseded run's pass changes nothing and schedules nothing,
 * that the job always terminates, and that the conclusion is true: a backfill is `ready` exactly when
 * the run that ended recorded no failures, and never while an item is unfixed; a lapse run that ends
 * with no failures left no lapse it began with. Passes are
 * run by hand from the scheduler's own records, in the order the property picks.
 */

import type { FunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import * as flagSubjectLib from './lib/flagSubject';
import * as peopleRows from './lib/peopleRows';
import {
  BACKFILL_STALL_MS,
  endRun,
  foundGap,
  LEASE_READS,
  PASS_SIZE,
  PEOPLE_BACKFILLS,
  type PeopleJob,
  type RunView,
  readPending,
  readRun,
  savePass,
  takeLease,
} from './lib/peopleRuns';
import * as withdrawalsLib from './lib/withdrawals';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;

const sizes = { ...PASS_SIZE };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  for (const job of Object.keys(PASS_SIZE) as PeopleJob[]) PASS_SIZE[job] = 1;
});
afterEach(() => {
  Object.assign(PASS_SIZE, sizes);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

function profile(subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return {
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
    createdAt: T0 - 86_400_000,
    ...over,
  };
}

// ── One spec per chained job ──

interface Spec {
  job: PeopleJob;
  /** The scheduler's name for the job. */
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: each job's own argument shape
  ref: FunctionReference<'mutation', 'internal', any>;
  /** How the next run is started: the documented recovery, or a cron tick. */
  restart: Record<string, unknown>;
  /** An item that needs the job's work (written before this build, or due). */
  seed: (ctx: MutationCtx, i: number) => Promise<unknown>;
  /** An item added mid-run: through the write path for a backfill, a new due item for a lapse job. */
  add: (ctx: MutationCtx, i: number) => Promise<unknown>;
  /** The items still needing the work. */
  remaining: (ctx: MutationCtx) => Promise<string[]>;
  /** Make the job's next item fail once; `null` when the job has no way to fail an item. */
  failOnce: (() => void) | null;
  /** The tables a pass may write. */
  tables: readonly string[];
  /** The conclusion holds, for the run that is current at the end. */
  holds: (row: Doc<'peopleJobRuns'>, remaining: string[], beganWith: Set<string>) => boolean;
  /**
   * The other functions a run's passes are (the content record's walk, replays and clocks), by the
   * scheduler's name — each carries its run's lease as `lease` rather than at the top level.
   */
  // biome-ignore lint/suspicious/noExplicitAny: each job's own argument shape
  chain?: Record<string, FunctionReference<'mutation', 'internal', any>>;
  /** Runs of the property, when the job's passes are many (the content record's clocks walk seven kinds). */
  runs?: number;
}

/** A Report by `authorId` on a body (the record's replay reads only the Report). */
async function reportRow(ctx: MutationCtx, authorId: Id<'profiles'>) {
  const waterBodyId =
    (await ctx.db.query('waterBodies').first())?._id ??
    (await ctx.db.insert('waterBodies', {
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
    }));
  return {
    authorId,
    waterBodyId,
    point: { lat: 0, lng: 0 },
    skateEndTime: T0,
    reportTime: T0,
    source: 'native' as const,
    iceTypes: [],
    surfaceTags: [],
    photoIds: [],
    moderationStatus: 'hidden' as const,
    hazardIdsCreated: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

async function filer(ctx: MutationCtx): Promise<Id<'profiles'>> {
  const found = await ctx.db
    .query('profiles')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', 'filer'))
    .first();
  if (found) return found._id;
  const id = await ctx.db.insert('profiles', profile('filer'));
  await peopleRows.refreshPersonRow(ctx, id);
  return id;
}

/**
 * A backfill's conclusion: `ready` exactly when the run that ended recorded no failures, and never
 * while an item is unfixed. (A failure on an item already fixed — a refresh of a row that exists —
 * still counts: the row may be stale, so "not ready" is the honest answer.)
 */
const backfillHolds: Spec['holds'] = (row, remaining) =>
  row.ready === (row.failed === 0) && (!row.ready || remaining.length === 0);
const lapseHolds: Spec['holds'] = (row, remaining, beganWith) =>
  row.failed > 0 || remaining.every((id) => !beganWith.has(id));

const failRefresh = () =>
  vi.spyOn(peopleRows, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));

const lapsed = (ctx: MutationCtx, i: number, over: Partial<Doc<'profiles'>> = {}) =>
  ctx.db.insert(
    'profiles',
    profile(`l${i}`, { status: 'suspended', suspendedUntil: T0 - 100_000 + i, ...over }),
  );

const stillSuspended = async (ctx: MutationCtx) =>
  (await ctx.db.query('profiles').collect())
    .filter((p) => p.status === 'suspended' && (p.suspendedUntil ?? 0) <= Date.now())
    .map((p) => p._id as string);

const SPECS: Spec[] = [
  {
    job: 'rows',
    name: 'peopleJobs:backfillRows',
    ref: internal.peopleJobs.backfillRows,
    restart: { alone: true },
    seed: (ctx, i) => ctx.db.insert('profiles', profile(`s${i}`)),
    add: async (ctx, i) => {
      const id = await ctx.db.insert('profiles', profile(`a${i}`));
      await peopleRows.refreshPersonRow(ctx, id);
    },
    remaining: async (ctx) => {
      const rows = new Set((await ctx.db.query('peopleRows').collect()).map((r) => r.userId));
      return (await ctx.db.query('profiles').collect())
        .filter((p) => !rows.has(p._id))
        .map((p) => p._id);
    },
    failOnce: failRefresh,
    tables: ['profiles', 'peopleRows', 'peopleCounts', 'peopleJobRuns', 'peopleJobProgress'],
    holds: backfillHolds,
  },
  {
    job: 'flagSubjects',
    name: 'peopleJobs:backfillFlagSubjects',
    ref: internal.peopleJobs.backfillFlagSubjects,
    restart: { alone: true },
    seed: async (ctx, i) =>
      ctx.db.insert('contentFlags', {
        flaggerId: await filer(ctx),
        targetType: 'report',
        targetId: `r${i}`,
        reason: 'spam',
        status: 'open',
        createdAt: T0 - 1_000 + i,
      }),
    add: async (ctx, i) =>
      ctx.db.insert('contentFlags', {
        flaggerId: await filer(ctx),
        targetType: 'report',
        targetId: `n${i}`,
        reason: 'spam',
        status: 'open',
        subjectUserId: null,
        createdAt: Date.now(),
      }),
    remaining: async (ctx) =>
      (await ctx.db.query('contentFlags').collect())
        .filter((f) => f.subjectUserId === undefined)
        .map((f) => f._id),
    failOnce: () =>
      vi.spyOn(flagSubjectLib, 'flagSubjectOf').mockRejectedValueOnce(new Error('poison')),
    tables: ['contentFlags', 'peopleJobRuns', 'peopleJobProgress'],
    holds: backfillHolds,
  },
  {
    job: 'undoChains',
    name: 'peopleJobs:backfillUndoChains',
    ref: internal.peopleJobs.backfillUndoChains,
    restart: { alone: true },
    seed: async (ctx, i) => {
      const base = {
        actorId: await filer(ctx),
        targetType: 'user' as const,
        targetId: `u${i}`,
        reason: 'r',
        action: 'set_posting_permission' as const,
      };
      const first = await ctx.db.insert('moderationActions', { ...base, createdAt: T0 - 9_000 });
      await ctx.db.insert('moderationActions', {
        ...base,
        undoesActionId: first,
        createdAt: T0 - 8_000,
      });
    },
    // The audit writer places an undo as it writes it; a plain row needs nothing.
    add: async (ctx, i) =>
      ctx.db.insert('moderationActions', {
        actorId: await filer(ctx),
        targetType: 'user',
        targetId: `n${i}`,
        reason: 'r',
        action: 'set_posting_permission',
        createdAt: Date.now(),
      }),
    remaining: async (ctx) =>
      (await ctx.db.query('moderationActions').collect())
        .filter((r) => r.undoesActionId !== undefined && r.undoRoot === undefined)
        .map((r) => r._id),
    // Placing a chain is two patches in the pass's own transaction: nothing to fail one item.
    failOnce: null,
    tables: ['moderationActions', 'peopleJobRuns', 'peopleJobProgress'],
    holds: backfillHolds,
  },
  {
    // The content record (B01-4d): one run across the walk, each item's replay and the clocks.
    job: 'verdicts',
    name: 'peopleJobs:backfillVerdicts',
    ref: internal.peopleJobs.backfillVerdicts,
    restart: { alone: true },
    // A moderator's hide recorded before the record existed: its verdict is the backfill's to make.
    seed: async (ctx, i) => {
      const author = await filer(ctx);
      const reportId = await ctx.db.insert('reports', await reportRow(ctx, author));
      await ctx.db.insert('moderationActions', {
        actorId: author,
        action: 'hide',
        targetType: 'report',
        targetId: reportId,
        reason: `seed ${i}`,
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: T0 - 5_000 + i,
      });
    },
    // The live writers record a verdict as they hide: nothing for the backfill to fix.
    add: async (ctx, i) => {
      const author = await filer(ctx);
      const reportId = await ctx.db.insert('reports', await reportRow(ctx, author));
      const actionId = await ctx.db.insert('moderationActions', {
        actorId: author,
        action: 'hide',
        targetType: 'report',
        targetId: reportId,
        reason: `added ${i}`,
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: Date.now(),
      });
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: author,
        targetType: 'report',
        targetId: reportId,
        actionId,
        kind: 'hidden',
        at: Date.now(),
        standing: true,
        superseded: false,
      });
    },
    remaining: async (ctx) => {
      const made = new Set(
        (await ctx.db.query('contentVerdicts').collect())
          .filter((v) => v.superseded === false)
          .map((v) => v.actionId as string),
      );
      return (await ctx.db.query('moderationActions').collect())
        .filter((r) => r.action === 'hide' && !made.has(r._id))
        .map((r) => r._id);
    },
    // A pass that throws stalls its run (the recovery's case); no item fails on its own.
    failOnce: null,
    tables: ['contentVerdicts', 'reports', 'peopleJobRuns', 'peopleJobProgress'],
    holds: backfillHolds,
    runs: 7,
    chain: {
      'contentRecord:backfillVerdicts': internal.contentRecord.backfillVerdicts,
      'contentRecord:replayVerdictHistory': internal.contentRecord.replayVerdictHistory,
      'erasure:backfillClocks': internal.erasure.backfillClocks,
    },
  },
  {
    // The withdrawal rows (B01-4m): one per item a person took back, walked person by person.
    job: 'withdrawals',
    name: 'peopleJobs:backfillWithdrawals',
    ref: internal.peopleJobs.backfillWithdrawals,
    restart: { alone: true },
    // A Report its author deleted before the rows existed: its row is the backfill's to make.
    seed: async (ctx, i) => {
      const author = await filer(ctx);
      await ctx.db.insert('reports', {
        ...(await reportRow(ctx, author)),
        moderationStatus: 'removed',
        authorDeletedAt: T0 - 5_000 + i,
      });
    },
    // The live writers keep the row as they withdraw: nothing for the backfill to fix.
    add: async (ctx, i) => {
      const author = await filer(ctx);
      const id = await ctx.db.insert('reports', {
        ...(await reportRow(ctx, author)),
        moderationStatus: 'removed',
        authorDeletedAt: Date.now() + i,
      });
      await withdrawalsLib.syncWithdrawalById(ctx, 'report', id);
    },
    remaining: async (ctx) => {
      const rows = new Set(
        (await ctx.db.query('contentWithdrawals').collect()).map((r) => r.targetId),
      );
      return (await ctx.db.query('reports').collect())
        .filter((r) => r.authorDeletedAt !== undefined && !rows.has(r._id))
        .map((r) => r._id);
    },
    failOnce: () =>
      vi.spyOn(withdrawalsLib, 'syncWithdrawal').mockRejectedValueOnce(new Error('poison')),
    tables: ['contentWithdrawals', 'peopleJobRuns', 'peopleJobProgress'],
    holds: backfillHolds,
  },
  {
    job: 'lapseSweep',
    name: 'peopleJobs:sweepLapsedSuspensions',
    ref: internal.peopleJobs.sweepLapsedSuspensions,
    restart: {},
    seed: (ctx, i) => lapsed(ctx, i),
    add: (ctx, i) => lapsed(ctx, 1_000 + i),
    remaining: stillSuspended,
    failOnce: failRefresh,
    tables: ['profiles', 'peopleRows', 'moderationActions', 'peopleJobRuns', 'peopleJobProgress'],
    holds: lapseHolds,
  },
  {
    job: 'lapseRetry',
    name: 'peopleJobs:retryLapsedDaily',
    ref: internal.peopleJobs.retryLapsedDaily,
    restart: {},
    seed: (ctx, i) =>
      lapsed(ctx, i, { lapseAttempts: 3, lapseParkedAt: T0 - 50_000 + i, lapseErrorClass: 'x' }),
    add: (ctx, i) =>
      lapsed(ctx, 1_000 + i, {
        lapseAttempts: 3,
        lapseParkedAt: T0 - 40_000 + i,
        lapseErrorClass: 'x',
      }),
    remaining: stillSuspended,
    failOnce: failRefresh,
    tables: ['profiles', 'peopleRows', 'moderationActions', 'peopleJobRuns', 'peopleJobProgress'],
    holds: lapseHolds,
  },
];

// ── The harness: passes run by hand, from the scheduler's records ──

interface Pending {
  id: Id<'_scheduled_functions'>;
  name: string;
  run: number;
  // biome-ignore lint/suspicious/noExplicitAny: the job's own arguments, passed through
  args: any;
}

/** A pass's run and token: at the top level, or — a chained function's pass — in its `lease`. */
function leaseOf(args: { run?: number; pass?: number; lease?: { run: number; pass: number } }) {
  return args.lease ?? { run: args.run, pass: args.pass };
}

async function pendingPasses(t: T, spec: Spec): Promise<Pending[]> {
  const all = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  return all
    .filter(
      (f) =>
        (f.name === spec.name || (spec.chain !== undefined && f.name in spec.chain)) &&
        f.state.kind === 'pending',
    )
    .map((f) => ({
      id: f._id,
      name: f.name,
      run: leaseOf(f.args[0] as Parameters<typeof leaseOf>[0]).run as number,
      args: f.args[0],
    }));
}

function refOf(spec: Spec, name: string) {
  return name === spec.name ? spec.ref : (spec.chain?.[name] ?? spec.ref);
}

/** The job's run as its passes see it: the run row with its current progress (`lib/peopleRuns`). */
async function runRow(t: T, job: PeopleJob): Promise<RunView | null> {
  return t.run((ctx) => readRun(ctx, job));
}

async function snapshot(t: T, spec: Spec): Promise<string> {
  return t.run(async (ctx) => {
    const out: Record<string, unknown> = {};
    // biome-ignore lint/suspicious/noExplicitAny: the spec's tables by name
    for (const table of spec.tables) out[table] = await ctx.db.query(table as any).collect();
    return JSON.stringify(out);
  });
}

/** Run one scheduled pass by hand; a superseded one must change nothing and schedule nothing. */
async function runPass(t: T, spec: Spec, pass: Pending): Promise<void> {
  await t.run((ctx) => ctx.scheduler.cancel(pass.id));
  await runArgs(t, spec, pass.args, pass.name);
}

/**
 * Run a pass's arguments: a pass of a run that isn't current — or whose token was already used, as
 * when its arguments are replayed by hand — must change nothing and schedule nothing.
 */
async function runArgs(
  t: T,
  spec: Spec,
  // biome-ignore lint/suspicious/noExplicitAny: the job's own arguments, passed through
  args: any,
  name: string = spec.name,
): Promise<void> {
  const row = await runRow(t, spec.job);
  const lease = leaseOf(args);
  const holds = row?.running === true && row.run === lease.run && row.pass === lease.pass;
  const ref = refOf(spec, name);
  if (!holds) {
    const before = await snapshot(t, spec);
    const scheduledBefore = (await pendingPasses(t, spec)).length;
    await t.mutation(ref, args);
    expect(await snapshot(t, spec), 'a stale pass changed nothing').toBe(before);
    expect((await pendingPasses(t, spec)).length, 'and scheduled nothing').toBe(scheduledBefore);
    return;
  }
  await t.mutation(ref, args);
}

type Op =
  | { kind: 'step'; which: 'A' | 'B' }
  | { kind: 'restart' }
  | { kind: 'add' }
  | { kind: 'fail' }
  | { kind: 'replay' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom<Op>({ kind: 'step', which: 'A' }, { kind: 'step', which: 'B' }),
  },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'restart' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'add' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'fail' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'replay' }) },
);

/** Drive the job through `ops` from `seeded` items; returns the final state for the assertions. */
async function drive(spec: Spec, seeded: number, ops: Op[]) {
  vi.setSystemTime(T0);
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < seeded; i++) await spec.seed(ctx, i);
  });
  const remainingNow = () => t.run((ctx) => spec.remaining(ctx));
  await t.mutation(spec.ref, {});
  const runA = (await runRow(t, spec.job))?.run as number;
  let runB: number | null = null;
  let beganWith = new Set(await remainingNow());
  let added = 0;
  // biome-ignore lint/suspicious/noExplicitAny: the passes' own arguments
  const ran: any[] = [];
  for (const op of ops) {
    if (op.kind === 'fail' && spec.failOnce) spec.failOnce();
    if (op.kind === 'add') {
      // The write path is not the job: an armed failure is for the job's own next item.
      vi.restoreAllMocks();
      await t.run((ctx) => spec.add(ctx, added++));
    }
    if (op.kind === 'restart' && runB === null) {
      // The old run reads as stalled before the recovery (or the next tick) starts.
      vi.setSystemTime(Date.now() + BACKFILL_STALL_MS + 1);
      beganWith = new Set(await remainingNow());
      await t.mutation(spec.ref, spec.restart);
      runB = (await runRow(t, spec.job))?.run as number;
    }
    if (op.kind === 'step') {
      const want = op.which === 'A' ? runA : runB;
      const pass = (await pendingPasses(t, spec)).find((p) => p.run === want);
      if (pass) {
        await runPass(t, spec, pass);
        ran.push(pass);
      }
    }
    // A pass's arguments run again by hand: its token is spent, so it does nothing.
    const last = ran[ran.length - 1];
    if (op.kind === 'replay' && last !== undefined) await runArgs(t, spec, last.args, last.name);
  }
  // Every pass left runs, in any order: the job must terminate.
  for (let i = 0; ; i++) {
    expect(i, 'the job terminates').toBeLessThan(500);
    const pass = (await pendingPasses(t, spec))[0];
    if (!pass) break;
    await runPass(t, spec, pass);
  }
  vi.restoreAllMocks();
  const row = (await runRow(t, spec.job)) as RunView;
  return { t, row, remaining: await remainingNow(), beganWith };
}

describe.each(SPECS)('$job: two runs at once', (spec) => {
  test('a superseded run changes nothing, the job terminates, and its conclusion is true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(opArb, { maxLength: 14 }),
        async (n, ops) => {
          const { row, remaining, beganWith } = await drive(spec, n, ops);
          expect(row.running).toBe(false);
          expect(spec.holds(row, remaining, beganWith)).toBe(true);
        },
      ),
      { numRuns: spec.runs ?? 12 },
    );
  });
});

describe('the Greptile sequence (rows): a delayed old run can no longer conclude for the new one', () => {
  test('A fails a person, stalls, B recovers; A’s delayed passes then do nothing, and ready waits for B', async () => {
    const spec = SPECS[0] as Spec;
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) await spec.seed(ctx, i);
    });
    // A's first pass fails the first person and schedules its next pass, which is delayed.
    failRefresh();
    await t.mutation(spec.ref, {});
    expect((await runRow(t, 'rows'))?.failed).toBe(1);
    // Stalled: the recovery starts B, which makes A non-current before it does anything.
    vi.setSystemTime(T0 + BACKFILL_STALL_MS + 1);
    await t.mutation(spec.ref, { alone: true });
    expect((await runRow(t, 'rows'))?.run).toBe(2);
    // A's delayed passes, run to the end before B goes on: each changes nothing.
    for (;;) {
      const pass = (await pendingPasses(t, spec)).find((p) => p.run === 1);
      if (!pass) break;
      await runPass(t, spec, pass);
    }
    expect((await runRow(t, 'rows'))?.ready).toBe(false);
    // B walks on to the end and only then concludes, every row there.
    for (;;) {
      const pass = (await pendingPasses(t, spec))[0];
      if (!pass) break;
      await runPass(t, spec, pass);
    }
    expect(await t.run((ctx) => spec.remaining(ctx))).toEqual([]);
    expect(await runRow(t, 'rows')).toMatchObject({
      run: 2,
      ready: true,
      running: false,
      failed: 0,
    });
  });
});

describe('a new run begun mid-range (rows): it never saw the start, so it cannot conclude ready', () => {
  test('A fails the first person; B starts at A’s cursor, ends clean, and the backfill stays not ready', async () => {
    const spec = SPECS[0] as Spec;
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) await spec.seed(ctx, i);
    });
    failRefresh();
    await t.mutation(spec.ref, { alone: true });
    const a = (await runRow(t, 'rows')) as RunView;
    expect(a).toMatchObject({ run: 1, failed: 1 });
    // A new run (no `run`) from A's recorded cursor: everything before it is behind B.
    await t.mutation(spec.ref, { alone: true, cursor: a.cursor });
    for (;;) {
      const pass = (await pendingPasses(t, spec))[0];
      if (!pass) break;
      await runPass(t, spec, pass);
    }
    expect(await t.run((ctx) => spec.remaining(ctx))).toHaveLength(1);
    expect(await runRow(t, 'rows')).toMatchObject({
      run: 2,
      running: false,
      failed: 0,
      ready: false,
    });
    // The documented re-run, from the start, is what concludes.
    await t.mutation(spec.ref, { alone: true });
    for (;;) {
      const pass = (await pendingPasses(t, spec))[0];
      if (!pass) break;
      await runPass(t, spec, pass);
    }
    expect(await t.run((ctx) => spec.remaining(ctx))).toEqual([]);
    expect(await runRow(t, 'rows')).toMatchObject({ run: 3, ready: true });
    // Begun part-way with nothing to fix, it keeps that conclusion; meeting a gap, it gives it up.
    const drainAll = async () => {
      for (;;) {
        const pass = (await pendingPasses(t, spec))[0];
        if (!pass) break;
        await runPass(t, spec, pass);
      }
    };
    const profiles = await t.run((ctx) => ctx.db.query('profiles').collect());
    const cursor = String(profiles[0]?._creationTime);
    await t.mutation(spec.ref, { alone: true, cursor });
    await drainAll();
    expect(await runRow(t, 'rows')).toMatchObject({ run: 4, ready: true });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', profiles[2]?._id as Id<'profiles'>))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
    await t.mutation(spec.ref, { alone: true, cursor });
    await drainAll();
    expect(await t.run((ctx) => spec.remaining(ctx))).toEqual([]);
    expect(await runRow(t, 'rows')).toMatchObject({ run: 5, failed: 0, ready: false });
  });
});

// ── A pass writes nothing a People read depends on (B01-4j) ──

/**
 * Wrap a context's database so every table it queries and every document it gets is recorded — the
 * read set a Convex subscription would hold, by table.
 */
function recording(ctx: QueryCtx): { ctx: QueryCtx; tables: Set<string>; gets: number } {
  const seen = { tables: new Set<string>(), gets: 0 };
  const db = new Proxy(ctx.db, {
    get(target, key, receiver) {
      if (key === 'query')
        return (table: string) => {
          seen.tables.add(table);
          // biome-ignore lint/suspicious/noExplicitAny: the table by name
          return target.query(table as any);
        };
      if (key === 'get')
        return (...args: unknown[]) => {
          seen.gets += 1;
          // biome-ignore lint/suspicious/noExplicitAny: passed through
          return (target.get as any)(...args);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    ctx: { ...ctx, db } as QueryCtx,
    get tables() {
      return seen.tables;
    },
    get gets() {
      return seen.gets;
    },
  };
}

/** Count the documents a mutation context's reads fetch (each `first`, `unique` and `get`). */
function recordingReads(ctx: MutationCtx) {
  let n = 0;
  const wrapQuery = (q: unknown): unknown =>
    new Proxy(q as object, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (key === 'first' || key === 'unique') n += 1;
          return out instanceof Promise ? out : wrapQuery(out);
        };
      },
    });
  const db = new Proxy(ctx.db, {
    get(target, key, receiver) {
      if (key === 'query') return (table: string) => wrapQuery(target.query(table as never));
      if (key === 'get')
        return (...args: unknown[]) => {
          n += 1;
          return (target.get as (...a: unknown[]) => unknown)(...args);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    ctx: { ...ctx, db } as MutationCtx,
    reads: () => n,
    reset: () => {
      n = 0;
    },
  };
}

/** The documents a People read's `pending` depends on: each backfill's run row, as stored. */
async function pendingDocs(t: T): Promise<string[]> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('peopleJobRuns').collect();
    return PEOPLE_BACKFILLS.map(({ backfill }) =>
      JSON.stringify(rows.find((r) => r.job === backfill) ?? null),
    );
  });
}

/** Every pass of every backfill scheduled now, by the scheduler's name. */
const BACKFILL_REFS = Object.fromEntries(
  SPECS.slice(0, PEOPLE_BACKFILLS.length).flatMap((s) => [
    [s.name, s.ref],
    ...Object.entries(s.chain ?? {}),
  ]),
) as Record<string, Spec['ref']>;

describe('a backfill in flight re-runs no People read pass by pass', () => {
  test('`readPending` reads the backfills’ run rows and nothing else', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.peopleJobs.backfillRows, {});
    const seen = await t.run(async (ctx) => {
      const r = recording(ctx as unknown as QueryCtx);
      const answer = await readPending(r.ctx);
      return { tables: [...r.tables], gets: r.gets, answer };
    });
    expect(seen.tables).toEqual(['peopleJobRuns']);
    expect(seen.gets).toBe(0);
    expect(seen.answer.pending.length).toBeGreaterThan(0);
  });

  test('over a whole chain of five backfills, each run row changes only as its run starts and concludes', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const spec of SPECS.slice(0, PEOPLE_BACKFILLS.length))
        for (let i = 0; i < 3; i++) await spec.seed(ctx, i);
    });
    const versions: string[][] = PEOPLE_BACKFILLS.map(() => []);
    const observe = async () => {
      const docs = await pendingDocs(t);
      docs.forEach((doc, i) => {
        const seen = versions[i] as string[];
        if (seen[seen.length - 1] !== doc) seen.push(doc);
      });
    };
    await observe();
    await t.mutation(internal.peopleJobs.backfillRows, {});
    await observe();
    let passes = 1;
    for (;;) {
      expect(passes, 'the chain terminates').toBeLessThan(500);
      const all = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
      const next = all.find((f) => f.state.kind === 'pending' && f.name in BACKFILL_REFS);
      if (!next) break;
      await t.run((ctx) => ctx.scheduler.cancel(next._id));
      await t.mutation(BACKFILL_REFS[next.name] as Spec['ref'], next.args[0]);
      passes += 1;
      await observe();
    }
    // Many passes, and each backfill's row went: absent → started → concluded. Nothing between.
    expect(passes).toBeGreaterThan(16);
    for (const [i, seen] of versions.entries()) {
      const states = seen.map((doc) => JSON.parse(doc) as Doc<'peopleJobRuns'> | null);
      expect(
        states.map((s) => (s === null ? 'absent' : s.running ? 'started' : 'concluded')),
        PEOPLE_BACKFILLS[i]?.backfill,
      ).toEqual(['absent', 'started', 'concluded']);
      expect(states[2]?.ready, PEOPLE_BACKFILLS[i]?.backfill).toBe(true);
    }
    expect((await t.run((ctx) => readPending(ctx))).ready).toBe(true);
  });

  test('a run in flight when this deployed resumes at its cursor and token — none lost, none taken twice', async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const out: Id<'profiles'>[] = [];
      for (let i = 0; i < 3; i++) out.push(await ctx.db.insert('profiles', profile(`f${i}`)));
      return out;
    });
    const first = await t.run(
      async (ctx) => (await ctx.db.get(ids[0] as Id<'profiles'>))?._creationTime,
    );
    // The old shape: a run whose passes wrote their progress on the run row itself, two passes in,
    // the first profile walked (its row left out here, so a second walk of it would show).
    await t.run(async (ctx) => {
      await ctx.db.insert('peopleJobRuns', {
        job: 'rows',
        run: 1,
        ready: false,
        running: true,
        cursor: String(first),
        failed: 0,
        chains: false,
        pass: 2,
        updatedAt: T0,
      });
    });
    // The operator's check reads the old run's progress where it is.
    const before = await t.query(internal.peopleJobs.preparation, {});
    expect(before.backfills[0]).toMatchObject({ run: 1, running: true, cursor: String(first) });
    // Its scheduled pass, carried across the deploy: it holds the lease.
    await t.mutation(internal.peopleJobs.backfillRows, { run: 1, pass: 2, cursor: String(first) });
    expect(await runRow(t, 'rows')).toMatchObject({ run: 1, pass: 3, running: true });
    // The same arguments again — a delayed duplicate — find the token spent and do nothing.
    const snap = await snapshot(t, SPECS[0] as Spec);
    await t.mutation(internal.peopleJobs.backfillRows, { run: 1, pass: 2, cursor: String(first) });
    expect(await snapshot(t, SPECS[0] as Spec)).toBe(snap);
    // The rest of the run: every profile after the cursor gets its row, the walked one isn't walked again.
    for (;;) {
      const pass = (await pendingPasses(t, SPECS[0] as Spec))[0];
      if (!pass) break;
      await runPass(t, SPECS[0] as Spec, pass);
    }
    const rows = await t.run((ctx) => ctx.db.query('peopleRows').collect());
    expect(rows.map((r) => r.userId).sort()).toEqual([ids[1], ids[2]].sort());
    expect(await runRow(t, 'rows')).toMatchObject({ run: 1, running: false, ready: true });
  });

  test('a pass’s lease reads no more than its budget reserves (`LEASE_READS`)', async () => {
    const t = convexTest(schema, modules);
    const reads = await t.run(async (ctx) => {
      const counted = recordingReads(ctx as unknown as MutationCtx);
      // The dearest pass: a run continued, a gap recorded, handed on.
      const start = await takeLease(ctx as unknown as MutationCtx, 'rows', { alone: true });
      if (start === null) throw new Error('no lease');
      await endRun(ctx as unknown as MutationCtx, start, 0);
      const begun = await takeLease(ctx as unknown as MutationCtx, 'rows', { alone: true });
      if (begun === null) throw new Error('no lease');
      const first = await savePass(ctx as unknown as MutationCtx, begun, {
        cursor: 'a',
        failed: 0,
      });
      counted.reset();
      const lease = await takeLease(counted.ctx, 'rows', first);
      if (lease === null) throw new Error('no lease');
      await foundGap(counted.ctx, lease);
      await savePass(counted.ctx, lease, { cursor: 'b', failed: 0 });
      return counted.reads();
    });
    expect(reads).toBeLessThanOrEqual(LEASE_READS);
    expect(reads).toBeGreaterThan(0);
  });

  test('a progress row that outlived its run row is another run’s: a new run mints past it', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) await ctx.db.insert('profiles', profile(`s${i}`));
      // A run row cleared by hand, its run's progress left behind, its token long spent.
      await ctx.db.insert('peopleJobProgress', {
        job: 'rows',
        run: 1,
        pass: 7,
        cursor: null,
        failed: 2,
        updatedAt: T0,
      });
    });
    await t.mutation(internal.peopleJobs.backfillRows, { alone: true });
    expect(await runRow(t, 'rows')).toMatchObject({ run: 2, pass: 1, failed: 0, running: true });
    for (;;) {
      const pass = (await pendingPasses(t, SPECS[0] as Spec))[0];
      if (!pass) break;
      await runPass(t, SPECS[0] as Spec, pass);
    }
    expect(await runRow(t, 'rows')).toMatchObject({ run: 2, running: false, ready: true });
  });

  test('a stalled run is still told stalled, by its progress’s heartbeat', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) await ctx.db.insert('profiles', profile(`h${i}`));
    });
    await t.mutation(internal.peopleJobs.backfillRows, { alone: true });
    const ran = await t.query(internal.peopleJobs.preparation, {});
    expect(ran.backfills[0]).toMatchObject({ running: true, stalled: false });
    expect(ran.backfills[0]?.cursor).not.toBeNull();
    vi.setSystemTime(T0 + BACKFILL_STALL_MS + 1);
    const later = await t.query(internal.peopleJobs.preparation, {});
    expect(later.backfills[0]).toMatchObject({ running: true, stalled: true });
    expect(later.rerun).toContain('peopleJobs:backfillRows');
  });
});
