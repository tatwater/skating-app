/**
 * **The People pages' chained jobs and their runs** (B01 §5.7): the backfills the reads rest on,
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
 *   otherwise. A run begun part-way (a new run given a `cursor`) never saw the start of the range, so
 *   it can only keep an earlier clean conclusion, never reach one. A later run that finds what the
 *   backfill exists to fix — a profile without its row (or a stale one), a flag without its subject,
 *   an undo without its place — clears it in that pass ({@link foundGap}), so reads go back to "not
 *   ready" honestly until a run ends clean. Between runs,
 *   nothing can leave a gap: every write that creates what a backfill fixes does the backfill's work in
 *   its own transaction (the one profile insert refreshes its row, both flag writers stamp the subject,
 *   the one audit writer places the chain), which `packages/guards` holds.
 *
 * - **A pass writes nothing a People read depends on** (B01-4j). What changes every pass — where the
 *   next resumes, failures so far, the pass token, the heartbeat — is the job's row in
 *   `peopleJobProgress`; `peopleJobRuns` holds what readers rest on (the run, whether it runs, `ready`)
 *   and is written only when a run starts, ends or finds a gap. A People read's `pending`
 *   ({@link readPending}) reads `peopleJobRuns` alone, so a backfill in flight re-runs none of them
 *   pass by pass; only the operator's check ({@link readPreparation}) reads the progress too.
 *
 * {@link readPending} and {@link readPreparation} are the only readings of the backfills' rows, one
 * rule for `ready` between them.
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
  // The content record (D248, B01-4d): every item's verdicts replayed from the audit log, each item's
  // newest decision marked, then the erasure clocks — one run across the three chained jobs
  // (`contentRecord.backfillVerdicts`, `contentRecord.replayVerdictHistory`, `erasure.backfillClocks`),
  // which carry its lease.
  { backfill: 'verdicts', job: 'peopleJobs:backfillVerdicts' },
  // The withdrawal rows the Deleted list and count read (B01-4m, D282): one per item a person took
  // back, from each person's withdrawn ranges — after the content record, whose standing verdicts
  // say which are held.
  { backfill: 'withdrawals', job: 'peopleJobs:backfillWithdrawals' },
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
  'verdicts',
  'withdrawals',
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
  verdicts: 200,
  withdrawals: 100,
  lapseSweep: 1_000,
  lapseRetry: 1_000,
};

/**
 * Every backfill's arguments — one shape, one meaning, so one recovery sentence is true of all of them:
 * - `run` and `pass` — the run a pass belongs to and its pass token. Left out, the call **starts a new
 *   run**, which supersedes any older one (its delayed passes then do nothing); a backfill passes both
 *   to its own next pass, and only the pass holding the current token may act.
 * - `cursor` — where the pass resumes, opaque; a new run starts there if given, else at the start. A
 *   new run begun at a `cursor` can't conclude `ready` (what lies before it is not its own to vouch
 *   for); only a run from the start can.
 * - `alone` — a new run that doesn't start the backfills after it when it ends (a re-run after a fix).
 */
export const BACKFILL_ARGS = {
  run: v.optional(v.number()),
  pass: v.optional(v.number()),
  cursor: v.optional(v.union(v.string(), v.null())),
  alone: v.optional(v.boolean()),
};
export interface BackfillArgs {
  run?: number;
  pass?: number;
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
  "(2) `convex run peopleJobs:backfillRows '{}'` — it runs the five People backfills in turn (rows, flag subjects, undo chains, the content record — which ends by giving withdrawn content its erasure clocks — and the withdrawal rows the Deleted list reads). Estimate: unmeasured.",
  "(3) `convex run peopleJobs:preparation '{}'` until it returns `ready: true`.",
  '(4) For each job in its `rerun`: `convex run <job> \'{"alone":true}\'` (a new run, which supersedes any older one), then step 3 again.',
  '(5) For each id `backfillRows` logs as an overwritten tombstone: `convex run peopleJobs:restoreTombstoneStatus \'{"userId":"<id>"}\'`.',
  "(6) Only if steps 2–5 ran before the People follow-up (B01-4b) or the status-terms rule (B01-4f) was deployed: `convex run peopleJobs:backfillRows '{\"alone\":true}'` once, which stamps each staffer's tenure, and when each suspended or banned person's terms were set, on their row, then step 3 again.",
].join(' ');

/** A run that hasn't recorded a pass in this long has stopped (a pass takes seconds). */
export const BACKFILL_STALL_MS = 10 * 60_000;

// ── The lease ──────────────────────────────────────────────────────────────────────────────────

/**
 * The small documents a pass's lease reads at its dearest, for its budget to reserve: taken
 * ({@link takeLease}: the run row and its progress), a gap recorded ({@link foundGap}: the run row),
 * handed on ({@link savePass}: both again). A pass that ends instead ({@link endRun}) reads less.
 */
export const LEASE_READS = 5;

/** A pass's hold on its job: the current run and pass token, its failures so far, whether it chains. */
export interface Lease {
  job: PeopleJob;
  run: number;
  pass: number;
  failed: number;
  chains: boolean;
}

