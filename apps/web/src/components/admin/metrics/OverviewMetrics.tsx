import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { CoverageByState } from './CoverageByState';
import { KeepingUp } from './KeepingUp';
import type { CoverageData, DayKey, KeepingUpData, ShowingUpData } from './metricsModel';
import { SeasonNotOpen } from './metricsParts';
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
  /**
   * The season's window, oldest first: from its opening (1 October) to today, or the whole of a
   * past season. Every per-day series aligns with it. Empty before the window opens.
   */
  days: readonly DayKey[];
  /**
   * The window's first day (`metricsWindow`). With `days` empty — the season has begun (1 July) but
   * its window hasn't opened — every season-ranged section says when its record begins instead.
   */
  opensOn?: DayKey;
  /** The instant ages are measured to (the oldest open flag, the oldest ticket). */
  now: number;
  /** The zone a table's dates are read in ("Last report"). The reader's own when omitted. */
  timeZone?: string;
  keepingUp: KeepingUpData;
  showingUp: ShowingUpData;
  coverage: CoverageData;
  /** A pulse day to show hovered from the start — a board's drawn hover, for stories. */
  pulseActive?: number | null;
  /** Opens a most-reported row's body; the page says where (the route supplies the path). */
  onOpenBody?: ((bodyId: string) => void) | undefined;
};

export function OverviewMetrics({
  days,
  opensOn,
  now,
  timeZone,
  keepingUp,
  showingUp,
  coverage,
  pulseActive,
  onOpenBody,
  className,
  ...props
}: OverviewMetricsProps) {
  const page = (
    <div
      data-slot="overview-metrics"
      className={cn('flex min-w-0 flex-col gap-(--space-5_5)', className)}
      {...props}
    >
      <div className="mt-(--space-2_5) grid grid-cols-2 gap-x-[2.75rem]">
        <KeepingUp data={keepingUp} days={days} now={now} />
        <ShowingUp
          data={showingUp}
          days={days}
          timeZone={timeZone}
          pulseActive={pulseActive}
          onOpenBody={onOpenBody}
        />
      </div>
      <CoverageByState data={coverage} />
    </div>
  );
  return days.length === 0 && opensOn !== undefined ? (
    <SeasonNotOpen opensOn={opensOn}>{page}</SeasonNotOpen>
  ) : (
    page
  );
}
