import {
  type CompassSector,
  compassRing,
  lineToPath,
  NEAR_SHORE_STROKE_PX,
  onRing,
  ringSectorAtXY,
  ringsToPath,
  ringToPath,
  type Sector,
  type SilhouetteData,
  sectorHighlightPath,
  silhouetteProjection,
} from '@skating/core';
import { useId, useState } from 'react';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { useTheme } from 'tamagui';

/** A known launch or lot to draw, and whether it is the one the author chose. */
export interface LakeMapPin {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  kind: 'putIn' | 'parking';
}

/**
 * The lake as the sheet's mini-map (A10 §4 / §7.1, §12.3) — the same silhouette the card draws,
 * larger, and **tappable**: the known put-ins are dots with their names, a chosen one is filled,
 * the chips' sector is a wash, and a tap anywhere on the water comes back as a coordinate. It is
 * still not a map (D203): no tiles, no zoom — a shape you point at. That is what makes it the same
 * offline as online, and what makes the put-in you tapped here the dot you see on the card.
 *
 * **The compass ring is drawn only when asked** (`ring`, the where question, A10-6 / D206): eight
 * arcs from core's `compassRing`, cut on the wedges' own bearings, so a tap on the N arc and the N
 * wedge it lights are one fact. A tap on the water inside it is a point. The ring is a cursor for
 * a question, never a permanent control; the chips beside the lake answer the same question.
 *
 * Taps go through the wrapping `Pressable`: `react-native-svg` fires press events on elements, but
 * a tap on the water between elements would be lost, and the sheet wants every tap. The dots are
 * hit-tested here too, by distance, so a fat finger near a launch picks the launch.
 */
