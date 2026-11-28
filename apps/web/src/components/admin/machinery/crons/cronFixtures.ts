import type { Id } from '@skating/convex/dataModel';
import { CRON_TICK_CODES } from '@skating/core';

import type { CronJobView, CronLogLineView, CronRunView, CronTickView } from './cronViews';

/**
 * **The cron pieces' fixtures** (stories and tests only): boards 6.4 *Runs* and *Runs · Pump* on a
 * pinned clock — Wednesday 14 October 2026, 14:12:30 in New York — with the imagery crons, a sparse
 * mutation cron, their strips, runs and logs, shaped exactly as `machineryCrons`' reads answer.
 */

export const ZONE = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The boards' "now": Wed 14 Oct 2026, 14:12:30 EDT. */
export const NOW = Date.UTC(2026, 9, 14, 18, 12, 30);
/** A local time today (EDT, UTC−4): `at(12, 40)` is 12:40. */
export const at = (h: number, m: number, s = 0, daysAgo = 0) =>
  Date.UTC(2026, 9, 14, h + 4, m, s) - daysAgo * DAY;
/** When the season's imagery started: Fri 9 Oct, 12:40. */
export const SEASON_START = at(12, 40, 0, 5);

export const POLL = 'poll for new satellite imagery';
export const PUMP = 'pump live satellite imagery';
export const INDEX = 'rebuild the live imagery index';
export const FLUSH = 'flush notification queue';
export const WATCH = 'watch for the imagery season to open';

export const runId = (s: string) => s as Id<'cronRuns'>;

type JobOver = Partial<Omit<CronJobView, 'inputs'>> & { inputs?: CronJobView['inputs'] };

/** A cron as `jobs` sends it; its `liveness` is the server's at the minute (re-read on the web). */
export function cronJob(job: string, over: JobOver = {}): CronJobView {
  return {
    job,
    title: job.charAt(0).toUpperCase() + job.slice(1),
    pipeline: 'imagery',
    record: 'every',
    schedule: { every: 6 * HOUR },
    liveness: { state: 'never' },
    inputs: {},
    lastRun: null,
    ...over,
  };
}

export const POLL_JOB = cronJob(POLL, {
  schedule: { every: 6 * HOUR },
  inputs: { lastTickAt: at(12, 40), lastOutcome: 'worked' },
  lastRun: {
    id: runId('poll-1240'),
    startedAt: at(12, 40),
    outcome: 'ok',
    counts: { found: 10, queued: 6 },
  },
});

export const PUMP_JOB = cronJob(PUMP, {
  schedule: { every: 3 * MIN },
  inputs: {
    lastTickAt: at(14, 9),
    lastOutcome: 'worked',
    runningSince: at(14, 12),
    runningTrigger: 'cron',
  },
  lastRun: {
    id: runId('pump-1409'),
    startedAt: at(14, 9),
    outcome: 'ok',
    counts: { checked: 2, started: 0 },
  },
});

export const INDEX_JOB = cronJob(INDEX, {
  schedule: { every: 10 * MIN },
  inputs: { lastTickAt: at(14, 10), lastOutcome: 'ok' },
  lastRun: null,
});

/** The imagery crons, in the cards' order. */
export const IMAGERY_JOBS = [POLL_JOB, PUMP_JOB, INDEX_JOB] as const;

/** A sparse mutation cron: one quiet tick an hour, no measured durations. */
export const FLUSH_JOB = cronJob(FLUSH, {
  pipeline: 'notifications',
  record: 'sparse',
  schedule: { every: MIN },
  inputs: { lastTickAt: at(14, 0), lastOutcome: 'ok', quietFloorMs: HOUR },
});

/** The daily watch: a fixed UTC time, its next run named. */
export const WATCH_JOB = cronJob(WATCH, {
  schedule: { daily: { hourUTC: 11, minuteUTC: 30 } },
  inputs: { lastTickAt: at(7, 30), lastOutcome: 'ok' },
});

