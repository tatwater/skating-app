import {
  COMPASS_LABELS,
  cmToInches,
  DEFAULT_TIMELINE_HEIGHT,
  EMPHASIS_RAIL_HEIGHT,
  formatLocalHour,
  formatTemperatureF,
  hourAtX,
  kphToMph,
  mmToInches,
  offsetAtTrackX,
  type PositionedHour,
  precipitationKind,
  roundTo,
  shortDayLabel,
  type TimelineDayInput,
  timelineScrollbar,
  weatherTimelineModel,
  windSectorOf,
} from '@skating/core';
import { type WeatherChartPalette, weatherChartPalette } from '@skating/design';
import { useTheme } from 'next-themes';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The past-weather timeline (N6h Workstream D) — **the drawing half only.**
 *
 * Every coordinate comes from `weatherTimelineModel` in core, and every color from
 * `@skating/design`'s validated scale. This file owns nothing but SVG elements, the two `<defs>` the
 * geometry cannot express, and the pointer handling. That split is what lets the native app draw the
 * identical chart from the identical numbers.
 *
 * ## The gradient is the whole trick
 *
 * Line color is a function of temperature, and temperature *is* the y position — so one vertical
 * `linearGradient` in user space paints every segment correctly, including the parts between two
 * sampled hours. No per-segment paths, no per-point color, and `react-native-svg` supports the same
 * element. Two stops share the 32°F offset, which is the hard step across freezing.
 *
 * ## Hover scrubs, drag pans
 *
 * Unambiguous on a pointer device, and it is why the readout can be this detailed: there is room to
 * name a precipitation type in words, which is where `weather_code`'s cost actually pays off. The
 * readout is an enhancement, never the only route to a value — the day labels, the freezing rule and
 * the panel's sentences all stand on their own.
 *
 * ## Colour says the same thing in every lane
 *
 * Cyan is the cold side and orange the warm side, throughout — see {@link AUX_LANES}. The sun trace is
 * additionally yellow whenever the sun is up and neutral when it is not, so the lane reads as daylight
 * before it reads as values.
 */

/**
 * The three auxiliary lanes, and how each one is coloured.
 *
 * `side` picks which temperature pole the emphasis rail wears, because both emphases are conjunctions
 * with temperature: wind is highlighted when it was calm *and below* freezing, sun when it was bright
 * *and above*. `litColor` is the trace colour while the measure is actually happening — only the sun
 * has one, and it is what turns that lane into a legible day/night rhythm rather than a row of bumps.
 *
 * A table rather than three near-identical JSX blocks: the lanes differ in exactly these two ways, and
 * spelling that out is what stops a later edit from giving wind a sun colour by copy-paste.
 */
const AUX_LANES: {
  key: 'wind' | 'sun' | 'snowDepth';
  side: 'cold' | 'warm';
  litColor?: (p: WeatherChartPalette) => string;
}[] = [
  { key: 'wind', side: 'cold' },
  { key: 'sun', side: 'warm', litColor: (p) => p.aux.sunLit },
  { key: 'snowDepth', side: 'cold' },
];

