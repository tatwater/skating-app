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
 * Every view carries the entry's `record` mode: a `sparse` cron's strip holds one quiet tick an hour
 * (what was recorded), and its verdict's *E* is floored at an hour (`cronQuietFloorMs`).
 */

import {
  type CronLiveness,
  type CronLivenessInput,
  type CronSchedule,
  callerNow,
  cronLiveness,
  cronQuietFloorMs,
  unpackTick,
} from '@skating/core';
import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import {
  CRON_JOBS,
  type CronJobEntry,
  type CronRecordMode,
  cronJob,
  cronScheduleOf,
} from './cronJobs';
import { requireCapability } from './lib/auth';
import { EVENTS_PAGE_SIZE } from './lib/runEventPage';
import { literals } from './lib/validators';
import type { PersonView, RunEventView } from './machineryRuns';

/** A cron as its card and lane read it. */
export type CronJobView = {
  job: string;
  title: string;
  pipeline: string;
  /** How the recorder writes its quiet ticks: a `sparse` strip holds one an hour. */
  record: CronRecordMode;
  schedule: CronSchedule;
  liveness: CronLiveness;
  /** The rule's inputs, so the web re-reads the verdict on its ticking clock. */
  inputs: CronLivenessInput;
  lastRun: {
    id: Id<'cronRuns'>;
    startedAt: number;
    outcome: Doc<'cronRuns'>['outcome'];
    counts: Record<string, number> | null;
    /** The run's headline (`cronRuns.detail`, at most `RUN_DETAIL_MAX` characters), or `null`. */
    detail: string | null;
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
  /** How long it ran, or `null` for a mutation job (see {@link durationOf}). */
  durationMs: number | null;
};

/**
 * One tick on the strip: when, its outcome's code (core's `CRON_TICK_CODES`), and how long — `null`
 * for a mutation job (see {@link durationOf}).
 */
export type CronTickView = { at: number; code: number; ms: number | null };

/**
 * A recorded duration as the reads send it. **A mutation job's is always 0 ms as stored** —
 * `Date.now()` is frozen for the whole of a mutation, the nested job's included — so it is `null`
 * here (not measured), never a real 0. An action job's is its measured time. A job no longer in the
 * registry keeps what was stored.
 */
export function durationOf(job: string, ms: number): number | null {
  return cronJob(job)?.kind === 'mutation' ? null : ms;
}

/**
 * The runs list's filter: every run, or the failed ones (`by_job_outcome_started` at `failed`, a
 * defined value).
 */
export const CRON_RUNS_FILTERS = ['all', 'failed'] as const;

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How far the caller's clock may sit from the server's: one minute, the rounding it sends. */
const CLOCK_SLACK_MS = MINUTE;
/** The tick rows one strip reads, newest first. */
export const STRIP_ROWS = 200;
/** The ticks one strip returns, newest kept: well under the 8,192-item array cap. */
export const STRIP_MAX_TICKS = 5_000;
/** The largest tick bucket (a UTC day): a row starting this long before `from` may hold ticks in it. */
const MAX_BUCKET_MS = DAY;
/** The runs list's page. */
export const RUNS_PAGE_SIZE = 25;

// ── The rule's inputs ─────────────────────────────────────────────────────────────────────────

/**
 * What core's rule reads for an entry: its heartbeat's three facts and the entry's quiet floor —
 * the one place a read builds them, so the jobs read, the Overview and the web's clock agree.
 */
export function cronLivenessInputOf(
  entry: Pick<CronJobEntry, 'record'>,
  hb: Doc<'cronHeartbeats'> | null,
): CronLivenessInput {
  const floor = cronQuietFloorMs(entry.record);
  return {
    ...(hb?.lastTickAt === undefined ? {} : { lastTickAt: hb.lastTickAt }),
    ...(hb?.lastOutcome === undefined ? {} : { lastOutcome: hb.lastOutcome }),
    ...(hb?.runningSince === undefined ? {} : { runningSince: hb.runningSince }),
    // Who started the run under way (Ma27 (b)): carried for the card's words, never read by the rule.
    // A manual run with no presser (one job chaining another, the poll's follow-on pump) was pressed
    // by no one, so the card isn't told it was: it reads as the cron's own run.
    ...(hb?.runningSince === undefined ||
    hb.runningTrigger === undefined ||
    (hb.runningTrigger === 'manual' && hb.runningByUserId === undefined)
      ? {}
      : { runningTrigger: hb.runningTrigger }),
    ...(floor > 0 ? { quietFloorMs: floor } : {}),
  };
}

/** A cron's heartbeat: one point read (`by_job`). */
export async function heartbeatOf(
  ctx: QueryCtx,
  job: string,
): Promise<Doc<'cronHeartbeats'> | null> {
  return await ctx.db
    .query('cronHeartbeats')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

/** A cron's name as a title: its registered name, capitalized. */
const titleOf = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The views of the named crons, in the order asked: each registry name once, unknown names dropped,
 * so the read is at most two point reads (the heartbeat, its last run) per registry entry.
 */
export async function cronJobViews(
  ctx: QueryCtx,
  names: readonly string[],
  now: number,
): Promise<CronJobView[]> {
  const seen = new Set<string>();
  const views: CronJobView[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = cronJob(name);
    if (entry === null) continue;
    const hb = await heartbeatOf(ctx, name);
    const schedule = cronScheduleOf(entry.schedule);
    const inputs = cronLivenessInputOf(entry, hb);
    const run = hb?.lastRunId === undefined ? null : await ctx.db.get(hb.lastRunId);
    views.push({
      job: name,
      title: titleOf(name),
      pipeline: entry.pipeline,
      record: entry.record,
      schedule,
      liveness: cronLiveness(inputs, schedule, now),
      inputs,
      lastRun:
        run === null
          ? null
          : {
              id: run._id,
              startedAt: run.startedAt,
              outcome: run.outcome,
              counts: run.counts ?? null,
              // The run's headline as stored (trimmed by the recorder, `RUN_DETAIL_MAX`): the card's
              // *6 new*.
              detail: run.detail ?? null,
            },
    });
  }
  return views;
}

export async function personOf(ctx: QueryCtx, id: Id<'profiles'>): Promise<PersonView> {
  const p = await ctx.db.get(id);
  const gone = p === null || p.status === 'deleted' || p.deletionRequestedAt !== undefined;
  return { id, name: p?.displayName ?? '', avatarUrl: gone ? null : (p.profileImageUrl ?? null) };
}

/** Every registry name, in the registry's order (Health's read, later). */
export const CRON_JOB_NAMES: readonly string[] = CRON_JOBS.map((j) => j.name);

// ── The reads ──────────────────────────────────────────────────────────────────────────────────

/** Every named cron's verdict, in the order asked; a name not in the registry is left out. */
export const jobs = query({
  args: { names: v.array(v.string()), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<CronJobView[]> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    return await cronJobViews(ctx, args.names, now);
  },
});

/**
 * A cron's ticks between `from` and `to` (inclusive), oldest first. One `by_job_bucket` range,
 * newest rows first, at most {@link STRIP_ROWS} rows and {@link STRIP_MAX_TICKS} ticks; `truncated`
 * when either bound cut the oldest off. A `sparse` cron's strip is what was recorded: one quiet
 * tick an hour, every failure and every tick that worked.
 */
export const strip = query({
  args: { job: v.string(), from: v.number(), to: v.number() },
  handler: async (ctx, args): Promise<{ ticks: CronTickView[]; truncated: boolean }> => {
    await requireCapability(ctx, 'machinery.read');
    if (!Number.isFinite(args.from) || !Number.isFinite(args.to) || args.to < args.from) {
      return { ticks: [], truncated: false };
    }
    const rows = await ctx.db
      .query('cronTicks')
      .withIndex('by_job_bucket', (q) =>
        q
          .eq('job', args.job)
          .gt('bucketStart', args.from - MAX_BUCKET_MS)
          .lte('bucketStart', args.to),
      )
      .order('desc')
      .take(STRIP_ROWS + 1);
    // Cut only if the newest row left out reaches `from`: the range reads a day of rows before it
    // (a row may start up to a day early), and an hour row ending before `from` holds no tick in it.
    const cut = rows[STRIP_ROWS];
    let truncated = cut !== undefined && cut.bucketStart + cut.bucketMs > args.from;
    const newestFirst: CronTickView[] = [];
    for (const row of rows.slice(0, STRIP_ROWS)) {
      const inRow: CronTickView[] = [];
      const n = Math.min(row.ticks.length, row.ms.length);
      for (let i = 0; i < n; i++) {
        const { offsetSec, code } = unpackTick(row.ticks[i] as number);
        const at = row.bucketStart + offsetSec * 1000;
        if (at < args.from || at > args.to) continue;
        inRow.push({ at, code, ms: durationOf(args.job, row.ms[i] as number) });
      }
      inRow.sort((a, b) => b.at - a.at);
      for (const tick of inRow) {
        if (newestFirst.length >= STRIP_MAX_TICKS) {
          truncated = true;
          break;
        }
        newestFirst.push(tick);
      }
      // Stop only once a tick has been left out: a bound filled exactly at a row's end says
      // nothing yet, so the older rows (already read) are still looked at for one more tick.
      if (truncated && newestFirst.length >= STRIP_MAX_TICKS) break;
    }
    return { ticks: newestFirst.reverse(), truncated };
  },
});

/** A cron's runs, newest first, 25 a page. */
export const runsPage = query({
  args: {
    job: v.string(),
    filter: literals(CRON_RUNS_FILTERS),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PaginationResult<CronRunView>> => {
    await requireCapability(ctx, 'machinery.read');
    const opts = {
      ...args.paginationOpts,
      numItems: Math.max(1, Math.min(RUNS_PAGE_SIZE, args.paginationOpts.numItems)),
    };
    const result =
      args.filter === 'failed'
        ? await ctx.db
            .query('cronRuns')
            .withIndex('by_job_outcome_started', (q) =>
              q.eq('job', args.job).eq('outcome', 'failed'),
            )
            .order('desc')
            .paginate(opts)
        : await ctx.db
            .query('cronRuns')
            .withIndex('by_job_started', (q) => q.eq('job', args.job))
            .order('desc')
            .paginate(opts);
    const page: CronRunView[] = [];
    for (const run of result.page) {
      page.push({
        id: run._id,
        job: run.job,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        trigger: run.trigger,
        by: run.byUserId === undefined ? null : await personOf(ctx, run.byUserId),
        season: run.season ?? null,
        detail: run.detail ?? null,
        error: run.error ?? null,
        counts: run.counts ?? null,
        durationMs: durationOf(run.job, run.finishedAt - run.startedAt),
      });
    }
    return { ...result, page };
  },
});

/** A cron run's lines, newest first, 200 a page; the web reverses each page. */
export const runLog = query({
  args: { runId: v.id('cronRuns'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<RunEventView>> => {
    await requireCapability(ctx, 'machinery.read');
    const result = await ctx.db
      .query('runEvents')
      .withIndex('by_cron_run_seq', (q) => q.eq('cronRunId', args.runId))
      .order('desc')
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(EVENTS_PAGE_SIZE, args.paginationOpts.numItems)),
      });
    return {
      ...result,
      page: result.page.map((e) => ({
        seq: e.seq,
        loggedAt: e.loggedAt,
        kind: e.kind,
        text: e.text,
        dropped: e.dropped ?? null,
      })),
    };
  },
});
