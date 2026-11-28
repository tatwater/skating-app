import { useState } from 'react';

import { Button } from '@/components/kit/button';

import {
  type CronRunsColumn,
  CronCard as GenericCronCard,
  CronRunsDrawer as GenericCronRunsDrawer,
} from '../crons';
import { IMAGERY_RUNS_TABS, type ImageryRunsTab } from '../imagerySearch';
import type { CronJobView, RunNowProp } from './imageryModel';
import {
  CRON_LABELS,
  CRON_TABS,
  IMAGERY,
  imageryRunHeadline,
  RUN_NOW,
  RUN_NOW_WHAT,
} from './imageryWords';

/**
 * **The Imagery page's cron pieces** — the generic card and runs drawer (`machinery/crons/*`),
 * dressed in the page's own words: the board's names (*Poll for new passes*), each run's headline
 * (*6 new*, *1 starting*, *nothing new*) from its counts, the runs table's count columns, and the
 * poll's *Run now*.
 *
 * **Run now** is one control, drawn beside the poll's card and in the drawer's foot on the poll's
 * tab (`runNow`): pressable while imagery runs; drawn disabled while the season waits for a start
 * (a poll before *Start* is a silent skip, so the server refuses it); not drawn at all when paused,
 * ended, or for a viewer who can't write — never offered where the server would refuse.
 */

/** Which of the page's three a cron is, by its registered name (the page's `crons` order). */
export function imageryTabOf(crons: readonly CronJobView[], job: string): ImageryRunsTab | null {
  const i = crons.findIndex((c) => c.job === job);
  return i < 0 ? null : (IMAGERY_RUNS_TABS[i] ?? null);
}

/** The runs table's count columns per cron. */
const COLUMNS: Record<ImageryRunsTab, readonly CronRunsColumn[]> = {
  poll: [
    { key: 'selected', label: 'Found' },
    { key: 'queued', label: 'Queued' },
  ],
  pump: [
    { key: 'spawned', label: 'Started' },
    { key: 'landed', label: 'Landed' },
  ],
  index: [
    { key: 'added', label: 'Added' },
    { key: 'frames', label: 'Frames' },
  ],
};

/** The poll's *Run now*: one button, busy while its press is out. */
export function RunNowButton({ runNow, wide = false }: { runNow: RunNowProp; wide?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={wide ? 'default' : 'xs'}
      {...(wide && { variant: 'primary' as const })}
      data-slot="cron-run-now"
      title={RUN_NOW_WHAT}
      disabled={runNow === null}
      loading={busy}
      className={wide ? 'w-full' : '-ml-px'}
      onClick={() => {
        if (runNow === null || busy) return;
        setBusy(true);
        void Promise.resolve(runNow.onPress()).finally(() => setBusy(false));
      }}
    >
      {RUN_NOW}
    </Button>
  );
}

export function CronCard({
  job,
  tab,
  onOpenRuns,
  runNow,
  now,
  timeZone,
  className,
}: {
  job: CronJobView;
  tab: ImageryRunsTab;
  onOpenRuns: () => void;
  /** The poll's *Run now* (see the file's head); absent, not drawn. */
  runNow?: RunNowProp;
  now?: number;
  timeZone?: string;
  className?: string;
}) {
  return (
    <GenericCronCard
      job={job}
      label={CRON_LABELS[tab]}
      headline={job.lastRun === null ? null : imageryRunHeadline(tab, job.lastRun)}
      onOpenRuns={onOpenRuns}
      {...(runNow !== undefined && { action: <RunNowButton runNow={runNow} /> })}
      {...(now !== undefined && { now })}
      {...(timeZone !== undefined && { timeZone })}
      {...(className !== undefined && { className })}
    />
  );
}

export function CronRunsDrawer({
  crons,
  tab,
  open,
  onClose,
  onTab,
  runNow,
  timeZone,
  container,
}: {
  /** The page's three crons, in order (poll, pump, index). */
  crons: readonly CronJobView[];
  tab: ImageryRunsTab;
  open: boolean;
  onClose: () => void;
  /** A tab was chosen (the page keeps it in the URL). */
  onTab: (tab: ImageryRunsTab) => void;
  runNow?: RunNowProp;
  timeZone?: string;
  container?: HTMLElement | null;
}) {
  const job = crons[IMAGERY_RUNS_TABS.indexOf(tab)];
  if (job === undefined) return null;
  const tabOf = (name: string) => imageryTabOf(crons, name);
  return (
    <GenericCronRunsDrawer
      job={job.job}
      open={open}
      onClose={onClose}
      tabs={crons.map((c) => c.job)}
      onJobChange={(name) => {
        const next = tabOf(name);
        if (next !== null) onTab(next);
      }}
      pipeline={IMAGERY}
      labelOf={(name) => {
        const t = tabOf(name);
        return t === null ? name : CRON_TABS[t];
      }}
      columnsOf={(name) => {
        const t = tabOf(name);
        return t === null ? [] : COLUMNS[t];
      }}
      headlineOf={(run) => imageryRunHeadline(tab, run)}
      jobHeadlineOf={(j) => {
        const t = tabOf(j.job);
        return t === null || j.lastRun === null ? null : imageryRunHeadline(t, j.lastRun);
      }}
      footOf={(name) =>
        tabOf(name) === 'poll' && runNow !== undefined ? (
          <RunNowButton runNow={runNow} wide />
        ) : null
      }
      {...(timeZone !== undefined && { timeZone })}
      {...(container !== undefined && { container })}
    />
  );
}
