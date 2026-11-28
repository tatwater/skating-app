import type { ReactElement, ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';

import { clock } from '../corpus/runFormat';
import type { ImageryRunsTab } from '../imagerySearch';
import { CronCard } from './crons';
import {
  type CronJobView,
  dayWords,
  fahrenheit,
  type ImageryPageView,
  isoDayWords,
  type LowsFacts,
  lineCrossed,
  machineMinutes,
  pageShapeOf,
  type RunNowProp,
  relativeDay,
  runNowOf,
  seasonWords,
  shortDayWords,
  totalQueued,
} from './imageryModel';
import * as W from './imageryWords';

/**
 * **The Imagery page's head** (boards 6.4, *Waiting for Cold*, *Line Crossed*) — spanning the list
 * and the detail: the page word, its kicker and the link to Seasons; the five stats; the three cron
 * cards (the generic `CronCard` in the page's words, `./crons`), each opening its runs drawer.
 *
 * - **Working** (running, paused, ended): *State*, *Granules landed*, *Machines*, *Live index*,
 *   *Fly · this season* in machine-minutes only (never dollars, ruling 6).
 * - **Waiting** (not started, no watch): *State*, *Ice watch*, then *Closest night* and *Imagery
 *   line* until a sentinel crosses it, *Imagery line: Crossed* and *Staff email* after, and *Fly*.
 * - **The poll's *Run now*** only while imagery runs; waiting, it is drawn disabled (a poll before
 *   *Start* is a silent skip, ruling 16); paused or ended, not drawn.
 *
 * Air temperatures at named sites, never ice (D3).
 */
export type ImageryHeadProps = {
  view: ImageryPageView;
  /** The lows' facts for the waiting head (how many sentinels opened the watch, the line's night). */
  lows?: LowsFacts | null;
  now: number;
  timeZone?: string;
  /** The router's link to Seasons (a story's anchor). */
  seasonsLink: ReactElement;
  onOpenRuns: (tab: ImageryRunsTab) => void;
  /** The poll's *Run now*; absent when the viewer can't write. */
  onRunNow?: () => Promise<boolean>;
  /** The console's narrow rule: the stats two to a row, the cron cards stacked. */
  narrow?: boolean;
  className?: string;
};

const TABS: readonly ImageryRunsTab[] = ['poll', 'pump', 'index'];

export function ImageryHead({
  view,
  lows = null,
  now,
  timeZone,
  seasonsLink,
  onOpenRuns,
  onRunNow,
  narrow = false,
  className,
}: ImageryHeadProps) {
  const shape = pageShapeOf(view.state);
  const runNow: RunNowProp | undefined =
    onRunNow === undefined ? undefined : runNowOf(view.state, onRunNow);
  return (
    <header
      data-slot="imagery-head"
      data-state={view.state}
      className={cn('flex min-w-0 flex-col border-0 border-b border-solid border-line', className)}
    >
      <div className="flex min-w-0 items-end gap-(--space-3_5) px-gutter pt-(--space-4)">
        <h1
          data-slot="page-word"
          className="m-0 text-disp leading-none font-semibold tracking-disp whitespace-nowrap text-fg uppercase"
        >
          {W.IMAGERY}
        </h1>
        <span
          data-slot="imagery-kicker"
          className="min-w-0 truncate pb-(--space-0_5) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
        >
          {W.headKicker(seasonWords(view.season))}
        </span>
        <span className="ms-auto shrink-0">
          <Button
            variant="link"
            size="xs"
            data-slot="seasons-link"
            nativeButton={false}
            render={seasonsLink}
          >
            {W.SEASONS_LINK}
          </Button>
        </span>
      </div>
      <StatGrid
        data-slot="imagery-stats"
        columns={narrow ? 2 : 5}
        // The board's cells take their content's width, the last the rest (never squeezed to fifths).
        style={
          narrow ? undefined : { gridTemplateColumns: 'repeat(4, max-content) minmax(0, 1fr)' }
        }
        className="px-gutter pt-(--space-3_5) pb-(--space-3)"
      >
        {shape === 'working'
          ? workingStats(view, now, timeZone)
          : waitingStats(view, lows, now, timeZone)}
      </StatGrid>
      {!view.configured && (
        <Note data-slot="imagery-unconfigured" tone="warn" className="mx-gutter mb-(--space-3)">
          {W.UNCONFIGURED}
        </Note>
      )}
      {view.backoffUntil !== null && view.backoffUntil > now && (
        <Note data-slot="imagery-backoff" tone="warn" className="mx-gutter mb-(--space-3)">
          {W.backingOffUntil(clock(view.backoffUntil, timeZone))}
        </Note>
      )}
      <div
        data-slot="cron-strip"
        className={cn(
          'mx-gutter grid min-w-0 border-0 border-t-(length:--stroke-hair) border-dotted border-line',
          narrow
            ? 'grid-cols-1 [&>*+*]:border-0 [&>*+*]:border-t-(length:--stroke-hair) [&>*+*]:border-dotted [&>*+*]:border-line'
            : 'grid-cols-3 [&>*+*]:border-0 [&>*+*]:border-s-(length:--stroke-hair) [&>*+*]:border-dotted [&>*+*]:border-line [&>*+*]:ps-(--space-4)',
        )}
      >
        {view.crons.slice(0, 3).map((job: CronJobView, i) => {
          const tab = TABS[i] as ImageryRunsTab;
          return (
            <CronCard
              key={job.job}
              job={job}
              tab={tab}
              onOpenRuns={() => onOpenRuns(tab)}
              {...(now !== undefined && { now })}
              {...(timeZone !== undefined && { timeZone })}
              {...(tab === 'poll' && runNow !== undefined && { runNow })}
            />
          );
        })}
      </div>
    </header>
  );
}

function workingStats(view: ImageryPageView, now: number, timeZone?: string): ReactNode[] {
  const { counts, machines, index, fly } = view;
  return [
    <StatTile
      key="state"
      data-slot="stat-state"
      label={W.STATE}
      value={
        view.state === 'running' ? (
          <span className="text-acc">{W.STATE_WORDS.running}</span>
        ) : (
          W.STATE_WORDS[view.state]
        )
      }
      {...(view.state === 'paused' && { tone: 'warn' as const })}
      {...(view.state === 'ended' && { tone: 'dim' as const })}
      sub={stateSub(view, timeZone)}
    />,
    <StatTile
      key="landed"
      data-slot="stat-landed"
      label={W.LANDED}
      value={counts.landed.toLocaleString('en-US')}
      sub={W.ofQueued(totalQueued(counts))}
    />,
    <StatTile
      key="machines"
      data-slot="stat-machines"
      label={W.MACHINES}
      value={
        machines.live === null ? (
          W.NOT_RECORDED
        ) : (
          <>
            {machines.live}
            <span className="text-fg3">/{machines.cap}</span>
          </>
        )
      }
      {...(machines.live !== null ? { unit: W.LIVE } : { tone: 'dim' as const })}
      sub={
        machines.live === null
          ? W.NOT_LISTED_YET
          : machines.live > 0
            ? W.CUTTING_NOW
            : W.NONE_CUTTING
      }
    />,
    <StatTile
      key="index"
      data-slot="stat-index"
      label={W.LIVE_INDEX}
      value={index.built ? index.frames.toLocaleString('en-US') : W.NOT_BUILT}
      {...(index.built ? { unit: W.FRAMES } : { tone: 'dim' as const })}
      sub={
        index.retryAt !== null
          ? index.retryAt > now
            ? W.rereadsAt(clock(index.retryAt, timeZone))
            : W.REREADS_NEXT
          : index.built
            ? W.REBUILT_AS_FRAMES_LAND
            : W.BUILDS_ONCE
      }
    />,
    flyStat(fly, timeZone),
  ];
}

function flyStat(fly: ImageryPageView['fly'], timeZone?: string): ReactNode {
  return (
    <StatTile
      key="fly"
      data-slot="stat-fly"
      label={W.FLY}
      value={machineMinutes(fly.machineMs).toLocaleString('en-US')}
      unit={W.MACHINE_MIN}
      sub={
        fly.countedFrom === null
          ? W.SINCE_THE_START
          : W.countedFrom(shortDayWords(fly.countedFrom, timeZone))
      }
    />
  );
}

function stateSub(view: ImageryPageView, timeZone?: string): string {
  switch (view.state) {
    case 'paused':
      return W.PAUSED_SUB;
    case 'ended':
      return W.ENDED_SUB;
    default: {
      const parts: string[] = [];
      if (view.startedAt !== null) {
        const day = shortDayWords(view.startedAt, timeZone);
        parts.push(
          view.startedBy === null ? W.startedOn(day) : W.startedBy(view.startedBy.name, day),
        );
      }
      if (view.image !== null)
        parts.push(W.cutterPinned(shortDayWords(view.image.seenAt, timeZone)));
      return parts.join(' · ');
    }
  }
}

function waitingStats(
  view: ImageryPageView,
  lows: LowsFacts | null,
  now: number,
  timeZone?: string,
): ReactNode[] {
  const watch = view.watch;
  const crossed = lineCrossed(watch);
  const opened = watch?.openedAt ?? null;
  const stats: ReactNode[] = [
    <StatTile
      key="state"
      data-slot="stat-state"
      label={W.STATE}
      value={W.STATE_WORDS[view.state]}
      sub={view.state === 'noWatch' ? W.NO_WATCH_SUB : W.NOT_STARTED_SUB}
    />,
    <StatTile
      key="watch"
      data-slot="stat-watch"
      label={W.ICE_WATCH}
      value={opened === null ? W.NOT_OPEN : <span className="text-acc">{W.OPEN}</span>}
      {...(opened === null && { tone: 'dim' as const })}
      sub={
        opened === null
          ? W.OPENS_ON_COLD
          : [
              W.openSince(dayWords(opened, timeZone)),
              ...(lows?.opened != null ? [W.sentinelsOf(lows.opened.fired, lows.opened.of)] : []),
            ].join(' · ')
      }
    />,
  ];
  if (!crossed) {
    const night = watch?.closestNight ?? null;
    stats.push(
      <StatTile
        key="closest"
        data-slot="stat-closest"
        label={<span className="text-warn">{W.CLOSEST_NIGHT}</span>}
        value={night === null ? W.NOT_RECORDED : fahrenheit(night.lowC)}
        {...(night === null ? { tone: 'dim' as const } : { unit: W.DEGREES_F })}
        sub={night === null ? W.NO_NIGHT_YET : `${night.site} · ${isoDayWords(night.date)}`}
      />,
      <StatTile
        key="line"
        data-slot="stat-line"
        label={W.IMAGERY_LINE}
        value={watch === null ? W.NOT_RECORDED : fahrenheit(watch.lineC)}
        {...(watch === null ? { tone: 'dim' as const } : { unit: W.DEGREES_F })}
        sub={W.ANY_ONE_SENTINEL}
      />,
    );
  } else {
    const on = lows?.crossed?.on ?? watch?.closestNight?.date ?? null;
    const sites = lows?.crossed?.sites.length ?? null;
    stats.push(
      <StatTile
        key="line"
        data-slot="stat-line"
        label={<span className="text-warn">{W.IMAGERY_LINE}</span>}
        value={W.CROSSED}
        sub={[
          ...(on !== null ? [isoDayWords(on)] : []),
          ...(sites !== null && lows?.opened != null ? [W.sentinelsOf(sites, lows.opened.of)] : []),
        ].join(' · ')}
      />,
      <StatTile
        key="email"
        data-slot="stat-email"
        label={W.STAFF_EMAIL}
        value={watch?.staffEmailAt == null ? W.NOT_SENT_YET : clock(watch.staffEmailAt, timeZone)}
        {...(watch?.staffEmailAt == null && { tone: 'dim' as const })}
        sub={
          watch?.staffEmailAt == null
            ? W.THEN_NOT_SENT_SHORT
            : `${relativeDay(watch.staffEmailAt, now, timeZone)} · ${W.SENT_TO_STAFF}`
        }
      />,
    );
  }
  stats.push(flyStat(view.fly, timeZone));
  return stats;
}
