import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { cn } from '@/lib/utils';

import { useTickingNow } from '../../body/tabs/tabParts';
import { isFixedTime, scheduleWords, shortWhen } from './cronFormat';
import { type CronCardState, type CronReading, type CronTone, cronReading } from './cronModel';
import type { CronJobView } from './cronViews';
import { CRON_STATE_WORDS, CRON_WORDS, countsLine } from './cronWords';

/**
 * **A cron's card** (board 6.4's cron strip: *Poll for new passes · Every 6 hours · 6 new · 12:40 ·
 * Runs · Run now*; Weather and Health reuse it) — a **kit candidate**, kit-shaped here until the
 * governor promotes it.
 *
 * - **Its state ticks on the viewer's clock**: the verdict is core's rule re-read every second from
 *   the inputs the server sent (`cronModel`), so the card turns late the second the cron does.
 * - **When it ran, never a guessed next run** (ruling 17): an interval cron says its interval and
 *   its last run; a daily or weekly one its fixed UTC time and its next run in the viewer's clock.
 * - **The right slot** holds the last run's time while all is well; otherwise the state's word in
 *   caps (*Running*, *Late*, *Failed*, *Cut off*, *Not recorded yet*), toned by meaning, and the last
 *   run moves to the sub-line. The word is there for a reader who doesn't see the color.
 * - **A sparse cron says so**: its quiet checks are kept once an hour, so its last time can be an
 *   hour old while it is on time.
 * - **Runs** opens the drawer; the page passes its own action (the poll's *Run now*) beside it.
 */

export type CronCardProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The cron, as `machineryCrons.jobs` sends it. */
  job: CronJobView;
  /** Opens the runs drawer on this cron. */
  onOpenRuns: () => void;
  /** The card's name ("Poll for new passes"); the read's title otherwise. */
  label?: string;
  /** What the last run did ("6 new"); its counts otherwise. `null` says nothing. */
  headline?: string | null;
  /** The page's own control beside *Runs* (the poll's *Run now*). */
  action?: ReactNode;
  /** A pinned clock (a story's); else the card ticks every second. */
  now?: number;
  timeZone?: string;
};

const WHEN_TONE: Record<CronTone, string> = {
  bad: 'text-bad font-medium tracking-micro uppercase text-kick',
  warn: 'text-warn font-medium tracking-micro uppercase text-kick',
  live: 'text-fg font-medium tracking-micro uppercase text-kick',
  quiet: 'text-fg3 text-mono-sm',
  hollow: 'text-fg3 font-medium tracking-micro uppercase text-kick',
};

const LED: Record<CronTone, string> = {
  bad: 'bg-bad',
  warn: 'bg-warn',
  live: 'bg-fg shadow-glow-w',
  quiet: 'bg-fg2',
  hollow: 'bg-transparent inset-ring inset-ring-fg3',
};

const TITLE: Record<CronTone, string> = {
  bad: 'text-bad',
  warn: 'text-warn',
  live: 'text-fg',
  quiet: 'text-fg',
  hollow: 'text-fg1',
};

export function CronCard({
  job,
  onOpenRuns,
  label,
  headline,
  action,
  now: pinned,
  timeZone,
  className,
  ...props
}: CronCardProps) {
  const ticking = useTickingNow(1_000);
  const now = pinned ?? ticking;
  const reading = cronReading(job, now);
  const title = label ?? job.title;
  const what =
    headline === undefined ? (countsLine(job.lastRun?.counts ?? null) ?? null) : headline;
  const sub = cronSubLine(job, reading, what, now, timeZone);
  const when = whenSlot(reading, now, timeZone);
  return (
    <div
      data-slot="cron-card"
      data-job={job.job}
      data-state={reading.state}
      data-tone={reading.tone}
      className={cn(
        'flex min-w-0 items-center gap-(--space-2_5) py-(--space-2_5) pr-(--space-4)',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="cron-led"
        className={cn('size-(--stroke-tick) shrink-0', LED[reading.tone])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
        <span
          data-slot="cron-title"
          className={cn('truncate text-row leading-snug font-medium', TITLE[reading.tone])}
        >
          {title}
        </span>
        <span data-slot="cron-sub" className="truncate text-assist leading-snug text-fg3">
          {sub}
        </span>
      </div>
      <span
        data-slot="cron-when"
        className={cn(
          'shrink-0 font-(family-name:--family-mono) leading-none whitespace-nowrap',
          WHEN_TONE[reading.tone],
        )}
      >
        {when.text}
        {when.hidden !== null && <span className="sr-only"> · {when.hidden}</span>}
      </span>
      <span className="flex shrink-0 items-center">
        <Button
          size="xs"
          data-slot="cron-runs"
          aria-label={`${CRON_WORDS.runs} · ${title}`}
          onClick={onOpenRuns}
        >
          {CRON_WORDS.runs}
        </Button>
        {action}
      </span>
    </div>
  );
}

/** The right slot: the last run's time while all is well, else the state's word. */
export function whenSlot(
  reading: CronReading,
  now: number,
  timeZone?: string,
): { text: string; hidden: string | null } {
  if (reading.state === 'ok' && reading.at !== null) {
    return { text: shortWhen(reading.at, now, timeZone), hidden: CRON_STATE_WORDS.ok };
  }
  return { text: stateWord(reading.state), hidden: null };
}

export const stateWord = (state: CronCardState) => CRON_STATE_WORDS[state];

/**
 * The sub-line: the schedule in words, a fixed-time cron's next run, then what the last run did
 * (on time) or when it last ran (any other state); a sparse cron's note while it is quiet.
 */
export function cronSubLine(
  job: Pick<CronJobView, 'schedule' | 'record' | 'inputs'>,
  reading: CronReading,
  headline: string | null,
  now: number,
  timeZone?: string,
): string {
  const parts = [scheduleWords(job.schedule)];
  if (isFixedTime(job.schedule) && reading.nextAt !== null) {
    parts.push(CRON_WORDS.next(shortWhen(reading.nextAt, now, timeZone)));
  }
  if (reading.state === 'running' && job.inputs.runningTrigger === 'manual') {
    parts.push(CRON_WORDS.pressed);
  } else if (reading.state === 'ok' || reading.state === 'running') {
    if (headline !== null) parts.push(headline);
    else if (job.record === 'sparse') parts.push(CRON_WORDS.keptHourly);
  } else if (reading.at !== null) {
    parts.push(CRON_WORDS.last(shortWhen(reading.at, now, timeZone)));
  }
  return parts.join(' · ');
}
