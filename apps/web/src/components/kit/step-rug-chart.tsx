import { type ComponentProps, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * **A running count's steps over a rug** (Inbox zero's *Open, today*, 2.9) — any
 * count that one kind of event raises and another lowers, through a span of time: a queue's depth,
 * a sheet's open items (`OpenTodayChart` in the Inbox design). Tokens only, no page props.
 *
 * - **The line steps**, never slopes: the count holds until the next event moves it, from `start`
 *   at `from` to `to`, a faint fill under it.
 * - **The rug** under the axis: each rise a hollow square, each fall a tick — every event shown,
 *   whatever the line's scale.
 * - **Where the count first reaches zero** (after starting above it) is marked with a dot and a
 *   label (`zeroLabel`), the bright ink.
 * - Gridlines every fifth of the scale, dashed; hour ticks on the axis, every other one labeled.
 * - Sized by its box (`height` from the caller's class); the drawing is hidden from readers and
 *   `label` names it.
 */

export type StepEvent = { at: number; delta: 1 | -1 };

/** The steps: each event's instant and the count after it, oldest first, held to ≥ 0. */
export function stepsOf(
  start: number,
  events: readonly StepEvent[],
): { at: number; value: number }[] {
  const out: { at: number; value: number }[] = [];
  let value = Math.max(0, start);
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    value = Math.max(0, value + e.delta);
    out.push({ at: e.at, value });
  }
  return out;
}

/** When the count first reaches zero after being above it, or `null`. */
export function firstZero(start: number, events: readonly StepEvent[]): number | null {
  let above = start > 0;
  for (const s of stepsOf(start, events)) {
    if (s.value > 0) above = true;
    else if (above) return s.at;
  }
  return null;
}

/** The gridlines: every five while that makes six or fewer, else every multiple of five that does. */
export function gridOf(top: number): number[] {
  const step = 5 * Math.max(1, Math.ceil(top / 25));
  const out: number[] = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

/** The scale's top: the highest count, rounded up to a multiple of five (at least five). */
export function scaleTop(start: number, events: readonly StepEvent[]): number {
  const max = Math.max(start, ...stepsOf(start, events).map((s) => s.value));
  return Math.max(5, Math.ceil(max / 5) * 5);
}

const HOUR = 3_600_000;

/** A UTC whole hour: the default floor, for a caller that names no clock. */
const utcHour = (at: number) => Math.floor(at / HOUR) * HOUR;

/**
 * The whole hours from `from` to `to`, on the clock `floorHour` reads (it returns the whole hour at
 * or before an instant): pass a zoned floor and the ticks fall on the reader's :00 in any zone —
 * a half-hour or 45-minute one, and across a DST change (each next tick is floored again, never
 * stepped blind). The kit holds no zone: the caller's floor is the clock.
 */
export function hourTicks(
  from: number,
  to: number,
  floorHour: (at: number) => number = utcHour,
): number[] {
  const ticks: number[] = [];
  /** A whole hour on that clock: the floor leaves it where it is. */
  const whole = (at: number) => floorHour(at) === at;
  let t = floorHour(from);
  while (t < from || !whole(t)) t = next(t);
  for (; t <= to; t = next(t)) ticks.push(t);
  return ticks;

  /**
   * The next whole hour after `at` on that clock: the first of half-hour steps on whose floor is a
   * whole hour after `at` — an hour on, except where the clock itself moves (by an hour, or by half
   * of one, as Lord Howe's does), where a floor taken across the change can land on a :30.
   */
  function next(at: number): number {
    for (let k = 1; k <= 6; k++) {
      const n = floorHour(at + (k * HOUR) / 2);
      if (n > at && whole(n)) return n;
    }
    // (No clock goes two hours without a whole hour; the guard keeps the loop finite regardless.)
    /* v8 ignore next */
    return at + HOUR;
  }
}

type StepRugChartProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The count at `from`. */
  start: number;
  events: readonly StepEvent[];
  from: number;
  to: number;
  /** A clock label for an instant ("13:00"). */
  formatTime: (at: number) => string;
  /** The zero mark's label for its instant ("ZERO 15:02"); none, and the mark isn't drawn. */
  zeroLabel?: (at: number) => string;
  /** What the chart shows, for a reader. */
  label: string;
  /**
   * Where the hour ticks fall: instants, from `hourTicks` with the reader's zoned floor. Absent,
   * the whole UTC hours of the span.
   */
  ticks?: readonly number[];
};

const PAD = { l: 30, r: 6, t: 8, b: 40 };

