/**
 * **The Corpus tasks: the backfill and the drift repair** (B01-6a). The tasks themselves are written
 * by `lib/corpusTasks.ts` beside every write that changes a body's questions; this module files them
 * for bodies written before the hooks (the backfill) and re-derives them on a slow walk (the repair).
 *
 * **Every pass is bounded on bytes as well as rows, and never wedges** (the Inbox's shape,
 * `inboxItems.ts`): a pass sizes its page by the `ReadBudget` — each body its worst case plus a whole
 * item's work ({@link ITEM_BYTES}) — and runs each body as its own nested transaction under
 * {@link ITEM_LIMITS} (`runIsolated`), so Convex itself holds the item to its bytes. A body that
 * throws, or reads past its limits, rolls back alone, is recorded in `jobFailures` (keyed by the job
 * and the body id, its error class, never its contents) and stepped past; the cursor always moves to
 * the page's end. The backfill's failures are retried by the repair's passes, and counted on
 * Machinery until they go through.
 *
 *   pnpm convex run corpusTaskJobs:backfill '{}'          # resumable; '{"restart":true}' re-runs it
 *   pnpm convex run corpusTaskJobs:repair '{"dryRun":true}'   # what one pass would fix; writes nothing
 */

import {
  CORPUS_TASK_LANES,
  type CorpusTaskLane,
  REVIEW_REASONS,
  type ReviewReason,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import {
  bodyTaskDrift,
  CORPUS_TASK_LANES_6A,
  type CorpusDriftKind,
  laneCountDrift,
  repairBodyTasks,
  repairLaneCounts,
} from './lib/corpusTaskRepair';
import { syncBodyTasks } from './lib/corpusTasks';
import { ReadBudget, ROW_MAX, TX_BUDGET, traced } from './lib/readBudget';
import {
  affords,
  asItem,
  clearFailure,
  type ItemBudget,
  type Limits,
  MiB,
  recordFailure,
  runIsolated,
} from './lib/recurringWork';
import { literals } from './lib/validators';

/** What one body's sync may read and write — its nested transaction's own limits. */
export const ITEM_LIMITS: Limits = {
  bytesRead: 2 * MiB,
  documentsRead: 200,
  databaseQueries: 32,
  documentsWritten: 48,
};
/** A body's bytes, as a pass plans them. */
export const ITEM_BYTES = ITEM_LIMITS.bytesRead;
/** What one item costs a pass, and what the pass keeps back past it (the outcome's record). */
const ITEM: ItemBudget = {
  limits: ITEM_LIMITS,
  reserve: { bytesRead: MiB / 4, documentsRead: 20, databaseQueries: 8, documentsWritten: 8 },
};

/** What one lane's count check may read and write: every open task in the lane, and its rows. */
export const COUNT_LIMITS: Limits = {
  bytesRead: 8 * MiB,
  documentsRead: 10_200,
  databaseQueries: 16,
  documentsWritten: 128,
};
const COUNT_ITEM: ItemBudget = { limits: COUNT_LIMITS, reserve: ITEM.reserve };

/** Bodies a backfill pass reads at most; the budget may take fewer. */
export const BACKFILL_PAGE = 40;
/** Open tasks a repair pass re-checks at most, and bodies its lap reads at most. */
export const REPAIR_PAGE = 8;
/** Backfill failures a repair pass retries. */
export const RETRY_PAGE = 3;

/**
 * The phases of a walk over every body with a question: one per review reason, each through the
 * body's primary reason (`by_review_reason`) — so every body with any reason is met once, and the
 * sync files every 6a reason it carries.
 */
export const BODY_PHASES: readonly string[] = REVIEW_REASONS.map((r) => `reason:${r}`);

function reasonOfPhase(phase: string): ReviewReason {
  return phase.slice('reason:'.length) as ReviewReason;
}

/** One page of the bodies whose primary reason is the phase's. The pass's one `paginate`. */
function bodyPage(ctx: QueryCtx, phase: string, cursor: string | null, n: number) {
  return ctx.db
    .query('waterBodies')
    .withIndex('by_review_reason', (q) => q.eq('reviewReason', reasonOfPhase(phase)))
    .paginate({ cursor, numItems: n });
}

/** Where a walk goes after a page: on in its phase, to the next phase, or done. */
function advance(
  phase: string,
  page: { isDone: boolean; continueCursor: string },
): { phase: string; cursor: string | null; done: boolean } {
  const index = Math.max(0, BODY_PHASES.indexOf(phase));
  if (!page.isDone) return { phase, cursor: page.continueCursor, done: false };
  const next = BODY_PHASES[index + 1];
  return next === undefined
    ? { phase: BODY_PHASES[0] as string, cursor: null, done: true }
    : { phase: next, cursor: null, done: false };
}

/** How many bodies a pass takes: each its worst case plus an item's work, at least one. */
function bodiesFor(budget: ReadBudget, cap: number): number {
  return Math.max(1, budget.rows('waterBody', cap, 0, ROW_MAX.waterBody + ITEM_BYTES));
}

/** One body's tasks synced from its fields, as its own transaction (the backfill's and the retry's). */
export const syncOne = internalMutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: (ctx, { waterBodyId }) => asItem(waterBodyId, () => syncBodyTasks(ctx, waterBodyId)),
});

