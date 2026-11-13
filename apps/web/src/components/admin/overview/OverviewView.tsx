import { type Season, seasonRecordWindow } from '@skating/core';
import { useMemo } from 'react';

import { type DayKey, metricsNotRecorded } from '@/components/admin/metrics/metricsModel';
import { OverviewMetrics } from '@/components/admin/metrics/OverviewMetrics';
import type { MetricsReads } from '@/components/admin/metrics/useOverviewMetrics';
import type { SeasonPending } from '@/components/admin/season/SeasonTiles';
import { isoDay } from '@/components/admin/season/seasonFacts';
import { ScrollArea } from '@/components/kit/scroll-area';

import { ConsoleStatus } from '../shell/ConsoleShell';
import { LiveMark } from './LiveMark';
import { OverviewHome, type OverviewHomeData } from './OverviewHome';
import { OverviewPage } from './OverviewPage';
import { type FeedTarget, inboxTotal, machineryTrouble } from './overviewData';
import type { LinkTo } from './overviewLinks';
import { type LiveState, overviewHeads } from './overviewModel';
import type { OverviewTabValue } from './overviewSearch';
import { overviewStatus } from './overviewStatus';
import type { HomeReads } from './useOverviewHome';

/**
 * The Overview page as the console mounts it, from what the route hands it: the tab, the season,
 * Home's reads and Metrics', the clock and the connection. `OverviewRoute` wires it to the router
 * and Convex; a story draws the same page inside the real shell.
 *
 * **Nothing here is a fixture.** Cost, which no read serves yet, is `null` — *Not recorded yet* — and
 * so is whatever a read returned as `null`. A Metrics section whose read hasn't landed, or was read
 * over other days than the page draws (a read either side of midnight), is drawn unread
 * (`metricsNotRecorded`) over the season window until it matches.
 */

/** The blocks no read serves yet. Each is drawn *Not recorded yet*, never as a zero or a guess. */
export const UNREAD: Pick<OverviewHomeData, 'cost'> = { cost: null };

/** Whether a read covers exactly the days the page draws. */
function sameDays(a: readonly DayKey[], b: readonly DayKey[]): boolean {
  return a.length === b.length && a.every((day, i) => day === b[i]);
}

export type OverviewViewProps = {
  /**
   * The season the page shows: the one `now` falls in (it flips on 1 July) unless a season is
   * chosen. Every season-ranged block reads from it — a chooser is wiring, not a redraw.
   */
  season: Season;
  tab: OverviewTabValue;
  onTabChange: (tab: OverviewTabValue) => void;
  /** Home's reads (`useOverviewHome`), each `undefined` while it loads. */
  reads: HomeReads;
  /** Metrics' reads (`useOverviewMetrics`); none, or one still loading, draws unread. */
  metrics?: MetricsReads;
  /** The instant every age is read against. */
  now: number;
  /** The audit feed's live mark. */
  live: { state: LiveState; lastCheckedAt: number | null };
  /** Whether the viewer may read support (Metrics' support half). */
  support: boolean;
  linkTo?: LinkTo;
  onOpenTarget?: (target: FeedTarget) => void;
  /** Opens a body (Metrics' most-reported rows); the route says where. */
  onOpenBody?: (bodyId: string) => void;
  onRefresh?: () => void;
};

export function OverviewView({
  season,
  tab,
  onTabChange,
  reads,
  metrics: metricReads = {},
  now,
  live,
  support,
  linkTo,
  onOpenTarget,
  onOpenBody,
  onRefresh,
}: OverviewViewProps) {
  const span = useMemo(() => seasonRecordWindow(season, now), [season, now]);
  // From 1 July to 30 September the season has begun but its record hasn't: its four tiles show
  // the new season, empty, and when its record begins — never the last season's facts.
  const preseason: SeasonPending | null =
    span.days.length === 0 ? { state: 'pending', opensOn: isoDay(span.opensOn) } : null;
  const data: OverviewHomeData = {
    ...reads,
    ...UNREAD,
    ...(preseason !== null && {
      watch: preseason,
      winter: preseason,
      imagery: preseason,
      firstSkate: preseason,
    }),
  };
  // Machinery unread, withheld or loading says no run is stalled or failed — and none is fine.
  const trouble =
    data.machinery && data.machinery !== 'withheld'
      ? machineryTrouble(data.machinery)
      : { stalled: 0, failed: 0 };
  const heads = overviewHeads({
    inbox: data.inbox ? inboxTotal(data.inbox) : { count: 0, capped: false },
    refits: data.corpus?.chordRefits ?? { count: 0, capped: false },
    ...trouble,
  });
  const { keepingUp, showingUp, coverage } = metricReads;
  const metrics = useMemo(() => {
    const unread = metricsNotRecorded(span.days, { support });
    const read = <T,>(
      r: { days: readonly DayKey[] } | undefined,
      part: T | undefined,
    ): T | undefined => (r !== undefined && sameDays(r.days, span.days) ? part : undefined);
    return {
      keepingUp: read(keepingUp, keepingUp?.keepingUp) ?? unread.keepingUp,
      showingUp: read(showingUp, showingUp?.showingUp) ?? unread.showingUp,
      coverage: read(coverage, coverage?.coverage) ?? unread.coverage,
    };
  }, [span.days, support, keepingUp, showingUp, coverage]);

  return (
    <div
      data-slot="overview-route"
      className="flex h-full min-h-0 flex-col px-(--space-5_5) pt-(--space-3_5) pb-(--space-5_5)"
    >
      <ConsoleStatus groups={overviewStatus(data)} />
      <OverviewPage
        className="flex-1"
        value={tab}
        onValueChange={onTabChange}
        heads={heads}
        tabs={[
          {
            value: 'home',
            label: 'Home',
            panel: (
              <OverviewHome
                data={data}
                now={now}
                {...(linkTo !== undefined && { linkTo })}
                {...(onOpenTarget !== undefined && { onOpenTarget })}
                live={
                  <LiveMark
                    state={live.state}
                    lastCheckedAt={live.lastCheckedAt}
                    {...(onRefresh !== undefined && { onRefresh })}
                  />
                }
              />
            ),
          },
          {
            value: 'metrics',
            label: 'Metrics',
            // Metrics runs taller than the screen (the board is 1,300 px); the shell's main area
            // doesn't scroll, so the tab scrolls under the page head, which stays put.
            panel: (
              <div data-slot="metrics-scroll" className="flex min-h-0 flex-1 flex-col">
                <ScrollArea className="min-h-0 flex-1" gutter={false}>
                  <OverviewMetrics
                    days={span.days}
                    opensOn={span.opensOn}
                    now={now}
                    onOpenBody={onOpenBody}
                    {...metrics}
                  />
                </ScrollArea>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
