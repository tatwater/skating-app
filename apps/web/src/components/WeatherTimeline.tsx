import {
  cmToInches,
  DEFAULT_TIMELINE_HEIGHT,
  EMPHASIS_RAIL_HEIGHT,
  formatLocalHour,
  formatTemperatureF,
  hourAtX,
  kphToMph,
  mmToInches,
  type PositionedHour,
  precipitationKind,
  roundTo,
  shortDayLabel,
  type TimelineDayInput,
  weatherTimelineModel,
} from '@skating/core';
import { weatherChartPalette } from '@skating/design';
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
 */
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

            {[model.wind, model.sun, model.snowDepth].map(
              (lane) =>
                lane && (
                  <g key={lane.box.top}>
                    <path d={lane.area} fill={palette.aux.fill} opacity={0.55} />
                    <path
                      d={lane.line}
                      fill="none"
                      stroke={palette.aux.trace}
                      strokeLinejoin="round"
                      strokeWidth="1"
                    />
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
                        fill={palette.aux.emphasis}
                        height={EMPHASIS_RAIL_HEIGHT}
                        key={span.x}
                        width={span.width}
                        x={span.x}
                        y={lane.box.bottom - EMPHASIS_RAIL_HEIGHT}
                      />
                    ))}
                  </g>
                ),
            )}

            {scrub && (
              <line
                stroke={palette.aux.emphasis}
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

      <TimelineReadout hour={scrub} />
      <TimelineLegend
        hasSnowDepth={model?.snowDepth != null}
        hasSun={model?.sun != null}
        hasWind={model?.wind != null}
      />
      {maxOffset > 0 && (
        <p className="text-[10px] text-foreground-muted italic">
          Drag to see earlier days
          {clampedOffset > 0 ? ` — ${clampedOffset} day${clampedOffset === 1 ? '' : 's'} back` : ''}
        </p>
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
    parts.push(`${Math.round(kphToMph(h.windSpeedKph))} mph`);
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
