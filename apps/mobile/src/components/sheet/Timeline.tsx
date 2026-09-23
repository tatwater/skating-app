import type { TimelineModel } from '@skating/core';
import { useState } from 'react';
import { type LayoutChangeEvent, Pressable, View } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from 'tamagui';

const HEIGHT = 74;
const BASE_Y = 40;
const PAD = 14;

/**
 * The timeline on the phone (A10-6 / D206): core's `timelineModel` drawn as a ruler in
 * `react-native-svg` — hour ticks, sunrise and sunset in amber, the start and end carets in ice
 * with the skate as a filled span between them, *now* in ink, the Post's other Reports as faded
 * spans, and D192's half-hour ladder as tappable ticks.
 *
 * No drag on a phone: a caret in a scrolling sheet is a scroll waiting to happen. The ladder ticks
 * choose the end (a tap), and the WHEN section's chips and pickers set all three exactly. Nothing
 * here is a safety claim (D3).
 */
export function Timeline({
  model,
  onChooseEnd,
}: {
  model: TimelineModel;
  /** A tap on a ladder tick. */
  onChooseEnd?: (ms: number) => void;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const ink = theme.foreground?.val ?? '#fff';
  const muted = theme.foregroundMuted?.val ?? '#999';
  const line = theme.borderStrong?.val ?? '#666';
  const ice = theme.primary?.val ?? '#1fc9ec';
  const amber = theme.warning?.val ?? '#e39a09';
  const canvas = theme.background?.val ?? '#000';
  const x = (fraction: number) => PAD + fraction * Math.max(width - 2 * PAD, 1);
  const mine = model.spans.find((s) => s.mine);
  const startMark = model.marks.find((m) => m.kind === 'start');
  const endMark = model.marks.find((m) => m.kind === 'end');

  return (
    <View
      style={{ width: '100%', height: HEIGHT }}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessibilityLabel="The day, as a timeline"
    >
      {width > 0 ? (
        <Svg width={width} height={HEIGHT}>
          <Line
            x1={PAD}
            y1={BASE_Y}
            x2={width - PAD}
            y2={BASE_Y}
            stroke={line}
            strokeWidth={1}
            opacity={0.6}
          />
          {model.spans
            .filter((s) => !s.mine)
            .map((s) => (
              <Rect
                key={s.id}
                x={x(s.from)}
                y={BASE_Y - 2}
                width={Math.max(x(s.to) - x(s.from), 2)}
                height={5}
                fill={muted}
                opacity={0.35}
              />
            ))}
          {mine && startMark && endMark ? (
            <Rect
              x={Math.min(x(startMark.fraction), x(endMark.fraction))}
              y={BASE_Y - 2}
              width={Math.max(Math.abs(x(endMark.fraction) - x(startMark.fraction)), 2)}
              height={5}
              fill={ice}
              opacity={0.8}
            />
          ) : null}
          {model.ticks.map((t) => (
            <Line
              key={t.ms}
              x1={x(t.fraction)}
              y1={BASE_Y - 4}
              x2={x(t.fraction)}
              y2={BASE_Y + 5}
              stroke={line}
              strokeWidth={1}
            />
          ))}
          {model.ticks.map((t) => (
            <SvgText
              key={`l${t.ms}`}
              x={x(t.fraction)}
              y={BASE_Y + 18}
              fontSize={10}
              fill={muted}
              textAnchor="middle"
            >
              {t.label}
            </SvgText>
          ))}
          {model.photos.map((p) => (
            <Rect
              key={p.id}
              x={x(p.fraction) - 3}
              y={BASE_Y - 13}
              width={6}
              height={6}
              fill={p.placed ? ice : canvas}
              stroke={p.placed ? ice : p.mine ? ink : muted}
              strokeWidth={1}
            />
          ))}
          {model.ladder.map((l) => (
            <Line
              key={l.ms}
              x1={x(l.fraction)}
              y1={BASE_Y - 10}
              x2={x(l.fraction)}
              y2={BASE_Y + 2}
              stroke={l.pinned ? ink : muted}
              strokeWidth={1.5}
            />
          ))}
          {model.marks.map((m) => {
            const mx = x(m.fraction);
            if (m.kind === 'sunrise' || m.kind === 'sunset') {
              return (
                <Path
                  key={m.kind}
                  d={`M ${mx} ${BASE_Y - 6} L ${mx} ${BASE_Y + 6}`}
                  stroke={amber}
                  strokeWidth={1.2}
                />
              );
            }
            return null;
          })}
          {model.marks.map((m) => {
            const mx = x(m.fraction);
            const anchor = m.fraction > 0.85 ? 'end' : m.fraction < 0.15 ? 'start' : 'middle';
            if (m.kind === 'sunrise' || m.kind === 'sunset') {
              return (
                <SvgText
                  key={m.kind}
                  x={mx}
                  y={BASE_Y + 30}
                  fontSize={9.5}
                  fill={amber}
                  textAnchor={anchor}
                >
                  {m.label}
                </SvgText>
              );
            }
            if (m.kind === 'now') {
              return (
                <Line
                  key={m.kind}
                  x1={mx}
                  y1={BASE_Y - 12}
                  x2={mx}
                  y2={BASE_Y + 8}
                  stroke={ink}
                  strokeWidth={1}
                />
              );
            }
            return (
              <Path
                key={m.kind}
                d={`M ${mx - 5} ${BASE_Y - 22} L ${mx + 5} ${BASE_Y - 22} L ${mx} ${BASE_Y - 15} Z M ${mx} ${BASE_Y - 15} L ${mx} ${BASE_Y + 2}`}
                fill={m.kind === 'end' ? ice : canvas}
                stroke={ice}
                strokeWidth={1.2}
              />
            );
          })}
          {model.marks
            .filter((m) => m.kind === 'start' || m.kind === 'end' || m.kind === 'now')
            .map((m) => {
              const mx = x(m.fraction);
              const anchor = m.fraction > 0.85 ? 'end' : m.fraction < 0.15 ? 'start' : 'middle';
              return (
                <SvgText
                  key={`t${m.kind}`}
                  x={mx}
                  y={m.kind === 'now' ? BASE_Y + 30 : BASE_Y - 27}
                  fontSize={9.5}
                  fontWeight="700"
                  fill={ink}
                  textAnchor={anchor}
                >
                  {m.label}
                </SvgText>
              );
            })}
        </Svg>
      ) : null}
      {/* The ladder's tap targets sit over the drawing: a finger's width each. */}
      {width > 0 && onChooseEnd
        ? model.ladder.map((l) => (
            <Pressable
              key={`p${l.ms}`}
              onPress={() => onChooseEnd(l.ms)}
              accessibilityRole="button"
              accessibilityLabel={`End about ${l.label}`}
              style={{
                position: 'absolute',
                left: x(l.fraction) - 14,
                top: BASE_Y - 22,
                width: 28,
                height: 36,
              }}
            />
          ))
        : null}
    </View>
  );
}
