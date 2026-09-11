import {
  DEFAULT_TIMELINE_HEIGHT,
  EMPHASIS_RAIL_HEIGHT,
  hourAtX,
  type PositionedHour,
  scrollPxAtTrackX,
  shortDayLabel,
  type TimelineDayInput,
  timelineExtent,
  timelineReadoutParts,
  timelineScrollbar,
  type WeatherTimelineModel,
  weatherTimelineModel,
} from '@skating/core';
import { type WeatherChartPalette, WIND_FETCH_OPACITY, weatherChartPalette } from '@skating/design';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
/**
 * The three auxiliary lanes and how each is coloured — the native twin of web's `AUX_LANES`.
 *
 * `side` picks which temperature pole the emphasis rail wears (both emphases are conjunctions with
 * temperature); `litColor` is the trace colour while the measure is actually happening, which only
 * the sun lane has.
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
  days: TimelineDayInput[];
  /** The body's 16-sector fetch profile — the wind fill's density. Absent draws it flat. */
  fetchProfileM?: number[] | undefined;
  height?: number;
}) {
  const { isDark } = useThemePreference();
  const palette = weatherChartPalette(isDark ? 'dark' : 'light');

  const [width, setWidth] = useState(0);
  // Newest-first scroll in **pixels** — see the web twin. The scale is fixed, so the viewport crops
  // mid-day and a whole-day offset could not express most positions a drag passes through.
  const [scrollPx, setScrollPx] = useState(0);
  const [scrub, setScrub] = useState<PositionedHour | null>(null);
  const scrollAtDragStart = useRef(0);

  const { contentWidth, maxScrollPx } = timelineExtent(days.length, width);
  const clampedScroll = Math.min(Math.max(scrollPx, 0), maxScrollPx);

  // ⚠ Every day, not a slice: the model translates by the scroll so a path runs continuously through
  // the viewport edge rather than being cut at a day boundary the reader never chose.
  const model = useMemo(
    () =>
      width > 0
        ? weatherTimelineModel({ days, width, height, fetchProfileM, scrollPx: clampedScroll })
        : null,
    [days, width, height, fetchProfileM, clampedScroll],
  );

  // ⚠ **Mirrors, so the gesture objects do not have to be rebuilt to see a new value.** A `useMemo`
  // that depends on `clampedScroll` or on `model` re-creates its gesture on *every frame of a drag*,
  // and react-native-gesture-handler is explicit that reconfiguring a gesture while it is active may
  // cancel it — a pan that stutters or dies halfway, on the one control that moves this chart. The
  // handlers read the latest value through a ref instead, so the gestures are built once per
  // viewport change.
  const latestScroll = useRef(0);
  const modelRef = useRef<WeatherTimelineModel | null>(null);
  useEffect(() => {
    latestScroll.current = clampedScroll;
  }, [clampedScroll]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // ⚠ Both offsets are load-bearing — see the docblock. `activeOffsetX` stops a vertical flick
        // from panning the chart; `failOffsetY` hands it to the sheet instead of swallowing it.
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          scrollAtDragStart.current = latestScroll.current;
        })
        .onUpdate((e) => {
          if (maxScrollPx === 0) return;
          // 1:1 with the finger, now that the content has a real pixel width. The old version had to
          // convert a translation into whole days and round, which made a slow drag stutter.
          const next = scrollAtDragStart.current + e.translationX;
          setScrollPx(Math.min(maxScrollPx, Math.max(0, next)));
        })
        .runOnJS(true),
    [maxScrollPx],
  );

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .onEnd((e) => {
          const current = modelRef.current;
          if (current) setScrub(hourAtX(current, e.x));
        })
        .runOnJS(true),
    [],
  );

  const gesture = useMemo(() => Gesture.Race(pan, tap), [pan, tap]);

  if (days.length === 0) return null;

  const gradientId = 'weatherTimelineTemp';
  const hatchId = 'weatherTimelineHatch';
  const sunGradientId = 'weatherTimelineSun';

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
                {model.sun ? (
                  // Intensity rides on the y axis: irradiance is what the lane plots, so one vertical
                  // gradient paints the whole trace pale at first light and saturated at solar noon.
                  <LinearGradient
                    gradientUnits="userSpaceOnUse"
                    id={sunGradientId}
                    x1={0}
                    x2={0}
                    y1={model.sun.box.top}
                    y2={model.sun.box.bottom}
                  >
                    <Stop offset={0} stopColor={palette.sunRamp.lit} />
                    <Stop offset={1} stopColor={palette.sunRamp.dim} />
                  </LinearGradient>
                ) : null}
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

              {model.days
                .filter((d) => d.showLabel)
                .map((d) => (
                  <SvgText
                    fill={palette.aux.trace}
                    fontSize="9"
                    key={d.dayMs}
                    textAnchor="middle"
                    x={d.labelX}
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

              {AUX_LANES.map(({ key, side, litColor }) => {
                const lane = model[key];
                if (!lane) return null;
                return (
                  <React.Fragment key={lane.box.top}>
                    {/* Flat when the lane has no second measure — or when the lake is under a kilometre of
                        fetch, where its own geometry cannot support the distinction. */}
                    {lane.areaSegments.length === 0 ? (
                      <Path d={lane.area} fill={palette.aux.fill} opacity={0.55} />
                    ) : (
                      lane.areaSegments.map((seg) => (
                        // Density is fetch: how much open water that bearing had behind it. A magnitude
                        // channel, not a hue — D145 keeps wind out of the warm ramp, and the chart has no
                        // spare hue left in any case.
                        <Path
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
                    {/* One stroke per run: a run ends both at a data hole and at every crossing into
                        or out of "the measure is happening". Only the sun draws two colours today. */}
                    {lane.segments.map((seg) => (
                      <Path
                        d={seg.d}
                        fill="none"
                        key={seg.d}
                        stroke={
                          seg.active && litColor ? litColor(sunGradientId) : palette.aux.trace
                        }
                        strokeLinejoin="round"
                        strokeWidth={seg.active && litColor ? 1.5 : 1}
                      />
                    ))}
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
                        // Cold pole for wind (calm *and* freezing), warm for sun (bright *and* above
                        // freezing) — both are conjunctions with temperature, so they wear the
                        // temperature scale's own poles.
                        fill={palette.emphasis[side]}
                        height={EMPHASIS_RAIL_HEIGHT}
                        key={span.x}
                        width={span.width}
                        x={span.x}
                        y={lane.box.bottom - EMPHASIS_RAIL_HEIGHT}
                      />
                    ))}
                  </React.Fragment>
                );
              })}

              {scrub ? (
                <Line
                  stroke={palette.aux.control}
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
      <Text color="$foregroundMuted" fontSize={10} lineHeight={13}>
        Top to bottom: Temperature · Precipitation
        {model?.wind ? ' · Wind, marked when calm and freezing' : ''}
        {model?.sun ? ' · Sun, marked when sunlit above freezing' : ''}
        {model?.snowDepth ? ' · Snow on the ground' : ''}
      </Text>
    </YStack>
  );
}

/**
 * The scroll track under the chart — drag the thumb, or tap anywhere on the track to jump.
 *
 * ⚠ **This matters more on native than on the web.** Panning the plot itself has to share the
 * horizontal axis with the sheet's own gestures, so it is hedged about with `activeOffsetX` /
 * `failOffsetY` and can still lose a race. The track has no such conflict: it is a small dedicated
 * control that owns its gestures outright, which makes it the *reliable* way to move through time and
 * the plot-drag the convenience. It also replaces a line of italic hint text, which was the only
 * thing previously telling a reader the chart could be moved at all.
 *
 * Geometry comes from `timelineScrollbar` in core so the two clients cannot disagree about which way
 * the thumb travels — `offset` counts backwards from the newest window, and a control that gets that
 * inverted works perfectly while moving the wrong way.
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
  const bar = timelineScrollbar({
    maxScrollPx,
    viewportWidth,
    contentWidth,
    trackWidth,
    scrollPx,
  });

  const gesture = useMemo(() => {
    // ⚠ Rebuilt from the primitives *inside* the memo. Closing over a `geometry` object built in
    // the render body would make the dependency a fresh reference every time, so the memo would
    // rebuild the gesture on each render while claiming not to — a dep list that lies is worse
    // than none, because the next reader trusts it.
    const geometry = { maxScrollPx, viewportWidth, contentWidth, trackWidth };
    return (
      Gesture.Pan()
        // The track is its own control, so it claims horizontal movement immediately rather than
        // waiting for a threshold — but it still yields a vertical drag to the sheet.
        .failOffsetY([-12, 12])
        .onBegin((e) => onScroll(scrollPxAtTrackX(e.x, geometry)))
        .onUpdate((e) => onScroll(scrollPxAtTrackX(e.x, geometry)))
        .runOnJS(true)
    );
  }, [maxScrollPx, viewportWidth, contentWidth, trackWidth, onScroll]);

  // Gated on there being something to scroll rather than on a measured width — see the web twin.
  // A width of 0 costs an invisible thumb for the frame before `onLayout` fires, which is the same
  // frame the chart itself is blank.
  if (maxScrollPx <= 0) return null;

  return (
    <GestureDetector gesture={gesture}>
      {/* 24px tall so the touch target clears the ~44pt guideline once the surrounding gap is
          counted; the visible track is the 4px rule inside it. */}
      <XStack alignItems="center" height={24} width="100%">
        {/* ⚠ `style`, not the `backgroundColor` prop. Tamagui's shorthand colour props take *theme
            tokens*; these are resolved hex values from the validated chart scale, which has no
            Tamagui token because it is a data palette rather than a UI role. Same reason
            `WindExposure` reads `theme.x.val` for its SVG fills. */}
        <XStack
          borderRadius={9999}
          height={4}
          style={{ backgroundColor: palette.aux.fill }}
          width="100%"
        />
        {bar ? (
          <XStack
            borderRadius={9999}
            height={10}
            left={bar.x}
            position="absolute"
            style={{ backgroundColor: palette.aux.control }}
            width={bar.width}
          />
        ) : null}
      </XStack>
    </GestureDetector>
  );
}

/**
 * The tapped hour, in words — **where `weather_code` earns its 9%.**
 *
 * At mobile's density nothing in the drawing separates sleet from freezing drizzle; a sentence can.
 * `formatLocalHour` rather than a hand-rolled 12-hour conversion: the archive stores a plain local
 * hour, and both clients printing it means two chances to get noon or midnight off by one.
 */
function TimelineReadout({
  hour,
  fetchProfileM,
}: {
  hour: PositionedHour | null;
  fetchProfileM?: number[] | undefined;
}) {
  if (!hour) {
    return (
      <Text color="$foregroundMuted" fontSize={10} fontStyle="italic" minHeight={28}>
        Tap the chart for any hour
      </Text>
    );
  }
  // ⚠ Assembled in core, not here — see `timelineReadoutParts`. The two clients each hand-rolled
  // this list and had already drifted apart on the snow-depth phrasing.
  const parts = timelineReadoutParts(hour.hour, fetchProfileM);
  return (
    // ⚠ `minHeight`, not `height` — the readout grew to six fields with the open-water clause, and a
    // fixed 14 clipped the second line silently.
    <Text color="$foreground" fontSize={10} lineHeight={13} minHeight={28}>
      {parts.join(' · ')}
    </Text>
  );
}
