import { api } from '@skating/convex/api';
import { type Capability, metricDay, metricDayStart, type Season } from '@skating/core';
import { useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';

/** `metrics.keepingUp`, `metrics.showingUp` and `metrics.coverage`, as the server returns them. */
export type KeepingUpRead = FunctionReturnType<typeof api.metrics.keepingUp>;
export type ShowingUpRead = FunctionReturnType<typeof api.metrics.showingUp>;
export type CoverageRead = FunctionReturnType<typeof api.metrics.coverage>;

/** Metrics' three reads, each `undefined` while it loads or when the viewer can't read Metrics. */
export type MetricsReads = {
  keepingUp?: KeepingUpRead | undefined;
  showingUp?: ShowingUpRead | undefined;
  coverage?: CoverageRead | undefined;
};

/**
 * Metrics' reads for `season`, asked for only when the viewer holds `metrics.read`. Each carries the
 * window it was read over (`days`), so the page draws it only on the same days it draws the axis.
 *
 * The reads take the start of the page's UTC day as their clock: the argument changes once a day,
 * at the moment the page's window gains a day, so the server reads the new window then rather than
 * answering from a read cached before midnight.
 */
export function useOverviewMetrics({
  season,
  now,
  can,
  active,
}: {
  season: Season;
  /** The page's clock. */
  now: number;
  can: (capability: Capability) => boolean;
  /** Whether the tab is open: a closed tab subscribes to nothing. */
  active: boolean;
}): MetricsReads {
  const args =
    can('metrics.read') && active ? { season, now: metricDayStart(metricDay(now)) } : 'skip';
  return {
    keepingUp: useQuery(api.metrics.keepingUp, args),
    showingUp: useQuery(api.metrics.showingUp, args),
    coverage: useQuery(api.metrics.coverage, args),
  };
}
