import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A kit candidate: the **lane timeline** — one lane per thing that holds, laid on a time axis, each
 * a bar from the axis's start that either runs off the end (open-ended, an arrowhead) or stops at a
 * date (a stop bar). Body › Standing's *What keeps it active* is its first use (board 5.4.8).
 *
 * - **A label column on the left**: each lane's name over its value, both on the lane's rule.
 * - **The axis above**: a kicker at the label column's foot, the gridlines' labels centered over
 *   their lines. The first gridline (the axis's start, *today*) is solid; the rest are dotted.
 * - **Gridlines run unbroken** from the axis to the last lane, like axes, never a tick per row.
 * - **What a bar means is said in words too**: a reader hears each lane's name, its value and
 *   where it ends (`openLabel` or the lane's `endLabel`); the bars and the axis are decoration.
 *
 * Tokens only. Nothing here knows what a lane is about — the caller says.
 */

export type LaneTimelineGridline = {
  /** Where the line stands, in the axis's units (an instant, usually). */
  at: number;
  /** What it says over the axis ("2027"). */
  label?: string;
};

export type LaneTimelineLane = {
  key: string;
  /** The lane's name ("Map boost"). */
  label: ReactNode;
  /** Its value under the name ("0.3 · 19 Sep"). */
  value?: ReactNode;
  /** Where the bar stops, in the axis's units; `null` runs it off the end (it holds). */
  end: number | null;
  /** Where it stops, in words, for a reader ("Until 1 Jul 2030"). */
  endLabel?: string;
};

type LaneTimelineProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The axis's start: the left edge of every bar. */
  start: number;
  /** The axis's end. */
  end: number;
  /** The kicker over the label column ("Rollovers"). */
  axisLabel?: ReactNode;
  gridlines: readonly LaneTimelineGridline[];
  lanes: readonly LaneTimelineLane[];
  /** What an open-ended bar says to a reader. Default "Holds". */
  openLabel?: string;
};

/** Where `at` falls on `[start, end]`, as a fraction clamped to the axis. */
export function laneFraction(at: number, start: number, end: number): number {
  if (!(end > start)) return 0;
  return Math.min(1, Math.max(0, (at - start) / (end - start)));
}

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

/*
 * Values the token library lacks yet (the mock's, body-tab-standing-v5.js `.keeps`). Each is set as
 * a custom property on the root so the classes below read a name, never a raw number.
 */
/** The label column: 108 px. */
const LANE_LABEL_WIDTH = '6.75rem';
/** The open-ended arrowhead: 6 px long, 5 px each side of the bar (`.bar.open::after`). */
const LANE_ARROW_LENGTH = '6px';
const LANE_ARROW_HALF = '5px';
/** The stop bar where a lane ends: 12 px tall (`.bar.ends::after`). */
const LANE_STOP_HEIGHT = '0.75rem';

const LANE_VARS = {
  '--lane-label-width': LANE_LABEL_WIDTH,
  '--lane-arrow-length': LANE_ARROW_LENGTH,
  '--lane-arrow-half': LANE_ARROW_HALF,
  '--lane-stop-height': LANE_STOP_HEIGHT,
} as CSSProperties;

function LaneTimeline({
  start,
  end,
  axisLabel,
  gridlines,
  lanes,
  openLabel = 'Holds',
  className,
  style,
  ...props
}: LaneTimelineProps) {
  return (
    <div
      data-slot="lane-timeline"
      className={cn('grid grid-cols-[var(--lane-label-width)_minmax(0,1fr)] text-fg', className)}
      style={{ ...LANE_VARS, ...style }}
      {...props}
    >
      {/* The axis row: the kicker, then the gridlines' labels. */}
      <span
        aria-hidden="true"
        data-slot="lane-axis-kicker"
        className="text-kick leading-(--lead-snug) font-medium tracking-kick text-fg3 uppercase"
      >
        {axisLabel}
      </span>
      <span aria-hidden="true" data-slot="lane-axis" className="relative h-[1.4em] text-kick">
        {gridlines.map((g) =>
          g.label === undefined ? null : (
            <span
              key={g.at}
              data-slot="lane-axis-label"
              className="absolute top-0 -translate-x-1/2 font-(family-name:--family-mono) leading-none tracking-micro whitespace-nowrap text-fg2"
              style={{ left: pct(laneFraction(g.at, start, end)) }}
            >
              {g.label}
            </span>
          ),
        )}
      </span>

      {/* The lanes, over the gridlines (which span every lane's row). */}
      <div className="relative col-span-2 grid grid-cols-subgrid">
        <span
          aria-hidden="true"
          data-slot="lane-grid"
          className="pointer-events-none absolute inset-y-0 right-0 left-(--lane-label-width)"
        >
          <i
            data-slot="lane-gridline"
            data-start=""
            className="absolute inset-y-0 left-0 border-l border-solid border-fg3"
          />
          {gridlines.map((g) => (
            <i
              key={g.at}
              data-slot="lane-gridline"
              className="absolute inset-y-0 border-l border-dotted border-line2"
              style={{ left: pct(laneFraction(g.at, start, end)) }}
            />
          ))}
        </span>
        <ul className="col-span-2 m-0 grid list-none grid-cols-subgrid p-0">
          {lanes.map((lane) => {
            const to = lane.end === null ? 1 : laneFraction(lane.end, start, end);
            return (
              <li
                key={lane.key}
                data-slot="lane"
                data-open={lane.end === null ? '' : undefined}
                className="col-span-2 grid grid-cols-subgrid"
              >
                <span
                  data-slot="lane-label"
                  className="flex flex-col gap-(--space-1) border-t border-solid border-line pt-(--space-1_5) pb-(--space-2)"
                >
                  <span className="text-row leading-none font-medium text-fg">{lane.label}</span>
                  {lane.value != null && (
                    <span className="text-assist leading-none whitespace-nowrap text-fg3">
                      {lane.value}
                    </span>
                  )}
                  <span className="sr-only">
                    {lane.end === null ? openLabel : (lane.endLabel ?? '')}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  data-slot="lane-track"
                  className="relative border-t border-solid border-line"
                >
                  <i
                    data-slot="lane-bar"
                    className={cn(
                      'absolute top-1/2 left-0 h-(--stroke-note) -translate-y-1/2 bg-fg',
                      // The end: an arrowhead where it holds, a stop bar where it ends.
                      lane.end === null
                        ? 'after:absolute after:top-1/2 after:-right-px after:-translate-y-1/2 after:border-y-(length:--lane-arrow-half) after:border-l-(length:--lane-arrow-length) after:border-solid after:border-y-transparent after:border-l-fg after:content-[""]'
                        : 'after:absolute after:top-1/2 after:-right-px after:h-(--lane-stop-height) after:w-(--stroke-note) after:-translate-y-1/2 after:bg-fg after:content-[""]',
                    )}
                    style={{ width: pct(to) }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export { LaneTimeline, type LaneTimelineProps };
