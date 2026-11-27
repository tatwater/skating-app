import type { Doc, Id } from '@skating/convex/dataModel';
import {
  CORPUS_RUN_PLAN,
  RUN_QUIET_MS,
  RUN_WAIT_MS,
  type RunLivenessInput,
  runLiveness,
} from '@skating/core';

import type {
  CampaignView,
  MarkedView,
  PassRowView,
  PersonView,
  RunEventView,
  RunView,
  WaitingView,
} from './runViews';

/**
 * **Board 6.2's campaign, and `live-v5` §1's run going quiet** — for stories and tests only (the
 * fixtures-stay-in-stories rule). Times are the board's, read in New York: the campaign started at
 * 12:58 on 12 Oct 2026, its load at 13:26, the load's last flush at 13:31:18, and the page read at
 * 13:31:36 (running), 13:38 (late), 14:12 (stalled), and 14:20 (marked failed).
 */

export const ZONE = 'America/New_York';
const MIN = 60_000;
/** 12 Oct 2026, h:m:s in New York (EDT, UTC−4). */
export const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 12, h + 4, m, s);

export const STARTED = at(12, 58);
export const LOAD_STARTED = at(13, 26);
export const LAST_FLUSH = at(13, 31, 18);
export const NOW_RUNNING = at(13, 31, 36);
export const NOW_LATE = at(13, 38);
export const NOW_STALLED = at(14, 12);
export const NOW_MARKED = at(14, 20);

const id = <T extends 'importRuns' | 'profiles' | 'moderationActions'>(s: string) => s as Id<T>;

export const CAMPAIGN_ID = id<'importRuns'>('run_campaign');
export const LOAD_ID = id<'importRuns'>('run_load');
export const MERGE_ID = id<'importRuns'>('run_merge');
export const REGION_ID = id<'importRuns'>('run_region');

export const TEAGAN: PersonView = {
  id: id<'profiles'>('p_teagan'),
  name: 'Teagan Atwater',
  avatarUrl: null,
};
export const SARAH: PersonView = {
  id: id<'profiles'>('p_sarah'),
  name: 'Sarah Lyme',
  avatarUrl: null,
};

const DOES: Record<string, string> = {
  'build-region': 'Region masks',
  merge: 'Three catalogs, one filter',
  load: 'Bodies → Convex',
  'load-sub-areas': 'Bays under their lakes',
  landmarks: 'Match OSM + GNIS names',
  'load-landmarks': 'Landmarks → Convex',
  'load-landmark-names': 'Unplaced names → review',
  'prune-floor': 'Demote rows the floor refuses',
  'seed-standing': 'Shelve new bodies nobody uses',
  'retire-absorbed': 'Fold the duplicates the merge absorbed',
};

/** The board's plan: build-region and merge done, the load running, the rest waiting. */
export function boardPasses(loadState: PassRowView['state'] = 'running'): PassRowView[] {
  return CORPUS_RUN_PLAN.map((p): PassRowView => {
    const base = { pass: p.pass, does: DOES[p.pass] ?? '', by: p.by, skipped: null };
    switch (p.pass) {
      case 'build-region':
        return {
          ...base,
          state: 'done',
          run: {
            id: REGION_ID,
            startedAt: at(12, 58),
            finishedAt: at(13, 2, 10),
            inUp: null,
            failed: 0,
          },
        };
      case 'merge':
        return {
          ...base,
          state: 'done',
          run: {
            id: MERGE_ID,
            startedAt: at(13, 3),
            finishedAt: at(13, 25, 41),
            inUp: null,
            failed: 0,
          },
        };
      case 'load':
        return {
          ...base,
          state: loadState,
          run: {
            id: LOAD_ID,
            startedAt: LOAD_STARTED,
            finishedAt: loadState === 'failed' ? NOW_MARKED : null,
            inUp: { in: 0, up: 9_412 },
            failed: 3,
          },
        };
      case 'retire-absorbed':
        return { ...base, state: 'required', run: null };
      default:
        return { ...base, state: p.by === 'hand' ? 'notRun' : 'waiting', run: null };
    }
  });
}

export const MARKED: MarkedView = {
  by: TEAGAN,
  at: NOW_MARKED,
  reason: 'Laptop slept; no process.',
  loaderFinish: null,
};

export const WAITING: WaitingView = { by: SARAH, at: at(14, 12), until: at(14, 42) };

const MERGE_PATH: Doc<'importRuns'>['stages'] = [
  {
    name: 'osm · vt',
    sourceAt: Date.UTC(2026, 9, 11),
    bytes: 412 * 1024 ** 2,
    sha256: 'ab12',
    checksumVerified: true,
  },
  {
    name: 'nhd · VT',
    sourceAt: Date.UTC(2026, 8, 30),
    bytes: 1.9 * 1024 ** 3,
    md5: 'cd34',
    checksumVerified: true,
  },
  {
    name: '3dhp',
    detail: 'fy26 waterbody clip',
    bytes: 318 * 1024 ** 2,
    sha256: 'ef56',
    checksumVerified: true,
  },
  { name: 'mask', detail: 'five-state · built 12:58' },
];