/** A cron in each card state, at {@link NOW}. */
export const STATE_JOBS: { name: string; job: CronJobView }[] = [
  { name: 'never', job: cronJob('never ticked', { schedule: { every: 6 * HOUR } }) },
  { name: 'running', job: PUMP_JOB },
  {
    name: 'killed',
    job: cronJob('killed mid-run', {
      schedule: { every: 10 * MIN },
      inputs: { lastTickAt: at(13, 30), lastOutcome: 'ok', runningSince: at(13, 31) },
    }),
  },
  {
    name: 'failed',
    job: cronJob('failed last run', {
      schedule: { every: 3 * MIN },
      inputs: { lastTickAt: at(14, 12), lastOutcome: 'failed' },
      lastRun: { id: runId('f'), startedAt: at(14, 12), outcome: 'failed', counts: null },
    }),
  },
  {
    name: 'late',
    job: cronJob('late poll', {
      schedule: { every: 6 * HOUR },
      inputs: { lastTickAt: at(0, 40), lastOutcome: 'ok' },
    }),
  },
  {
    name: 'stalled',
    job: cronJob('stalled pump', {
      schedule: { every: 3 * MIN },
      inputs: { lastTickAt: at(13, 10), lastOutcome: 'ok' },
    }),
  },
  {
    name: 'retried',
    job: cronJob('refused spawn', {
      schedule: { every: 3 * MIN },
      inputs: { lastTickAt: at(14, 12), lastOutcome: 'ok' },
      lastRun: {
        id: runId('r'),
        startedAt: at(14, 9),
        outcome: 'refused',
        counts: { refused: 1 },
      },
    }),
  },
  { name: 'ok', job: POLL_JOB },
  { name: 'daily', job: WATCH_JOB },
  { name: 'sparse', job: FLUSH_JOB },
];

// ── Ticks ────────────────────────────────────────────────────────────────────────────────────

const tick = (atMs: number, code: number, ms: number | null): CronTickView => ({
  at: atMs,
  code,
  ms,
});

/** The pump's last 12 hours: a quiet tick every 3 minutes, its runs, a refusal, a failure, a kill. */
export function pumpTicks(): CronTickView[] {
  const out: CronTickView[] = [];
  const worked = new Set([at(14, 3), at(14, 6), at(14, 9), at(8, 40), at(12, 1), at(13, 21)]);
  const special = new Map<number, number>([
    [at(8, 46), CRON_TICK_CODES.refused],
    [at(10, 0), CRON_TICK_CODES.failed],
    [at(11, 30), CRON_TICK_CODES.killed],
  ]);
  for (let t = at(2, 12); t <= at(14, 9); t += 3 * MIN) {
    const code = special.get(t) ?? (worked.has(t) ? CRON_TICK_CODES.worked : CRON_TICK_CODES.ok);
    out.push(tick(t, code, code === CRON_TICK_CODES.ok ? 12 : 2_900));
  }
  for (const [t, code] of special) {
    if (!out.some((x) => x.at === t)) out.push(tick(t, code, 2_900));
  }
  // A row is in recorded order, not time order: shuffle two so the strip must sort.
  const [a, b] = [out[3], out[4]] as [CronTickView, CronTickView];
  out[3] = b;
  out[4] = a;
  return out;
}

/** The poll since the start: four ticks a day, most of them working. */
export function pollTicks(): CronTickView[] {
  const out: CronTickView[] = [];
  for (let t = SEASON_START; t <= at(12, 40); t += 6 * HOUR) {
    const code = t === at(18, 40, 0, 1) ? CRON_TICK_CODES.refused : CRON_TICK_CODES.worked;
    out.push(tick(t, code, 7_000));
  }
  return out;
}

