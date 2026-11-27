import type { Id } from '@skating/convex/dataModel';

import type { RunListPage, RunRowView } from '../machineryTypes';

/**
 * **Board 6.2's run list, as fixtures** — for stories and tests only (`fixturesStayInStories`): the
 * stalled October campaign, the passes run by hand since, and the August campaigns from before
 * Machinery kept a campaign record (rebuilt from their runs). The board's clock: Monday 12 October
 * 2026, 14:12 in New York, 41 minutes after the load last reported.
 */

export const ZONE = 'America/New_York';
/** 14:12 EDT, 12 October 2026. */
export const NOW = Date.UTC(2026, 9, 12, 18, 12);
const MIN = 60_000;
const DAY = 86_400_000;

/** A run id the URL keeps (`ID_SHAPE`): 32 characters, `k` and the number padded. */
export const runId = (n: number) => `k${String(n).padStart(31, '0')}` as Id<'importRuns'>;

const finished = { state: 'finished' } as const;

const base = {
  campaignId: null,
  dryRun: false,
  marked: false,
  scope: null,
  finishedAt: null,
} satisfies Partial<RunRowView>;

/** A single pass that finished. */
function pass(
  n: number,
  title: string,
  at: number,
  headline: { name: string; value: number } | null,
  extra: Partial<RunRowView> = {},
): RunRowView {
  return {
    ...base,
    id: runId(n),
    kind: 'pass',
    title,
    status: 'succeeded',
    liveness: finished,
    startedAt: at,
    finishedAt: at + 6 * MIN,
    line: { kind: 'pass', headline },
    ...extra,
  };
}

/** The October campaign: two passes done, the load quiet for 41 minutes. */
export const STALLED_CAMPAIGN: RunRowView = {
  ...base,
  id: runId(1),
  kind: 'campaign',
  title: 'a07a-20261012',
  campaignId: 'a07a-20261012',
  status: 'running',
  liveness: { state: 'stalled', quietMs: 41 * MIN, expectedMs: 3 * MIN, waitUntil: null },
  scope: { pass: 'full-canonical', states: ['ME', 'NH', 'VT', 'MA', 'NY'], complete: true },
  startedAt: NOW - 74 * MIN,
  line: {
    kind: 'campaign',
    passesDone: 2,
    passesPlanned: 10,
    current: 'load',
    stoppedAt: null,
    bodiesLoaded: null,
    recorded: true,
  },
};

/** A campaign from before the record, rebuilt from its runs: it stopped at the sub-areas. */
export const REBUILT_FAILED: RunRowView = {
  ...base,
  id: runId(8),
  kind: 'campaign',
  title: 'a07a-20260809',
  campaignId: 'a07a-20260809',
  status: 'failed',
  liveness: finished,
  startedAt: NOW - 64 * DAY,
  finishedAt: NOW - 64 * DAY + 50 * MIN,
  line: {
    kind: 'campaign',
    passesDone: 2,
    passesPlanned: null,
    current: null,
    stoppedAt: 'load-sub-areas',
    bodiesLoaded: 25_050,
    recorded: false,
  },
};

/** …and one that succeeded, its stored row carrying the backfill's own flag. */
export const REBUILT_FLAGGED = {
  ...base,
  id: runId(9),
  kind: 'campaign',
  title: 'a07a-20260807',
  campaignId: 'a07a-20260807',
  status: 'succeeded',
  liveness: finished,
  startedAt: NOW - 66 * DAY,
  finishedAt: NOW - 66 * DAY + 70 * MIN,
  reconstructed: true,
  line: {
    kind: 'campaign',
    passesDone: 3,
    passesPlanned: null,
    current: null,
    stoppedAt: null,
    bodiesLoaded: 25_050,
    recorded: true,
  },
} as RunRowView;

/** Board 6.2's list, newest first. */
export const BOARD_ROWS: RunRowView[] = [
  STALLED_CAMPAIGN,
  pass(2, 'load-landmark-names', NOW - 3 * DAY, { name: 'placeNamesQueued', value: 237 }),
  pass(3, 'load-landmarks', NOW - 3 * DAY - 20 * MIN, { name: 'landmarks', value: 1_904 }),
  pass(
    4,
    'referee-duplicates',
    NOW - 20 * DAY,
    { name: 'pairsProposed', value: 283 },
    {
      dryRun: true,
    },
  ),
  pass(5, 'seed-standing', NOW - 25 * DAY, { name: 'bodiesShelved', value: 23_520 }),
  pass(6, 'retire-absorbed', NOW - 63 * DAY, { name: 'rowsFolded', value: 96 }),
  pass(7, 'prune-floor', NOW - 63 * DAY - 2 * 3_600_000, { name: 'rowsDemoted', value: 412 }),
  REBUILT_FAILED,
  REBUILT_FLAGGED,
  pass(
    10,
    'load',
    NOW - 86 * DAY,
    { name: 'bodiesLoaded', value: 8_214 },
    {
      scope: { pass: 'one-state', states: ['VT'], complete: false },
    },
  ),
];

/** A running row in each live state, for the chips. */
export function liveRow(
  state: 'running' | 'late' | 'stalled' | 'waiting' | 'notRecorded',
  n = 20,
): RunRowView {
  return {
    ...STALLED_CAMPAIGN,
    id: runId(n),
    title: `a07a-live-${state}`,
    campaignId: `a07a-live-${state}`,
    liveness:
      state === 'notRecorded'
        ? { state }
        : {
            state,
            quietMs: state === 'running' ? 2 * MIN : state === 'late' ? 9 * MIN : 41 * MIN,
            expectedMs: 3 * MIN,
            waitUntil: state === 'waiting' ? NOW + 20 * MIN : null,
          },
  };
}

/** One page of the chain, as `machineryRuns.listPage` answers. */
export function runPage(
  rows: readonly RunRowView[],
  { isDone = true, indexed = true, cursor = 'end' } = {},
): RunListPage {
  return { page: [...rows], isDone, continueCursor: cursor, indexed };
}
