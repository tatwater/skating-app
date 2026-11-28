import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { Fragment, type ReactNode, type UIEvent, useMemo, useState } from 'react';

import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { CellLoader } from '@/components/kit/meter';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/kit/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/kit/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { cn } from '@/lib/utils';

import { clock } from '../corpus/runFormat';
import { cronSubLine, stateWord } from './CronCard';
import { CronTickStrip } from './CronTickStrip';
import { dayClock, isFixedTime, scheduleWords, shortWhen, tookWords } from './cronFormat';
import {
  type CronReading,
  type CronTone,
  cronReading,
  foldQuiet,
  MAX_OPEN_BY_ITSELF,
  opensByItself,
  type RunsListRow,
  runTone,
} from './cronModel';
import type { CronJobView, CronRunView, CronTickView } from './cronViews';
import { CRON_WORDS, countsLine, RUN_OUTCOME_WORDS, runPressedWords } from './cronWords';

/**
 * **A pipeline's runs drawer** (boards 6.4 *Runs* and *Runs · Pump*; 6.6 and 6.7 draw the same for
 * Notifications and Rollovers) — the view, fed by props; `CronRunsDrawer` wires it to the reads.
 *
 * - **One tab per cron of the pipeline**, each mirroring its card: its square, its name, its state
 *   or last time, its schedule — so switching histories is one press.
 * - **The strip** of the cron's ticks over the range (`CronTickStrip`).
 * - **The runs**: *All* (the runs, with the quiet ticks between them folded into one line each —
 *   *12 quiet checks · 13:54–14:00*), *Did something* (the runs alone) and *Failed*. The *Failed*
 *   read lists failed runs only, so a killed run is under *All* — the list says so (Ma29).
 * - **A run's log opens in place**: a failed or killed run's opens by itself (the first few, each one
 *   a read), a successful one's stays collapsed until asked. A press of *Run now* says who pressed.
 *   A duration is drawn only where one was measured: a mutation job's is never "0 ms".
 * - **Older runs load as you scroll**, 25 at a time.
 * - **The foot** is the page's (the poll's *Run now*); no foot, no bar.
 */

export type CronRunsFilterView = 'all' | 'worked' | 'failed';

/** A count column of a job's runs table: the run's `counts[key]` under `label`. */
export type CronRunsColumn = { key: string; label: string };

/** Where the runs list stands. */
export type CronRunsStatus = 'loading' | 'more' | 'fetching' | 'done' | 'error';

export type CronRunsViewProps = {
  open: boolean;
  onClose: () => void;
  /** The sheet's title ("Imagery runs"). */
  title: string;
  /**
   * The pipeline's crons, as the tabs read them (each with its short name, and what its last run
   * did in the page's words — its counts otherwise); `undefined` while they load.
   */
  tabs: readonly { job: CronJobView; label: string; headline?: string | null }[] | undefined;
  /** The open cron's registered name. */
  job: string;
  onJobChange: (job: string) => void;
  strip: {
    ticks: readonly CronTickView[] | undefined;
    truncated: boolean;
    from: number;
    to: number;
    label: string;
  };
  filter: CronRunsFilterView;
  onFilterChange: (filter: CronRunsFilterView) => void;
  /** The runs read so far, newest first; `undefined` while the first page loads. */
  runs: readonly CronRunView[] | undefined;
  status: CronRunsStatus;
  onLoadMore: () => void;
  /** The open cron's count columns (none by default: the outcome line carries its counts). */
  columns?: readonly CronRunsColumn[];
  /** What a run did, in the page's words ("6 new"); its detail or counts otherwise. */
  headlineOf?: (run: CronRunView) => string | null;
  /** A run's log, drawn when its row is open. */
  logFor: (run: CronRunView, label: string) => ReactNode;
  /** The foot's action (the poll's *Run now*); none, no foot. */
  foot?: ReactNode;
  now: number;
  timeZone?: string;
  /** Where the sheet portals (a story's frame). */
  container?: HTMLElement | null;
  /** Whether the page behind is inert while it is open (a story's pair keeps both quads live). */
  modal?: boolean;
};

/** Within this of the list's end, the reader has scrolled down for more. */
const BOTTOM_SLACK_PX = 240;

