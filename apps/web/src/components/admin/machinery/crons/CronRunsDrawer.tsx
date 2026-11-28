import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { toast } from '@/components/kit/toast';

import { useTickingNow } from '../../body/tabs/tabParts';
import {
  isFailed,
  type Loadable,
  type ReadFailure,
  read,
  useConsoleReadSet,
} from '../../reads/consoleReads';
import { joinChain, useJoinedPages } from '../../reads/joinChain';
import { useChainedPages } from '../../reads/useChainedPages';
import { useMinuteNow } from '../../shell/presence';
import { CronRunLog } from './CronRunLog';
import {
  type CronRunsColumn,
  type CronRunsFilterView,
  type CronRunsStatus,
  CronRunsView,
} from './CronRunsView';
import {
  CRON_LOG_PAGE,
  CRON_RUNS_PAGE,
  type CronJobView,
  type CronRunLogPage,
  type CronRunsPage,
  type CronRunView,
  type CronStripView,
} from './cronViews';
import { CRON_WORDS } from './cronWords';

/**
 * **The runs drawer, wired** — what a pipeline page mounts (Imagery now; Weather and Health later).
 * It reads its own data by the cron's name: the tabs' crons (`machineryCrons.jobs`, on the minute),
 * the open cron's strip (`strip`, the range ending at the minute), its runs (`runsPage`, 25 a page
 * as a chain of cursor pages) and each open run's log (`runLog`, 200 a page, newest first, drawn
 * oldest first). Nothing is read while it is closed. Each read goes through the console's one read
 * layer; a read that fails says so in a toast with *Try again*, never inline.
 *
 * The page owns where the drawer is (`job`, `open`): switching tabs calls `onJobChange` when it is
 * given (to keep the URL), and switches in place otherwise.
 */

