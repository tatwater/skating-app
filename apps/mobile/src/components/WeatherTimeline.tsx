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
import React, { useMemo, useRef, useState } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, {
  Defs,
  Line,
  LinearGradient,
  Path,
  Pattern,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { Text, XStack, YStack } from 'tamagui';
import { useThemePreference } from '../providers/ThemeProvider';

/**
 * The past-weather timeline — the native mirror of web's `WeatherTimeline` (N6h Workstream D).
 *
 * **The picture is not re-derived here.** Every coordinate comes from `weatherTimelineModel` in
 * `@skating/core`, the same function the web app calls, and every color from `@skating/design`'s
 * validated scale. This file maps a model onto `react-native-svg` primitives and handles two
 * gestures. The pattern, and the reason for it, is `WindExposure` one chart over: mobile has no
 * RN-under-Vitest harness, so anything that lives in a component here cannot be tested at all.
 *
 * ## ⚠ Two gestures on one axis, inside a bottom sheet
 *
 * The drawer is a `@gorhom/bottom-sheet`, which claims vertical drags to move the sheet. A horizontal
 * pan on this chart would fight it, so the pan is declared with `activeOffsetX` / `failOffsetY`: it
 * only activates once the finger has moved horizontally, and it *fails* — handing the gesture back to
 * the sheet — the moment the movement is vertical. Without both, dragging the chart either scrolls
 * the sheet or the sheet stops scrolling over the chart, depending on which handler wins the race.
 *
 * Scrubbing is a **tap**, not a drag, which is what keeps the two unambiguous: a tap has no movement,
 * so it can never be confused with a pan.
 */
export function WeatherTimeline({
  days,
  height = DEFAULT_TIMELINE_HEIGHT,
  windowDays = 7,
}: {
  days: TimelineDayInput[];
  height?: number;
  windowDays?: number;
}) {
  const { isDark } = useThemePreference();
  const palette = weatherChartPalette(isDark ? 'dark' : 'light');

  const [width, setWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  const [scrub, setScrub] = useState<PositionedHour | null>(null);
  const offsetAtDragStart = useRef(0);

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

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // ⚠ Both offsets are load-bearing — see the docblock. `activeOffsetX` stops a vertical flick
        // from panning the chart; `failOffsetY` hands that flick to the sheet instead of swallowing it.
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          offsetAtDragStart.current = clampedOffset;
        })
        .onUpdate((e) => {
          if (maxOffset === 0 || !model) return;
          const dayWidth = model.width / Math.max(1, visible.length);
          const moved = Math.round(e.translationX / dayWidth);
          setOffset(Math.min(maxOffset, Math.max(0, offsetAtDragStart.current + moved)));
        })
        .runOnJS(true),
    [clampedOffset, maxOffset, model, visible.length],
  );

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .onEnd((e) => {
          if (model) setScrub(hourAtX(model, e.x));
        })
        .runOnJS(true),
    [model],
  );

  const gesture = useMemo(() => Gesture.Race(pan, tap), [pan, tap]);

  if (days.length === 0) return null;

  const gradientId = 'weatherTimelineTemp';
  const hatchId = 'weatherTimelineHatch';

  return (
    <YStack gap="$1">
      <GestureDetector gesture={gesture}>
        <XStack
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          // The sheet's own scroll must not start from a horizontal drag that began here.
          width="100%"
        >
          {model ? (
            <Svg
              accessibilityLabel="Recent weather timeline. The observations beside it describe the same days."
              accessibilityRole="image"
              height={height}
              viewBox={`0 0 ${model.width} ${height}`}
              width={model.width}
            >
              <Defs>
                {model.temperature ? (
                  <LinearGradient
                    gradientUnits="userSpaceOnUse"
                    id={gradientId}
                    x1={model.temperature.gradient.x1}
                    x2={model.temperature.gradient.x2}
                    y1={model.temperature.gradient.y1}
                    y2={model.temperature.gradient.y2}
                  >
                    {model.temperature.gradient.stops.map((stop) => (
                      // Two stops share the 32°F offset — the hard step. They differ by band there,
                      // which is what makes offset+band a unique key without an array index.
                      <Stop
                        key={`${stop.offset}-${stop.band}`}
                        offset={stop.offset}
                        stopColor={palette.temperature[stop.band]}
                      />
                    ))}
                  </LinearGradient>
                ) : null}
                <Pattern
                  height="4"
                  id={hatchId}
                  patternTransform="rotate(45)"
                  patternUnits="userSpaceOnUse"
                  width="4"
                >
                  <Line
                    stroke={palette.precipitation.rain}
                    strokeWidth="2"
                    x1="0"
                    x2="0"
                    y1="0"
                    y2="4"
                  />
                </Pattern>
              </Defs>

              {model.dividers.map((x) => (
                <Line
                  key={x}
                  stroke={palette.aux.fill}
                  strokeWidth="1"
                  x1={x}
                  x2={x}
                  y1={model.boxes.temperature.top}
                  y2={model.boxes.snowDepth.bottom}
                />
              ))}

              {model.days
                .filter((d) => d.missing)
                .map((d) => (
                  <Rect
                    fill={palette.aux.fill}
                    height={model.boxes.snowDepth.bottom - model.boxes.temperature.top}
                    key={d.dayMs}
                    opacity={0.25}
                    width={d.width}
                    x={d.x}
                    y={model.boxes.temperature.top}
                  />
                ))}

              {model.days.map((d) => (
                <SvgText
                  fill={palette.aux.trace}
                  fontSize="9"
                  key={d.dayMs}
                  textAnchor="middle"
                  x={d.x + d.width / 2}
                  y={9}
                >
                  {shortDayLabel(d.localDate)}
                </SvgText>
              ))}

              {model.temperature ? (
                <>
                  <Line
                    stroke={palette.aux.trace}
                    strokeWidth="1"
                    x1={0}
                    x2={model.width}
                    y1={model.temperature.freezeY}
                    y2={model.temperature.freezeY}
                  />
                  <SvgText
                    fill={palette.aux.trace}
                    fontSize="8"
                    x={2}
                    y={model.temperature.freezeY - 3}
                  >
                    32°F
                  </SvgText>
                  {model.temperature.segments.map((d) => (
                    <Path
                      d={d}
                      fill="none"
                      key={d}
                      stroke={`url(#${gradientId})`}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  ))}
                  {model.temperature.partialSegments.map((d) => (
                    <Path
                      d={d}
                      fill="none"
                      key={d}
                      opacity={0.55}
                      stroke={`url(#${gradientId})`}
                      strokeDasharray="3,2"
                      strokeLinecap="round"
                      strokeWidth="2"
                    />
                  ))}
                </>
              ) : null}

              <Rect
                fill={palette.aux.fill}
                height={model.precipitation.box.height}
                opacity={0.3}
                width={model.width}
                x={0}
                y={model.precipitation.box.top}
              />
              {model.precipitation.blocks.map((b) => (
                <Rect
                  fill={b.hatched ? `url(#${hatchId})` : palette.precipitation[b.fill]}
                  height={model.precipitation.box.height}
                  key={`${b.x}-${b.label}`}
                  width={b.width}
                  x={b.x}
                  y={model.precipitation.box.top}
                />
              ))}

              {[model.wind, model.sun, model.snowDepth].map((lane) =>
                lane ? (
                  <React.Fragment key={lane.box.top}>
                    <Path d={lane.area} fill={palette.aux.fill} opacity={0.55} />
                    <Path
                      d={lane.line}
                      fill="none"
                      stroke={palette.aux.trace}
                      strokeLinejoin="round"
                      strokeWidth="1"
                    />
                    <Line
                      stroke={palette.aux.fill}
                      strokeWidth="1"
                      x1={0}
                      x2={model.width}
                      y1={lane.box.bottom}
                      y2={lane.box.bottom}
                    />
                    {/* A rail, not a full-height region — in a 24px lane the latter is
                        indistinguishable from a tall value, so a calm frozen week read as high wind. */}
                    {lane.emphasis.map((span) => (
                      <Rect
                        fill={palette.aux.emphasis}
                        height={EMPHASIS_RAIL_HEIGHT}
                        key={span.x}
                        width={span.width}
                        x={span.x}
                        y={lane.box.bottom - EMPHASIS_RAIL_HEIGHT}
                      />
                    ))}
                  </React.Fragment>
                ) : null,
              )}

              {scrub ? (
                <Line
                  stroke={palette.aux.emphasis}
                  strokeWidth="1"
                  x1={scrub.x}
                  x2={scrub.x}
                  y1={model.boxes.temperature.top}
                  y2={model.boxes.snowDepth.bottom}
                />
              ) : null}
            </Svg>
          ) : null}
        </XStack>
      </GestureDetector>

      <TimelineReadout hour={scrub} />
      <Text color="$foregroundMuted" fontSize={10} lineHeight={13}>
        Top to bottom: Temperature · Precipitation
        {model?.wind ? ' · Wind, marked when calm and freezing' : ''}
        {model?.sun ? ' · Sun, marked when sunlit above freezing' : ''}
        {model?.snowDepth ? ' · Snow on the ground' : ''}
      </Text>
      {maxOffset > 0 ? (
        <Text color="$foregroundMuted" fontSize={10} fontStyle="italic">
          Drag sideways for earlier days
          {clampedOffset > 0 ? ` — ${clampedOffset} back` : ''}
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * The tapped hour, in words — **where `weather_code` earns its 9%.**
 *
 * At mobile's density nothing in the drawing separates sleet from freezing drizzle; a sentence can.
 * `formatLocalHour` rather than a hand-rolled 12-hour conversion: the archive stores a plain local
 * hour, and both clients printing it means two chances to get noon or midnight off by one.
 */
function TimelineReadout({ hour }: { hour: PositionedHour | null }) {
  if (!hour) {
    return (
      <Text color="$foregroundMuted" fontSize={10} fontStyle="italic" height={14}>
        Tap the chart for any hour
      </Text>
    );
  }
  const h = hour.hour;
  const precip = precipitationKind(h);
  const parts = [formatLocalHour(h.localHour), formatTemperatureF(h.temperatureC)];
  if (precip) {
    const amount =
      typeof h.snowfallCm === 'number' && h.snowfallCm > 0
        ? `${roundTo(cmToInches(h.snowfallCm), 1)}″`
        : `${roundTo(mmToInches(h.precipitationMm ?? h.rainMm ?? 0), 2)}″`;
    parts.push(`${precip.label} ${amount}`);
  }
  if (typeof h.windSpeedKph === 'number') parts.push(`${Math.round(kphToMph(h.windSpeedKph))} mph`);
  if (typeof h.snowDepthM === 'number' && h.snowDepthM > 0) {
    parts.push(`${roundTo(cmToInches(h.snowDepthM * 100), 1)}″ down`);
  }
  return (
    <Text color="$foreground" fontSize={10} height={14}>
      {parts.join(' · ')}
    </Text>
  );
}
