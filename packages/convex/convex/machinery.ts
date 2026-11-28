/**
 * The Overview's Machinery card (B01 §5.1): the jobs that need a look first, then a few that don't.
 *
 * **Only what a record can tell.** A job is listed when something records how its last run went:
 * the live imagery's poll, pump and index (their heartbeats, read through core's `cronLiveness`
 * exactly as Machinery's cron cards read them, `machineryCrons.cronJobViews`), the 6-hourly metric
 * rollup and the weekly coverage sweep (the `metricSnapshots` rows they stamp), and the newest
 * corpus run Machinery lists (`importRuns`, D341) — running, late or stalled by core's
 * `runLiveness`, the same verdict Machinery's sidebar draws (`machineryRuns.corpusTail`). Every
 * other cron is counted in `more` and never called ok (`moreAllOk` is true only when nothing left
 * out is unknown) until Health (B01-8e) reads every cron from the backbone.
 *
 * Admin only, as Machinery is (`machinery.read`): a moderator's read is `null`, which the card draws
 * as *Not recorded yet*.
 */

import type { CronLiveness, RunLiveness } from '@skating/core';
import { callerNow } from '@skating/core';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import crons from './crons';
import { hasCapability, requireCapability } from './lib/auth';
import { latestMetric } from './lib/metricReads';
import { type CronJobView, cronJobViews } from './machineryCrons';
import { corpusTail } from './machineryRuns';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A job's last word, worst first — the card's order. `running` is a corpus run reporting on time
 * (shown, so the card says the campaign is going); `never` hasn't run this season.
 */