/** The board's campaign at `now`, its liveness read by core's rule. */
export function boardCampaign(
  now: number,
  {
    marked = null,
    waiting = null,
    loadState,
  }: {
    marked?: MarkedView | null;
    waiting?: WaitingView | null;
    loadState?: PassRowView['state'];
  } = {},
): CampaignView {
  const load: RunLivenessInput = {
    kind: 'canonical_water',
    status: 'running',
    progressAt: LAST_FLUSH,
    ...(marked !== null && { markedFailed: true }),
    ...(waiting !== null && { stallWaitUntil: waiting.until }),
  };
  const liveness = runLiveness(load, now);
  const state =
    loadState ??
    (marked !== null
      ? 'failed'
      : liveness.state === 'running'
        ? 'running'
        : liveness.state === 'finished'
          ? 'failed'
          : liveness.state);
  return {
    row: {
      id: CAMPAIGN_ID,
      kind: 'campaign',
      title: 'a07a-20261012',
      campaignId: 'a07a-20261012',
      status: marked !== null ? 'failed' : 'running',
      liveness,
      // The inputs core's rule re-reads (the campaign's own row, and its running load).
      livenessInputs:
        marked !== null
          ? null
          : { self: { kind: 'corpus_campaign', status: 'running' }, passes: [load] },
      dryRun: false,
      marked: marked !== null,
      scope: { pass: 'full-canonical', states: null, complete: true },
      startedAt: STARTED,
      finishedAt: marked !== null ? marked.at : null,
      line: {
        kind: 'campaign',
        passesDone: 2,
        passesPlanned: 10,
        current: marked !== null ? null : 'load',
        stoppedAt: marked !== null ? 'load' : null,
        bodiesLoaded: null,
        recorded: true,
      },
    },
    recorded: true,
    flags: [],
    passes: boardPasses(state as PassRowView['state']),
    liveness,
    // The running pass, or (as the read gives it) the last pass that ran once nothing runs.
    current: {
      runId: LOAD_ID,
      pass: 'load',
      counts: [
        { name: 'inserted', value: 0 },
        { name: 'updated', value: 9_412 },
        { name: 'refused', value: 41 },
        { name: 'queued', value: 571 },
      ],
      progressAt: LAST_FLUSH,
      batches: { applied: 66, total: 170 },
      failures: { stored: 3, total: 3, keys: ['nhd/3290011', 'nhd/3290444', 'osm/way/52215'] },
    },
    path: MERGE_PATH,
    marked,
    waiting,
    clockSkewMs: null,
    deployment: 'dev',
    isProd: false,
  };
}

/** August's campaign, assembled from its runs (no campaign row was kept), long finished. */
export function assembledCampaign(): CampaignView {
  const done = (pass: string, i: number): PassRowView => ({
    pass,
    does: DOES[pass] ?? '',
    by: 'script',
    state: 'done',
    skipped: null,
    run: {
      id: id<'importRuns'>(`run_aug_${pass}`),
      startedAt: Date.UTC(2026, 7, 7, 14, 10 * i),
      finishedAt: Date.UTC(2026, 7, 7, 14, 10 * i + 8),
      inUp: pass === 'load' ? { in: 25_050, up: 0 } : null,
      failed: 0,
    },
  });
  return {
    row: {
      id: id<'importRuns'>('run_aug_merge'),
      kind: 'campaign',
      title: 'a07a-20260807',
      campaignId: 'a07a-20260807',
      status: 'succeeded',
      liveness: { state: 'finished' },
      dryRun: false,
      marked: false,
      scope: null,
      startedAt: Date.UTC(2026, 7, 7, 14, 0),
      finishedAt: Date.UTC(2026, 7, 7, 14, 28),
      line: {
        kind: 'campaign',
        passesDone: 2,
        passesPlanned: null,
        current: null,
        stoppedAt: null,
        bodiesLoaded: 25_050,
        recorded: false,
      },
    },
    recorded: false,
    flags: null,
    passes: [done('merge', 0), done('load', 1)],
    liveness: { state: 'finished' },
    current: null,
    path: [],
    marked: null,
    waiting: null,
    clockSkewMs: null,
  };
}

