import { useState } from 'react';

import { Button } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';

import { CronRunLog } from './CronRunLog';
import {
  type CronRunsColumn,
  type CronRunsFilterView,
  type CronRunsStatus,
  CronRunsView,
} from './CronRunsView';
import {
  FLUSH,
  flushRuns,
  flushTicks,
  IMAGERY_JOBS,
  NOW,
  POLL,
  PUMP,
  pollRuns,
  pollTicks,
  pumpRuns,
  pumpTicks,
  runLines,
  SEASON_START,
  ZONE,
} from './cronFixtures';
import type { CronJobView, CronRunView, CronTickView } from './cronViews';
import { CRON_WORDS } from './cronWords';

/**
 * **The runs drawer on the boards' fixtures** (story support only): the view with its tabs, filter
 * and open logs held as the wired drawer holds them, the read's *Failed* filter applied to the
 * fixture runs as the server applies it (failed only), and the poll's *Run now* in the foot.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

type Fixture = {
  ticks: CronTickView[];
  runs: CronRunView[];
  from: number;
  label: string;
  columns: CronRunsColumn[];
};

const FIXTURES: Record<string, Fixture> = {
  [POLL]: {
    ticks: pollTicks(),
    runs: pollRuns(),
    from: SEASON_START,
    label: CRON_WORDS.sinceTheStart,
    columns: [
      { key: 'found', label: 'Found' },
      { key: 'queued', label: 'Queued' },
    ],
  },
  [PUMP]: {
    ticks: pumpTicks(),
    runs: pumpRuns(),
    from: NOW - 12 * HOUR,
    label: CRON_WORDS.stripLast(12),
    columns: [
      { key: 'checked', label: 'Checked' },
      { key: 'started', label: 'Started' },
    ],
  },
  [FLUSH]: {
    ticks: flushTicks(),
    runs: flushRuns(),
    from: NOW - 12 * HOUR,
    label: CRON_WORDS.stripLast(12),
    columns: [],
  },
};

const LABELS: Record<string, string> = {
  'poll for new satellite imagery': 'Poll',
  'pump live satellite imagery': 'Pump',
  'rebuild the live imagery index': 'Rebuild',
};

/** The board's tab headlines: what each cron's last run did, as the page words it. */
const HEADLINES: Record<string, string> = {
  'poll for new satellite imagery': '6 new',
  'pump live satellite imagery': '1 starting',
  'rebuild the live imagery index': 'nothing new',
};

export type CronBoardProps = {
  /** The open tab. */
  job?: string;
  /** The tabs' crons (the imagery three by default), or still loading. */
  jobs?: readonly CronJobView[] | 'loading';
  filter?: CronRunsFilterView;
  /** Override the runs, or still loading. */
  runs?: CronRunView[] | 'loading' | 'fixture';
  status?: CronRunsStatus;
  /** Override the ticks, or still loading. */
  ticks?: CronTickView[] | 'loading' | 'fixture';
  now?: number;
  /** Where the sheet portals (the story's frame). */
  container?: HTMLElement | null;
};

export function CronBoard({
  job: initialJob = POLL,
  jobs = IMAGERY_JOBS,
  filter: initialFilter = 'all',
  runs: runsOver = 'fixture',
  status: statusOver,
  ticks: ticksOver = 'fixture',
  now = NOW,
  container,
}: CronBoardProps) {
  const [job, setJob] = useState(initialJob);
  const [filter, setFilter] = useState<CronRunsFilterView>(initialFilter);
  const fixture = (FIXTURES[job] ?? FIXTURES[FLUSH]) as Fixture;
  const all = runsOver === 'fixture' ? fixture.runs : runsOver === 'loading' ? undefined : runsOver;
  const runs = filter === 'failed' ? all?.filter((r) => r.outcome === 'failed') : all;
  const ticks =
    ticksOver === 'fixture' ? fixture.ticks : ticksOver === 'loading' ? undefined : ticksOver;
  const status: CronRunsStatus = statusOver ?? (runs === undefined ? 'loading' : 'done');
  return (
    <CronRunsView
      open
      onClose={() => {}}
      title={CRON_WORDS.drawerTitle(job === FLUSH ? 'Notifications' : 'Imagery')}
      tabs={
        jobs === 'loading'
          ? undefined
          : jobs.map((j) => ({
              job: j,
              label: LABELS[j.job] ?? j.title,
              headline: HEADLINES[j.job] ?? null,
            }))
      }
      modal={false}
      job={job}
      onJobChange={(j) => {
        setJob(j);
        setFilter('all');
      }}
      strip={{ ticks, truncated: false, from: fixture.from, to: now, label: fixture.label }}
      filter={filter}
      onFilterChange={setFilter}
      runs={runs}
      status={status}
      onLoadMore={() => {}}
      columns={fixture.columns}
      headlineOf={(r) => r.detail}
      logFor={(run, label) => (
        <CronRunLog
          lines={runLines(run)}
          more={false}
          failed={run.outcome === 'failed' || run.outcome === 'killed'}
          label={label}
          timeZone={ZONE}
          onCopy={() => {}}
        />
      )}
      foot={
        job === POLL ? (
          <Button variant="primary" data-slot="story-run-now">
            Run now
            <Kbd variant="dim" aria-hidden="true">
              R
            </Kbd>
          </Button>
        ) : undefined
      }
      now={now}
      timeZone={ZONE}
      {...(container !== undefined && { container })}
    />
  );
}