export function CronRunsView(props: CronRunsViewProps) {
  const { open, onClose, title, container, modal = true } = props;
  return (
    <Sheet
      open={open}
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent size="drawer" {...(container !== undefined && { container })}>
        <div data-slot="cron-runs" className="flex min-h-0 flex-1 flex-col">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <CronRunsBody {...props} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CronRunsBody({
  tabs,
  job,
  onJobChange,
  strip,
  filter,
  onFilterChange,
  runs,
  status,
  onLoadMore,
  columns = [],
  headlineOf,
  logFor,
  foot,
  now,
  timeZone,
}: CronRunsViewProps) {
  const current = tabs?.find((t) => t.job.job === job)?.job ?? null;
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (status === 'more' && el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK_PX) {
      onLoadMore();
    }
  };
  const describe = useMemo(() => describeTick(runs, headlineOf), [runs, headlineOf]);
  return (
    <>
      <CronTabs tabs={tabs} job={job} onJobChange={onJobChange} now={now} timeZone={timeZone} />
      <SheetBody className="gap-(--space-6) bg-panel pt-(--space-5_5)" onScroll={onScroll}>
        <CronTickStrip
          ticks={strip.ticks}
          from={strip.from}
          to={strip.to}
          truncated={strip.truncated}
          sparse={current?.record === 'sparse'}
          label={strip.label}
          now={now}
          {...(timeZone !== undefined && { timeZone })}
          describe={describe}
        />
        <RunsSection
          key={`${job}:${filter}`}
          current={current}
          ticks={strip.ticks}
          filter={filter}
          onFilterChange={onFilterChange}
          runs={runs}
          status={status}
          columns={columns}
          headlineOf={headlineOf}
          logFor={logFor}
          now={now}
          timeZone={timeZone}
        />
      </SheetBody>
      {foot !== undefined && foot !== null && (
        <SheetFooter full data-slot="cron-runs-foot">
          {foot}
        </SheetFooter>
      )}
    </>
  );
}

// ── The tabs ─────────────────────────────────────────────────────────────────────────────────

const LED: Record<CronTone, string> = {
  bad: 'bg-bad',
  warn: 'bg-warn',
  live: 'bg-fg shadow-glow-w',
  quiet: 'bg-fg2',
  hollow: 'bg-transparent inset-ring inset-ring-fg3',
};

function CronTabs({
  tabs,
  job,
  onJobChange,
  now,
  timeZone,
}: Pick<CronRunsViewProps, 'tabs' | 'job' | 'onJobChange' | 'now' | 'timeZone'>) {
  if (tabs === undefined) {
    return (
      <div className="flex h-[3.95rem] shrink-0 items-center border-b border-solid border-line px-gutter">
        <CellLoader label={CRON_WORDS.runs} />
      </div>
    );
  }
  return (
    <TabsPrimitive.Root
      value={job}
      onValueChange={(v) => {
        if (typeof v === 'string') onJobChange(v);
      }}
    >
      <TabsPrimitive.List
        data-slot="cron-tabs"
        className="flex shrink-0 border-b border-solid border-line"
      >
        {tabs.map(({ job: j, label, headline }) => (
          <CronTab
            key={j.job}
            job={j}
            label={label}
            headline={headline === undefined ? countsLine(j.lastRun?.counts ?? null) : headline}
            now={now}
            timeZone={timeZone}
          />
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

function CronTab({
  job,
  label,
  headline,
  now,
  timeZone,
}: {
  job: CronJobView;
  label: string;
  headline: string | null;
  now: number;
  timeZone: string | undefined;
}) {
  const reading = cronReading(job, now);
  const when = tabWhen(reading, now, timeZone);
  const sub = cronSubLine(job, reading, headline, now, timeZone);
  return (
    <TabsPrimitive.Tab
      value={job.job}
      data-slot="cron-tab"
      data-state={reading.state}
      data-tone={reading.tone}
      className={cn(
        'group/tab relative grid min-w-0 flex-1 basis-0 cursor-pointer grid-cols-[var(--stroke-tick)_minmax(0,1fr)_auto] items-baseline gap-x-(--space-2_5) gap-y-(--space-1_5)',
        'border-0 border-l border-solid border-line bg-transparent px-gutter pt-[0.8rem] pb-(--space-3) text-left first:border-l-0',
        'text-fg3 outline-none transition-[background-color] duration-(--duration-fast) ease-standard',
        'lit:not-data-active:bg-lift-03 focus-visible:shadow-focus',
        'data-active:bg-panel',
        // The open tab: a 2 px rule along its top, and its foot opens into the body below.
        'data-active:before:absolute data-active:before:inset-x-0 data-active:before:top-0 data-active:before:h-(--space-0_5) data-active:before:bg-fg data-active:before:content-[""]',
        'data-active:after:absolute data-active:after:inset-x-0 data-active:after:-bottom-px data-active:after:h-px data-active:after:bg-panel data-active:after:content-[""]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-(--stroke-tick) self-center', LED[reading.tone])}
      />
      <b
        className={cn(
          'truncate text-body leading-snug font-medium text-fg2 group-data-active/tab:text-fg',
          reading.tone === 'bad' && 'text-bad group-data-active/tab:text-bad',
          reading.tone === 'warn' && 'text-warn group-data-active/tab:text-warn',
        )}
      >
        {label}
      </b>
      <span
        data-slot="cron-tab-when"
        className={cn(
          'text-right font-(family-name:--family-mono) leading-none whitespace-nowrap',
          reading.state === 'ok'
            ? 'text-mono-sm text-fg3'
            : 'text-kick font-medium tracking-micro uppercase',
          reading.tone === 'live' && 'text-fg',
          reading.tone === 'bad' && 'text-bad',
          reading.tone === 'warn' && 'text-warn',
          reading.tone === 'hollow' && 'text-fg3',
        )}
      >
        {when}
      </span>
      <small className="col-start-2 col-end-4 truncate text-assist leading-snug text-fg3 group-data-active/tab:text-fg2">
        {sub}
      </small>
    </TabsPrimitive.Tab>
  );
}

function tabWhen(reading: CronReading, now: number, timeZone: string | undefined): string {
  if (reading.state === 'ok' && reading.at !== null) return shortWhen(reading.at, now, timeZone);
  return stateWord(reading.state);
}

// ── The runs ─────────────────────────────────────────────────────────────────────────────────

function RunsSection({
  current,
  ticks,
  filter,
  onFilterChange,
  runs,
  status,
  columns,
  headlineOf,
  logFor,
  now,
  timeZone,
}: {
  current: CronJobView | null;
  ticks: readonly CronTickView[] | undefined;
  filter: CronRunsFilterView;
  onFilterChange: (f: CronRunsFilterView) => void;
  runs: readonly CronRunView[] | undefined;
  status: CronRunsStatus;
  columns: readonly CronRunsColumn[];
  headlineOf: CronRunsViewProps['headlineOf'];
  logFor: CronRunsViewProps['logFor'];
  now: number;
  timeZone: string | undefined;
}) {
  // Which logs the reader opened or closed; the rest follow the rule (failed open, the first few).
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const rows: RunsListRow[] = useMemo(() => {
    if (runs === undefined) return [];
    if (filter === 'all') return foldQuiet(runs, ticks ?? [], status === 'done');
    return runs.map((run) => ({ kind: 'run' as const, run }));
  }, [runs, ticks, filter, status]);
  const openByRule = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs ?? []) {
      if (ids.size >= MAX_OPEN_BY_ITSELF) break;
      if (opensByItself(run)) ids.add(run.id);
    }
    return ids;
  }, [runs]);
  const isOpen = (id: string) => toggled.get(id) ?? openByRule.has(id);
  const toggle = (id: string) =>
    setToggled((m) => new Map(m).set(id, !(m.get(id) ?? openByRule.has(id))));
  const timed = (runs ?? []).some((r) => r.durationMs !== null);
  const span = 4 + columns.length + (timed ? 1 : 0);
  const right = current === null ? null : headRight(current, now, timeZone);

  return (
    <section data-slot="cron-runs-list" aria-label={CRON_WORDS.runs} className="flex flex-col">
      <div className="mb-(--space-1) flex items-center gap-(--space-3)">
        <ToggleGroup
          aria-label={CRON_WORDS.filterLabel}
          value={filter}
          onValueChange={(v) => onFilterChange(v as CronRunsFilterView)}
        >
          <ToggleGroupItem value="all">{CRON_WORDS.filters.all}</ToggleGroupItem>
          <ToggleGroupItem value="worked">{CRON_WORDS.filters.worked}</ToggleGroupItem>
          <ToggleGroupItem value="failed">{CRON_WORDS.filters.failed}</ToggleGroupItem>
        </ToggleGroup>
        {right !== null && (
          <span
            data-slot="cron-runs-right"
            className="ml-auto truncate font-(family-name:--family-mono) text-mono-sm leading-none tracking-micro text-fg3 uppercase"
          >
            {right}
          </span>
        )}
      </div>
      {filter === 'failed' && (
        <p data-slot="cron-runs-killed-note" className="m-0 mt-(--space-2) text-assist text-fg3">
          {CRON_WORDS.failedOmitsKilled}
        </p>
      )}
      <div className="-mx-gutter">
        <Table className="[--table-ground:var(--panel)]">
          <TableHeader>
            <tr>
              <TableHead className="w-[2.125rem] pr-0" />
              <TableHead>{CRON_WORDS.columns.run}</TableHead>
              {timed && (
                <TableHead align="end" className="w-[4.5rem]">
                  {CRON_WORDS.columns.took}
                </TableHead>
              )}
              {columns.map((c) => (
                <TableHead key={c.key} align="end" className="w-[4.75rem]">
                  {c.label}
                </TableHead>
              ))}
              <TableHead className="pl-(--space-5_5)">{CRON_WORDS.columns.outcome}</TableHead>
              <TableHead className="w-[6.3rem]" />
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((row) =>
              row.kind === 'quiet' ? (
                <QuietRow
                  key={`q${row.to}`}
                  row={row}
                  sparse={current?.record === 'sparse'}
                  span={span}
                  timeZone={timeZone}
                />
              ) : (
                <Fragment key={row.run.id}>
                  <RunRow
                    run={row.run}
                    timed={timed}
                    columns={columns}
                    headlineOf={headlineOf}
                    open={isOpen(row.run.id)}
                    onToggle={() => toggle(row.run.id)}
                    now={now}
                    timeZone={timeZone}
                  />
                  {isOpen(row.run.id) && (
                    <tr data-slot="cron-run-logrow">
                      <td
                        colSpan={span}
                        className="bg-lift-05 px-gutter pt-(--space-1_5) pb-(--space-4)"
                      >
                        {logFor(
                          row.run,
                          CRON_WORDS.logLabel(dayClock(row.run.startedAt, now, timeZone)),
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ),
            )}
          </TableBody>
        </Table>
        <ListFoot status={status} empty={rows.length === 0} filter={filter} />
      </div>
    </section>
  );
}

/** The table head's right: a schedule and its last run (an interval), or its next (a fixed time). */
function headRight(job: CronJobView, now: number, timeZone: string | undefined): string {
  const reading = cronReading(job, now);
  const parts = [scheduleWords(job.schedule)];
  if (isFixedTime(job.schedule) && reading.nextAt !== null) {
    parts.push(CRON_WORDS.next(shortWhen(reading.nextAt, now, timeZone)));
  } else if (reading.at !== null) {
    parts.push(CRON_WORDS.last(shortWhen(reading.at, now, timeZone)));
  }
  return parts.join(' · ');
}

const ROW_TONE = { bad: 'text-bad', warn: 'text-warn', quiet: 'text-fg2' } as const;
const DOT_TONE = { bad: 'bg-bad', warn: 'bg-warn', quiet: 'bg-fg2' } as const;

/** What a run's outcome cell says: the page's words, the run's own, its counts, or its outcome. */
export function runOutcomeWords(
  run: CronRunView,
  headlineOf?: (run: CronRunView) => string | null,
): string {
  const own = headlineOf?.(run) ?? null;
  if (own !== null) return own;
  if (run.outcome === 'failed' || run.outcome === 'killed') {
    return run.error ?? run.detail ?? RUN_OUTCOME_WORDS[run.outcome];
  }
  return run.detail ?? countsLine(run.counts) ?? RUN_OUTCOME_WORDS[run.outcome];
}

function RunRow({
  run,
  timed,
  columns,
  headlineOf,
  open,
  onToggle,
  now,
  timeZone,
}: {
  run: CronRunView;
  timed: boolean;
  columns: readonly CronRunsColumn[];
  headlineOf: CronRunsViewProps['headlineOf'];
  open: boolean;
  onToggle: () => void;
  now: number;
  timeZone: string | undefined;
}) {
  const tone = runTone(run);
  const when = dayClock(run.startedAt, now, timeZone);
  const outcome = runOutcomeWords(run, headlineOf);
  const pressed = runPressedWords(run);
  return (
    <TableRow
      data-slot="cron-run"
      data-run={run.id}
      data-outcome={run.outcome}
      data-open={open ? '' : undefined}
      className={cn(open && 'bg-lift-05 [&>td:first-child]:shadow-select-rule')}
    >
      <TableCell className="pr-0">
        <span
          aria-hidden="true"
          className={cn('inline-block size-(--stroke-tick)', DOT_TONE[tone])}
        />
      </TableCell>
      <TableCell className={cn('whitespace-nowrap', tone === 'quiet' ? 'text-fg' : ROW_TONE[tone])}>
        {when}
      </TableCell>
      {timed && (
        <TableCell align="end" mono className="whitespace-nowrap text-fg3">
          {run.durationMs === null ? '' : tookWords(run.durationMs)}
        </TableCell>
      )}
      {columns.map((c) => (
        <TableCell key={c.key} align="end" mono className="whitespace-nowrap text-fg3">
          {(run.counts?.[c.key] ?? 0).toLocaleString('en-US')}
        </TableCell>
      ))}
      <TableCell className="pl-(--space-5_5)">
        <span
          data-slot="cron-run-outcome"
          className={cn(
            'font-(family-name:--family-mono) text-mono-sm font-medium',
            ROW_TONE[tone],
          )}
        >
          {outcome}
        </span>
        {pressed !== null && (
          <span data-slot="cron-run-pressed" className="ml-(--space-2) text-assist text-fg3">
            {pressed}
          </span>
        )}
      </TableCell>
      <TableCell align="end">
        <Button
          size="xs"
          data-slot="cron-run-log-toggle"
          aria-expanded={open}
          aria-label={`${open ? CRON_WORDS.hideLog : CRON_WORDS.log} · ${when}`}
          onClick={onToggle}
          className={cn(open && 'bg-lift-12 inset-ring-fg2 text-fg')}
        >
          {open ? CRON_WORDS.hideLog : CRON_WORDS.log}
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** The quiet ticks between two runs, folded into one line. */
function QuietRow({
  row,
  sparse,
  span,
  timeZone,
}: {
  row: Extract<RunsListRow, { kind: 'quiet' }>;
  sparse: boolean;
  span: number;
  timeZone: string | undefined;
}) {
  const count = sparse ? CRON_WORDS.quietHours(row.count) : CRON_WORDS.quietChecks(row.count);
  const range =
    row.from === row.to
      ? clock(row.to, timeZone)
      : `${clock(row.from, timeZone)}–${clock(row.to, timeZone)}`;
  return (
    <tr data-slot="cron-quiet" data-count={row.count}>
      <td
        colSpan={span}
        className="border-0 border-b border-dotted border-line py-(--space-2) pl-[2.125rem] font-(family-name:--family-mono) text-mono-sm leading-none text-fg3"
      >
        {count} · {range}
      </td>
    </tr>
  );
}

function ListFoot({
  status,
  empty,
  filter,
}: {
  status: CronRunsStatus;
  empty: boolean;
  filter: CronRunsFilterView;
}) {
  if (status === 'loading') {
    return (
      <div data-slot="cron-runs-loading" className="px-gutter py-(--space-3)">
        <CellLoader label={CRON_WORDS.runs} />
      </div>
    );
  }
  if (status === 'error') return null;
  if (empty && status === 'done') {
    return (
      <ListEnd data-slot="cron-runs-empty">
        {filter === 'failed' ? CRON_WORDS.noFailedRuns : CRON_WORDS.noRunsYet}
      </ListEnd>
    );
  }
  if (status === 'done') return <ListEnd data-slot="cron-runs-end">{CRON_WORDS.allLoaded}</ListEnd>;
  return (
    <p
      data-slot="cron-runs-more"
      className="m-0 px-gutter py-(--space-3) font-(family-name:--family-mono) text-mono-sm leading-none tracking-micro text-fg3 uppercase"
    >
      {status === 'fetching' ? CRON_WORDS.loadingOlder : CRON_WORDS.olderOnScroll}
    </p>
  );
}

/** A tick's plate lines from the runs loaded: the run that started in its second, in its words. */
function describeTick(
  runs: readonly CronRunView[] | undefined,
  headlineOf: CronRunsViewProps['headlineOf'],
): ((tick: CronTickView) => readonly string[]) | undefined {
  if (runs === undefined || runs.length === 0) return undefined;
  return (tick) => {
    const run = runs.find((r) => Math.abs(r.startedAt - tick.at) < 1_000);
    return run === undefined ? [] : [runOutcomeWords(run, headlineOf)];
  };
}
