import type { Season } from '@skating/core';
import { useMemo } from 'react';

import { metricsNotRecorded, metricsWindow } from '@/components/admin/metrics/metricsModel';
import { OverviewMetrics } from '@/components/admin/metrics/OverviewMetrics';
import type { SeasonPending } from '@/components/admin/season/SeasonTiles';
import { isoDay } from '@/components/admin/season/seasonFacts';
import { ScrollArea } from '@/components/kit/scroll-area';

import { ConsoleStatus } from '../shell/ConsoleShell';
import { LiveMark } from './LiveMark';
import { OverviewHome, type OverviewHomeData } from './OverviewHome';
import { OverviewPage } from './OverviewPage';
import { type FeedTarget, inboxTotal } from './overviewData';
import type { LinkTo } from './overviewLinks';
import { type LiveState, overviewHeads } from './overviewModel';
import type { OverviewTabValue } from './overviewSearch';
import { overviewStatus } from './overviewStatus';

/**
 * The Overview page as the console mounts it, from what the route hands it: the tab, Home's reads
 * that exist, the clock and the connection. `OverviewRoute` wires it to the router and Convex; a
 * story draws the same page inside the real shell.
 *
 * **Nothing here is a fixture.** Every block no read serves yet — the season's four, cost,
 * Machinery — is `null`, which each block draws as *Not recorded yet*; Metrics has no reads yet, so
 * every section is drawn unread (`metricsNotRecorded`) over the season window. As each read lands,
 * its `null` is swapped for the read.
 */

/** The blocks no read serves yet. Each is drawn *Not recorded yet*, never as a zero or a guess. */
export const UNREAD: Pick<
  OverviewHomeData,
  'watch' | 'winter' | 'imagery' | 'firstSkate' | 'cost' | 'machinery'
> = {
  watch: null,
  winter: null,
  imagery: null,
  firstSkate: null,
  cost: null,
  machinery: null,
};

export type OverviewViewProps = {
  /**
   * The season the page shows: the one `now` falls in (it flips on 1 July) unless a season is
   * chosen. Every season-ranged block reads from it — a chooser is wiring, not a redraw.
   */
  season: Season;
  tab: OverviewTabValue;
  onTabChange: (tab: OverviewTabValue) => void;
  /** Home's reads that exist (`useOverviewHome`), each `undefined` while it loads. */
  reads: Pick<OverviewHomeData, 'inbox' | 'corpus' | 'people' | 'feed'>;
  /** The instant every age is read against. */
  now: number;
  /** The audit feed's live mark. */
  live: { state: LiveState; lastCheckedAt: number | null };
  /** Whether the viewer may read support (Metrics' support half). */
  support: boolean;
  linkTo?: LinkTo;
  onOpenTarget?: (target: FeedTarget) => void;
  onRefresh?: () => void;
};

export function OverviewView({
  season,
  tab,
  onTabChange,
  reads,
  now,
  live,
  support,
  linkTo,
  onOpenTarget,
  onRefresh,
}: OverviewViewProps) {
  const span = useMemo(() => metricsWindow(season, now), [season, now]);
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
  const heads = overviewHeads({
    inbox: data.inbox ? inboxTotal(data.inbox) : { count: 0, capped: false },
    refits: data.corpus?.chordRefits ?? { count: 0, capped: false },
    // Machinery is unread: no run is said to be stalled or failed, and none is said to be fine.
    stalled: 0,
    failed: 0,
  });
  const metrics = useMemo(() => metricsNotRecorded(span.days, { support }), [span.days, support]);

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
                  <OverviewMetrics days={span.days} opensOn={span.opensOn} now={now} {...metrics} />
                </ScrollArea>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
