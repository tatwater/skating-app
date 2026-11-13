import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { CoverageByState } from './CoverageByState';
import { KeepingUp } from './KeepingUp';
import type { CoverageData, DayKey, KeepingUpData, ShowingUpData } from './metricsModel';
import { ShowingUp } from './ShowingUp';

/**
 * Overview › Metrics: how staff are keeping up (left) and whether people are showing up (right),
 * one season window for both so a day reads across the page; coverage by state under them. The top
 * stats are the last seven days (or now); everything under them is the season.
 *
 * The tab's body only — the page head (Overview, the Home | Metrics tabs, the needs-a-person
 * badges) and the page's own padding are the shell's, shared with Home. Every number comes in as a
 * prop shaped like the read that serves it; nothing here reads Convex or the clock.
 */

export type OverviewMetricsProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The season's days, oldest first; the last is today. Every per-day series aligns with it. */
  days: readonly DayKey[];
  /** The instant ages are measured to (the oldest open flag, the oldest ticket). */
  now: number;
  /** The zone a table's dates are read in ("Last report"). The reader's own when omitted. */
  timeZone?: string;
  keepingUp: KeepingUpData;
  showingUp: ShowingUpData;
  coverage: CoverageData;
  /** A pulse day to show hovered from the start — a board's drawn hover, for stories. */
  pulseActive?: number | null;
};

export function OverviewMetrics({
  days,
  now,
  timeZone,
  keepingUp,
  showingUp,
  coverage,
  pulseActive,
  className,
  ...props
}: OverviewMetricsProps) {
  return (
    <div
      data-slot="overview-metrics"
      className={cn('flex min-w-0 flex-col gap-(--space-5_5)', className)}
      {...props}
    >
      <div className="mt-(--space-2_5) grid grid-cols-2 gap-x-[2.75rem]">
        <KeepingUp data={keepingUp} days={days} now={now} />
        <ShowingUp data={showingUp} days={days} timeZone={timeZone} pulseActive={pulseActive} />
      </div>
      <CoverageByState data={coverage} />
    </div>
  );
}