export function WeatherTimeline({
  days,
  height = DEFAULT_TIMELINE_HEIGHT,
  windowDays = 7,
}: {
  /** The full range the archive returned — usually 30 days; the window slides within it. */
  days: TimelineDayInput[];
  height?: number;
  windowDays?: number;
}) {
  const { resolvedTheme } = useTheme();
  // `resolvedTheme` is undefined until next-themes has read localStorage. Light is the D34 default,
  // and a brief flash of the default beats rendering nothing.
  const palette = weatherChartPalette(resolvedTheme === 'dark' ? 'dark' : 'light');

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Newest-first offset: 0 is "the most recent `windowDays` days", growing as you drag back in time.
  const [offset, setOffset] = useState(0);
  const [scrub, setScrub] = useState<PositionedHour | null>(null);
  const drag = useRef<{ startX: number; startOffset: number } | null>(null);

  // The sidebar is a fixed 26rem but its padding is not this component's business, so the plot
  // measures itself rather than assuming. Without this the first paint lays out against width 0 and
  // every path collapses to a point.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxOffset = Math.max(0, days.length - windowDays);
  const clampedOffset = Math.min(offset, maxOffset);

  /**
   * Horizontal wheel / trackpad panning.
   *
   * ⚠ **A native listener with `passive: false`, not `onWheel` — and the reason is not performance.**
   * React registers `wheel` on its root as *passive*, so `preventDefault()` inside an `onWheel` prop
   * is silently ignored. On macOS an unhandled horizontal wheel is a **browser back-navigation
   * gesture**: two-finger-swiping through a lake's weather would eventually throw the user out of the
   * page entirely, losing the panel they were reading. So the default has to be genuinely preventable,
   * which means attaching it ourselves.
   *
   * Only horizontal-dominant events are claimed. A vertical scroll that happens to pass over the
   * chart still scrolls the sidebar, which is what a reader expects and what makes the chart safe to
   * put in a long panel.
   */
  const wheelBudget = useRef(0);
  useEffect(() => {
    const el = hostRef.current;
    if (!el || maxOffset === 0 || width === 0) return;
    const dayWidth = width / windowDays;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical — let the panel scroll
      e.preventDefault();
      // A trackpad emits a stream of sub-pixel deltas. Converting each one straight to a day step
      // would either round to zero (nothing moves) or to a whole day (a two-finger nudge jumps a
      // week), so they accumulate into a pixel budget and are spent a column at a time.
      wheelBudget.current += e.deltaX;
      const steps = Math.trunc(wheelBudget.current / dayWidth);
      if (steps === 0) return;
      wheelBudget.current -= steps * dayWidth;
      // Scrolling right moves toward the right-hand edge of the content, which is *now* — so it
      // decreases the backwards-counting offset. This is the opposite sign from dragging the chart
      // itself, and correctly so: dragging moves the content, scrolling moves the viewport.
      setOffset((current) => Math.min(maxOffset, Math.max(0, current - steps)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [maxOffset, width, windowDays]);

  const visible = useMemo(() => {
    const end = days.length - clampedOffset;
    return days.slice(Math.max(0, end - windowDays), end);
  }, [days, clampedOffset, windowDays]);

  const model = useMemo(
    () => (width > 0 ? weatherTimelineModel({ days: visible, width, height }) : null),
    [visible, width, height],
  );

  if (days.length === 0) return null;

  const gradientId = 'weather-timeline-temp';
  const hatchId = 'weather-timeline-hatch';

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`relative select-none ${maxOffset > 0 ? 'cursor-ew-resize' : ''}`}
        ref={hostRef}
        onPointerDown={(e) => {
          if (maxOffset === 0) return;
          drag.current = { startX: e.clientX, startOffset: clampedOffset };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const d = drag.current;
          if (d && model) {
            // Drag right = go back in time, which is the direction the content moves under the
            // finger. One day per column keeps the gesture 1:1 with what the eye is tracking.
            const dayWidth = model.width / visible.length;
            const moved = Math.round((e.clientX - d.startX) / dayWidth);
            setOffset(Math.min(maxOffset, Math.max(0, d.startOffset + moved)));
            return;
          }
          if (model) setScrub(hourAtX(model, e.clientX - rect.left));
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerLeave={() => {
          drag.current = null;
          setScrub(null);
        }}
      >
        {model && (
          // `aria-hidden` because the chart is decorative *relative to* the readout and the panel's
          // sentences, which carry every fact it draws in text. A screen reader gets the prose, not a
          // description of 168 line segments.
          <svg
            aria-hidden="true"
            height={height}
            style={{ display: 'block' }}
            viewBox={`0 0 ${model.width} ${height}`}
            width="100%"
          >
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
                    <stop
                      // Two stops legitimately share an offset at 32°F — the hard step — so the band
                      // has to be part of the key. They differ there by construction ('thaw' then
                      // 'cold'), which is what makes offset+band unique without an array index.
                      key={`${stop.offset}-${stop.band}`}
                      offset={stop.offset}
                      stopColor={palette.temperature[stop.band]}
                    />
                  ))}
                </linearGradient>
              )}
              {/* Hatch means "arrived wet and froze" — freezing rain, sleet, ice pellets. Drawn as
                  explicit lines rather than a rotated pattern so it renders identically under
                  `react-native-svg`, whose pattern support is the flakiest thing in the library. */}
              <pattern
                height="4"
                id={hatchId}
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
                width="4"
              >
                <line
                  stroke={palette.precipitation.rain}
                  strokeWidth="2"
                  x1="0"
                  x2="0"
                  y1="0"
                  y2="4"
                />
              </pattern>
            </defs>

            {/* Day dividers — full height, hairline, solid. Dashed would read as "threshold". */}
            {model.dividers.map((x) => (
              <line
                key={x}
                stroke={palette.aux.fill}
                strokeWidth="1"
                x1={x}
                x2={x}
                y1={model.boxes.temperature.top}
                y2={model.boxes.snowDepth.bottom}
              />
            ))}

            {/* A missing day is drawn as an explicitly empty column, not skipped. */}
            {model.days
              .filter((d) => d.missing)
              .map((d) => (
                <rect
                  fill={palette.aux.fill}
                  height={model.boxes.snowDepth.bottom - model.boxes.temperature.top}
                  key={d.dayMs}
                  opacity={0.25}
                  width={d.width}
                  x={d.x}
                  y={model.boxes.temperature.top}
                />
              ))}

            {model.days
              .filter((d) => d.showLabel)
              .map((d) => (
                <text
                  fill={palette.aux.trace}
                  fontSize="9"
                  key={d.dayMs}
                  textAnchor="middle"
                  x={d.labelX}
                  y={9}
                >
                  {shortDayLabel(d.localDate)}
                </text>
              ))}

            {model.temperature && (
              <>
                <line
                  stroke={palette.aux.trace}
                  strokeWidth="1"
                  x1={0}
                  x2={model.width}
                  y1={model.temperature.freezeY}
                  y2={model.temperature.freezeY}
                />
                <text fill={palette.aux.trace} fontSize="8" x={2} y={model.temperature.freezeY - 3}>
                  32°F
                </text>
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
                {/* Today so far: real data whose day has not finished. Drawn, but not as settled. */}
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

            {/* A track behind the precipitation blocks, so a dry week reads as an empty lane rather
                than as a missing one — and so the blocks sit *in* something instead of floating. */}
            <rect
              fill={palette.aux.fill}
              height={model.precipitation.box.height}
              opacity={0.3}
              width={model.width}
              x={0}
              y={model.precipitation.box.top}
            />
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

            {AUX_LANES.map(({ key, side, litColor }) => {
              const lane = model[key];
              if (!lane) return null;
              return (
                <g key={lane.box.top}>
                  <path d={lane.area} fill={palette.aux.fill} opacity={0.55} />
                  {/* One stroke per run, because a run ends both at a data hole and at every
                        crossing into or out of "the measure is happening". Only the sun lane draws
                        two colors today; the others return a single run and are unaffected. */}
                  {lane.segments.map((seg) => (
                    <path
                      d={seg.d}
                      fill="none"
                      key={seg.d}
                      stroke={seg.active && litColor ? litColor(palette) : palette.aux.trace}
                      strokeLinejoin="round"
                      strokeWidth={seg.active && litColor ? 1.5 : 1}
                    />
                  ))}
                  {/* A hairline floor, so three stacked sparklines read as three lanes. */}
                  <line
                    stroke={palette.aux.fill}
                    strokeWidth="1"
                    x1={0}
                    x2={model.width}
                    y1={lane.box.bottom}
                    y2={lane.box.bottom}
                  />
                  {/* The emphasis rule, as a rail on the baseline — see `EMPHASIS_RAIL_HEIGHT` for
                        why this is not a full-height shaded region. */}
                  {lane.emphasis.map((span) => (
                    <rect
                      // Cold pole for wind (calm *and* freezing), warm pole for sun (bright *and*
                      // above freezing). Both conditions are conjunctions with temperature, so they
                      // wear the temperature scale's own poles — cyan is the cold side and orange
                      // the warm side, in every lane of this chart.
                      fill={palette.emphasis[side]}
                      height={EMPHASIS_RAIL_HEIGHT}
                      key={span.x}
                      width={span.width}
                      x={span.x}
                      y={lane.box.bottom - EMPHASIS_RAIL_HEIGHT}
                    />
                  ))}
                </g>
              );
            })}

            {scrub && (
              <line
                stroke={palette.aux.control}
                strokeWidth="1"
                x1={scrub.x}
                x2={scrub.x}
                y1={model.boxes.temperature.top}
                y2={model.boxes.snowDepth.bottom}
              />
            )}
          </svg>
        )}
      </div>

      <TimelineScrubber
        maxOffset={maxOffset}
        offset={clampedOffset}
        onOffset={setOffset}
        palette={palette}
        totalDays={days.length}
        trackWidth={width}
        windowDays={windowDays}
      />

      <TimelineReadout hour={scrub} />
      <TimelineLegend
        hasSnowDepth={model?.snowDepth != null}
        hasSun={model?.sun != null}
        hasWind={model?.wind != null}
      />
    </div>
  );
}

