/**
 * **A chained job's calls into its run** (D349, B01-8c), for the jobs' actions: each one catches what
 * the recorder throws, so a job that can't record still does its work and schedules its next batch
 * (the record misses that step, nothing else). The rules are `cronRuns.ts`' (*A run that continues
 * past its tick*); this file only calls them safely.
 *
 * The order, per chain:
 *
 * ```ts
 * const opened = await openChainRun(ctx, tick, { job: NAME, detail, counts: { registry } });
 * if ('busy' in opened) return { cronReport: { worked: false, detail: 'still running' } }; // skip
 * const runId = opened.runId; // null: run unrecorded, the work goes on
 * await openChainBranch(ctx, runId);            // before each batch the head runs or schedules
 * await ctx.runAction(internal.x.batch, { …, runId });
 * return { cronReport: { worked: true, runId: runId ?? undefined, … } }; // the merge closes the head
 *
 * // in each batch, after its work, before it schedules:
 * await chainStepSafely(ctx, runId, { closed: 1, opened: more ? 1 : 0, counts, causes, lines });
 * ```
 *
 * A head with no tick (a chain another job scheduled, which no dispatcher records) closes its own
 * branch at its end: {@link closeChainHead}.
 */

import type { CronCauseTally, CronReportLine, CronTickContext } from '@skating/core';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';

/** What `openChainRun` answers: the run, a live run of the job (`busy`), or no run (it failed). */
export type OpenedChain = { runId: Id<'cronRuns'> } | { busy: Id<'cronRuns'> } | { runId: null };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Open the run before the first batch. With a tick (the dispatcher's third argument), the run takes
 * the tick's start, trigger and presser, so the dispatcher's merge and a killed head's `begin` find
 * it; with none, it is a `manual` run with no presser, started now (8b-2's convention for a run
 * another job chained). `{ runId: null }` when the recorder threw: go on unrecorded.
 */
export async function openChainRun(
  ctx: Pick<ActionCtx, 'runMutation'>,
  tick: CronTickContext | undefined,
  run: { job: string; detail?: string; season?: string; counts?: Record<string, number> },
): Promise<OpenedChain> {
  try {
    return await ctx.runMutation(internal.cronRuns.openRun, {
      job: tick?.job ?? run.job,
      startedAt: tick?.startedAt ?? Date.now(),
      trigger: tick?.trigger ?? 'manual',
      ...(tick?.byUserId !== undefined ? { byUserId: tick.byUserId as Id<'profiles'> } : {}),
      ...(run.detail !== undefined ? { detail: run.detail } : {}),
      ...(run.season !== undefined ? { season: run.season } : {}),
      ...(run.counts !== undefined ? { counts: run.counts } : {}),
    });
  } catch (err) {
    console.error(`cron "${run.job}": openRun failed, running unrecorded: ${messageOf(err)}`);
    return { runId: null };
  }
}

/** One step's tallies (`cronRuns.chainStep`'s arguments, less the run). */
export interface ChainStepTallies {
  opened?: number;
  closed?: number;
  counts?: Record<string, number>;
  causes?: CronCauseTally[];
  lines?: CronReportLine[];
  error?: string;
}

/**
 * Convex's words when a mutation lost its write conflict on every one of its own retries: it did not
 * commit, so sending it again can't count it twice.
 */
const WRITE_CONFLICT =
  /changed while this mutation was being run|OptimisticConcurrencyControlFailure/i;
/** How many times a step is sent when it keeps losing a write conflict (branches stepping at once). */
export const CHAIN_STEP_ATTEMPTS = 4;
/** The first wait before a step is sent again; doubled each time, with up to as much again of jitter. */
export const CHAIN_STEP_RETRY_MS = 200;

/**
 * One step into the run; nothing without a run; a recorder that throws is logged, never rethrown.
 *
 * A step that lost its write conflict on all of Convex's own retries (two branches stepping on the
 * one run row at once — measured on a local backend with instant batches) is sent again, up to
 * {@link CHAIN_STEP_ATTEMPTS} in all, after a short backoff: a lost conflict never committed, so the
 * resend can't double-count. Any other error is not resent — it may have committed (a reply lost on
 * the way back), and a double count is worse than a missed one.
 */
export async function chainStepSafely(
  ctx: Pick<ActionCtx, 'runMutation'>,
  runId: Id<'cronRuns'> | null | undefined,
  step: ChainStepTallies & { head?: boolean },
): Promise<void> {
  if (runId === null || runId === undefined) return;
  try {
    await retryOnWriteConflict(() =>
      ctx.runMutation(internal.cronRuns.chainStep, { runId, ...step }),
    );
  } catch (err) {
    console.error(`cronRuns.chainStep failed on run ${runId}, the work goes on: ${messageOf(err)}`);
  }
}

/**
 * Send a mutation again when it lost its write conflict on all of Convex's own retries, up to
 * {@link CHAIN_STEP_ATTEMPTS} in all, waiting {@link CHAIN_STEP_RETRY_MS} doubled each time (with
 * jitter); any other error, or the last attempt's, is thrown. Only for a mutation whose lost
 * conflict is the one error that certainly didn't commit.
 */
export async function retryOnWriteConflict<R>(send: () => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!WRITE_CONFLICT.test(messageOf(err)) || attempt >= CHAIN_STEP_ATTEMPTS) throw err;
      const wait = CHAIN_STEP_RETRY_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, wait + Math.random() * wait));
    }
  }
}

/**
 * A branch opened for a batch the head is about to run inline or schedule (no batch counted), with
 * the branch's start line if it has one — so it lands ahead of every line the batch sends.
 */
export function openChainBranch(
  ctx: Pick<ActionCtx, 'runMutation'>,
  runId: Id<'cronRuns'> | null | undefined,
  branches = 1,
  lines?: CronReportLine[],
): Promise<void> {
  return chainStepSafely(ctx, runId, {
    opened: branches,
    ...(lines !== undefined && lines.length > 0 ? { lines } : {}),
  });
}

/** A head with no tick closes its own branch at its end, with its own tallies if it has any. */
export function closeChainHead(
  ctx: Pick<ActionCtx, 'runMutation'>,
  runId: Id<'cronRuns'> | null | undefined,
  step: Omit<ChainStepTallies, 'opened' | 'closed'> = {},
): Promise<void> {
  return chainStepSafely(ctx, runId, { ...step, closed: 1, head: true });
}
