import { seasonOf } from '@skating/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { useOverviewMetrics } from '@/components/admin/metrics/useOverviewMetrics';
import { useConnection } from '@/lib/useConnection';
import { useRole } from '@/lib/useRole';
import { useMinuteNow } from '../shell/presence';
import { OverviewView } from './OverviewView';
import type { LinkTo } from './overviewLinks';
import type { LiveState } from './overviewModel';
import { consolePathFor, feedTargetPath } from './overviewRoutes';
import { type OverviewSearch, overviewTabOf, searchForTab, seasonOfSearch } from './overviewSearch';
import { liveStateOf } from './overviewStatus';
import { useOverviewHome } from './useOverviewHome';

/**
 * The Overview at `/admin`, wired: the tab and the season from the URL (`?tab=metrics`,
 * `?season=2025`; Home and the current season are no param), Home's reads (`useOverviewHome`) and
 * Metrics' (`useOverviewMetrics`, while its tab is open), each asked for only when the viewer holds
 * its capability; the connection for the live mark; and every link to the old page that does the
 * work until each target's mode lands. The page itself is `OverviewView`, props only.
 */

/** A link through the router to the old page that does the work, or plain text where none does. */
const linkTo: LinkTo = (to) => {
  const path = consolePathFor(to);
  return path === null ? <span /> : <Link to={path} />;
};

export function OverviewRoute() {
  const search = useSearch({ from: '/admin/' }) as OverviewSearch;
  const navigate = useNavigate();
  const { can } = useRole();
  const now = useMinuteNow();
  const season = seasonOfSearch(search, seasonOf(now));
  const tab = overviewTabOf(search);
  const reads = useOverviewHome({ season, now, can });
  const metrics = useOverviewMetrics({ season, now, can, active: tab === 'metrics' });
  const live = useFeedLive(reads.feed);
  return (
    <OverviewView
      season={season}
      tab={tab}
      onTabChange={(next) =>
        void navigate({ to: '/admin', search: searchForTab(next, search.season) })
      }
      reads={reads}
      metrics={metrics}
      now={now}
      live={live}
      support={can('inbox.support.read')}
      linkTo={linkTo}
      onOpenTarget={(target) => {
        const path = feedTargetPath(target);
        if (path !== null) void navigate({ to: path });
      }}
      onOpenBody={(id) => {
        const path = consolePathFor({ kind: 'body', id });
        if (path !== null) void navigate({ to: path });
      }}
      onRefresh={() => window.location.reload()}
    />
  );
}

/**
 * The audit feed's live mark. The feed is a subscription, not a poll, so it is live exactly while
 * the socket is; *Last checked* is the later of when its rows last changed and when the socket last
 * came up — or, offline, when it went down.
 */
function useFeedLive(feed: unknown): { state: LiveState; lastCheckedAt: number | null } {
  const { status, lastConnectedAt } = useConnection();
  const [arrivedAt, setArrivedAt] = useState<number | null>(null);
  useEffect(() => {
    if (feed !== undefined) setArrivedAt(Date.now());
  }, [feed]);
  const heard = [arrivedAt, lastConnectedAt].filter((t): t is number => t !== null);
  return {
    state: liveStateOf(status),
    lastCheckedAt: heard.length > 0 ? Math.max(...heard) : null,
  };
}