/** A sparse mutation cron's ticks: one quiet an hour, one failure, no durations. */
export function flushTicks(): CronTickView[] {
  const out: CronTickView[] = [];
  for (let t = at(2, 0); t <= at(14, 0); t += HOUR) out.push(tick(t, CRON_TICK_CODES.ok, null));
  out.push(tick(at(9, 17), CRON_TICK_CODES.failed, null));
  return out;
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

const TEAGAN = { id: 'p_teagan' as Id<'profiles'>, name: 'Teagan', avatarUrl: null };

export function cronRun(
  job: string,
  startedAt: number,
  over: Partial<CronRunView> = {},
): CronRunView {
  return {
    id: runId(`${job.split(' ')[0]}-${startedAt}`),
    job,
    startedAt,
    finishedAt: startedAt + (over.durationMs ?? 0),
    outcome: 'ok',
    trigger: 'cron',
    by: null,
    season: 'winter-2026-27',
    detail: null,
    error: null,
    counts: null,
    durationMs: 2_000,
    ...over,
  };
}

/** The pump's runs, newest first: its working ticks, a refusal, a failure, a kill. */
export function pumpRuns(): CronRunView[] {
  return [
    cronRun(PUMP, at(14, 9), {
      counts: { checked: 2, started: 0 },
      durationMs: 1_800,
      detail: '2 still cutting',
    }),
    cronRun(PUMP, at(14, 6), {
      counts: { checked: 1, started: 1 },
      durationMs: 6_400,
      detail: '1 started',
    }),
    cronRun(PUMP, at(14, 3), {
      counts: { checked: 0, started: 1 },
      durationMs: 5_900,
      detail: '1 started',
    }),
    cronRun(PUMP, at(13, 21), {
      counts: { checked: 1, started: 0 },
      durationMs: 3_100,
      detail: '1 empty · nothing to cut',
      trigger: 'manual',
      by: TEAGAN,
    }),
    cronRun(PUMP, at(12, 1), {
      counts: { checked: 1, started: 1 },
      durationMs: 4_200,
      detail: '1 started',
    }),
    cronRun(PUMP, at(11, 30), {
      outcome: 'killed',
      durationMs: 31 * MIN,
      error: 'It began and never finished: Convex stopped it at its time limit',
    }),
    cronRun(PUMP, at(10, 0), {
      outcome: 'failed',
      durationMs: 2_300,
      error: 'Listing Machines failed: 401 Unauthorized',
    }),
    cronRun(PUMP, at(8, 46), {
      outcome: 'refused',
      durationMs: 2_900,
      detail: '1 refusal · back of the queue',
      counts: { checked: 0, started: 0, refused: 1 },
    }),
    cronRun(PUMP, at(8, 40), {
      counts: { checked: 1, started: 0 },
      durationMs: 3_100,
      detail: '1 empty · nothing to cut',
    }),
  ];
}

/** The poll's runs, newest first. */
export function pollRuns(): CronRunView[] {
  const out: CronRunView[] = [];
  for (let t = at(12, 40); t >= SEASON_START; t -= 6 * HOUR) {
    const refused = t === at(18, 40, 0, 1);
    out.push(
      cronRun(POLL, t, {
        durationMs: refused ? 41_000 : 7_100,
        outcome: refused ? 'refused' : 'ok',
        counts: refused ? { found: 8, queued: 3 } : { found: 4, queued: t === at(12, 40) ? 6 : 0 },
        detail: refused ? '3 new · 1 retry' : t === at(12, 40) ? '6 new' : 'nothing new',
      }),
    );
  }
  return out;
}

/** The sparse mutation cron's one run: its failure. */
export function flushRuns(): CronRunView[] {
  return [
    cronRun(FLUSH, at(9, 17), {
      outcome: 'failed',
      durationMs: null,
      error: 'Too many reads in a single function execution (limit: 4091)',
    }),
  ];
}

// ── Logs ─────────────────────────────────────────────────────────────────────────────────────

const line = (seq: number, loggedAt: number, kind: string, text: string): CronLogLineView => ({
  seq,
  loggedAt,
  kind,
  text,
  dropped: null,
});

/** A run's lines, oldest first, as the drawer draws them. */
export function runLines(run: CronRunView): CronLogLineView[] {
  const t = run.startedAt;
  if (run.outcome === 'failed') {
    return [
      line(1, t, 'stage', 'pump · lease taken · 6 queued · 2 in flight'),
      line(2, t + 1_000, 'line', 'list machines · app skating-imagery'),
      line(
        3,
        t + 2_300,
        'fail',
        'Listing Machines failed: 401 Unauthorized · backing off 30 minutes',
      ),
    ];
  }
  if (run.outcome === 'killed') {
    return [
      line(1, t, 'stage', 'pump · lease taken · 4 queued'),
      line(2, t + 4_000, 'line', 'check · granule 18TXP · machine started 4 min'),
      line(3, t + 31 * MIN, 'fail', 'never finished · Convex stopped it at its time limit'),
    ];
  }
  return [
    line(1, t, 'stage', 'pump · lease taken · 6 queued · 2 in flight'),
    line(2, t + 2_000, 'line', 'check · granule 18TXP · machine started 4 min'),
    line(3, t + 3_000, 'line', 'check · granule 18TXQ · machine started 1 min'),
    line(4, t + 4_000, 'line', 'live machines · 2 of 25'),
  ];
}
