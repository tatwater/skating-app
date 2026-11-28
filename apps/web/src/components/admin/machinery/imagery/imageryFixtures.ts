/**
 * Machinery › Imagery's fixtures, in the server's own shapes (`machineryImagery`'s contract): the
 * season in each state, the board's granules, and the attempts the stories and tests open — a cut
 * killed for memory twice (its log open), a landed one (its log collapsed), one from before
 * attempts were recorded, and one cut on an old image that kept no log. The board's clock: 14:12 on
 * 14 Oct 2026, New York.
 */
import { cronLiveness, cronQuietFloorMs } from '@skating/core';

import type {
  AttemptLogLine,
  AttemptView,
  CronJobView,
  GranuleRowView,
  GranuleView,
  ImageryPageView,
  WatchFactsView,
} from './imageryModel';

export const ZONE = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 14:12 on Wed 14 Oct 2026, in New York. */
export const NOW = Date.UTC(2026, 9, 14, 18, 12);
/** A New York wall time on a day of October 2026. */
export const at = (day: number, h: number, m = 0, s = 0) => Date.UTC(2026, 9, day, h + 4, m, s);

const SEASON = 'winter-2026-27';
const TEAGAN = {
  id: 'jp00000000000000000000000000000t',
  name: 'Teagan',
  avatarUrl: null,
} as NonNullable<ImageryPageView['startedBy']>;

// ── The crons ──────────────────────────────────────────────────────────────────────────────────

type CronSpec = {
  job: string;
  title: string;
  every: number;
  lastTickAt?: number;
  lastOutcome?: 'ok' | 'worked' | 'failed' | 'killed';
  runningSince?: number;
  lastRun?: {
    at: number;
    outcome: 'ok' | 'capped' | 'refused' | 'failed' | 'killed';
    counts?: Record<string, number>;
    detail?: string;
  } | null;
};

export function cron(spec: CronSpec, now = NOW): CronJobView {
  const schedule = { every: spec.every };
  const inputs = {
    ...(spec.lastTickAt !== undefined && { lastTickAt: spec.lastTickAt }),
    ...(spec.lastOutcome !== undefined && { lastOutcome: spec.lastOutcome }),
    ...(spec.runningSince !== undefined && { runningSince: spec.runningSince }),
  };
  const floor = cronQuietFloorMs('every');
  return {
    job: spec.job,
    title: spec.title,
    pipeline: 'imagery',
    record: 'every',
    schedule,
    liveness: cronLiveness({ ...inputs, ...(floor > 0 && { quietFloorMs: floor }) }, schedule, now),
    inputs,
    lastRun:
      spec.lastRun == null
        ? null
        : {
            id: `cr_${spec.job.length}_${spec.lastRun.at}` as never,
            startedAt: spec.lastRun.at,
            outcome: spec.lastRun.outcome,
            counts: spec.lastRun.counts ?? null,
            detail: spec.lastRun.detail ?? null,
          },
  } as CronJobView;
}

export const POLL = 'poll for new satellite imagery';
export const PUMP = 'pump live satellite imagery';
export const INDEX = 'rebuild the live imagery index';

/** The board's three: the poll ran at 12:40, the pump is mid-tick, the index ran at 14:10. */
export const RUNNING_CRONS: CronJobView[] = [
  cron({
    job: POLL,
    title: 'Poll for new satellite imagery',
    every: 6 * HOUR,
    lastTickAt: at(14, 12, 40),
    lastOutcome: 'worked',
    lastRun: { at: at(14, 12, 40), outcome: 'ok', counts: { selected: 10, queued: 6 } },
  }),
  cron({
    job: PUMP,
    title: 'Pump live satellite imagery',
    every: 3 * MIN,
    lastTickAt: at(14, 14, 9),
    lastOutcome: 'worked',
    runningSince: at(14, 14, 12),
    lastRun: { at: at(14, 14, 9), outcome: 'ok', counts: { spawned: 1, landed: 0 } },
  }),
  cron({
    job: INDEX,
    title: 'Rebuild the live imagery index',
    every: 10 * MIN,
    lastTickAt: at(14, 14, 10),
    lastOutcome: 'ok',
    lastRun: null,
  }),
];

/** Before imagery starts: the poll and index skip quietly, the pump finds nothing. */
export const WAITING_CRONS: CronJobView[] = [
  cron({
    job: POLL,
    title: 'Poll for new satellite imagery',
    every: 6 * HOUR,
    lastTickAt: at(14, 12, 40),
    lastOutcome: 'ok',
  }),
  cron({
    job: PUMP,
    title: 'Pump live satellite imagery',
    every: 3 * MIN,
    lastTickAt: at(14, 14, 12),
    lastOutcome: 'ok',
  }),
  cron({
    job: INDEX,
    title: 'Rebuild the live imagery index',
    every: 10 * MIN,
    lastTickAt: at(14, 14, 10),
    lastOutcome: 'ok',
  }),
];