function StepRugChart({
  start,
  events,
  from,
  to,
  formatTime,
  zeroLabel,
  label,
  ticks,
  className,
  ...props
}: StepRugChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    /* v8 ignore next */
    if (el === null) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize(r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const inSpan = events.filter((e) => e.at >= from && e.at <= to);
  const top = scaleTop(start, inSpan);
  const zero = zeroLabel === undefined ? null : firstZero(start, inSpan);

  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      data-slot="step-rug-chart"
      className={cn('relative w-full', className)}
      {...props}
    >
      {size !== null && to > from && (
        <Drawing
          w={size.w}
          h={size.h}
          start={start}
          events={inSpan}
          from={from}
          to={to}
          top={top}
          zero={zero}
          formatTime={formatTime}
          zeroLabel={zeroLabel}
          hours={(ticks ?? hourTicks(from, to)).filter((t) => t >= from && t <= to)}
        />
      )}
    </div>
  );
}

function Drawing({
  w,
  h,
  start,
  events,
  from,
  to,
  top,
  zero,
  formatTime,
  zeroLabel,
  hours,
}: {
  w: number;
  h: number;
  start: number;
  events: readonly StepEvent[];
  from: number;
  to: number;
  top: number;
  zero: number | null;
  formatTime: (at: number) => string;
  zeroLabel: ((at: number) => string) | undefined;
  hours: readonly number[];
}) {
  const X = (t: number) => PAD.l + ((t - from) / (to - from)) * (w - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - v / top) * (h - PAD.t - PAD.b);
  const steps = stepsOf(start, events);
  let d = `M${X(from)} ${Y(Math.max(0, start))}`;
  for (const s of steps) d += ` H${X(s.at).toFixed(1)} V${Y(s.value).toFixed(1)}`;
  d += ` H${X(to)}`;
  const grid = gridOf(top);
  const base = Y(0);
  return (
    <svg
      aria-hidden="true"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="absolute inset-0 overflow-visible"
    >
      {grid.map((v) => (
        <g key={v} data-slot="step-rug-grid">
          <line
            x1={PAD.l}
            x2={w - PAD.r}
            y1={Y(v)}
            y2={Y(v)}
            className={v === 0 ? 'stroke-line2' : 'stroke-line'}
            strokeDasharray={v === 0 ? undefined : '2 4'}
          />
          <text x={PAD.l - 8} y={Y(v) + 3.5} textAnchor="end" className="fill-fg3 text-[0.625rem]">
            {Math.round(v)}
          </text>
        </g>
      ))}
      {hours.map((t, i) => (
        <g key={t} data-slot="step-rug-hour" data-at={t}>
          <line x1={X(t)} x2={X(t)} y1={base} y2={base + (i % 2 ? 4 : 7)} className="stroke-fg3" />
          {i % 2 === 0 && (
            <text x={X(t)} y={base + 19} textAnchor="middle" className="fill-fg3 text-[0.625rem]">
              {formatTime(t)}
            </text>
          )}
        </g>
      ))}
      <path d={`${d} V${base} H${X(from)} Z`} className="fill-lift-05" />
      <path data-slot="step-rug-line" d={d} className="fill-none stroke-fg" strokeWidth={1.3} />
      {events.map((e, i) =>
        e.delta < 0 ? (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: events at one instant are told apart by their place
            key={`f${i}`}
            data-slot="step-rug-fall"
            x1={X(e.at)}
            x2={X(e.at)}
            y1={base + 26}
            y2={base + 34}
            className="stroke-fg2"
          />
        ) : (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: events at one instant are told apart by their place
            key={`r${i}`}
            data-slot="step-rug-rise"
            x={X(e.at) - 2.5}
            y={base + 27}
            width={5}
            height={5}
            className="fill-none stroke-fg3"
          />
        ),
      )}
      {zero !== null && zeroLabel !== undefined && (
        <g data-slot="step-rug-zero">
          <circle cx={X(zero)} cy={base} r={3.5} className="fill-fg" />
          <text
            // Right of the dot, or left of it near the box's right edge, so it stays inside.
            x={X(zero) > w * 0.8 ? X(zero) - 8 : X(zero) + 8}
            y={base - 8}
            textAnchor={X(zero) > w * 0.8 ? 'end' : 'start'}
            className="fill-fg text-[0.5625rem] tracking-kick uppercase"
          >
            {zeroLabel(zero)}
          </text>
        </g>
      )}
    </svg>
  );
}

export { StepRugChart, type StepRugChartProps };
