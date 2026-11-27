/**
 * **The crons' reads** (D343, D346, D347, B01-8b): every cron's verdict, a cron's ticks over a range,
 * its runs, and one run's log — what Machinery's cron cards, runs drawer and lanes read, and later
 * Health (8e) and Weather (8c).
 *
 * Each gated `machinery.read`, each taking the caller's `now` through `callerNow` where a verdict
 * depends on the clock (a cron falling late is a change in the clock, not in any row). Every verdict
 * is core's `cronLiveness`, sent with its inputs so the web re-reads it on its own clock. Bounds:
 * `jobs` at most one heartbeat point read per registry entry; `strip` one `by_job_bucket` range,
 * `take(200)`; `runsPage` one `.paginate()` of 25 over `by_job_started` (or, for *Failed*,
 * `by_job_outcome_started`); `runLog` one `.paginate()` of 200 over `by_cron_run_seq`, newest first.
 *
 * PLACEHOLDER (B01-8b seams): the contracts are the seam (the web derives its types from `api`, so
 * the stubs return these shapes); every body is S2's, and each returns the empty answer until then.
 */

import type { CronLiveness, CronLivenessInput, CronSchedule } from '@skating/core';
import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { literals } from './lib/validators';
import type { PersonView, RunEventView } from './machineryRuns';

/** A cron as its card and lane read it. */
export type CronJobView = {
  job: string;
  title: string;
  pipeline: string;
  schedule: CronSchedule;
  liveness: CronLiveness;
  /** The rule's inputs, so the web re-reads the verdict on its ticking clock. */
  inputs: CronLivenessInput;
  lastRun: {
    id: Id<'cronRuns'>;
    startedAt: number;
    outcome: Doc<'cronRuns'>['outcome'];
    counts: Record<string, number> | null;
  } | null;
};

/** A row of a cron's runs list. */
export type CronRunView = {
  id: Id<'cronRuns'>;
  job: string;
  startedAt: number;
  finishedAt: number;
  outcome: Doc<'cronRuns'>['outcome'];
  trigger: Doc<'cronRuns'>['trigger'];
  /** A manual run's presser. */
  by: PersonView | null;
  season: string | null;
  detail: string | null;
  error: string | null;
  counts: Record<string, number> | null;
};

/** One tick on the strip: when, its outcome's code (core's `CRON_TICK_CODES`), and how long. */
export type CronTickView = { at: number; code: number; ms: number };

/**
 * The runs list's filter: every run, or the failed ones (`by_job_outcome_started` at `failed`, a
 * defined value).
 */
export const CRON_RUNS_FILTERS = ['all', 'failed'] as const;

/** Every named cron's verdict, in the order asked. */
export const jobs = query({
  args: { names: v.array(v.string()), now: v.optional(v.number()) },
  handler: async (ctx, _args): Promise<CronJobView[]> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S2).
    return [];
  },
});

/** A cron's ticks between `from` and `to`, oldest first; `truncated` past the read's bound. */
export const strip = query({
  args: { job: v.string(), from: v.number(), to: v.number() },
  handler: async (ctx, _args): Promise<{ ticks: CronTickView[]; truncated: boolean }> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S2).
    return { ticks: [], truncated: false };
  },
});

/** A cron's runs, newest first, 25 a page. */
export const runsPage = query({
  args: {
    job: v.string(),
    filter: literals(CRON_RUNS_FILTERS),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, _args): Promise<PaginationResult<CronRunView>> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S2).
    return { page: [], isDone: true, continueCursor: '' };
  },
});

/** A cron run's lines, newest first, 200 a page; the web reverses each page. */
export const runLog = query({
  args: { runId: v.id('cronRuns'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, _args): Promise<PaginationResult<RunEventView>> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S2).
    return { page: [], isDone: true, continueCursor: '' };
  },
});