/** No tick recorded yet for any (the backbone just deployed). */
export const NEVER_CRONS: CronJobView[] = [
  cron({ job: POLL, title: 'Poll for new satellite imagery', every: 6 * HOUR }),
  cron({ job: PUMP, title: 'Pump live satellite imagery', every: 3 * MIN }),
  cron({ job: INDEX, title: 'Rebuild the live imagery index', every: 10 * MIN }),
];

// ── The page ───────────────────────────────────────────────────────────────────────────────────

const WATCH_WAITING: WatchFactsView = {
  season: SEASON,
  opensOn: '2026-10-03',
  openedAt: at(3, 6, 30),
  lineC: -6.667,
  crossed: null,
  closestNight: { date: '2026-10-07', lowC: -6.222, site: 'Upper Lake of the Clouds' },
  staffEmailAt: null,
  openedEmailAt: at(3, 6, 31),
};

const WATCH_CROSSED: WatchFactsView = {
  season: SEASON,
  opensOn: '2026-10-03',
  openedAt: at(3, 6, 30),
  lineC: -6.667,
  crossed: { on: '2026-10-07', sites: [{ name: 'Upper Lake of the Clouds', lowC: -7.222 }] },
  closestNight: { date: '2026-10-07', lowC: -7.222, site: 'Upper Lake of the Clouds' },
  staffEmailAt: at(14, 7, 31),
  openedEmailAt: at(3, 6, 31),
};

/** Board 6.4: running, two cutting, one failed, the index not built yet. */
export const RUNNING_PAGE: ImageryPageView = {
  season: SEASON,
  state: 'running',
  startedBy: TEAGAN,
  startedAt: at(9, 12, 38),
  counts: { queued: 2, spawned: 2, landed: 0, empty: 18, failed: 1 },
  machines: { live: 2, cap: 25, at: at(14, 14, 9) },
  index: { built: false, frames: 0, retryAt: null },
  fly: { machineMs: 38 * MIN, countedFrom: null },
  image: { ref: 'registry.fly.io/skating-imagery:deployment-01JA', seenAt: at(11, 9, 2) },
  crons: RUNNING_CRONS,
  backoffUntil: null,
  configured: true,
  watch: WATCH_WAITING,
};

export const PAUSED_PAGE: ImageryPageView = { ...RUNNING_PAGE, state: 'paused' };

export const ENDED_PAGE: ImageryPageView = {
  ...RUNNING_PAGE,
  state: 'ended',
  counts: { queued: 0, spawned: 0, landed: 212, empty: 640, failed: 3 },
  machines: { live: 0, cap: 25, at: at(14, 14, 9) },
  index: { built: true, frames: 212, retryAt: null },
  fly: { machineMs: 4_210 * MIN, countedFrom: at(1, 0) },
};

/** Running, the pump backing off after Fly failed, and the index waiting to re-read. */
export const BACKING_OFF_PAGE: ImageryPageView = {
  ...RUNNING_PAGE,
  backoffUntil: NOW + 22 * MIN,
  index: { built: true, frames: 14, retryAt: NOW + 8 * MIN },
};

/** Board 6.4 | Waiting for Cold: not started, the line not reached. */
export const WAITING_PAGE: ImageryPageView = {
  ...RUNNING_PAGE,
  state: 'notStarted',
  startedBy: null,
  startedAt: null,
  counts: { queued: 0, spawned: 0, landed: 0, empty: 0, failed: 0 },
  machines: { live: 0, cap: 25, at: null },
  index: { built: false, frames: 0, retryAt: null },
  fly: { machineMs: 0, countedFrom: null },
  image: null,
  crons: WAITING_CRONS,
  watch: WATCH_WAITING,
};

/** Board 6.4 | Line Crossed: not started, a sentinel past the line, the staff email sent. */
export const CROSSED_PAGE: ImageryPageView = {
  ...WAITING_PAGE,
  watch: WATCH_CROSSED,
};

/** No ice watch yet this season, and no tick recorded. */
export const NO_WATCH_PAGE: ImageryPageView = {
  ...WAITING_PAGE,
  state: 'noWatch',
  crons: NEVER_CRONS,
  watch: { ...WATCH_WAITING, openedAt: null, closestNight: null },
};