export function LakeMap({
  data,
  pins = [],
  chosenPinId,
  sector,
  point,
  path,
  height = 200,
  ring = false,
  litPins = false,
  onTap,
  onTapPin,
  onTapSector,
}: {
  data: SilhouetteData;
  pins?: readonly LakeMapPin[];
  chosenPinId?: string;
  /** The wash — the chips' `where`, or the sector the author is choosing. */
  sector?: Sector;
  /** A coarse point the author placed ("somewhere else", or a `where: point`). */
  point?: { lat: number; lng: number; radiusMeters?: number };
  /** The recorded skate, when a track opened the sheet. */
  path?: SilhouetteData['path'];
  height?: number;
  /** Draw the compass ring (the where question). */
  ring?: boolean;
  /** Light every launch (the put-in question), not only the chosen one. */
  litPins?: boolean;
  onTap?: (coord: { lat: number; lng: number }) => void;
  onTapPin?: (pin: LakeMapPin) => void;
  /** A tap on the ring's arc, or outside it, by bearing. */
  onTapSector?: (sector: CompassSector) => void;
}) {
  const theme = useTheme();
  const clipId = useId();
  const [width, setWidth] = useState(0);
  const primary = theme.primary?.val ?? '#3b82f6';
  const foreground = theme.foreground?.val ?? '#111';
  const muted = theme.foregroundMuted?.val ?? '#666';
  const surface = theme.surface?.val ?? '#fff';

  const p = width > 0 ? silhouetteProjection(data.bbox, width, height, ring ? 30 : 12) : null;
  const compass = p && ring ? compassRing(p, data.origin) : null;
  const outline = p ? ringsToPath(data.rings, p) : '';
  const highlight = p && sector ? sectorHighlightPath(data, sector, p) : null;
  const skate = p && path ? lineToPath(path, p) : '';
  const dots = p
    ? pins.map((pin) => {
        const [x, y] = p.toXY([pin.lng, pin.lat]);
        return { pin, x, y };
      })
    : [];
  const placed = p && point ? p.toXY([point.lng, point.lat]) : null;
  const placedR =
    p && point?.radiusMeters !== undefined ? Math.max(6, point.radiusMeters * p.pxPerMeter) : 6;

  const onPress = (e: GestureResponderEvent) => {
    if (!p) return;
    const { locationX, locationY } = e.nativeEvent;
    // A dot within a finger's reach wins over the water under it.
    let nearest: { pin: LakeMapPin; d: number } | null = null;
    for (const dot of dots) {
      const d = Math.hypot(dot.x - locationX, dot.y - locationY);
      if (d <= 22 && (nearest === null || d < nearest.d)) nearest = { pin: dot.pin, d };
    }
    if (nearest && onTapPin) {
      onTapPin(nearest.pin);
      return;
    }
    if (compass && onTapSector) {
      const d = Math.hypot(locationX - compass.cx, locationY - compass.cy);
      if (onRing(compass, [locationX, locationY], 16) || d > compass.r) {
        onTapSector(ringSectorAtXY(compass, [locationX, locationY]));
        return;
      }
    }
    if (!onTap) return;
    const [lng, lat] = p.fromXY([locationX, locationY]);
    onTap({ lat, lng });
  };

  return (
    <Pressable
      style={{ width: '100%', height }}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      // A press, not a touch-end: a scroll that happens to end over the lake must not place a pin.
      onPress={onTap || onTapPin || onTapSector ? onPress : undefined}
      disabled={!onTap && !onTapPin && !onTapSector}
      accessibilityRole={onTap || onTapPin || onTapSector ? 'button' : undefined}
      accessibilityLabel="The lake. Tap a launch, or anywhere on the water."
    >
      {p ? (
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            <ClipPath id={clipId}>
              <Path d={outline} clipRule="evenodd" />
            </ClipPath>
          </Defs>
          {compass
            ? compass.segments.map((seg) => {
                const lit = seg.sector === sector;
                return (
                  <G key={seg.sector}>
                    <Path
                      d={seg.d}
                      fill="none"
                      stroke={lit ? primary : (theme.borderStrong?.val ?? '#999')}
                      strokeOpacity={lit ? 1 : 0.6}
                      strokeWidth={lit ? 3 : 1}
                    />
                    <Line
                      x1={seg.tick[0][0]}
                      y1={seg.tick[0][1]}
                      x2={seg.tick[1][0]}
                      y2={seg.tick[1][1]}
                      stroke={theme.borderStrong?.val ?? '#999'}
                      strokeWidth={1}
                    />
                    <SvgText
                      x={seg.label[0]}
                      y={seg.label[1] + 3.5}
                      textAnchor="middle"
                      fontSize={9.5}
                      fontWeight={lit ? '700' : '400'}
                      fill={lit ? primary : muted}
                    >
                      {seg.sector}
                    </SvgText>
                  </G>
                );
              })
            : null}
          {compass ? (
            <Circle
              cx={compass.cx}
              cy={compass.cy}
              r={3}
              fill="none"
              stroke={theme.borderStrong?.val ?? '#999'}
            />
          ) : null}
          <Path d={outline} fill={theme.surfaceMuted?.val ?? '#eee'} fillRule="evenodd" />
          <G clipPath={`url(#${clipId})`}>
            {data.bayRing ? (
              <Path d={ringToPath(data.bayRing, p)} fill={primary} fillOpacity={0.12} />
            ) : null}
            {highlight ? <Path d={highlight} fill={primary} fillOpacity={0.22} /> : null}
            {sector === 'near_shore' ? (
              <Path
                d={outline}
                fill="none"
                stroke={primary}
                strokeOpacity={0.22}
                strokeWidth={NEAR_SHORE_STROKE_PX * 1.6}
              />
            ) : null}
            {skate ? (
              <Path
                d={skate}
                fill="none"
                stroke={foreground}
                strokeOpacity={0.5}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
          </G>
          <Path d={outline} fill="none" stroke={foreground} strokeWidth={1.3} />
          {placed ? (
            <>
              <Circle
                cx={placed[0]}
                cy={placed[1]}
                r={placedR}
                fill={primary}
                fillOpacity={0.18}
                stroke={primary}
                strokeWidth={1}
              />
              <Circle cx={placed[0]} cy={placed[1]} r={2.5} fill={primary} />
            </>
          ) : null}
          {dots.map(({ pin, x, y }) => {
            const chosen = pin.id === chosenPinId;
            const lit = chosen || litPins;
            const lot = pin.kind === 'parking';
            return (
              <G key={pin.id}>
                {lot ? (
                  <Path
                    d={`M ${x - 4} ${y - 4} h 8 v 8 h -8 Z`}
                    fill={chosen ? primary : surface}
                    stroke={lit ? primary : muted}
                    strokeWidth={1.25}
                  />
                ) : (
                  <Circle
                    cx={x}
                    cy={y}
                    r={chosen ? 6 : litPins ? 6.5 : 4.5}
                    fill={chosen ? primary : surface}
                    stroke={lit ? primary : muted}
                    strokeWidth={1.25}
                  />
                )}
                {pin.label ? (
                  <SvgText
                    x={x + 9}
                    y={y + 4}
                    fontSize={10}
                    fill={chosen ? foreground : muted}
                    fontWeight={chosen ? '600' : '400'}
                  >
                    {pin.label}
                  </SvgText>
                ) : null}
              </G>
            );
          })}
        </Svg>
      ) : null}
    </Pressable>
  );
}
