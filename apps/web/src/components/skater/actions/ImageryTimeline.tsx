import { nearestLandableStop, stopCaption, type TimelineStop } from '@skating/core';
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import {
  edgeUsable,
  type ImageryAxis,
  type ImageryTick,
  stepUsable,
  tickTip,
} from './imageryTicks';

/**
 * The freeze-up timeline's track (boards 3.14/3.15, the founder's drawing and Review 4): a hairline
 * track with bracket ends, one tick per day — tall where the day has a usable picture, short and
 * faint where its pass is hidden, nothing on a day without a pass (radar never draws a short one) —
 * and the chosen day inside a **narrow, hollow thumb of one size**, whether it sits on a tall tick
 * or a short one.
 *
 * It's a slider: ← → step to the previous or next usable day, Home / End to the ends; a click picks
 * the nearest usable day. Hovering a tick shows its date, and for a hidden day why.
 */

const X0 = 4;
const MAX_STEP = 12;
const FALLBACK_WIDTH = 372;

/** A lozenge tick: pointed ends, 2 px wide at the middle. */
function lozenge(x: number, y0: number, h: number): string {
  return `M${x - 0.5} ${y0} H${x + 0.5} L${x + 1} ${y0 + h / 3} V${y0 + (2 * h) / 3} L${x + 0.5} ${y0 + h} H${x - 0.5} L${x - 1} ${y0 + (2 * h) / 3} V${y0 + h / 3} Z`;
}

/** The thumb: a beveled plate centered on x — the same size on every tick. */
function bevel(x: number): string {
  const [y0, w, h, b] = [12.75, 8.5, 34.5, 1.7];
  const [l, r, y1] = [x - w / 2, x + w / 2, y0 + h];
  return `M${l + b} ${y0} H${r - b} L${r} ${y0 + b * 1.1} V${y1 - b * 1.1} L${r - b} ${y1} H${l + b} L${l} ${y1 - b * 1.1} V${y0 + b * 1.1} Z`;
}

/** The step between days that fits `width`, capped so a short season doesn't sprawl. */
export function dayStep(width: number, days: number): number {
  if (days <= 1) return 0;
  return Math.min(MAX_STEP, Math.max(1, (width - 2 * X0) / (days - 1)));
}

/** The tick nearest an x offset on the track. */
export function tickAt(ticks: readonly ImageryTick[], x: number, step: number): ImageryTick | null {
  let best: ImageryTick | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tick of ticks) {
    const distance = Math.abs(X0 + tick.dayIndex * step - x);
    if (distance < bestDistance) {
      best = tick;
      bestDistance = distance;
    }
  }
  return best;
}

/** The selected stop's caption: the date, what took it, and anything in the way. */
export function captionOf(stop: TimelineStop): { date: string; rest: string } {
  const caption = stopCaption(stop);
  return {
    date: caption.date,
    rest: [caption.source, caption.caveat].filter(Boolean).join(' — '),
  };
}

