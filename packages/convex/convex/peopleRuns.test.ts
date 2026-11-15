/**
 * Two runs of the same chained job, alive at once (B01 §5.7, `lib/peopleRuns`). For each of the five
 * chained People jobs — the three backfills, the lapsed-suspension sweep, its daily retry — a property
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
import type { MutationCtx } from './_generated/server';
import * as flagSubjectLib from './lib/flagSubject';
import * as peopleRows from './lib/peopleRows';
import { BACKFILL_STALL_MS, PASS_SIZE, type PeopleJob } from './lib/peopleRuns';
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
    tables: ['profiles', 'peopleRows', 'peopleCounts', 'peopleJobRuns'],
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
    tables: ['contentFlags', 'peopleJobRuns'],
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
    tables: ['moderationActions', 'peopleJobRuns'],
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
    tables: ['profiles', 'peopleRows', 'moderationActions', 'peopleJobRuns'],
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
    tables: ['profiles', 'peopleRows', 'moderationActions', 'peopleJobRuns'],
    holds: lapseHolds,
  },
];

// ── The harness: passes run by hand, from the scheduler's records ──

interface Pending {
  id: Id<'_scheduled_functions'>;
  run: number;
  // biome-ignore lint/suspicious/noExplicitAny: the job's own arguments, passed through
  args: any;
}

async function pendingPasses(t: T, spec: Spec): Promise<Pending[]> {
  const all = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  return all
    .filter((f) => f.name === spec.name && f.state.kind === 'pending')
    .map((f) => ({ id: f._id, run: (f.args[0] as { run: number }).run, args: f.args[0] }));
}

async function runRow(t: T, job: PeopleJob): Promise<Doc<'peopleJobRuns'> | null> {
  return t.run((ctx) =>
    (ctx as unknown as MutationCtx).db
      .query('peopleJobRuns')
      .withIndex('by_job', (q) => q.eq('job', job))
      .first(),
  );
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
  await runArgs(t, spec, pass.args);
}

/**
 * Run a pass's arguments: a pass of a run that isn't current — or whose token was already used, as
 * when its arguments are replayed by hand — must change nothing and schedule nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: the job's own arguments, passed through
async function runArgs(t: T, spec: Spec, args: any): Promise<void> {
  const row = await runRow(t, spec.job);
  const holds = row?.running === true && row.run === args.run && row.pass === args.pass;
  if (!holds) {
    const before = await snapshot(t, spec);
    const scheduledBefore = (await pendingPasses(t, spec)).length;
    await t.mutation(spec.ref, args);
    expect(await snapshot(t, spec), 'a stale pass changed nothing').toBe(before);
    expect((await pendingPasses(t, spec)).length, 'and scheduled nothing').toBe(scheduledBefore);
    return;
  }
  await t.mutation(spec.ref, args);
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
        ran.push(pass.args);
      }
    }
    // A pass's arguments run again by hand: its token is spent, so it does nothing.
    const last = ran[ran.length - 1];
    if (op.kind === 'replay' && last !== undefined) await runArgs(t, spec, last);
  }
  // Every pass left runs, in any order: the job must terminate.
  for (let i = 0; ; i++) {
    expect(i, 'the job terminates').toBeLessThan(500);
    const pass = (await pendingPasses(t, spec))[0];
    if (!pass) break;
    await runPass(t, spec, pass);
  }
  vi.restoreAllMocks();
  const row = (await runRow(t, spec.job)) as Doc<'peopleJobRuns'>;
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
      { numRuns: 12 },
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
    const a = (await runRow(t, 'rows')) as Doc<'peopleJobRuns'>;
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