/** Fly and R2 missing on the deployment. */
export const UNCONFIGURED_PAGE: ImageryPageView = { ...CROSSED_PAGE, configured: false };

// ── The granules ───────────────────────────────────────────────────────────────────────────────

let seq = 0;
function granule(
  part: Partial<GranuleRowView> & Pick<GranuleRowView, 'granuleId' | 'status'>,
): GranuleRowView {
  seq += 1;
  return {
    id: `jg${String(seq).padStart(30, '0')}` as GranuleRowView['id'],
    mission: part.granuleId.startsWith('S1') ? 's1' : 's2',
    season: SEASON,
    capturedAt: '2026-10-14T19:41:00Z',
    attempts: 0,
    refusals: 0,
    queuedAt: at(14, 13, 0),
    spawnedAt: null,
    settledAt: null,
    catalogedAt: at(14, 22, 0) - DAY,
    lastError: null,
    emptyReason: null,
    ...part,
  };
}

export const FAILED_OOM = granule({
  granuleId: 'S1A_IW_GRDH_1SDV_20261012T225104_20261012T225129_061224_07A1B3',
  status: 'failed',
  capturedAt: '2026-10-13T02:51:04Z',
  catalogedAt: at(13, 9, 14),
  queuedAt: at(13, 12, 40),
  spawnedAt: at(13, 12, 52),
  settledAt: at(13, 13, 1),
  attempts: 2,
  lastError: 'exit 137 both times',
});
export const CUTTING_A = granule({
  granuleId: 'S2B_18TXP_20261014_0_L2A',
  status: 'spawned',
  attempts: 1,
  spawnedAt: NOW - 4 * MIN,
  queuedAt: NOW - 6 * MIN,
});
export const CUTTING_B = granule({
  granuleId: 'S2B_18TXQ_20261014_0_L2A',
  status: 'spawned',
  attempts: 1,
  spawnedAt: NOW - MIN,
  queuedAt: NOW - 6 * MIN,
});
export const QUEUED_A = granule({
  granuleId: 'S2B_19TBJ_20261014_0_L2A',
  status: 'queued',
  queuedAt: NOW - HOUR,
});
export const QUEUED_B = granule({
  granuleId: 'S2B_19TCJ_20261014_0_L2A',
  status: 'queued',
  queuedAt: NOW - HOUR,
});
export const EMPTY_A = granule({
  granuleId: 'S2A_18TXP_20261013_0_L2A',
  status: 'empty',
  capturedAt: '2026-10-13T15:31:00Z',
  attempts: 1,
  queuedAt: NOW - DAY - HOUR,
  spawnedAt: NOW - DAY - 50 * MIN,
  settledAt: NOW - DAY,
  emptyReason: 'no lake inside the imaged footprint',
});
export const EMPTY_OLD = granule({
  granuleId: 'S2A_19TBJ_20261013_0_L2A',
  status: 'empty',
  capturedAt: '2026-10-13T15:31:00Z',
  attempts: 1,
  queuedAt: NOW - DAY - HOUR,
  spawnedAt: NOW - DAY - 50 * MIN,
  settledAt: NOW - DAY,
  catalogedAt: null,
  emptyReason: null,
});
export const LANDED_A = granule({
  granuleId: 'S2A_19TCJ_20261013_0_L2A',
  status: 'landed',
  capturedAt: '2026-10-13T15:31:00Z',
  attempts: 1,
  queuedAt: NOW - DAY - HOUR,
  spawnedAt: NOW - DAY - 50 * MIN,
  settledAt: NOW - DAY - 41 * MIN,
});

/** The board's list: one failed first, then everything else newest first. */
export const BOARD_FAILED: GranuleRowView[] = [FAILED_OOM];
export const BOARD_ROWS: GranuleRowView[] = [
  CUTTING_A,
  CUTTING_B,
  QUEUED_A,
  QUEUED_B,
  EMPTY_A,
  EMPTY_OLD,
  LANDED_A,
];

// ── Attempts ───────────────────────────────────────────────────────────────────────────────────

function attempt(
  part: Partial<AttemptView> & Pick<AttemptView, 'attempt' | 'verdict'>,
): AttemptView {
  return {
    id: `ja${String(part.attempt).padStart(30, '0')}` as AttemptView['id'],
    machineName: `cut-${part.attempt}`,
    machineId: null,
    image: 'registry.fly.io/skating-imagery:deployment-01JA',
    spawnedAt: at(13, 12, 40),
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    oomKilled: null,
    error: null,
    machineMs: null,
    machineMsFrom: null,
    log: 'kept',
    settledAt: null,
    ...part,
  };
}