/** The load's run row (the campaign's running pass), at a state. */
export function loadDoc(over: Partial<Doc<'importRuns'>> = {}): Doc<'importRuns'> {
  return {
    _id: LOAD_ID,
    _creationTime: LOAD_STARTED,
    kind: 'canonical_water',
    label: 'canonical water · full',
    campaignId: 'a07a-20261012',
    deployment: 'dev',
    isProd: false,
    status: 'running',
    startedAt: LOAD_STARTED,
    counts: [
      { name: 'inserted', value: 0 },
      { name: 'updated', value: 9_412 },
      { name: 'refused.floor', value: 37 },
      { name: 'refused.class', value: 4 },
      { name: 'queue.name', value: 412 },
      { name: 'queue.class', value: 98 },
      { name: 'queue.bay', value: 61 },
      { name: 'batchesApplied', value: 66 },
      { name: 'batchesTotal', value: 170 },
    ],
    stages: [
      {
        name: 'load',
        counts: [
          { name: 'inserted', value: 0 },
          { name: 'updated', value: 9_412 },
        ],
      },
    ],
    failures: [
      { stage: 'load', key: 'nhd/3290011', reason: 'self-intersects after simplify' },
      { stage: 'load', key: 'nhd/3290444', reason: 'self-intersects after simplify' },
      { stage: 'load', key: 'osm/way/52215', reason: 'ring under 3 points' },
    ],
    failuresTotal: 3,
    coverage: {
      unit: 'bodies',
      eligible: 25_050,
      covered: 9_412,
      omissions: [{ reason: 'Below the area floor', count: 14_900 }],
    },
    scope: { pass: 'full-canonical', complete: true },
    progressAt: LAST_FLUSH,
    parentRunId: CAMPAIGN_ID,
    campaignPass: 'load',
    ...over,
  };
}

/** The run page's view of the load at `now`. */
export function loadView(
  now: number,
  {
    doc = loadDoc(),
    marked = null,
    waiting = null,
  }: { doc?: Doc<'importRuns'>; marked?: MarkedView | null; waiting?: WaitingView | null } = {},
): RunView {
  const input: RunLivenessInput = {
    kind: doc.kind,
    status: doc.status,
    ...(doc.progressAt !== undefined && { progressAt: doc.progressAt }),
    ...(doc.markedFailed !== undefined && { markedFailed: true }),
    ...(doc.stallWait !== undefined && { stallWaitUntil: doc.stallWait.until }),
  };
  return {
    doc,
    liveness: runLiveness(input, now),
    livenessInputs:
      doc.status === 'running' && doc.markedFailed === undefined
        ? { self: input, passes: [] }
        : null,
    parent: { id: CAMPAIGN_ID, title: 'a07a-20261012' },
    marked,
    waiting,
  };
}

/** A finished single pass with a long record: totals, groups past the preview, a path. */
export function finishedPassDoc(): Doc<'importRuns'> {
  return {
    _id: id<'importRuns'>('run_prune'),
    _creationTime: Date.UTC(2026, 7, 10, 15),
    kind: 'floor_prune',
    label: 'prune-floor',
    campaignId: 'a07a-20260809',
    deployment: 'dev',
    isProd: false,
    status: 'succeeded',
    startedAt: Date.UTC(2026, 7, 10, 15, 0),
    finishedAt: Date.UTC(2026, 7, 10, 15, 4, 10),
    counts: [
      { name: 'demoted', value: 412 },
      { name: 'deleted', value: 0 },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `floor.reason-${i + 1}`,
        value: (i + 1) * 7,
      })),
    ],
    stages: [],
    failures: [],
    failuresTotal: 0,
    notes: ['Applied (not a dry run)'],
  };
}

/** The load's log, as its logger flushed it, oldest first. */
export function loadEvents(): RunEventView[] {
  const line = (seq: number, t: number, kind: string, text: string): RunEventView => ({
    seq,
    loggedAt: t,
    kind,
    text,
    dropped: null,
  });
  return [
    line(0, at(13, 26, 4), 'start', 'Run started · full canonical, 5 states · dev'),
    line(1, at(13, 26, 5), 'stage', 'osm · vt  extract 2026-10-11 · 412 MB · checksum verified'),
    line(2, at(13, 26, 5), 'stage', 'nhd · VT  HR gdb 2026-09-30 · 1.9 GB · checksum verified'),
    line(
      3,
      at(13, 26, 6),
      'stage',
      '3dhp · clip  fy26 waterbody clip · 318 MB · checksum verified',
    ),
    line(4, at(13, 27, 51), 'flush', 'inserted=0 updated=3,750 refused=14 batchesApplied=25'),
    line(5, at(13, 29, 33), 'flush', 'inserted=0 updated=7,500 refused=35 batchesApplied=50'),
    line(
      6,
      at(13, 30, 40),
      'fail',
      '3 new failures · e.g. nhd/3290011 · self-intersects after simplify',
    ),
    line(7, at(13, 31, 18), 'flush', 'inserted=0 updated=9,412 refused=41 batchesApplied=66'),
  ];
}

/** A log that hit its cap: the `cap` row, then the always-kept close. */
export function cappedEvents(): RunEventView[] {
  return [
    ...loadEvents(),
    { seq: 8, loggedAt: at(13, 40), kind: 'cap', text: '', dropped: 1_204 },
    {
      seq: 9,
      loggedAt: at(13, 50),
      kind: 'close',
      text: 'Failed: batch 120 timed out',
      dropped: null,
    },
  ];
}

export const QUIET_MS = { E: RUN_QUIET_MS.canonical_water ?? 3 * MIN, WAIT: RUN_WAIT_MS };