/**
 * One body repaired (or, with `dryRun`, only checked), as its own transaction: what it fixed and the
 * kinds of drift. A visited open task (`taskId`) is moved to the back of the walk, fixed or not, so
 * the walk never re-reads one head forever.
 */
export const repairOne = internalMutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    taskId: v.optional(v.id('corpusTasks')),
    dryRun: v.optional(v.boolean()),
  },
  handler: (ctx, { waterBodyId, taskId, dryRun }) =>
    asItem(waterBodyId, async (): Promise<{ fixed: number; kinds: CorpusDriftKind[] }> => {
      if (dryRun === true) return { fixed: 0, kinds: await bodyTaskDrift(ctx, waterBodyId) };
      const now = Date.now();
      const result = await repairBodyTasks(ctx, waterBodyId, now);
      if (taskId !== undefined) {
        const task = await ctx.db.get(taskId);
        if (task?.status === 'open') await ctx.db.patch(taskId, { refreshedAt: now });
      }
      return result;
    }),
});

/** One lane's counts recounted (or, with `dryRun`, only checked), as its own transaction. */
export const repairCountsOne = internalMutation({
  args: { lane: literals(CORPUS_TASK_LANES), dryRun: v.optional(v.boolean()) },
  handler: (ctx, { lane, dryRun }) =>
    asItem(`counts:${lane}`, async () =>
      dryRun === true
        ? (await laneCountDrift(ctx, lane as CorpusTaskLane)).length
        : repairLaneCounts(ctx, lane as CorpusTaskLane),
    ),
});

export { corpusTasksPending } from './lib/corpusTasks';

const passArgs = {
  /** Test seams: a smaller page, and a smaller budget (a pass ends early, then reschedules). */
  pageCap: v.optional(v.number()),
  budgetBytes: v.optional(v.number()),
};

