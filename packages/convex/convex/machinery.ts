/**
 * The Overview's Machinery card (B01 §5.1): the jobs that need a look first, then a few that don't.
 *
 * **Only what a record can tell.** A job is listed when something it writes says how its last run
 * went: the live imagery's poll, pump and index (`imageryRuns`), the 6-hourly metric rollup and the
 * weekly coverage sweep (the `metricSnapshots` rows they stamp), and the newest corpus run Machinery
 * lists (`importRuns`, D341) — running, late or stalled by core's `runLiveness`, the same verdict
 * Machinery's sidebar draws (`machineryRuns.corpusTail`). Every other cron leaves no trace yet —
 * that is §5's heartbeat (D218) — so it is counted in `more` and never called ok: `moreAllOk` is
 * true only when nothing left out is unknown.
 *
 * Admin only, as Machinery is (`machinery.read`): a moderator's read is `null`, which the card draws
 * as *Not recorded yet*.
 */

import type { RunLiveness } from '@skating/core';
import { archiveSeasonAt, callerNow } from '@skating/core';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import crons from './crons';
import { hasCapability, requireCapability } from './lib/auth';
import { jobRow } from './lib/imageryPump';
import { latestMetric } from './lib/metricReads';
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

const IMAGERY_KINDS = [
  { kind: 'poll', id: 'imagery-poll', name: 'Imagery poll', every: 6 * HOUR },
  { kind: 'pump', id: 'imagery-pump', name: 'Imagery pump', every: 3 * MINUTE },
  { kind: 'index', id: 'imagery-index', name: 'Imagery index', every: 10 * MINUTE },
] as const;

/**
 * An imagery run's state: a failure is failed, a refusal (a cut the machine host turned down, now
 * backing off) is retried, anything else ran. Its lateness counts only while the job owes work —
 * `owedSince`, the instant it began to, or `null` — because the pump and the index write a run only
 * when a beat changed something: a quiet one with nothing to do is the schedule, not a fault. Late
 * is measured from whichever came last: the last run, the last beat that took the lease
 * (`beganAt`), or the work arriving.
 */
function imageryState(
  run: Doc<'imageryRuns'> | null,
  every: number,
  owedSince: number | null,
  beganAt: number | null,
  now: number,
): JobState {
  if (run === null) return 'never';
  if (run.outcome === 'failed') return 'failed';
  if (run.outcome === 'refused') return 'retried';
  if (owedSince === null) return 'ok';
  return byAge(Math.max(run.finishedAt ?? run.startedAt, beganAt ?? 0, owedSince), every, now);
}

/** Every job a record can tell, worst first. */
async function trackedJobs(ctx: QueryCtx, now: number): Promise<JobRow[]> {
  const rows: JobRow[] = [];

  const label = archiveSeasonAt(now);
  const season = await ctx.db
    .query('imageryIngestSeasons')
    .withIndex('by_season', (q) => q.eq('season', label))
    .unique();
  const imageryRunning =
    season?.imageryStartedAt !== undefined &&
    season.imageryPausedAt === undefined &&
    season.closesOn === undefined;

  // What each imagery job owes while imagery runs, and since when. The poll owes a search every
  // tick. The pump owes a beat while a cut is queued or in flight — since the oldest of them was
  // queued. The index owes a build only once one is asked for, and nothing records when that was,
  // so a quiet index is never called late: that waits for §5's heartbeat.
  const waiting = async (status: 'queued' | 'spawned') =>
    await ctx.db
      .query('imageryGranules')
      .withIndex('by_season_status', (q) => q.eq('season', label).eq('status', status))
      .first();
  let pumpOwed: number | null = null;
  if (imageryRunning) {
    const queuedAts = [await waiting('spawned'), await waiting('queued')].flatMap((g) =>
      g === null ? [] : [g.queuedAt],
    );
    pumpOwed = queuedAts.length > 0 ? Math.min(...queuedAts) : null;
  }
  const owed = {
    poll: imageryRunning ? (season?.imageryStartedAt ?? null) : null,
    pump: pumpOwed,
    index: null,
  };
  // Every beat that had work takes the job's lease, recorded or not.
  const beganAt = {
    poll: null,
    pump: (await jobRow(ctx, 'pump'))?.runStartedAt ?? null,
    index: null,
  };

  for (const job of IMAGERY_KINDS) {
    const run = await ctx.db
      .query('imageryRuns')
      .withIndex('by_kind_started', (q) => q.eq('kind', job.kind))
      .order('desc')
      .first();
    rows.push({
      id: job.id,
      name: job.name,
      state: imageryState(run, job.every, owed[job.kind], beganAt[job.kind], now),
      at: run === null ? null : (run.finishedAt ?? run.startedAt),
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
