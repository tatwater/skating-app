import {
  DAY_LABEL_HEIGHT,
  DEFAULT_TIMELINE_HEIGHT,
  hourAtX,
  type PositionedHour,
  PX_PER_HOUR,
  scrollPxAtTrackX,
  shortDayLabel,
  type TimelineDayInput,
  timelineExtent,
  timelineReadoutParts,
  timelineScrollbar,
  weatherTimelineModel,
} from '@skating/core';
import { type WeatherChartPalette, WIND_FETCH_OPACITY, weatherChartPalette } from '@skating/design';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { dayOfMonth, monthSpan, TEMPERATURE_TICKS_F, temperatureTickY } from './weatherModel';

/**
 * The past-weather chart (boards 1.6/1.7): temperature on its four bands (32 °F the one hard
 * break), then precipitation, wind, sun and snow on the ground, each a labeled lane; day numbers
 * and the month under it; a crosshair with a readout plate while the pointer is on it.
 *
 * **Every coordinate is `weatherTimelineModel`'s** (core, shared with native) and every color
 * `@skating/design`'s weather scale — the shipped `WeatherTimeline`'s split, re-skinned. The scale
 * is fixed (2 px an hour), so the chart shows what the sidebar holds and pans to the rest: drag or
 * a horizontal wheel on the plot, or the slider under it — the keyboard's way back (the drawing is
 * `aria-hidden`; the sentences above it carry every fact it draws).
 */

/** Room on the left for the temperature ticks and the lane names. */
const GUTTER = 40;
/** The band under the plot for the day numbers and the month. */
const AXIS = 28;

/** The theme the chart sits in: its nearest stated `data-mode`, else the OS. */
function modeOf(el: Element | null): 'light' | 'dark' {
  const stated = el?.closest('[data-mode]')?.getAttribute('data-mode');
  if (stated === 'light' || stated === 'dark') return stated;
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Kept current across a theme flip (the avatar menu writes `data-mode` on the root). */
export function useChartMode(ref: RefObject<Element | null>): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>('dark');
  useLayoutEffect(() => {
    const sync = () => setMode(modeOf(ref.current));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-mode'],
    });
    return () => observer.disconnect();
  }, [ref]);
  return mode;
}

const LANE_NAMES = {
  precipitation: 'Precip',
  wind: 'Wind',
  sun: 'Sun',
  snowDepth: 'Snow',
} as const;