/**
 * The scroll track under the chart — a thumb you can drag, a track you can click, and arrow keys.
 *
 * **It exists because dragging the plot itself is a discoverable-only-by-accident gesture.** Nothing
 * about a chart says "you can grab this", and the one affordance that did say so — a line of italic
 * hint text — is a worse answer than a control that looks like what it is. The hint is gone; this
 * replaces it.
 *
 * ⚠ **A real `role="slider"`, not a styled `<div>`.** The chart itself is `aria-hidden` (a screen
 * reader gets the panel's sentences, not a description of 168 line segments), which means without
 * this there would be **no keyboard route to the older days at all** — the data would be reachable
 * only by mouse. Arrow keys step a day, Home/End jump to either end.
 *
 * The geometry is `timelineScrollbar` in core rather than arithmetic here, because the direction is
 * invertible without any type noticing: `offset` counts backwards from the newest window while the
 * thumb runs forwards, so a control that is wrong reads as one that simply moves the wrong way.
 */
function TimelineScrubber({
  offset,
  maxOffset,
  windowDays,
  totalDays,
  trackWidth,
  palette,
  onOffset,
}: {
  offset: number;
  maxOffset: number;
  windowDays: number;
  totalDays: number;
  trackWidth: number;
  palette: WeatherChartPalette;
  onOffset: (next: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  // ⚠ **Gated on `maxOffset`, not on having a measured width.** The thumb's *position* needs pixels,
  // but the control's *existence* must not: the chart is `aria-hidden`, so this slider is the only
  // keyboard route to the older days, and hiding it until a `ResizeObserver` has fired would make
  // that route appear a frame late — or never, anywhere the observer does not run. A width of 0
  // costs an invisible thumb for one frame, which is the same frame the chart itself is blank.
  if (maxOffset <= 0) return null;

  const bar = timelineScrollbar({ offset, maxOffset, windowDays, totalDays, trackWidth });

  const seek = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    // Measured at event time rather than taken from the chart's width, so a click lands correctly
    // even on the first interaction after a resize.
    if (!rect || rect.width <= 0) return;
    onOffset(
      offsetAtTrackX(clientX - rect.left, {
        maxOffset,
        windowDays,
        totalDays,
        trackWidth: rect.width,
      }),
    );
  };

  // Days back, not a raw offset: "9 days back" is what the reader is actually choosing, and it is
  // the only number here that means anything said aloud.
  const label = offset === 0 ? 'Showing the most recent days' : `${offset} days back`;

  return (
    <div
      aria-label="Scroll the weather timeline through time"
      aria-valuemax={maxOffset}
      aria-valuemin={0}
      aria-valuenow={offset}
      aria-valuetext={label}
      className="relative h-3 w-full cursor-pointer touch-none rounded-full"
      onKeyDown={(e) => {
        // Left goes back in time, which *increases* the backwards-counting offset. Reversing these
        // would make the keyboard disagree with the thumb it is moving.
        const step =
          e.key === 'ArrowLeft'
            ? 1
            : e.key === 'ArrowRight'
              ? -1
              : e.key === 'PageUp'
                ? 7
                : e.key === 'PageDown'
                  ? -7
                  : 0;
        if (step !== 0) {
          e.preventDefault();
          onOffset(Math.min(maxOffset, Math.max(0, offset + step)));
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          onOffset(maxOffset);
        } else if (e.key === 'End') {
          e.preventDefault();
          onOffset(0);
        }
      }}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) seek(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      ref={trackRef}
      role="slider"
      tabIndex={0}
    >
      <div
        className="absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 rounded-full"
        style={{ backgroundColor: palette.aux.fill }}
      />
      {bar && (
        <div
          className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full"
          style={{ backgroundColor: palette.aux.control, left: bar.x, width: bar.width }}
        />
      )}
    </div>
  );
}

/**
 * What the crosshair is pointing at, in words.
 *
 * **This is where `weather_code` earns its 9%.** At ~2 px an hour no fill or hatch can separate sleet
 * from freezing drizzle; a sentence can. The hour is formatted with `formatLocalHourLabel`, which
 * reads a local-shifted stamp back with UTC getters — the only correct way, since a local formatter
 * would apply the offset twice and slide every label 4–5 hours while still reading plausibly.
 */
function TimelineReadout({ hour }: { hour: PositionedHour | null }) {
  if (!hour) {
    return <p className="h-4 text-[10px] text-foreground-muted italic">Hover for any hour</p>;
  }
  const h = hour.hour;
  const precip = precipitationKind(h);
  const parts = [formatLocalHour(h.localHour), formatTemperatureF(h.temperatureC)];
  if (precip) {
    const inches =
      typeof h.snowfallCm === 'number' && h.snowfallCm > 0
        ? `${roundTo(cmToInches(h.snowfallCm), 1)}″`
        : `${roundTo(mmToInches(h.precipitationMm ?? h.rainMm ?? 0), 2)}″`;
    parts.push(`${precip.label} ${inches}`);
  }
  if (typeof h.windSpeedKph === 'number') {
    // Direction reads as "from the NW", which is the meteorological convention every compass label
    // in this app already uses — and the half of wind that a speed alone cannot tell you.
    const from =
      typeof h.windDirectionDeg === 'number'
        ? ` ${COMPASS_LABELS[windSectorOf(h.windDirectionDeg)] ?? ''}`
        : '';
    parts.push(`${Math.round(kphToMph(h.windSpeedKph))} mph${from}`);
  }
  if (typeof h.snowDepthM === 'number' && h.snowDepthM > 0) {
    parts.push(`${roundTo(cmToInches(h.snowDepthM * 100), 1)}″ on the ground`);
  }
  return (
    <p className="h-4 font-mono text-[10px] text-foreground tabular-nums">{parts.join(' · ')}</p>
  );
}

/**
 * The legend, which is not optional.
 *
 * Five lanes with no key is a puzzle, and the temperature ramp is a continuous color scale — the one
 * case where color-only encoding genuinely needs a stated scale. Lanes that returned `null` are
 * omitted rather than listed as empty: a legend entry for a series that is not drawn sends the reader
 * looking for a mark that does not exist.
 */
function TimelineLegend({
  hasWind,
  hasSun,
  hasSnowDepth,
}: {
  hasWind: boolean;
  hasSun: boolean;
  hasSnowDepth: boolean;
}) {
  const lanes = [
    'Temperature',
    'Precipitation',
    ...(hasWind ? ['Wind — highlighted when calm and freezing'] : []),
    ...(hasSun ? ['Sun — highlighted when sunlit above freezing'] : []),
    ...(hasSnowDepth ? ['Snow on the ground'] : []),
  ];
  return (
    <p className="text-[10px] text-foreground-muted leading-tight">
      Top to bottom: {lanes.join(' · ')}
    </p>
  );
}
