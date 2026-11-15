/**
 * **The People pages' chained jobs and their runs** (B01 §5.7): the three backfills the reads rest on,
 * the lapsed-suspension sweep and its daily retry. Each is a chain of passes, a pass scheduling the
 * next, so two chains of the same job could be alive at once — a delayed pass of an old run beside a
 * new run started by an operator, a cron tick or another job's end — sharing whatever state they keep.
 * This module makes that impossible by construction:
 *
 * - **A run has an identity.** Starting a job (a call with no `run`) mints the next run number for it
 *   in `peopleJobRuns` and makes it the job's current run — in that same transaction, so every older
 *   run is non-current before the new one does anything. Every pass carries its run; a pass whose run
 *   is not current does nothing and schedules nothing ({@link takeLease} returns `null`). At most one
 *   run of a job can make progress or declare completion.
 * - **Failures belong to the run.** The row's `failed` is the current run's own count, zeroed only by
 *   the start that makes a new run current — never under a run that can still write.
 * - **`ready` is a conclusion, and correctable.** A backfill's `ready` is written only when its current
 *   run reaches the end of its range: true exactly when that run recorded no failures, false
 *   otherwise. A later run that finds what the backfill exists to fix — a profile without its row (or
 *   a stale one), a flag without its subject, an undo without its place — clears it on the spot
 *   ({@link foundGap}), so reads go back to "not ready" honestly until a run ends clean. Between runs,
 *   nothing can leave a gap: every write that creates what a backfill fixes does the backfill's work in
 *   its own transaction (the one profile insert refreshes its row, both flag writers stamp the subject,
 *   the one audit writer places the chain), which `packages/guards` holds.
 *
 * {@link readPreparation} is the only reading of the backfills' rows: the operator's check
 * (`peopleJobs.preparation`) and every People read's `pending` alike.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/**
 * **Every one-time job the People reads rest on, in the order they run** — the registry the
 * after-merge procedure is written from. The operator starts the first (`peopleJobs:backfillRows`);
 * each run starts the next backfill when it ends, whatever its outcome (unless started `alone`). On a
 * database with nothing to backfill each ends at once, ready. `packages/guards` holds the jobs to it.
 */
export const PEOPLE_BACKFILLS = [
  { backfill: 'rows', job: 'peopleJobs:backfillRows' },
  { backfill: 'flagSubjects', job: 'peopleJobs:backfillFlagSubjects' },
  { backfill: 'undoChains', job: 'peopleJobs:backfillUndoChains' },
] as const;

/**
 * A backfill not yet finished, as a read names it in its `pending` — the figures resting on it may be
 * wrong, not merely short (`capped`) or unrecorded (`null`).
 */
export type PeopleBackfill = (typeof PEOPLE_BACKFILLS)[number]['backfill'];

/** Every chained People job: the backfills, the lapsed-suspension sweep and its daily retry. */
export const PEOPLE_JOBS = [
  'rows',
  'flagSubjects',
  'undoChains',
  'lapseSweep',
  'lapseRetry',
] as const;
export type PeopleJob = (typeof PEOPLE_JOBS)[number];

const isBackfill = (job: PeopleJob): job is PeopleBackfill =>
  PEOPLE_BACKFILLS.some((b) => b.backfill === job);

/**
 * Items a pass takes at most. The budget usually stops a pass first; tests shrink these so a property
 * can drive a run through many passes over a handful of rows.
 */
export const PASS_SIZE: Record<PeopleJob, number> = {
  rows: 50,
  flagSubjects: 200,
  undoChains: 200,
  lapseSweep: 1_000,
  lapseRetry: 1_000,
};

/**
 * Every backfill's arguments — one shape, one meaning, so one recovery sentence is true of all three:
 * - `run` — the run a pass belongs to. Left out, the call **starts a new run**, which supersedes any
 *   older one (its delayed passes then do nothing); a backfill passes it to its own next pass.
 * - `cursor` — where the pass resumes, opaque; a new run starts there if given, else at the start.
 * - `alone` — a new run that doesn't start the backfills after it when it ends (a re-run after a fix).
 */
export const BACKFILL_ARGS = {
  run: v.optional(v.number()),
  cursor: v.optional(v.union(v.string(), v.null())),
  alone: v.optional(v.boolean()),
};
export interface BackfillArgs {
  run?: number;
  cursor?: string | null;
  alone?: boolean;
}

/**
 * **The after-merge procedure, as the docs quote it word for word** — the phase doc, the roadmap's
 * Owed list and the PR body. `peopleBackfills.test.ts` runs its `convex run` commands literally, as
 * parsed out of this text (the same function names and argument objects), on an empty database and a
 * seeded one, a failure and a recovery over a still-scheduled old pass included; `packages/guards`
 * holds the docs to this text. Change the procedure here and the test and the docs follow, or fail.
 */
export const AFTER_MERGE_PROCEDURE = [
  '(1) `convex dev --once`.',
  "(2) `convex run peopleJobs:backfillRows '{}'` — it runs the three People backfills in turn (rows, flag subjects, undo chains). Estimate: unmeasured.",
  "(3) `convex run peopleJobs:preparation '{}'` until it returns `ready: true`.",
  '(4) For each job in its `rerun`: `convex run <job> \'{"alone":true}\'` (a new run, which supersedes any older one), then step 3 again.',
  '(5) For each id `backfillRows` logs as an overwritten tombstone: `convex run peopleJobs:restoreTombstoneStatus \'{"userId":"<id>"}\'`.',
].join(' ');

/** A run that hasn't recorded a pass in this long has stopped (a pass takes seconds). */
export const BACKFILL_STALL_MS = 10 * 60_000;

