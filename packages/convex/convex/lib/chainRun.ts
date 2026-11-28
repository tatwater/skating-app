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

/** One step into the run; nothing without a run; a recorder that throws is logged, never rethrown. */
export async function chainStepSafely(
  ctx: Pick<ActionCtx, 'runMutation'>,
  runId: Id<'cronRuns'> | null | undefined,
  step: ChainStepTallies & { head?: boolean },
): Promise<void> {
  if (runId === null || runId === undefined) return;
  try {
    await ctx.runMutation(internal.cronRuns.chainStep, { runId, ...step });
  } catch (err) {
    console.error(`cronRuns.chainStep failed on run ${runId}, the work goes on: ${messageOf(err)}`);
  }
}

/** A branch opened for a batch the head is about to run inline or schedule (no batch counted). */
export function openChainBranch(
  ctx: Pick<ActionCtx, 'runMutation'>,
  runId: Id<'cronRuns'> | null | undefined,
  branches = 1,
): Promise<void> {
  return chainStepSafely(ctx, runId, { opened: branches });
}

/** A head with no tick closes its own branch at its end, with its own tallies if it has any. */
export function closeChainHead(
  ctx: Pick<ActionCtx, 'runMutation'>,
  runId: Id<'cronRuns'> | null | undefined,
  step: Omit<ChainStepTallies, 'opened' | 'closed'> = {},
): Promise<void> {
  return chainStepSafely(ctx, runId, { ...step, closed: 1, head: true });
}
