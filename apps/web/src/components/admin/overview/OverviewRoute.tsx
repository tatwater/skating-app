import { seasonOf } from '@skating/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { useConnection } from '@/lib/useConnection';
import { useRole } from '@/lib/useRole';
import { OverviewView } from './OverviewView';
import type { LinkTo } from './overviewLinks';
import type { LiveState } from './overviewModel';
import { consolePathFor, feedTargetPath } from './overviewRoutes';
import { type OverviewSearch, overviewTabOf, searchForTab } from './overviewSearch';
import { liveStateOf } from './overviewStatus';
import { useOverviewHome } from './useOverviewHome';

/**
 * The Overview at `/admin`, wired: the tab from the URL (`?tab=metrics`; Home is no param), Home's
 * reads that exist today (`useOverviewHome`), the connection for the live mark, and every link to
 * the old page that does the work until each target's mode lands. The page itself is
 * `OverviewView`, which draws every block no read serves as *Not recorded yet*.
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
  const reads = useOverviewHome();
  const now = useMinuteClock();
  const live = useFeedLive(reads.feed);
  return (
    <OverviewView
      season={seasonOf(now)}
      tab={overviewTabOf(search)}
      onTabChange={(next) => void navigate({ to: '/admin', search: searchForTab(next) })}
      reads={reads}
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

/** The instant ages are read against, moved on once a minute (the coarsest age Home writes). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
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
