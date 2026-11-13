/**
 * The Overview's Machinery card (B01 §5.1): the jobs that need a look first, then a few that don't.
 *
 * **Only what a record can tell.** A job is listed when something it writes says how its last run
 * went: the live imagery's poll, pump and index (`imageryRuns`), the 6-hourly metric rollup and the
 * weekly coverage sweep (the `metricSnapshots` rows they stamp), and the last import (`importRuns`).
 * Every other cron leaves no trace yet — that is §5's heartbeat (D218) — so it is counted in `more`
 * and never called ok: `moreAllOk` is true only when nothing left out is unknown. A running import is
 * not shown either way: without a heartbeat it can't be told from a dead one.
 *
 * Admin only, as Machinery is (`machinery.read`): a moderator's read is `null`, which the card draws
 * as *Not recorded yet*.
 */

import { archiveSeasonAt } from '@skating/core';
import type { Doc } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import crons from './crons';
import { hasCapability, requireCapability } from './lib/auth';
import { latestMetric } from './lib/metricReads';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A job's last word, worst first — the card's order. `never` hasn't run this season. */
export const JOB_STATES = ['stalled', 'failed', 'late', 'retried', 'ok', 'never'] as const;
export type JobState = (typeof JOB_STATES)[number];

export type JobRow = {
  id: string;
  name: string;
  state: JobState;
  /** When its last run finished (or started, for a late one); `null` if it never ran. */
  at: number | null;
};

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
 * backing off) is retried, anything else ran. Its lateness counts only while imagery is running for
 * the season — paused or not started, a quiet pump is the schedule, not a fault.
 */
function imageryState(
  run: Doc<'imageryRuns'> | null,
  every: number,
  running: boolean,
  now: number,
): JobState {
  if (run === null) return 'never';
  if (run.outcome === 'failed') return 'failed';
  if (run.outcome === 'refused') return 'retried';
  if (!running) return 'ok';
  return byAge(run.finishedAt ?? run.startedAt, every, now);
}

/** Every job a record can tell, worst first. */
async function trackedJobs(ctx: QueryCtx, now: number): Promise<JobRow[]> {
  const rows: JobRow[] = [];

  const season = await ctx.db
    .query('imageryIngestSeasons')
    .withIndex('by_season', (q) => q.eq('season', archiveSeasonAt(now)))
    .unique();
  const imageryRunning =
    season?.imageryStartedAt !== undefined &&
    season.imageryPausedAt === undefined &&
    season.closesOn === undefined;
  for (const job of IMAGERY_KINDS) {
    const run = await ctx.db
      .query('imageryRuns')
      .withIndex('by_kind_started', (q) => q.eq('kind', job.kind))
      .order('desc')
      .first();
    rows.push({
      id: job.id,
      name: job.name,
      state: imageryState(run, job.every, imageryRunning, now),
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

  // The last import that finished. A running one is left out: nothing yet tells it from a dead one.
  const imports = await ctx.db.query('importRuns').withIndex('by_started').order('desc').take(10);
  const lastImport = imports.find((r) => r.status !== 'running');
  if (lastImport !== undefined) {
    rows.push({
      id: 'import',
      name: lastImport.label,
      state: lastImport.status === 'failed' ? 'failed' : 'ok',
      at: lastImport.finishedAt ?? lastImport.startedAt,
    });
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

export const overviewJobs = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    if (!hasCapability(viewer, 'machinery.read')) return null;
    const now = Date.now();
    const untracked = Math.max(
      0,
      Object.keys(crons.crons).filter(
        (name) => !(TRACKED_CRONS as readonly string[]).includes(name),
      ).length,
    );
    return { ...cardRows(await trackedJobs(ctx, now), untracked), untracked };
  },
});