export type CronRunsDrawerProps = {
  /** The open cron's registered name. */
  job: string;
  open: boolean;
  onClose: () => void;
  /** The pipeline's crons, in the tabs' order (the open one among them); `[job]` otherwise. */
  tabs?: readonly string[];
  /** A tab was chosen; the page moves its `job` (its URL). Without it the drawer switches itself. */
  onJobChange?: (job: string) => void;
  /** The pipeline's name, for the title ("Imagery" → "Imagery runs"). */
  pipeline?: string;
  /** A tab's short name ("Poll"); the cron's title otherwise. */
  labelOf?: (job: string) => string;
  /** A cron's count columns in the runs table. */
  columnsOf?: (job: string) => readonly CronRunsColumn[];
  /** What a run did, in the page's words. */
  headlineOf?: (run: CronRunView) => string | null;
  /** A cron's strip range: from when, and its words. The last 12 hours or 30 days otherwise. */
  stripRangeOf?: (job: string, now: number) => { from: number; label: string };
  /** The foot's action for a cron (the poll's *Run now*); none, no foot. */
  footOf?: (job: string) => ReactNode;
  timeZone?: string;
  /** Where the sheet portals (a story's frame). */
  container?: HTMLElement | null;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A cron that ticks at least every half hour draws its last 12 hours; a slower one its 30 days. */
const FREQUENT_MS = 30 * 60_000;

/** The default strip range for a cron. */
export function defaultStripRange(
  job: Pick<CronJobView, 'schedule'> | null,
  now: number,
): { from: number; label: string } {
  const frequent = job !== null && 'every' in job.schedule && job.schedule.every <= FREQUENT_MS;
  return frequent
    ? { from: now - 12 * HOUR, label: CRON_WORDS.stripLast(12) }
    : { from: now - 30 * DAY, label: CRON_WORDS.stripDays(30) };
}

/** The read filter behind a view filter: *Did something* is every run, unfolded. */
const readFilterOf = (f: CronRunsFilterView) => (f === 'failed' ? 'failed' : 'all');

export function CronRunsDrawer({
  job: jobProp,
  open,
  onClose,
  tabs,
  onJobChange,
  pipeline,
  labelOf,
  columnsOf,
  headlineOf,
  stripRangeOf,
  footOf,
  timeZone,
  container,
}: CronRunsDrawerProps) {
  const [ownJob, setOwnJob] = useState(jobProp);
  useEffect(() => setOwnJob(jobProp), [jobProp]);
  const job = onJobChange === undefined ? ownJob : jobProp;
  const names = useMemo(() => {
    const list = tabs === undefined || tabs.length === 0 ? [jobProp] : [...tabs];
    return list.includes(job) ? list : [...list, job];
  }, [tabs, jobProp, job]);
  // The filter starts over at *All* whenever the open cron changes.
  const [chosen, setChosen] = useState<{ job: string; filter: CronRunsFilterView }>({
    job,
    filter: 'all',
  });
  const filter = chosen.job === job ? chosen.filter : 'all';
  const setFilter = (f: CronRunsFilterView) => setChosen({ job, filter: f });

  const minute = useMinuteNow();
  const tick = useTickingNow(1_000);
  const to = Math.floor(minute / 60_000) * 60_000;

  // ── The tabs' crons ──
  const { reads: jobReads } = useConsoleReadSet({
    jobs: open ? read(api.machineryCrons.jobs, { names: [...names], now: to }) : null,
  });
  const jobs = jobReads.jobs as Loadable<CronJobView[]>;
  const jobsList = isFailed(jobs) ? undefined : jobs;
  const current = jobsList?.find((j) => j.job === job) ?? null;

  // ── The strip ──
  const range = stripRangeOf?.(job, to) ?? defaultStripRange(current, to);
  const { reads: stripReads } = useConsoleReadSet({
    strip:
      open && (stripRangeOf !== undefined || current !== null)
        ? read(api.machineryCrons.strip, { job, from: range.from, to })
        : null,
  });
  const strip = stripReads.strip as Loadable<CronStripView>;

  // ── The runs ──
  const readFilter = readFilterOf(filter);
  const chain = useChainedPages<CronRunsPage>(
    open ? `${job}:${readFilter}` : '',
    open
      ? (link) =>
          read(api.machineryCrons.runsPage, {
            job,
            filter: readFilter,
            paginationOpts: {
              numItems: CRON_RUNS_PAGE,
              cursor: link.cursor,
              ...(link.end !== null && { endCursor: link.end }),
            },
          })
      : null,
  );
  const joined = useJoinedPages(open ? chain.pages : null, joinRuns);

  useFailureToast(open && isFailed(jobs) ? jobs : null, CRON_WORDS.readFailed.jobs, `jobs:${job}`);
  useFailureToast(
    open && isFailed(strip) ? strip : null,
    CRON_WORDS.readFailed.strip,
    `strip:${job}`,
  );
  const runsFailure = open ? (chain.pages.find(isFailed) ?? null) : null;
  useFailureToast(runsFailure, CRON_WORDS.readFailed.runs, `runs:${job}:${readFilter}`);

  const status: CronRunsStatus =
    joined.status === 'unread' || joined.status === 'loading' ? 'loading' : joined.status;
  const chooseJob = (next: string) => {
    if (onJobChange !== undefined) onJobChange(next);
    else setOwnJob(next);
  };

  return (
    <CronRunsView
      open={open}
      onClose={onClose}
      title={CRON_WORDS.drawerTitle(pipeline ?? null)}
      tabs={jobsList?.map((j) => ({ job: j, label: labelOf?.(j.job) ?? j.title }))}
      job={job}
      onJobChange={chooseJob}
      strip={{
        ticks: isFailed(strip) ? [] : strip?.ticks,
        truncated: isFailed(strip) ? false : (strip?.truncated ?? false),
        from: range.from,
        to,
        label: range.label,
      }}
      filter={filter}
      onFilterChange={setFilter}
      runs={status === 'loading' ? undefined : joined.rows}
      status={status}
      onLoadMore={chain.loadMore}
      {...(columnsOf !== undefined && { columns: columnsOf(job) })}
      {...(headlineOf !== undefined && { headlineOf })}
      logFor={(run, label) => (
        <LiveCronRunLog key={run.id} run={run} label={label} timeZone={timeZone} />
      )}
      foot={footOf?.(job)}
      now={tick}
      {...(timeZone !== undefined && { timeZone })}
      {...(container !== undefined && { container })}
    />
  );
}

/** The runs list: each run once, in the chain's order. */
function joinRuns(pages: readonly Loadable<CronRunsPage>[] | null) {
  return joinChain(
    pages,
    (p) => p.page,
    (r) => r.id,
  );
}

/** A run's log, wired to `runLog`: 200 lines a page, newest first, drawn oldest first. */
export function LiveCronRunLog({
  run,
  label,
  timeZone,
}: {
  run: CronRunView;
  label: string;
  timeZone?: string;
}) {
  const chain = useChainedPages<CronRunLogPage>(run.id, (link) =>
    read(api.machineryCrons.runLog, {
      runId: run.id as Id<'cronRuns'>,
      paginationOpts: {
        numItems: CRON_LOG_PAGE,
        cursor: link.cursor,
        ...(link.end !== null && { endCursor: link.end }),
      },
    }),
  );
  const joined = useJoinedPages(chain.pages, joinLines);
  useFailureToast(chain.pages.find(isFailed) ?? null, CRON_WORDS.readFailed.log, `log:${run.id}`);
  const lines = useMemo(
    () =>
      joined.status === 'loading' || joined.status === 'unread'
        ? undefined
        : [...joined.rows].reverse(),
    [joined],
  );
  return (
    <CronRunLog
      lines={lines}
      more={joined.status === 'more' || joined.status === 'fetching'}
      loadingOlder={joined.status === 'fetching'}
      onLoadOlder={chain.loadMore}
      failed={run.outcome === 'failed' || run.outcome === 'killed'}
      label={label}
      {...(timeZone !== undefined && { timeZone })}
    />
  );
}

function joinLines(pages: readonly Loadable<CronRunLogPage>[] | null) {
  return joinChain(
    pages,
    (p) => p.page,
    (l) => String(l.seq),
  );
}

/**
 * A failed read's toast, once per failure (D268: errors are toasts, never inline), with *Try again*.
 * Keyed by what failed, so a failure that stands doesn't toast again on every render.
 */
function useFailureToast(failure: ReadFailure | null, title: string, key: string) {
  const failing = failure !== null && !failure.pending;
  useEffect(() => {
    if (!failing || failure === null) return;
    toast({
      id: `cron-read:${key}`,
      title,
      tone: 'bad',
      action: { label: CRON_WORDS.tryAgain, onAction: failure.retry },
    });
  }, [failing, failure, key, title]);
}