export const JOB_STATES = [
  'stalled',
  'failed',
  'late',
  'retried',
  'running',
  'ok',
  'never',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export type JobRow = {
  id: string;
  name: string;
  state: JobState;
  /** When its last run finished (or started, for a late one); `null` if it never ran. */
  at: number | null;
  /** The import row's run, which the card's row opens in Machinery; absent on every other job. */
  runId?: Id<'importRuns'>;
};

/**
 * A listed run's card state, from the verdict Machinery draws: a stall held by *Wait 30 minutes*
 * reads late (someone is on it, and it isn't fine), as does a running row with no heartbeat (it
 * needs a look, and nothing says it died); a finished one is failed — a mark included — or ok.
 */
export function importJobState(
  run: Pick<Doc<'importRuns'>, 'status' | 'markedFailed'>,
  liveness: RunLiveness,
): JobState {
  switch (liveness.state) {
    case 'finished':
      return run.status === 'failed' || run.markedFailed !== undefined ? 'failed' : 'ok';
    case 'waiting':
    case 'notRecorded':
      return 'late';
    default:
      return liveness.state;
  }
}

/** How many rows the card shows: everything that needs a look, then ok rows up to this many. */
export const CARD_ROWS = 5;

/** The cron entries a tracked job stands for, so the rest are counted as untracked. */
const TRACKED_CRONS = [
  'roll up operator metrics',
  'sweep water-body coverage',
  'poll for new satellite imagery',
  'pump live satellite imagery',
  'rebuild the live imagery index',
] as const;

/** A job is late once its record is older than two of its intervals. */
const lateAfter = (intervalMs: number) => 2 * intervalMs;

/** A record's age against its interval: ok inside, late past it, never with no record. */
function byAge(at: number | null, intervalMs: number, now: number): JobState {
  if (at === null) return 'never';
  return now - at > lateAfter(intervalMs) ? 'late' : 'ok';
}

/** The imagery crons the card lists, by their registry names. */
export const IMAGERY_CARD_JOBS = [
  { job: 'poll for new satellite imagery', id: 'imagery-poll', name: 'Imagery poll' },
  { job: 'pump live satellite imagery', id: 'imagery-pump', name: 'Imagery pump' },
  { job: 'rebuild the live imagery index', id: 'imagery-index', name: 'Imagery index' },
] as const;

/** A last run that failed or was killed: the card stays failed until a later run supersedes it. */
const lastRunFailed = (lastRun: CronJobView['lastRun']) =>
  lastRun?.outcome === 'failed' || lastRun?.outcome === 'killed';

/**
 * A cron's card state, from core's verdict — the one Machinery's cron cards draw, so the two can't
 * disagree on lateness. A tick killed mid-run is failed (it needs a look). On time, the card also
 * reads the cron's **last run** (the newest tick that did work or failed, `lastRunId`), as it read
 * the newest `imageryRuns` row before the backbone: a run that failed or was killed stays failed
 * until a later run supersedes it — so the pump's failure doesn't flip to ok on the quiet tick three
 * minutes on, while it backs off for half an hour — and one a machine host turned down (the pump
 * backing off) reads retried. `never` is a cron with no tick recorded yet — right after the deploy that began
 * recording, before its first tick (the pump's within three minutes, the poll's within six hours,
 * whether or not the history copy has run) — which the card draws quiet, with no time, never red,
 * and never counts as ok.
 */
export function cronJobState(liveness: CronLiveness, lastRun: CronJobView['lastRun']): JobState {
  switch (liveness.state) {
    case 'killed':
      return 'failed';
    case 'running':
      // A tick under way hasn't superseded a failed run yet: the pump backing off from one starts
      // (and skips) a tick every three minutes, and the card must not flicker off failed for each.
      return lastRunFailed(lastRun) ? 'failed' : 'running';
    case 'ok':
      if (lastRunFailed(lastRun)) return 'failed';
      return lastRun?.outcome === 'refused' ? 'retried' : 'ok';
    default:
      return liveness.state;
  }
}

/**
 * When the row says it last ran: the last run, when the row's state is that run's (a failed or
 * refused one the ticks since haven't superseded); else the last tick, the start of the tick still
 * running, or none.
 */
function cronJobAt(
  liveness: CronLiveness,
  lastRun: CronJobView['lastRun'],
  state: JobState,
): number | null {
  if (lastRun !== null && (state === 'failed' || state === 'retried')) {
    if (liveness.state === 'running' || liveness.state === 'ok') return lastRun.startedAt;
  }
  if (liveness.state === 'running' || liveness.state === 'killed') return liveness.since;
  if (liveness.state === 'never') return null;
  return liveness.lastTickAt;
}

/** Every job a record can tell, worst first. */
async function trackedJobs(ctx: QueryCtx, now: number): Promise<JobRow[]> {
  const rows: JobRow[] = [];

  // The imagery crons, by their heartbeats: the verdict Machinery's cron cards draw.
  const views = await cronJobViews(
    ctx,
    IMAGERY_CARD_JOBS.map((j) => j.job),
    now,
  );
  for (const [i, view] of views.entries()) {
    // The views come back in the order asked, every name a registry entry (pinned by a test).
    const card = IMAGERY_CARD_JOBS[i] as (typeof IMAGERY_CARD_JOBS)[number];
    const state = cronJobState(view.liveness, view.lastRun);
    rows.push({
      id: card.id,
      name: card.name,
      state,
      at: cronJobAt(view.liveness, view.lastRun, state),
    });
  }

  // The rollup stamps `flag_queue_depth` on every tick; the sweep stamps `zoom_band_distribution`.
  for (const job of [
    { id: 'metrics-rollup', name: 'Metrics rollup', metric: 'flag_queue_depth', every: 6 * HOUR },
    {
      id: 'coverage-sweep',
      name: 'Coverage sweep',
      metric: 'zoom_band_distribution',
      every: 7 * DAY,
    },
  ] as const) {
    const at = (await latestMetric(ctx, job.metric))?.updatedAt ?? null;
    rows.push({ id: job.id, name: job.name, state: byAge(at, job.every, now), at });
  }

  // The newest corpus run Machinery lists, whatever its status. Until the listing backfill has run
  // on a deployment nothing older than it is listed, so the card falls back to the last import that
  // finished, as it read before.
  const tail = await corpusTail(ctx, now);
  if (tail !== null) {
    const { run, liveness } = tail;
    rows.push({
      id: 'import',
      name: run.label,
      state: importJobState(run, liveness),
      at:
        liveness.state === 'finished'
          ? (run.finishedAt ?? run.startedAt)
          : (run.progressAt ?? run.startedAt),
      runId: run._id,
    });
  } else {
    const imports = await ctx.db.query('importRuns').withIndex('by_started').order('desc').take(10);
    const lastImport = imports.find((r) => r.status !== 'running');
    if (lastImport !== undefined) {
      rows.push({
        id: 'import',
        name: lastImport.label,
        state: lastImport.status === 'failed' ? 'failed' : 'ok',
        at: lastImport.finishedAt ?? lastImport.startedAt,
        runId: lastImport._id,
      });
    }
  }

  return rows.sort((a, b) => JOB_STATES.indexOf(a.state) - JOB_STATES.indexOf(b.state));
}

/**
 * The card's rows: every job that needs a look (stalled, failed, late, retried), then ok and never
 * rows up to {@link CARD_ROWS}. `more` counts what is left out, the untracked crons among it; it is
 * `all ok` only when every job left out is tracked and ok.
 */
export function cardRows(
  jobs: readonly JobRow[],
  untracked: number,
): { jobs: JobRow[]; more: number; moreAllOk: boolean } {
  const needsLook = jobs.filter((j) => j.state !== 'ok' && j.state !== 'never');
  const quiet = jobs.filter((j) => j.state === 'ok' || j.state === 'never');
  const shown = [...needsLook, ...quiet.slice(0, Math.max(0, CARD_ROWS - needsLook.length))];
  const left = jobs.filter((j) => !shown.includes(j));
  return {
    jobs: shown,
    more: left.length + untracked,
    moreAllOk: untracked === 0 && left.every((j) => j.state === 'ok'),
  };
}

/** How far the caller's clock may sit from the server's: one minute, the rounding it sends. */
const CLOCK_SLACK_MS = MINUTE;

export const overviewJobs = query({
  /**
   * `now` is the caller's clock, rounded to the minute. A query is cached on the rows it reads, and
   * a job falling late is a change in the clock, not in any row — precisely the case where nothing
   * writes — so without it a stalled job would read ok until some other row moved. Clamped to the
   * server's clock, so a skewed client can't move a job in or out of late.
   */
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    if (!hasCapability(viewer, 'machinery.read')) return null;
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const untracked = Object.keys(crons.crons).filter(
      (name) => !(TRACKED_CRONS as readonly string[]).includes(name),
    ).length;
    return { ...cardRows(await trackedJobs(ctx, now), untracked), untracked };
  },
});