/** Board 6.4's open granule: two attempts, both killed for memory. */
export const OOM_VIEW: GranuleView = {
  row: FAILED_OOM,
  before8b: false,
  attempts: [
    attempt({
      id: 'ja000000000000000000000000000001' as AttemptView['id'],
      attempt: 1,
      verdict: 'requeued',
      machineId: '3d8f5e2a9104d7',
      spawnedAt: at(13, 12, 42),
      startedAt: at(13, 12, 43),
      exitedAt: at(13, 12, 49, 12),
      exitCode: 137,
      oomKilled: true,
      machineMs: 6 * MIN + 12_000,
      machineMsFrom: 'fly',
      settledAt: at(13, 12, 49),
    }),
    attempt({
      id: 'ja000000000000000000000000000002' as AttemptView['id'],
      attempt: 2,
      verdict: 'failed',
      machineId: 'e1477c09b2a580',
      spawnedAt: at(13, 12, 51),
      startedAt: at(13, 12, 52),
      exitedAt: at(13, 12, 59, 11),
      exitCode: 137,
      oomKilled: true,
      machineMs: 6 * MIN + 40_000,
      machineMsFrom: 'fly',
      settledAt: at(13, 13, 1),
    }),
  ],
};

/** A landed granule: one attempt, its log collapsed. */
export const LANDED_VIEW: GranuleView = {
  row: LANDED_A,
  before8b: false,
  attempts: [
    attempt({
      id: 'ja000000000000000000000000000003' as AttemptView['id'],
      attempt: 1,
      verdict: 'landed',
      machineId: '91c0ab77e2d413',
      spawnedAt: NOW - DAY - 50 * MIN,
      startedAt: NOW - DAY - 49 * MIN,
      exitedAt: NOW - DAY - 43 * MIN,
      exitCode: 0,
      oomKilled: false,
      machineMs: 5 * MIN + 48_000,
      machineMsFrom: 'cutter',
      settledAt: NOW - DAY - 41 * MIN,
    }),
  ],
};

/** A granule from before attempts were recorded: its count and last error kept, no attempts. */
export const BEFORE_VIEW: GranuleView = {
  row: {
    ...FAILED_OOM,
    id: 'jg000000000000000000000000000099' as GranuleRowView['id'],
    granuleId: 'S2A_18TYP_20261002_0_L2A',
    mission: 's2',
    capturedAt: '2026-10-02T15:21:00Z',
    catalogedAt: null,
    lastError: 'exit 1',
  },
  before8b: true,
  attempts: [],
};

/** Cut on an image from before logs were kept: Fly's word only. */
export const OLD_IMAGE_VIEW: GranuleView = {
  row: { ...EMPTY_OLD, status: 'failed', lastError: 'exit 2' },
  before8b: false,
  attempts: [
    attempt({
      id: 'ja000000000000000000000000000004' as AttemptView['id'],
      attempt: 1,
      verdict: 'failed',
      machineId: '5b2e9a01c7d3f8',
      image: 'registry.fly.io/skating-imagery:deployment-00ZZ',
      startedAt: NOW - DAY - 49 * MIN,
      exitedAt: NOW - DAY - 47 * MIN,
      exitCode: 2,
      oomKilled: false,
      machineMs: 2 * MIN,
      machineMsFrom: 'settle',
      log: 'none',
      settledAt: NOW - DAY - 44 * MIN,
    }),
  ],
};

/** A queued granule: no machine yet. */
export const QUEUED_VIEW: GranuleView = { row: QUEUED_A, before8b: false, attempts: [] };

/** An empty granule, its marker's reason kept. */
export const EMPTY_VIEW: GranuleView = {
  row: EMPTY_A,
  before8b: false,
  attempts: [
    attempt({
      id: 'ja000000000000000000000000000005' as AttemptView['id'],
      attempt: 1,
      verdict: 'empty',
      machineId: '0aa31c9e57b264',
      startedAt: NOW - DAY - 49 * MIN,
      exitedAt: NOW - DAY - 46 * MIN,
      exitCode: 0,
      oomKilled: false,
      machineMs: 3 * MIN,
      machineMsFrom: 'fly',
      settledAt: NOW - DAY,
    }),
  ],
};

