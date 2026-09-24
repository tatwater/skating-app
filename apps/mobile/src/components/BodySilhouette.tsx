import {
  lineToPath,
  NEAR_SHORE_STROKE_PX,
  ringsToPath,
  ringToPath,
  type SilhouetteData,
  sectorHighlightPath,
  silhouetteProjection,
} from '@skating/core';
import { useId } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Path } from 'react-native-svg';
import { useTheme } from 'tamagui';

/**
 * The lake as a still image (A10 §12.3) — the mobile twin of web's `BodySilhouette`, over the same
 * core paths. `react-native-svg` rather than a MapLibre view: a GL surface per row in a FlatList
 * is the one thing a scrolling feed cannot afford, and a few hundred points of SVG is nothing.
 * Theme colors from Tamagui so it follows the palette.
 */
export function BodySilhouette({ data, size = 64 }: { data: SilhouetteData; size?: number }) {
  const theme = useTheme();
  const clipId = useId();
  const p = silhouetteProjection(data.bbox, size, size, 3);
  const outline = ringsToPath(data.rings, p);
  const highlight = data.sector ? sectorHighlightPath(data, data.sector, p) : null;
  const nearShore = data.sector === 'near_shore';
  const path = data.path ? lineToPath(data.path, p) : '';
  const putIn = data.putIn ? p.toXY([data.putIn.lng, data.putIn.lat]) : null;
  const primary = theme.primary?.val ?? '#3b82f6';
  const foreground = theme.foreground?.val ?? '#111';

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityLabel="Where on the lake"
    >
      <Defs>
        <ClipPath id={clipId}>
          <Path d={outline} clipRule="evenodd" />
        </ClipPath>
      </Defs>
      <Path d={outline} fill={theme.surfaceMuted?.val ?? '#eee'} fillRule="evenodd" />
      <G clipPath={`url(#${clipId})`}>
        {data.bayRing ? (
          <Path d={ringToPath(data.bayRing, p)} fill={primary} fillOpacity={0.14} />
        ) : null}
        {highlight ? <Path d={highlight} fill={primary} fillOpacity={0.22} /> : null}
        {nearShore ? (
          <Path
            d={outline}
            fill="none"
            stroke={primary}
            strokeOpacity={0.22}
            strokeWidth={NEAR_SHORE_STROKE_PX}
          />
        ) : null}
        {path ? (
          <Path
            d={path}
            fill="none"
            stroke={foreground}
            strokeOpacity={0.55}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </G>
      <Path d={outline} fill="none" stroke={theme.borderStrong?.val ?? '#999'} strokeWidth={1} />
      {putIn ? (
        <Circle
          cx={putIn[0]}
          cy={putIn[1]}
          r={2.5}
          fill={primary}
          stroke={theme.surface?.val ?? '#fff'}
          strokeWidth={1}
        />
      ) : null}
    </Svg>
  );
}