export function PastWeatherChart({
  days,
  fetchProfileM,
  height = DEFAULT_TIMELINE_HEIGHT,
}: {
  /** The full range the archive returned — usually 30 days; the window slides within it. */
  days: TimelineDayInput[];
  /** The body's 16-sector fetch profile — the wind fill's density. Absent draws it flat. */
  fetchProfileM?: number[] | undefined;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mode = useChartMode(hostRef);
  const palette = weatherChartPalette(mode);
  const [width, setWidth] = useState(0);
  // Newest-first scroll, in pixels: 0 shows the most recent days, growing as you travel back.
  const [scrollPx, setScrollPx] = useState(0);
  const [scrub, setScrub] = useState<PositionedHour | null>(null);
  const drag = useRef<{ startX: number; startScroll: number } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(0, width - GUTTER);
  const { contentWidth, maxScrollPx } = timelineExtent(days.length, plotWidth);
  const clampedScroll = Math.min(Math.max(scrollPx, 0), maxScrollPx);

  // ⚠ A native listener with `passive: false`, not `onWheel`: React's wheel listener is passive,
  // and an unclaimed horizontal wheel on macOS is a browser back-gesture — panning the chart would
  // eventually throw the reader off the page. Only horizontal-dominant events are claimed.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || maxScrollPx === 0) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      setScrollPx((current) => Math.min(maxScrollPx, Math.max(0, current - e.deltaX)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [maxScrollPx]);

  const model = useMemo(
    () =>
      plotWidth > 0
        ? weatherTimelineModel({
            days,
            width: plotWidth,
            height,
            fetchProfileM,
            scrollPx: clampedScroll,
          })
        : null,
    [days, plotWidth, height, fetchProfileM, clampedScroll],
  );

  if (days.length === 0) return null;

  // The model reserves a label band at the top; this chart puts its labels underneath instead.
  const plotHeight = height - DAY_LABEL_HEIGHT;
  const shown = model?.days.filter((d) => d.x + d.width > 0 && d.x < plotWidth) ?? [];

  return (
    <div data-slot="past-weather-chart" className="flex flex-col gap-(--space-2)">
      <div
        ref={hostRef}
        className={cn('relative touch-pan-y select-none', maxScrollPx > 0 && 'cursor-ew-resize')}
        style={{ height: plotHeight + AXIS }}
        onPointerDown={(e) => {
          if (maxScrollPx === 0) return;
          drag.current = { startX: e.clientX, startScroll: clampedScroll };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            // Drag right = go back in time: the content moves with the finger, 1:1.
            setScrollPx(Math.min(maxScrollPx, Math.max(0, d.startScroll + e.clientX - d.startX)));
            return;
          }
          if (model) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left - GUTTER;
            setScrub(x < 0 ? null : hourAtX(model, x));
          }
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onPointerLeave={() => {
          drag.current = null;
          setScrub(null);
        }}
      >
        {model && (
          <svg
            aria-hidden="true"
            width="100%"
            height={plotHeight + AXIS}
            className="block overflow-visible font-(family-name:--family-mono)"
          >
            {model.temperature &&
              TEMPERATURE_TICKS_F.map((t) => {
                const y = model.temperature && temperatureTickY(model.temperature, t);
                if (y == null) return null;
                return (
                  <text
                    key={t}
                    x={GUTTER - 6}
                    y={y - DAY_LABEL_HEIGHT + 3.5}
                    textAnchor="end"
                    fontSize="9.5"
                    className={t === 32 ? 'fill-fg1' : 'fill-fg3'}
                  >
                    {t}°
                  </text>
                );
              })}
            {(['precipitation', 'wind', 'sun', 'snowDepth'] as const).map((lane) => {
              const box = model.boxes[lane];
              return (
                <text
                  key={lane}
                  x={GUTTER - 6}
                  y={(box.top + box.bottom) / 2 - DAY_LABEL_HEIGHT + 3}
                  textAnchor="end"
                  fontSize="8"
                  letterSpacing="0.8"
                  className="fill-fg3 font-(family-name:--family-sans) uppercase"
                >
                  {LANE_NAMES[lane]}
                </text>
              );
            })}
            {/* The plot: a nested viewport, so a path panned past either edge is cut there. */}
            <svg
              aria-hidden="true"
              x={GUTTER}
              y={0}
              width={plotWidth}
              height={plotHeight}
              viewBox={`0 ${DAY_LABEL_HEIGHT} ${plotWidth} ${plotHeight}`}
            >
              <Plot model={model} palette={palette} scrub={scrub} />
            </svg>
            {shown
              .filter((d) => d.showLabel)
              .map((d) => (
                <text
                  key={d.dayMs}
                  x={GUTTER + Math.min(Math.max(d.labelX, 6), plotWidth - 6)}
                  y={plotHeight + 12}
                  textAnchor="middle"
                  fontSize="9"
                  className="fill-fg3"
                >
                  {dayOfMonth(d.localDate)}
                </text>
              ))}
            <text
              x={GUTTER + plotWidth / 2}
              y={plotHeight + 24}
              textAnchor="middle"
              fontSize="8.5"
              letterSpacing="1.5"
              className="fill-fg3 font-(family-name:--family-sans) uppercase"
            >
              {monthSpan(shown.map((d) => d.localDate))}
            </text>
          </svg>
        )}
        {scrub && (
          <Readout
            hour={scrub}
            fetchProfileM={fetchProfileM}
            x={GUTTER + scrub.x}
            flip={scrub.x > plotWidth / 2}
          />
        )}
      </div>
      <TimelineSlider
        scrollPx={clampedScroll}
        maxScrollPx={maxScrollPx}
        viewportWidth={plotWidth}
        contentWidth={contentWidth}
        trackWidth={plotWidth}
        onScroll={setScrollPx}
      />
    </div>
  );
}

/** The drawing itself, in the model's coordinates. */
function Plot({
  model,
  palette,
  scrub,
}: {
  model: NonNullable<ReturnType<typeof weatherTimelineModel>>;
  palette: WeatherChartPalette;
  scrub: PositionedHour | null;
}) {
  const gradientId = 'lake-weather-temp';
  const hatchId = 'lake-weather-hatch';
  const top = model.boxes.temperature.top;
  const bottom = model.boxes.snowDepth.bottom;
  return (
    <>
      <defs>
        {model.temperature && (
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={gradientId}
            x1={model.temperature.gradient.x1}
            x2={model.temperature.gradient.x2}
            y1={model.temperature.gradient.y1}
            y2={model.temperature.gradient.y2}
          >
            {model.temperature.gradient.stops.map((stop) => (
              // Two stops share the 32°F offset (the hard step), so the band is part of the key.
              <stop
                key={`${stop.offset}-${stop.band}`}
                offset={stop.offset}
                stopColor={palette.temperature[stop.band]}
              />
            ))}
          </linearGradient>
        )}
        {/* Hatch: arrived wet and froze — freezing rain, sleet, ice pellets. */}
        <pattern
          height="4"
          id={hatchId}
          patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse"
          width="4"
        >
          <line stroke={palette.precipitation.rain} strokeWidth="2" x1="0" x2="0" y1="0" y2="4" />
        </pattern>
      </defs>

      {/* Day dividers — hairlines, solid (a dash would read as a threshold). */}
      {model.dividers.map((x) => (
        <line key={x} className="stroke-line" strokeWidth="1" x1={x} x2={x} y1={top} y2={bottom} />
      ))}
      {/* A missing day is drawn as an explicitly empty column, not skipped. */}
      {model.days
        .filter((d) => d.missing)
        .map((d) => (
          <rect
            key={d.dayMs}
            className="fill-raise"
            height={bottom - top}
            width={d.width}
            x={d.x}
            y={top}
          />
        ))}

      {model.temperature && (
        <>
          {[40, 20, 0].map((t) => {
            const y = model.temperature && temperatureTickY(model.temperature, t);
            return y == null ? null : (
              <line
                key={t}
                className="stroke-line"
                strokeWidth="1"
                x1={0}
                x2={model.width}
                y1={y}
                y2={y}
              />
            );
          })}
          <line
            className="stroke-fg2"
            strokeDasharray="3 3"
            strokeWidth="1"
            x1={0}
            x2={model.width}
            y1={model.temperature.freezeY}
            y2={model.temperature.freezeY}
          />
          <line
            className="stroke-line"
            strokeWidth="1"
            x1={0}
            x2={model.width}
            y1={model.temperature.box.bottom}
            y2={model.temperature.box.bottom}
          />
          {model.temperature.segments.map((d) => (
            <path
              d={d}
              fill="none"
              key={d}
              stroke={`url(#${gradientId})`}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          ))}
          {/* Today so far: real data whose day has not finished — drawn, but not as settled. */}
          {model.temperature.partialSegments.map((d) => (
            <path
              d={d}
              fill="none"
              key={d}
              opacity={0.55}
              stroke={`url(#${gradientId})`}
              strokeDasharray="3 2"
              strokeLinecap="round"
              strokeWidth="2"
            />
          ))}
        </>
      )}

      {/* Precipitation marks the hours it fell, full lane height; how much is in the readout. */}
      {model.precipitation.blocks.map((b) => (
        <rect
          fill={b.hatched ? `url(#${hatchId})` : palette.precipitation[b.fill]}
          height={model.precipitation.box.height}
          key={`${b.x}-${b.label}`}
          width={b.width}
          x={b.x}
          y={model.precipitation.box.top}
        />
      ))}
      <LaneFloor y={model.precipitation.box.bottom} width={model.width} />

      {model.wind && (
        <g data-lane="wind">
          {model.wind.areaSegments.length === 0 ? (
            <path d={model.wind.area} fill={palette.aux.trace} opacity={0.85} />
          ) : (
            // Density is fetch: how much open water that bearing had behind it.
            model.wind.areaSegments.map((seg) => (
              <path
                d={seg.d}
                fill={palette.aux.trace}
                key={seg.d}
                opacity={
                  WIND_FETCH_OPACITY.min +
                  seg.intensity * (WIND_FETCH_OPACITY.max - WIND_FETCH_OPACITY.min)
                }
              />
            ))
          )}
          <Emphasis
            spans={model.wind.emphasis}
            y={model.wind.box.bottom}
            fill={palette.emphasis.cold}
          />
          <LaneFloor y={model.wind.box.bottom} width={model.width} />
        </g>
      )}
      {model.sun && (
        <g data-lane="sun">
          <path d={model.sun.area} fill={palette.aux.sunLit} opacity={0.85} />
          <Emphasis
            spans={model.sun.emphasis}
            y={model.sun.box.bottom}
            fill={palette.emphasis.warm}
          />
          <LaneFloor y={model.sun.box.bottom} width={model.width} />
        </g>
      )}
      {model.snowDepth && (
        <g data-lane="snowDepth">
          <path d={model.snowDepth.area} fill={palette.precipitation.snow} opacity={0.55} />
          <LaneFloor y={model.snowDepth.box.bottom} width={model.width} />
        </g>
      )}

      {/* The scrub: a crosshair in the control ink, with a ring on the temperature line. */}
      {scrub && (
        <line
          className="stroke-fg"
          strokeWidth="1.25"
          x1={scrub.x}
          x2={scrub.x}
          y1={top}
          y2={bottom}
        />
      )}
    </>
  );
}

function LaneFloor({ y, width }: { y: number; width: number }) {
  return <line className="stroke-line" strokeWidth="1" x1={0} x2={width} y1={y} y2={y} />;
}

/** The emphasis rail along a lane's baseline (calm and freezing; sunlit above freezing). */
function Emphasis({
  spans,
  y,
  fill,
}: {
  spans: readonly { x: number; width: number }[];
  y: number;
  fill: string;
}) {
  return (
    <>
      {spans.map((span) => (
        <rect key={span.x} fill={fill} height={3} width={span.width} x={span.x} y={y - 3} />
      ))}
    </>
  );
}

/**
 * What the crosshair points at, in words — a plate in the one tooltip style, beside the line. The
 * phrases are core's (`timelineReadoutParts`, shared with native); the date is the lake's own
 * local date, never a timestamp through a local formatter.
 */
function Readout({
  hour,
  fetchProfileM,
  x,
  flip,
}: {
  hour: PositionedHour;
  fetchProfileM?: number[] | undefined;
  x: number;
  flip: boolean;
}) {
  const [when, temp, ...rest] = timelineReadoutParts(hour.hour, fetchProfileM);
  return (
    <div
      data-slot="weather-readout"
      role="status"
      className={cn(
        'pointer-events-none absolute top-0 flex w-max max-w-[15rem] flex-col gap-(--space-1)',
        'rounded-container border border-solid border-line2 bg-plate-solid px-(--space-3) py-(--space-2) shadow-plate',
      )}
      style={flip ? { right: `calc(100% - ${x - 10}px)` } : { left: x + 10 }}
    >
      <span className="text-assist leading-none text-fg2">
        {shortDayLabel(hour.hour.localDate)} · {when}
      </span>
      <span className="font-(family-name:--family-mono) text-row leading-none font-medium text-fg tabular-nums">
        {temp}
      </span>
      {rest.length > 0 && (
        <span className="text-assist leading-snug text-fg2">{rest.join(' · ')}</span>
      )}
    </div>
  );
}

/**
 * The slider under the chart: the keyboard's (and a screen reader's) way back through the days.
 * Arrow keys step a day, Page keys a week, Home/End jump to either end. The geometry is core's
 * (`timelineScrollbar`), because the direction is invertible without any type noticing: the
 * scroll counts back from now while the thumb runs forward.
 */
export function TimelineSlider({
  scrollPx,
  maxScrollPx,
  viewportWidth,
  contentWidth,
  trackWidth,
  onScroll,
}: {
  scrollPx: number;
  maxScrollPx: number;
  viewportWidth: number;
  contentWidth: number;
  trackWidth: number;
  onScroll: (next: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  if (maxScrollPx <= 0) return null;

  const geometry = { maxScrollPx, viewportWidth, contentWidth, trackWidth };
  const bar = timelineScrollbar({ ...geometry, scrollPx });
  const seek = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    onScroll(scrollPxAtTrackX(clientX - rect.left, { ...geometry, trackWidth: rect.width }));
  };
  const dayStep = PX_PER_HOUR * 24;
  const daysBack = scrollPx / dayStep;
  const label =
    daysBack < 0.05 ? 'Showing the most recent days' : `${daysBack.toFixed(1)} days back`;
  const step = (key: string): number | 'home' | 'end' | null =>
    key === 'ArrowLeft'
      ? dayStep
      : key === 'ArrowRight'
        ? -dayStep
        : key === 'PageUp'
          ? dayStep * 7
          : key === 'PageDown'
            ? -dayStep * 7
            : key === 'Home'
              ? 'home'
              : key === 'End'
                ? 'end'
                : null;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Scroll the weather chart through time"
      aria-valuemin={0}
      aria-valuemax={Math.round(maxScrollPx / dayStep)}
      aria-valuenow={Number(daysBack.toFixed(1))}
      aria-valuetext={label}
      data-slot="weather-slider"
      style={{ marginInlineStart: GUTTER }}
      className="relative h-(--space-3) cursor-pointer touch-none rounded-control outline-none focus-visible:shadow-focus"
      onKeyDown={(e) => {
        const s = step(e.key);
        if (s === null) return;
        e.preventDefault();
        if (s === 'home') onScroll(maxScrollPx);
        else if (s === 'end') onScroll(0);
        // Left goes back in time, which *increases* the backwards-counting offset.
        else onScroll(Math.min(maxScrollPx, Math.max(0, scrollPx + s)));
      }}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        seek(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) seek(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
    >
      <div className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-line2" />
      {bar && (
        <div
          className="absolute top-1/2 h-(--space-1) -translate-y-1/2 bg-fg2"
          style={{ left: bar.x, width: bar.width }}
        />
      )}
    </div>
  );
}
