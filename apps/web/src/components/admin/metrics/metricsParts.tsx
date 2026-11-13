import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';

import { StatTile } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';

import { type AgePart, type DayKey, dayLabel, NOT_RECORDED } from './metricsModel';

/**
 * The small pieces every Metrics section shares: the two column heads, the "This season" tag at a
 * rule's end, a compound age value and a season axis' day tick.
 */

/** A column's head ("Keeping up"): display caps over a rule the column's width. */
export function ColumnHead({ children, className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="metrics-column-head"
      className={cn(
        'm-0 border-0 border-b-(length:--stroke-hair) border-solid border-line2 pb-(--space-1_5)',
        'text-logo leading-none font-semibold tracking-head text-fg uppercase',
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
}

/** What a section's numbers cover, at its rule's end ("This season"): mono caps, faint. */
export function SpanTag({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="metrics-span"
      className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
    >
      {children}
    </span>
  );
}

const SeasonOpensContext = createContext<DayKey | null>(null);

/**
 * The season before its chart window opens (1 July to 30 September — the founder, 2026-11-13): the
 * season-ranged sections under it draw their empty state and say when the record begins, whatever
 * a read returned for the days before it. `opensOn` is the window's first day.
 */
export function SeasonNotOpen({ opensOn, children }: { opensOn: DayKey; children: ReactNode }) {
  return <SeasonOpensContext.Provider value={opensOn}>{children}</SeasonOpensContext.Provider>;
}

/** "Record begins 1 Oct" under `SeasonNotOpen`, else `null`. */
export function useRecordBegins(): string | null {
  const opensOn = useContext(SeasonOpensContext);
  return opensOn === null ? null : `Record begins ${dayLabel(opensOn)}`;
}

/** A stat no read serves yet: a dash in the dim ink, and why — never a zero. */
export function UnrecordedTile({ label }: { label: string }) {
  return <StatTile label={label} value="—" tone="dim" sub={NOT_RECORDED} />;
}

/** A unit in a value's gray slot, 7 px from its figure, as the kit's `Value` sets one. */
function Unit({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="sr-only"> </span>
      <span
        data-slot="value-unit"
        className="ms-[0.4375rem] text-row font-light tracking-normal text-fg3"
      >
        {children}
      </span>
    </>
  );
}

/**
 * An age as a compound value — "3 d 22 h", each figure followed by its unit in the gray slot.
 * Hand it to a `StatTile` as the value, with no `unit` of its own.
 */
export function AgeValue({ parts }: { parts: readonly AgePart[] }) {
  return (
    <span data-slot="age-value">
      {parts.map((part, i) => (
        <span key={part.unit} className={cn(i > 0 && 'ms-(--space-2_5)')}>
          {part.n}
          <Unit>{part.unit}</Unit>
        </span>
      ))}
    </span>
  );
}

type DayTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value: DayKey; index?: number };
  /** The season's last day: labeled "Today", in the bright ink. */
  today: DayKey;
};

/**
 * A season axis' day label: "1 Oct" in the axis' kicker type (the chart container sets it by this
 * class), and "Today" in the bright ink for the last day.
 */
export function DayTick({ x = 0, y = 0, payload, today }: DayTickProps) {
  const day = payload?.value ?? '';
  const isToday = day === today;
  return (
    <text
      x={Number(x)}
      y={Number(y)}
      dy="0.71em"
      textAnchor="middle"
      className="recharts-cartesian-axis-tick-value"
      data-today={isToday ? '' : undefined}
      style={isToday ? { fill: 'var(--fg)' } : undefined}
    >
      {isToday ? 'Today' : dayLabel(day)}
    </text>
  );
}