export function ImageryTimeline({
  axis,
  stops,
  selected,
  onSelect,
}: {
  axis: ImageryAxis;
  stops: readonly TimelineStop[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [hover, setHover] = useState<ImageryTick | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => el.clientWidth > 0 && setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const step = dayStep(width, axis.days);
  const x = (dayIndex: number) => X0 + dayIndex * step + 0.5;
  const trackWidth = Math.max(X0 * 2 + (axis.days - 1) * step, 0);
  const selectedStop = selected !== null ? stops[selected] : undefined;
  const selectedTick =
    selected !== null ? axis.ticks.find((t) => t.stopIndex === selected) : undefined;
  const hoverStop = hover ? stops[hover.stopIndex] : undefined;
  const caption = selectedStop ? captionOf(selectedStop) : null;

  const pick = (tick: ImageryTick | null) => {
    if (!tick) return;
    // A hidden day can't be chosen: the thumb slides to the nearest usable one.
    const near = stops[tick.stopIndex]?.landable
      ? tick.stopIndex
      : nearestLandableStop(stops, tick.stopIndex);
    if (near !== null) onSelect(near);
  };
  const offset = (event: PointerEvent<HTMLDivElement>) =>
    event.clientX - event.currentTarget.getBoundingClientRect().left;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected === null) return;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
      next = stepUsable(stops, selected, -1);
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
      next = stepUsable(stops, selected, 1);
    if (event.key === 'Home') next = edgeUsable(stops, 'first');
    if (event.key === 'End') next = edgeUsable(stops, 'last');
    if (next === null) return;
    event.preventDefault();
    if (next !== selected) onSelect(next);
  };

  return (
    <div className="flex flex-col gap-(--space-2_5)">
      <div ref={host} className="relative h-[76px] w-full">
        {hover && hoverStop && (
          <div
            role="tooltip"
            data-slot="imagery-tip"
            className="pointer-events-none absolute -top-(--space-2) z-1 w-max max-w-[18rem] -translate-x-1/2 -translate-y-full rounded-container border border-solid border-line2 bg-plate-solid px-(--space-3) py-(--space-2) text-assist text-fg2 shadow-plate"
            style={{ left: Math.min(Math.max(x(hover.dayIndex), 72), width - 72) }}
          >
            {tickTip(hoverStop)}
          </div>
        )}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Freeze-up timeline"
          aria-valuemin={0}
          aria-valuemax={Math.max(stops.length - 1, 0)}
          aria-valuenow={selected ?? 0}
          aria-valuetext={caption ? caption.date : 'No usable picture'}
          data-attr="imagery-timeline"
          className="absolute inset-x-0 top-0 h-[60px] cursor-pointer outline-none focus-visible:shadow-focus"
          onKeyDown={onKeyDown}
          onPointerMove={(e) => setHover(tickAt(axis.ticks, offset(e), step))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) =>
            pick(tickAt(axis.ticks, e.clientX - e.currentTarget.getBoundingClientRect().left, step))
          }
        >
          <svg
            width={trackWidth}
            height={60}
            viewBox={`0 0 ${trackWidth} 60`}
            aria-hidden="true"
            className="block overflow-visible"
          >
            <path
              d={`M${trackWidth - 0.5} 12 V8 H.5 V12 M.5 48 V52 H${trackWidth - 0.5} V48`}
              className="fill-none stroke-acc"
              strokeOpacity={0.24}
            />
            {axis.ticks.map((tick) => (
              <path
                key={tick.day}
                data-tick={tick.tall ? 'tall' : 'short'}
                d={tick.tall ? lozenge(x(tick.dayIndex), 18, 24) : lozenge(x(tick.dayIndex), 26, 8)}
                className={cn(hover?.day === tick.day && !tick.tall ? 'fill-fg1' : 'fill-acc')}
                fillOpacity={tick.tall ? 0.64 : hover?.day === tick.day ? 1 : 0.14}
              />
            ))}
            {hover && hover.day !== selectedTick?.day && (
              <path
                d={bevel(x(hover.dayIndex))}
                data-slot="imagery-hover-ring"
                className="fill-none stroke-fg2"
                strokeWidth={1}
              />
            )}
            {selectedTick && (
              <path
                d={bevel(x(selectedTick.dayIndex))}
                data-slot="imagery-thumb"
                className="fill-none stroke-fg"
                strokeWidth={1.5}
              />
            )}
          </svg>
        </div>
        {axis.months.map((month) => (
          <span
            key={`${month.label}-${month.dayIndex}`}
            aria-hidden="true"
            className="absolute top-[64px] font-(family-name:--family-mono) text-[10px] leading-none tracking-micro text-fg3"
            style={{ left: Math.max(x(month.dayIndex) - 1.5, 0) }}
          >
            {month.label}
          </span>
        ))}
      </div>
      <p
        data-slot="imagery-caption"
        aria-live="polite"
        className="m-0 font-(family-name:--family-mono) text-mono-sm leading-snug text-fg1"
      >
        {caption ? (
          <>
            {caption.date} <span className="text-fg2">— {caption.rest}</span>
          </>
        ) : (
          <span className="text-fg2">No usable picture this season.</span>
        )}
      </p>
    </div>
  );
}