async function runRow(ctx: QueryCtx, job: 'backfill' | 'repair') {
  return ctx.db
    .query('corpusTaskJobRuns')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

/** The job's run row, made fresh (first run, `restart`, or a lap begun again). */
async function freshRow(
  ctx: MutationCtx,
  job: 'backfill' | 'repair',
  row: Doc<'corpusTaskJobRuns'> | null,
  now: number,
): Promise<Doc<'corpusTaskJobRuns'>> {
  const fresh = {
    job,
    phase: BODY_PHASES[0] as string,
    cursor: null,
    done: false,
    startedAt: now,
    updatedAt: now,
  };
  if (row === null) await ctx.db.insert('corpusTaskJobRuns', fresh);
  else await ctx.db.patch(row._id, fresh);
  const saved = await runRow(ctx, job);
  if (saved === null) throw new Error(`corpusTaskJobs:${job}: the run row did not save`);
  return saved;
}

/**
 * The backfill, a pass at a time: one page of the current phase's bodies, each its own transaction,
 * then the cursor to the page's end and the next pass scheduled — until the last phase is done and
 * the reads stop answering `pending`. Idempotent from any cursor: a sync of a body already filed
 * changes nothing.
 */
export const backfill = internalMutation({
  args: { restart: v.optional(v.boolean()), ...passArgs },
  handler: (ctx, args) => traced('corpusTaskJobs:backfill', args, () => backfillPass(ctx, args)),
});

async function backfillPass(
  ctx: MutationCtx,
  args: { restart?: boolean; pageCap?: number; budgetBytes?: number },
): Promise<{ phase: string; read: number; failed: number; done: boolean }> {
  const now = Date.now();
  let run = await runRow(ctx, 'backfill');
  if (run === null || args.restart === true) run = await freshRow(ctx, 'backfill', run, now);
  if (run.done) return { phase: run.phase, read: 0, failed: 0, done: true };
  const phase = BODY_PHASES.includes(run.phase) ? run.phase : (BODY_PHASES[0] as string);
  const cursor = phase === run.phase ? run.cursor : null;
  const budget = new ReadBudget(args.budgetBytes ?? TX_BUDGET);
  const n = bodiesFor(budget, args.pageCap ?? BACKFILL_PAGE);
  // The page is charged at its worst; the bodies' own reads are their nested transactions'.
  const page = await budget.page('waterBody', n, (k) => bodyPage(ctx, phase, cursor, k));
  let failed = 0;
  for (const body of page.page) {
    const result = await runIsolated<unknown>(
      ctx,
      internal.corpusTaskJobs.syncOne,
      { waterBodyId: body._id },
      ITEM_LIMITS,
    );
    if (result.ok) await clearFailure(ctx, 'corpusTaskBackfill', body._id);
    else {
      failed++;
      await recordFailure(ctx, 'corpusTaskBackfill', body._id, result.errorClass, now);
    }
  }
  const next = advance(phase, page);
  await ctx.db.patch(run._id, { ...next, updatedAt: now });
  if (!next.done) {
    await ctx.scheduler.runAfter(0, internal.corpusTaskJobs.backfill, {
      ...(args.pageCap !== undefined ? { pageCap: args.pageCap } : {}),
      ...(args.budgetBytes !== undefined ? { budgetBytes: args.budgetBytes } : {}),
    });
  }
  return { phase, read: page.page.length, failed, done: next.done };
}

/** What one repair pass did (or, dry, would do). */
export type RepairAnswer = {
  dryRun: boolean;
  /** Open tasks whose bodies were re-checked, oldest refresh first. */
  checked: number;
  /** Bodies the lap re-checked, and where it stands after them. */
  lapped: number;
  lap: { phase: string; cursor: string | null; done: boolean };
  /** Rows fixed (0 on a dry run), and the drift found by kind (bodies; lanes for `counts`). */
  fixed: number;
  drift: Partial<Record<CorpusDriftKind, number>>;
  /** Items that threw or read past their limits (recorded, unless dry). */
  failed: number;
  /** Backfill failures retried (none on a dry run). */
  retried: number;
};

/**
 * **The drift repair** (the cron, every few minutes): the oldest-refreshed open tasks' bodies, a page
 * of the lap over every body with a question, and each lane's counts — each its own transaction, a
 * failure recorded and stepped past — then a few of the backfill's failures retried.
 *
 * **`dryRun`**: every check, no fix, no record, no lap moved — what this pass would fix. It reads the
 * lap from `lap` when given (the answer's `lap` is the next position), so a whole corpus can be read
 * dry, pass by pass, without the cron's position moving.
 */
export const repair = internalMutation({
  args: {
    ...passArgs,
    dryRun: v.optional(v.boolean()),
    lap: v.optional(v.object({ phase: v.string(), cursor: v.union(v.string(), v.null()) })),
  },
  handler: (ctx, args) => traced('corpusTaskJobs:repair', args, () => repairPass(ctx, args)),
});

async function repairPass(
  ctx: MutationCtx,
  args: {
    pageCap?: number;
    budgetBytes?: number;
    dryRun?: boolean;
    lap?: { phase: string; cursor: string | null };
  },
): Promise<RepairAnswer> {
  const now = Date.now();
  const dry = args.dryRun === true;
  const budget = new ReadBudget(args.budgetBytes ?? TX_BUDGET);
  const cap = args.pageCap ?? REPAIR_PAGE;
  const answer: RepairAnswer = {
    dryRun: dry,
    checked: 0,
    lapped: 0,
    lap: { phase: BODY_PHASES[0] as string, cursor: null, done: false },
    fixed: 0,
    drift: {},
    failed: 0,
    retried: 0,
  };
  const seen = new Set<Id<'waterBodies'>>();

  /** One body through `repairOne`: its drift counted, its failure recorded (unless dry). */
  const visit = async (waterBodyId: Id<'waterBodies'>, taskId?: Id<'corpusTasks'>) => {
    seen.add(waterBodyId);
    const result = await runIsolated<{ fixed: number; kinds: CorpusDriftKind[] }>(
      ctx,
      internal.corpusTaskJobs.repairOne,
      {
        waterBodyId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(dry ? { dryRun: true } : {}),
      },
      ITEM_LIMITS,
    );
    if (result.ok) {
      answer.fixed += result.value.fixed;
      for (const k of result.value.kinds) answer.drift[k] = (answer.drift[k] ?? 0) + 1;
      if (!dry) await clearFailure(ctx, 'corpusTaskRepair', waterBodyId);
      return;
    }
    answer.failed++;
    if (dry) return;
    await recordFailure(ctx, 'corpusTaskRepair', waterBodyId, result.errorClass, now);
    // Its refresh rolled back with it: moved to the back here, so the walk goes on past it.
    if (taskId !== undefined) await ctx.db.patch(taskId, { refreshedAt: now });
  };

  // 1. The oldest-refreshed open tasks: a task whose question went, or whose tab moved, unhooked.
  const open = await budget.take('small', budget.rows('small', cap), (k) =>
    ctx.db
      .query('corpusTasks')
      .withIndex('by_refreshed_at', (q) => q.eq('status', 'open'))
      .take(k),
  );
  for (const task of open) {
    // Started only while the transaction can still pay an item's whole limits: a heavy body is never
    // starved into failing by the ones before it, and the rest wait for the next pass.
    if (!(await affords(ctx, ITEM))) break;
    answer.checked++;
    if (seen.has(task.waterBodyId)) {
      if (!dry) await ctx.db.patch(task._id, { refreshedAt: now });
      continue;
    }
    await visit(task.waterBodyId, task._id);
  }

  // 2. A page of the lap over every body with a question: a question with no task is found only here.
  const row = await runRow(ctx, 'repair');
  let lapAt = args.lap ?? (row && !row.done ? { phase: row.phase, cursor: row.cursor } : null);
  if (lapAt === null || !BODY_PHASES.includes(lapAt.phase)) {
    lapAt = { phase: BODY_PHASES[0] as string, cursor: null };
  }
  const at = lapAt;
  const n = Math.min(cap, bodiesFor(budget, cap));
  const page = await budget.page('waterBody', n, (k) => bodyPage(ctx, at.phase, at.cursor, k));
  for (const body of page.page) {
    if (!(await affords(ctx, ITEM))) break;
    answer.lapped++;
    if (!seen.has(body._id)) await visit(body._id);
  }
  // A lap cut short by the transaction resumes at the same page: the bodies it did are idempotent.
  const finished = answer.lapped === page.page.length;
  answer.lap = finished ? advance(at.phase, page) : { ...at, done: false };
  if (!dry) {
    if (row === null || row.done) {
      const fresh = await freshRow(ctx, 'repair', row, now);
      await ctx.db.patch(fresh._id, { ...answer.lap, updatedAt: now });
    } else {
      await ctx.db.patch(row._id, { ...answer.lap, updatedAt: now });
    }
  }

  // 3. Each lane's counts against its open tasks.
  for (const lane of CORPUS_TASK_LANES_6A) {
    if (!(await affords(ctx, COUNT_ITEM))) break;
    const result = await runIsolated<number>(
      ctx,
      internal.corpusTaskJobs.repairCountsOne,
      { lane, ...(dry ? { dryRun: true } : {}) },
      COUNT_LIMITS,
    );
    if (result.ok) {
      if (result.value > 0) answer.drift.counts = (answer.drift.counts ?? 0) + 1;
      if (!dry) {
        answer.fixed += result.value;
        await clearFailure(ctx, 'corpusTaskRepair', `counts:${lane}`);
      }
    } else {
      answer.failed++;
      if (!dry) {
        await recordFailure(ctx, 'corpusTaskRepair', `counts:${lane}`, result.errorClass, now);
      }
    }
  }

  // 4. The backfill's failures, retried a few at a time until they go through (or park, by the rule)
  // — read past the parked ones by index (`eq(parkedAt, undefined)`, the equality the non-sparse
  // index answers), so parked rows never hold the head.
  if (!dry) {
    const owed = await budget.take('small', budget.rows('small', RETRY_PAGE), (k) =>
      ctx.db
        .query('jobFailures')
        .withIndex('by_job_parked', (q) =>
          q.eq('job', 'corpusTaskBackfill').eq('parkedAt', undefined),
        )
        .take(k),
    );
    for (const failure of owed) {
      if (!(await affords(ctx, ITEM))) break;
      const id = ctx.db.normalizeId('waterBodies', failure.key);
      if (id === null) {
        await clearFailure(ctx, 'corpusTaskBackfill', failure.key);
        continue;
      }
      answer.retried++;
      const result = await runIsolated<unknown>(
        ctx,
        internal.corpusTaskJobs.syncOne,
        { waterBodyId: id },
        ITEM_LIMITS,
      );
      if (result.ok) await clearFailure(ctx, 'corpusTaskBackfill', failure.key);
      else await recordFailure(ctx, 'corpusTaskBackfill', failure.key, result.errorClass, now);
    }
  }
  if (answer.fixed > 0) console.info(`corpusTaskJobs:repair: fixed ${answer.fixed} drifted row(s)`);
  return answer;
}