async function runRow(ctx: QueryCtx, job: PeopleJob): Promise<Doc<'peopleJobRuns'> | null> {
  return ctx.db
    .query('peopleJobRuns')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

async function progressRow(
  ctx: QueryCtx,
  job: PeopleJob,
): Promise<Doc<'peopleJobProgress'> | null> {
  return ctx.db
    .query('peopleJobProgress')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

/** A run's progress: its pass token, where its next pass resumes, its failures, its heartbeat. */
export interface RunProgress {
  pass: number;
  cursor: string | null;
  failed: number;
  updatedAt: number;
}

/**
 * The current run's progress: its own `peopleJobProgress` row while it runs. Before its first pass
 * records there — and for a run started before B01-4j, until its next pass — the run row's own values
 * are its progress (those the run started with, or the old shape's last pass), so a run in flight
 * when this deployed resumes at its cursor and token, neither lost nor taken twice. A progress row of
 * another run is a past run's. Once the run has ended, the run row is the record (its failures and
 * end time).
 */
function progressOf(
  row: Doc<'peopleJobRuns'>,
  progress: Doc<'peopleJobProgress'> | null,
): RunProgress {
  if (row.running && progress !== null && progress.run === row.run)
    return {
      pass: progress.pass,
      cursor: progress.cursor,
      failed: progress.failed,
      updatedAt: progress.updatedAt,
    };
  return { pass: row.pass, cursor: row.cursor, failed: row.failed, updatedAt: row.updatedAt };
}

/** A job's run as its passes see it: the run row and its current progress, joined. */
export type RunView = Doc<'peopleJobRuns'> & RunProgress;

/**
 * The job's run, its progress joined — for the passes and the operator's check (and tests). A People
 * read never calls this: it would depend on every pass.
 */
export async function readRun(ctx: QueryCtx, job: PeopleJob): Promise<RunView | null> {
  const [row, progress] = await Promise.all([runRow(ctx, job), progressRow(ctx, job)]);
  return row === null ? null : joinRun(row, progress);
}

const joinRun = (
  row: Doc<'peopleJobRuns'>,
  progress: Doc<'peopleJobProgress'> | null,
): RunView => ({
  ...row,
  ...progressOf(row, progress),
});

/**
 * Take the lease for a pass. With no `run`, start a new run: mint the next run number, make it current
 * (every older run is non-current from this transaction on), failures zero. With `run` and `pass`,
 * continue it — or `null` when it is no longer the current run, has ended, or this pass's token was
 * already used (a replay), and the pass must do nothing at all.
 */
export async function takeLease(
  ctx: MutationCtx,
  job: PeopleJob,
  args: { run?: number; pass?: number; alone?: boolean; cursor?: string | null },
): Promise<Lease | null> {
  const [stored, progress] = await Promise.all([runRow(ctx, job), progressRow(ctx, job)]);
  const row = stored === null ? null : joinRun(stored, progress);
  if (args.run !== undefined) {
    if (!row || row.run !== args.run || !row.running || row.pass !== args.pass) return null;
    return { job, run: row.run, pass: row.pass, failed: row.failed, chains: row.chains };
  }
  const fields = {
    // Past any progress row too: one that outlived its run row (a row cleared by hand) must read as
    // another run's, never as this one's, or its spent token would hold this run's first pass.
    run: Math.max(row?.run ?? 0, progress?.run ?? 0) + 1,
    running: true,
    cursor: null,
    failed: 0,
    chains: args.alone !== true,
    partial: typeof args.cursor === 'string',
    pass: 0,
    updatedAt: Date.now(),
  };
  // Only a backfill carries `ready`; a sweep's record never does (an old one's is cleared here). A
  // past run's progress row stays until this run's first pass rewrites it: read as another run's.
  if (row) await ctx.db.patch(row._id, isBackfill(job) ? fields : { ...fields, ready: undefined });
  else
    await ctx.db.insert('peopleJobRuns', {
      job,
      ...fields,
      ...(isBackfill(job) ? { ready: false } : {}),
    });
  return { job, run: fields.run, pass: 0, failed: 0, chains: fields.chains };
}

/**
 * Record a pass of the lease's run (taken in this transaction) — where the next resumes, failures so
 * far — and move the pass token on: the returned `{ run, pass }` is what the next pass must carry.
 * It writes the job's progress row only — never the run row a People read depends on.
 */
export async function savePass(
  ctx: MutationCtx,
  lease: Lease,
  state: { cursor: string | null; failed: number },
): Promise<{ run: number; pass: number }> {
  const [row, progress] = await Promise.all([runRow(ctx, lease.job), progressRow(ctx, lease.job)]);
  if (row?.run !== lease.run || !row.running || progressOf(row, progress).pass !== lease.pass)
    throw new Error(`peopleRuns: ${lease.job} run ${lease.run} lost its lease`);
  const next = {
    run: lease.run,
    pass: lease.pass + 1,
    cursor: state.cursor,
    failed: state.failed,
    updatedAt: Date.now(),
  };
  if (progress) await ctx.db.replace(progress._id, { job: lease.job, ...next });
  else await ctx.db.insert('peopleJobProgress', { job: lease.job, ...next });
  return { run: lease.run, pass: next.pass };
}

/**
 * End the lease's run at the end of its range. A backfill concludes: `ready` exactly when this run
 * recorded no failures — set or cleared, so a run with failures takes back an earlier conclusion. A
 * run begun part-way never saw the start of the range: clean, it keeps an earlier conclusion (one no
 * gap it met has cleared), and can't reach one of its own.
 */
export async function endRun(ctx: MutationCtx, lease: Lease, failed: number): Promise<void> {
  const row = await runRow(ctx, lease.job);
  if (row?.run !== lease.run)
    throw new Error(`peopleRuns: ${lease.job} run ${lease.run} lost its lease`);
  const ready = failed === 0 && (row.partial !== true || row.ready === true);
  await ctx.db.patch(row._id, {
    running: false,
    cursor: null,
    failed,
    updatedAt: Date.now(),
    ...(isBackfill(lease.job) ? { ready } : {}),
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

/** The cursor the content record's last pass hands back with: its run reached the end of its range. */
export const VERDICTS_DONE = 'done';

/**
 * A chained job's pass hands its lease on: the run and the pass token the next pass must carry — for
 * a backfill whose run spans several functions (the content record's walk, replays and clocks), each
 * pass of which takes the lease ({@link takeLease}) and moves the token ({@link savePass}).
 */
export const LEASE_ARG = v.optional(v.object({ run: v.number(), pass: v.number() }));
export type LeaseArg = { run: number; pass: number };

/**
 * A chained pass's lease: `undefined` for a pass run by hand without one (it concludes nothing), the
 * lease while its run is current, `null` when it was superseded — and the pass must do nothing.
 */
export async function chainedLease(
  ctx: MutationCtx,
  job: PeopleJob,
  arg: LeaseArg | undefined,
): Promise<Lease | null | undefined> {
  if (arg === undefined) return undefined;
  return takeLease(ctx, job, arg);
}

/**
 * Hand a chained pass's lease to the next pass: the pass recorded (where it got to; a `gap` it fixed
 * takes back an earlier `ready`) and the token moved — what the scheduled call carries, or nothing for
 * a pass run without a lease.
 */
export async function handOn(
  ctx: MutationCtx,
  lease: Lease | undefined,
  { cursor, gap }: { cursor: string | null; gap: boolean },
): Promise<{ lease?: LeaseArg }> {
  if (lease === undefined) return {};
  if (gap) await foundGap(ctx, lease);
  return { lease: await savePass(ctx, lease, { cursor, failed: lease.failed }) };
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

export interface Preparation extends Pending {
  /**
   * The jobs to run again (`{"alone":true}`): not ready, not running (or stalled), and not about to be
   * started by an earlier backfill whose chain is still running.
   */
  rerun: string[];
  backfills: BackfillState[];
}

/** What a People read rests on: whether every backfill is ready, and which aren't. */
export interface Pending {
  ready: boolean;
  /** The backfills not ready, in the registry's order — what a read names in its `pending`. */
  pending: PeopleBackfill[];
}

/** `ready` is a run row's conclusion alone — one rule for {@link readPending} and the check. */
const pendingOf = (rows: readonly (Doc<'peopleJobRuns'> | null)[]): Pending => {
  const pending = PEOPLE_BACKFILLS.filter((_, i) => rows[i]?.ready !== true).map((b) => b.backfill);
  return { ready: pending.length === 0, pending };
};

const backfillRows = (ctx: QueryCtx) =>
  Promise.all(PEOPLE_BACKFILLS.map(({ backfill }) => runRow(ctx, backfill)));

/**
 * **What every People read's `pending` comes from** (and a mutation that asks, like the ledger's
 * editor check): a run row per backfill, each by its own index range — never the progress table,
 * which every pass writes, and never the whole table, whose lapse jobs' rows a cron writes every
 * fifteen minutes. So a read subscribed to it re-runs when a backfill starts, concludes or finds a
 * gap, and never pass by pass.
 */
export async function readPending(ctx: QueryCtx): Promise<Pending> {
  return pendingOf(await backfillRows(ctx));
}

/**
 * **The operator's check** (`peopleJobs.preparation`, internal): the backfills' state with each
 * running run's progress — its cursor, failures and heartbeat, so `stalled` and `rerun` can be told.
 * It depends on every pass; no People read may call it ({@link readPending} is theirs, and
 * `packages/guards` holds that).
 */
export async function readPreparation(
  ctx: QueryCtx,
  now: number = Date.now(),
): Promise<Preparation> {
  const rows = await Promise.all(PEOPLE_BACKFILLS.map(({ backfill }) => readRun(ctx, backfill)));
  let chainRunning = false;
  const rerun: string[] = [];
  const backfills = PEOPLE_BACKFILLS.map(({ backfill, job }, i): BackfillState => {
    const row = rows[i] ?? undefined;
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
  return { ...pendingOf(rows), rerun, backfills };
}
