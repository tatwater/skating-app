import {
  areaPath,
  arrowPoints,
  COMPASS_POINTS_16,
  MIN_FETCH_CLAUSE_M,
  mostExposedSector,
  spokenDirection,
  WIND_ARROW_REFERENCE_MPS,
  windExposureSummary,
  windRoseChartModel,
} from '@skating/core';
import { useState } from 'react';
import Svg, { Circle, Line, Path, Polygon, Text as SvgText } from 'react-native-svg';
import { Paragraph, Text, useTheme, XStack, YStack } from 'tamagui';

/**
 * The wind-exposure section on a lake page — the native mirror of web's `WindExposure` (N7-3).
 *
 * **The picture is not re-derived here.** Every coordinate comes from `windRoseChartModel` in
 * `@skating/core`, the same function the web app calls, so the two clients cannot drift into two
 * subtly different polar charts. This file is a renderer and nothing else: it maps the model onto
 * `react-native-svg` primitives and picks theme colors.
 *
 * The encoding, and the reasons for it, are documented once on the core module — filled area is
 * frequency, arrow size is mean speed, and **nothing is colored by value** because a warm ramp on
 * wind speed would read as a danger scale (D145).
 */

const CHART_SIZE = 208;
const MPS_TO_MPH = 2.23694;

export interface WindExposureBody {
  windRose?: number[];
  meanWindMps?: (number | null)[];
  fetchProfileM?: number[];
}

export function WindExposure({ body }: { body: WindExposureBody }) {
  const theme = useTheme();
  const [showTable, setShowTable] = useState(false);

  const exposed = mostExposedSector(body.windRose, body.fetchProfileM)?.sector ?? null;
  const model = windRoseChartModel({
    rose: body.windRose ?? [],
    meanWindMps: body.meanWindMps,
    emphasizedSector: exposed,
    size: CHART_SIZE,
  });
  if (!model) return null;

  const summary = windExposureSummary({
    rose: body.windRose as number[],
    meanWindMps: body.meanWindMps,
    fetchProfileM: body.fetchProfileM,
    mostExposedSector: exposed,
    minFetchClauseM: MIN_FETCH_CLAUSE_M,
    spokenDirection,
    formatMiles: (meters) => {
      const miles = meters / 1609.344;
      return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)}`;
    },
  });
  const prose = summary?.sentences.join(' ') ?? '';

  // Tamagui's shorthand color props take theme tokens; `react-native-svg` needs raw values, so the
  // SVG half reads them off the theme with fallbacks — the same pattern `TrustDisplay` uses.
  const gridColor = theme.borderColor?.val ?? '#c9d7e2';
  const areaColor = theme.primary?.val ?? '#0884ab';
  const arrowColor = theme.foregroundMuted?.val ?? '#526b81';
  const emphasisColor = theme.foreground?.val ?? '#16232e';

  return (
    <YStack gap="$2">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.2} textTransform="uppercase">
        Wind exposure
      </Text>

      {/* Rose centred, prose beneath — side by side it was pinned left against a narrow column of
          wrapped text and read as an afterthought. */}
      <YStack gap="$3">
        <XStack justifyContent="center">
          <Svg
            width={CHART_SIZE}
            height={CHART_SIZE}
            viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
            accessibilityRole="image"
            accessibilityLabel={`Winter wind rose. ${prose}`}
          >
            {model.rings.map((ring) => (
              <Circle
                key={ring.frequency}
                cx={model.center.x}
                cy={model.center.y}
                r={ring.radius}
                fill="none"
                stroke={gridColor}
                strokeWidth={1}
              />
            ))}
            {model.spokes.map((spoke, i) => (
              <Line
                key={COMPASS_POINTS_16[i]}
                x1={spoke.from.x}
                y1={spoke.from.y}
                x2={spoke.to.x}
                y2={spoke.to.y}
                stroke={gridColor}
                strokeWidth={1}
              />
            ))}
            <Path
              d={areaPath(model)}
              fill={areaColor}
              fillOpacity={0.22}
              stroke={areaColor}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {/* A sector with no speed reading has no arrow — an absence, not a zero. */}
            {model.arrows.map((arrow) => (
              <Polygon
                key={arrow.label}
                points={arrowPoints(arrow)}
                fill={arrow.emphasized ? emphasisColor : arrowColor}
                fillOpacity={arrow.emphasized ? 1 : 0.65}
              />
            ))}
            {model.cardinals.map((cardinal) => (
              <SvgText
                key={cardinal.label}
                x={cardinal.at.x}
                y={cardinal.at.y}
                fontSize={9}
                fill={arrowColor}
                textAnchor="middle"
              >
                {cardinal.label}
              </SvgText>
            ))}
          </Svg>
        </XStack>
        <Paragraph>{prose}</Paragraph>
      </YStack>

      {/* With two encodings a key is not optional — without it the arrows read as decoration. */}
      <Text color="$foregroundMuted" fontSize={11}>
        Shaded area: how often winter wind blows from each direction. Arrows: how hard it blows,
        against a {Math.round(WIND_ARROW_REFERENCE_MPS * MPS_TO_MPH)} mph scale shared by every
        lake.
        {model.emphasizedSector !== null ? ' The solid arrow marks the most exposed shore.' : ''}
      </Text>

      {/* The values, reachable without reading a shape or a size. */}
      <Text
        color="$foregroundMuted"
        fontSize={11}
        textDecorationLine="underline"
        onPress={() => setShowTable((v) => !v)}
        accessibilityRole="button"
      >
        {showTable ? 'Hide the numbers' : 'Show the numbers'}
      </Text>
      {showTable ? (
        <YStack gap="$1">
          <XStack gap="$3">
            <Text color="$foregroundMuted" fontSize={11} width={44}>
              From
            </Text>
            <Text color="$foregroundMuted" fontSize={11} width={52}>
              Hours
            </Text>
            <Text color="$foregroundMuted" fontSize={11}>
              Mean
            </Text>
          </XStack>
          {COMPASS_POINTS_16.map((point, sector) => {
            const mps = body.meanWindMps?.[sector];
            return (
              <XStack key={point} gap="$3">
                <Text fontSize={11} width={44}>
                  {point}
                </Text>
                <Text fontSize={11} width={52}>
                  {Math.round((body.windRose?.[sector] ?? 0) * 100)}%
                </Text>
                <Text fontSize={11}>
                  {typeof mps === 'number' ? `${Math.round(mps * MPS_TO_MPH)} mph` : '—'}
                </Text>
              </XStack>
            );
          })}
        </YStack>
      ) : null}
    </YStack>
  );
}