/** Fly turned every spawn down: three refused attempts, none with a Machine, none with a log. */
export const REFUSED_A = granule({
  granuleId: 'S2B_18TYP_20261014_0_L2A',
  status: 'failed',
  refusals: 3,
  queuedAt: NOW - 20 * MIN,
  settledAt: NOW - 8 * MIN,
  lastError: 'create machine: 422 image not found',
});
export const REFUSED_VIEW: GranuleView = {
  row: REFUSED_A,
  before8b: false,
  attempts: [1, 2, 3].map((n) =>
    attempt({
      id: `ja${String(10 + n).padStart(30, '0')}` as AttemptView['id'],
      attempt: n,
      verdict: 'refused',
      spawnedAt: NOW - (20 - 4 * n) * MIN,
      error: 'create machine: 422 image not found',
      log: 'none',
      settledAt: NOW - (20 - 4 * n) * MIN,
    }),
  ),
};

/** The detail the fixtures hold for a row, by its id. */
export function viewFor(id: string): GranuleView | null {
  for (const v of [
    OOM_VIEW,
    LANDED_VIEW,
    BEFORE_VIEW,
    OLD_IMAGE_VIEW,
    QUEUED_VIEW,
    EMPTY_VIEW,
    REFUSED_VIEW,
  ]) {
    if (v.row.id === id) return v;
  }
  const row = [...BOARD_FAILED, ...BOARD_ROWS].find((r) => r.id === id);
  return row === undefined ? null : { row, before8b: false, attempts: [] };
}

// ── Logs ───────────────────────────────────────────────────────────────────────────────────────

function line(
  seqNo: number,
  loggedAt: number,
  origin: AttemptLogLine['origin'],
  kind: string,
  text: string,
): AttemptLogLine {
  return { seq: seqNo, loggedAt, kind, text, dropped: null, origin };
}

/** Attempt 2 of the OOM granule, oldest first: the board's log, from the pump, the cutter and Fly. */
export const OOM_LOG: AttemptLogLine[] = [
  line(
    1,
    at(13, 12, 51, 58),
    'pump',
    'stage',
    'spawned on shared-cpu-4x · 2 GB · image pinned 11 Oct',
  ),
  line(
    2,
    at(13, 12, 52, 31),
    'cutter',
    'stage',
    'start · granule S1A_IW_GRDH_1SDV_20261012T225104',
  ),
  line(3, at(13, 12, 53, 40), 'cutter', 'line', 'fetch granule 1.7 GB ok'),
  line(4, at(13, 12, 56, 2), 'cutter', 'line', 'calibrate sigma0 VV+VH ok'),
  line(5, at(13, 12, 58, 47), 'cutter', 'warn', 'terrain correction · memory 1.92 of 2.00 GB'),
  line(6, at(13, 12, 59, 9), 'fly', 'fail', 'Out of memory: Killed process 412 (gdalwarp)'),
  line(7, at(13, 12, 59, 11), 'fly', 'fail', 'exit 137 · out of memory'),
  line(8, at(13, 13, 1, 2), 'pump', 'fail', 'settled failed: attempts spent · no frame written'),
];

/** The landed granule's log. */
export const LANDED_LOG: AttemptLogLine[] = [
  line(1, NOW - DAY - 50 * MIN, 'pump', 'stage', 'spawned on shared-cpu-4x · 2 GB'),
  line(2, NOW - DAY - 49 * MIN, 'cutter', 'stage', 'start · granule S2A_19TCJ_20261013_0_L2A'),
  line(3, NOW - DAY - 47 * MIN, 'cutter', 'line', 'clip 3 lakes · 41 MB'),
  line(4, NOW - DAY - 43 * MIN, 'cutter', 'line', 'manifest written · 3 frames'),
  line(5, NOW - DAY - 43 * MIN, 'fly', 'line', 'exit 0'),
  line(6, NOW - DAY - 41 * MIN, 'pump', 'line', 'settled landed'),
];

/** The old image's attempt: Fly's lines and the pump's, no cutter of its own. */
export const OLD_IMAGE_LOG: AttemptLogLine[] = [
  line(1, NOW - DAY - 50 * MIN, 'pump', 'stage', 'spawned on shared-cpu-4x · 2 GB'),
  line(2, NOW - DAY - 47 * MIN, 'fly', 'fail', 'exit 2'),
  line(3, NOW - DAY - 44 * MIN, 'pump', 'fail', 'settled failed: attempts spent'),
];

/** The lines the fixtures hold for an attempt, by its id. */
export function logFor(attemptId: string): AttemptLogLine[] {
  if (attemptId === 'ja000000000000000000000000000002') return OOM_LOG;
  if (attemptId === 'ja000000000000000000000000000001') return OOM_LOG.slice(0, 5);
  if (attemptId === 'ja000000000000000000000000000003') return LANDED_LOG;
  if (attemptId === 'ja000000000000000000000000000004') return OLD_IMAGE_LOG;
  return [];
}
