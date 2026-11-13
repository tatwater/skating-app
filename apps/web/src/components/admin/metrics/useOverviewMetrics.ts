import { api } from '@skating/convex/api';
import type { Capability, Season } from '@skating/core';
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
 */
export function useOverviewMetrics({
  season,
  can,
  active,
}: {
  season: Season;
  can: (capability: Capability) => boolean;
  /** Whether the tab is open: a closed tab subscribes to nothing. */
  active: boolean;
}): MetricsReads {
  const args = can('metrics.read') && active ? { season } : 'skip';
  return {
    keepingUp: useQuery(api.metrics.keepingUp, args),
    showingUp: useQuery(api.metrics.showingUp, args),
    coverage: useQuery(api.metrics.coverage, args),
  };
}