// ── The lease ──────────────────────────────────────────────────────────────────────────────────

/** A pass's hold on its job: the current run, its failures so far, and whether it chains. */
export interface Lease {
  job: PeopleJob;
  run: number;
  failed: number;
  chains: boolean;
}

async function runRow(ctx: QueryCtx, job: PeopleJob): Promise<Doc<'peopleJobRuns'> | null> {
  return ctx.db
    .query('peopleJobRuns')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

/**
 * Take the lease for a pass. With no `run`, start a new run: mint the next run number, make it current
 * (every older run is non-current from this transaction on), failures zero. With `run`, continue it —
 * or `null` when it is no longer the current run (or has ended), and the pass must do nothing at all.
 */
export async function takeLease(
  ctx: MutationCtx,
  job: PeopleJob,
  args: { run?: number; alone?: boolean },
): Promise<Lease | null> {
  const row = await runRow(ctx, job);
  if (args.run !== undefined) {
    if (!row || row.run !== args.run || !row.running) return null;
    return { job, run: row.run, failed: row.failed, chains: row.chains };
  }
  const fields = {
    run: (row?.run ?? 0) + 1,
    running: true,
    cursor: null,
    failed: 0,
    chains: args.alone !== true,
    updatedAt: Date.now(),
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert('peopleJobRuns', { job, ready: false, ...fields });
  return { job, run: fields.run, failed: 0, chains: fields.chains };
}

/** Record a pass of the lease's run (taken in this transaction): where the next resumes, failures so far. */
export async function savePass(
  ctx: MutationCtx,
  lease: Lease,
  state: { cursor: string | null; failed: number },
): Promise<void> {
  const row = await runRow(ctx, lease.job);
  if (row?.run !== lease.run)
    throw new Error(`peopleRuns: ${lease.job} run ${lease.run} lost its lease`);
  await ctx.db.patch(row._id, { ...state, updatedAt: Date.now() });
}

/**
 * End the lease's run at the end of its range. A backfill concludes: `ready` exactly when this run
 * recorded no failures — set or cleared, so a run with failures takes back an earlier conclusion.
 */
export async function endRun(ctx: MutationCtx, lease: Lease, failed: number): Promise<void> {
  const row = await runRow(ctx, lease.job);
  if (row?.run !== lease.run)
    throw new Error(`peopleRuns: ${lease.job} run ${lease.run} lost its lease`);
  await ctx.db.patch(row._id, {
    running: false,
    cursor: null,
    failed,
    updatedAt: Date.now(),
    ...(isBackfill(lease.job) ? { ready: failed === 0 } : {}),
  });
}

/**
 * The lease's run found what its backfill exists to fix (a missing or stale row, a flag without its
 * subject, an undo without its place): the backfill is not ready until a run ends clean.
 */
export async function foundGap(ctx: MutationCtx, lease: Lease): Promise<void> {
  const row = await runRow(ctx, lease.job);
  if (row?.run === lease.run && row.ready) await ctx.db.patch(row._id, { ready: false });
}

/** Mark a backfill concluded ready, as a clean run does (for tests and seeds). */
export async function markReady(ctx: MutationCtx, backfill: PeopleBackfill): Promise<void> {
  const lease = await takeLease(ctx, backfill, { alone: true });
  if (lease) await endRun(ctx, lease, 0);
}

// ── The one reading ────────────────────────────────────────────────────────────────────────────

/** One backfill's state, as the check reports it — its current run's. */
export interface BackfillState {
  backfill: PeopleBackfill;
  job: string;
  /** The current run's number; `null` before any run. */
  run: number | null;
  ready: boolean;
  running: boolean;
  /** Running, but no pass has recorded anything for {@link BACKFILL_STALL_MS}: a pass threw. */
  stalled: boolean;
  cursor: string | null;
  /** The current run's failures so far (or the last run's, once it ended). */
  failed: number;
  updatedAt: number | null;
}

export interface Preparation {
  /** Every backfill is ready. */
  ready: boolean;
  /** The backfills not ready, in the registry's order — what a read names in its `pending`. */
  pending: PeopleBackfill[];
  /**
   * The jobs to run again (`{"alone":true}`): not ready, not running (or stalled), and not about to be
   * started by an earlier backfill whose chain is still running.
   */
  rerun: string[];
  backfills: BackfillState[];
}

/** The backfills' state: one small read (a row per job), the only reading there is. */
export async function readPreparation(
  ctx: QueryCtx,
  now: number = Date.now(),
): Promise<Preparation> {
  const rows = await ctx.db.query('peopleJobRuns').take(PEOPLE_JOBS.length + 1);
  const byJob = new Map(rows.map((r) => [r.job as string, r]));
  let chainRunning = false;
  const rerun: string[] = [];
  const backfills = PEOPLE_BACKFILLS.map(({ backfill, job }): BackfillState => {
    const row = byJob.get(backfill);
    const running = row?.running === true;
    const stalled = running && now - (row?.updatedAt ?? 0) > BACKFILL_STALL_MS;
    const ready = row?.ready === true;
    if (!ready && !(running && !stalled) && !chainRunning) rerun.push(job);
    if (running && !stalled && row?.chains === true) chainRunning = true;
    return {
      backfill,
      job,
      run: row?.run ?? null,
      ready,
      running,
      stalled,
      cursor: row?.cursor ?? null,
      failed: row?.failed ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
  });
  const pending = backfills.filter((b) => !b.ready).map((b) => b.backfill);
  return { ready: pending.length === 0, pending, rerun, backfills };
}
