import {
  COMPASS_LABELS,
  cmToInches,
  DEFAULT_TIMELINE_HEIGHT,
  EMPHASIS_RAIL_HEIGHT,
  fetchAlong,
  formatLocalHour,
  formatTemperatureF,
  hourAtX,
  kphToMph,
  mmToInches,
  type PositionedHour,
  PX_PER_HOUR,
  precipitationKind,
  roundTo,
  scrollPxAtTrackX,
  shortDayLabel,
  type TimelineDayInput,
  timelineExtent,
  timelineScrollbar,
  weatherTimelineModel,
  windSectorOf,
} from '@skating/core';
import { type WeatherChartPalette, WIND_FETCH_OPACITY, weatherChartPalette } from '@skating/design';
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
  /** Given the sun gradient's id, the stroke for an "active" run. Only the sun lane has one. */
  litColor?: (gradientId: string) => string;
}[] = [
  { key: 'wind', side: 'cold' },
  // ⚠ A gradient reference rather than a flat colour: the sun trace ramps pale → saturated with
  // irradiance, and irradiance is the y axis, so the paint is a function of height.
  { key: 'sun', side: 'warm', litColor: (id) => `url(#${id})` },
  { key: 'snowDepth', side: 'cold' },
];

export function WeatherTimeline({
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
  const { resolvedTheme } = useTheme();
  // `resolvedTheme` is undefined until next-themes has read localStorage. Light is the D34 default,
  // and a brief flash of the default beats rendering nothing.
  const palette = weatherChartPalette(resolvedTheme === 'dark' ? 'dark' : 'light');

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Newest-first scroll, in **pixels**: 0 shows the most recent days, growing as you travel back.
  // Pixels rather than days since the scale was fixed — the viewport crops mid-day on purpose, and a
  // whole-day offset cannot express most of the positions a drag passes through.
  const [scrollPx, setScrollPx] = useState(0);
  const [scrub, setScrub] = useState<PositionedHour | null>(null);
  const drag = useRef<{ startX: number; startScroll: number } | null>(null);

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

  const { contentWidth, maxScrollPx } = timelineExtent(days.length, width);
  const clampedScroll = Math.min(Math.max(scrollPx, 0), maxScrollPx);

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
  useEffect(() => {
    const el = hostRef.current;
    if (!el || maxScrollPx === 0) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical — let the panel scroll
      e.preventDefault();
      // ⚠ **1:1 pixels, and the accumulator that used to live here is gone.** With a fixed scale
      // there is nothing to quantise to: a delta of 7px moves the chart 7px. The old code banked
      // sub-pixel deltas until they added up to a whole *day*, which was the only way to move a
      // fluid-width chart and made a gentle two-finger nudge either do nothing or jump 24 hours.
      setScrollPx((current) => Math.min(maxScrollPx, Math.max(0, current - e.deltaX)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [maxScrollPx]);

  // ⚠ No day-slicing any more. The model lays out **every** day at the fixed scale and translates by
  // the scroll, so a path runs continuously through the viewport edge instead of being cut at a day
  // boundary the reader never chose.
  const model = useMemo(
    () =>
      width > 0
        ? weatherTimelineModel({
            days,
            width,
            height,
            fetchProfileM,
            scrollPx: clampedScroll,
          })
        : null,
    [days, width, height, fetchProfileM, clampedScroll],
  );

  if (days.length === 0) return null;

  const gradientId = 'weather-timeline-temp';
  const hatchId = 'weather-timeline-hatch';
  const sunGradientId = 'weather-timeline-sun';

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`relative select-none ${maxScrollPx > 0 ? 'cursor-ew-resize' : ''}`}
        ref={hostRef}
        onPointerDown={(e) => {
          if (maxScrollPx === 0) return;
          drag.current = { startX: e.clientX, startScroll: clampedScroll };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const d = drag.current;
          if (d) {
            // Drag right = go back in time, which is the direction the content moves under the
            // finger — and now literally 1:1, because the content has a real pixel width.
            const moved = e.clientX - d.startX;
            setScrollPx(Math.min(maxScrollPx, Math.max(0, d.startScroll + moved)));
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
              {model.sun && (
                // Intensity rides on the y axis: irradiance is what the lane plots, so one vertical
                // gradient paints the whole trace pale at first light and saturated at solar noon.
                <linearGradient
                  gradientUnits="userSpaceOnUse"
                  id={sunGradientId}
                  x1={0}
                  x2={0}
                  y1={model.sun.box.top}
                  y2={model.sun.box.bottom}
                >
                  <stop offset={0} stopColor={palette.sunRamp.lit} />
                  <stop offset={1} stopColor={palette.sunRamp.dim} />
                </linearGradient>
              )}
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
                  {/* Flat when the lane has no second measure — or when the lake is under a kilometre of
                      fetch, where its own geometry cannot support the distinction. */}
                  {lane.areaSegments.length === 0 ? (
                    <path d={lane.area} fill={palette.aux.fill} opacity={0.55} />
                  ) : (
                    lane.areaSegments.map((seg) => (
                      // Density is fetch: how much open water that bearing had behind it. A magnitude
                      // channel, not a hue — D145 keeps wind out of the warm ramp, and the chart has no
                      // spare hue left in any case.
                      <path
                        d={seg.d}
                        fill={palette.aux.fill}
                        key={seg.d}
                        opacity={
                          WIND_FETCH_OPACITY.min +
                          seg.intensity * (WIND_FETCH_OPACITY.max - WIND_FETCH_OPACITY.min)
                        }
                      />
                    ))
                  )}
                  {/* One stroke per run, because a run ends both at a data hole and at every
                        crossing into or out of "the measure is happening". Only the sun lane draws
                        two colors today; the others return a single run and are unaffected. */}
                  {lane.segments.map((seg) => (
                    <path
                      d={seg.d}
                      fill="none"
                      key={seg.d}
                      stroke={seg.active && litColor ? litColor(sunGradientId) : palette.aux.trace}
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
        contentWidth={contentWidth}
        maxScrollPx={maxScrollPx}
        onScroll={setScrollPx}
        palette={palette}
        scrollPx={clampedScroll}
        trackWidth={width}
        viewportWidth={width}
      />

      <TimelineReadout fetchProfileM={fetchProfileM} hour={scrub} />
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
 * invertible without any type noticing: `scrollPx` counts backwards from the newest view while the
 * thumb runs forwards, so a control that is wrong reads as one that simply moves the wrong way.
 */
function TimelineScrubber({
  scrollPx,
  maxScrollPx,
  viewportWidth,
  contentWidth,
  trackWidth,
  palette,
  onScroll,
}: {
  scrollPx: number;
  maxScrollPx: number;
  viewportWidth: number;
  contentWidth: number;
  trackWidth: number;
  palette: WeatherChartPalette;
  onScroll: (next: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  // ⚠ **Gated on `maxScrollPx`, not on having a measured width.** The thumb's *position* needs pixels,
  // but the control's *existence* must not: the chart is `aria-hidden`, so this slider is the only
  // keyboard route to the older days, and hiding it until a `ResizeObserver` has fired would make
  // that route appear a frame late — or never, anywhere the observer does not run. A width of 0
  // costs an invisible thumb for one frame, which is the same frame the chart itself is blank.
  if (maxScrollPx <= 0) return null;

  const geometry = { maxScrollPx, viewportWidth, contentWidth, trackWidth };
  const bar = timelineScrollbar({ ...geometry, scrollPx });

  const seek = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    // Measured at event time rather than taken from the chart's width, so a click lands correctly
    // even on the first interaction after a resize.
    if (!rect || rect.width <= 0) return;
    onScroll(scrollPxAtTrackX(clientX - rect.left, { ...geometry, trackWidth: rect.width }));
  };

  // ⚠ Announced in **days**, not pixels. "3.5 days back" is what the reader is choosing; the pixel
  // count is an implementation detail and would be meaningless read aloud. One decimal because the
  // scroll is continuous now and rounding to whole days would make the value stop changing mid-drag.
  const daysBack = scrollPx / (PX_PER_HOUR * 24);
  const label =
    daysBack < 0.05 ? 'Showing the most recent days' : `${daysBack.toFixed(1)} days back`;
  const dayStep = PX_PER_HOUR * 24;

  return (
    <div
      aria-label="Scroll the weather timeline through time"
      aria-valuemax={Math.round(maxScrollPx / dayStep)}
      aria-valuemin={0}
      aria-valuenow={Number(daysBack.toFixed(1))}
      aria-valuetext={label}
      className="relative h-3 w-full cursor-pointer touch-none rounded-full"
      onKeyDown={(e) => {
        // Left goes back in time, which *increases* the backwards-counting offset. Reversing these
        // would make the keyboard disagree with the thumb it is moving.
        // A day per arrow and a week per page — still whole days, because a keyboard step that
        // landed mid-afternoon would be impossible to aim with.
        const step =
          e.key === 'ArrowLeft'
            ? dayStep
            : e.key === 'ArrowRight'
              ? -dayStep
              : e.key === 'PageUp'
                ? dayStep * 7
                : e.key === 'PageDown'
                  ? -dayStep * 7
                  : 0;
        if (step !== 0) {
          e.preventDefault();
          onScroll(Math.min(maxScrollPx, Math.max(0, scrollPx + step)));
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          onScroll(maxScrollPx);
        } else if (e.key === 'End') {
          e.preventDefault();
          onScroll(0);
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
function TimelineReadout({
  hour,
  fetchProfileM,
}: {
  hour: PositionedHour | null;
  fetchProfileM?: number[] | undefined;
}) {
  if (!hour) {
    return <p className="min-h-8 text-[10px] text-foreground-muted italic">Hover for any hour</p>;
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
    // ⚠ **"across the lake", never "of open water".** The app already uses *open water* as a hazard
    // type — the on-ice alert says "⚠ open water ~45 s ahead", meaning unfrozen water you are about
    // to skate into. Reusing it for fetch would make the same two words mean "the lake is not frozen"
    // in one place and "the wind had a long run" in another, on a page about frozen lakes.
    //
    // Gated where the lake's geometry supports the claim: `fetchAlong` returns null below
    // `MIN_FETCH_CLAUSE_M`, which is ~95% of the corpus.
    const acrossM = fetchAlong(fetchProfileM, h.windDirectionDeg);
    if (acrossM !== null) parts.push(`${roundTo(acrossM / 1000, 1)} km across the lake`);
  }
  if (typeof h.snowDepthM === 'number' && h.snowDepthM > 0) {
    parts.push(`${roundTo(cmToInches(h.snowDepthM * 100), 1)}″ on the ground`);
  }
  return (
    // ⚠ `min-h`, not a fixed height. The readout grew to six fields once the open-water clause
    // landed, and a fixed 1rem clipped the wrap silently — the fetch was there and simply invisible.
    // Two lines' worth is reserved so the layout does not jump between a short hour and a long one.
    <p className="min-h-8 font-mono text-[10px] text-foreground leading-tight tabular-nums">
      {parts.join(' · ')}
    </p>
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
