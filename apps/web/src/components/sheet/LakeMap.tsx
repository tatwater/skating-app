import {
  lineToPath,
  NEAR_SHORE_STROKE_PX,
  ringsToPath,
  ringToPath,
  type Sector,
  type SilhouetteData,
  sectorHighlightPath,
  silhouetteProjection,
} from '@skating/core';
import { type MouseEvent, useId } from 'react';

/** A known launch or lot to draw, and whether it is the one the author chose. */
export interface LakeMapPin {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  kind: 'putIn' | 'parking';
}

/** A photo placed on the water by its EXIF coordinate (§8.2 / D42). */
export interface LakeMapPhoto {
  id: string;
  lat: number;
  lng: number;
}

/**
 * The lake as the console's map (A10-5 §10.1) — the same silhouette `BodySilhouette` draws on a
 * card, larger and **clickable**: the known put-ins as dots with their names, the chosen one
 * filled, the chips' sector as a wash, the recorded skate as a line, placed photos as small marks,
 * and a click anywhere on the water coming back as a coordinate.
 *
 * It is still not a map (D203): no tiles, no zoom — a shape you point at. Mobile's `LakeMap` draws
 * the same paths from the same core helpers with `react-native-svg`; the geometry lives in core
 * (`silhouetteProjection`, `sectorHighlightPath`) so the two cannot drift.
 */
export function LakeMap({
  data,
  pins = [],
  chosenPinId,
  sector,
  point,
  path,
  photos = [],
  width = 420,
  height = 300,
  onPick,
  onPickPin,
  label = 'The lake. Click a launch, or anywhere on the water.',
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
  photos?: readonly LakeMapPhoto[];
  width?: number;
  height?: number;
  onPick?: (coord: { lat: number; lng: number }) => void;
  onPickPin?: (pin: LakeMapPin) => void;
  label?: string;
}) {
  const clipId = useId();
  const p = silhouetteProjection(data.bbox, width, height, 12);
  const outline = ringsToPath(data.rings, p);
  const highlight = sector ? sectorHighlightPath(data, sector, p) : null;
  const skate = path ? lineToPath(path, p) : '';
  const dots = pins.map((pin) => {
    const [x, y] = p.toXY([pin.lng, pin.lat]);
    return { pin, x, y };
  });
  const placed = point ? p.toXY([point.lng, point.lat]) : null;
  const placedR =
    point?.radiusMeters !== undefined ? Math.max(6, point.radiusMeters * p.pxPerMeter) : 6;
  const interactive = onPick !== undefined || onPickPin !== undefined;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // The SVG scales to its box; map the click back through that scale before un-projecting.
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const y = ((e.clientY - rect.top) / rect.height) * height;
    // A dot within reach wins over the water under it.
    let nearest: { pin: LakeMapPin; d: number } | null = null;
    for (const dot of dots) {
      const d = Math.hypot(dot.x - x, dot.y - y);
      if (d <= 14 && (nearest === null || d < nearest.d)) nearest = { pin: dot.pin, d };
    }
    if (nearest && onPickPin) {
      onPickPin(nearest.pin);
      return;
    }
    const [lng, lat] = p.fromXY([x, y]);
    onPick?.({ lat, lng });
  };

  const svg = (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <defs>
        <clipPath id={clipId}>
          <path d={outline} clipRule="evenodd" />
        </clipPath>
      </defs>
      <path d={outline} fill="var(--surface-muted)" fillRule="evenodd" />
      <g clipPath={`url(#${clipId})`}>
        {data.bayRing ? (
          <path d={ringToPath(data.bayRing, p)} fill="var(--primary)" fillOpacity={0.12} />
        ) : null}
        {highlight ? <path d={highlight} fill="var(--primary)" fillOpacity={0.22} /> : null}
        {sector === 'near_shore' ? (
          <path
            d={outline}
            fill="none"
            stroke="var(--primary)"
            strokeOpacity={0.22}
            strokeWidth={NEAR_SHORE_STROKE_PX * 1.6}
          />
        ) : null}
        {skate ? (
          <path
            d={skate}
            fill="none"
            stroke="var(--foreground)"
            strokeOpacity={0.5}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
      <path d={outline} fill="none" stroke="var(--border-strong)" strokeWidth={1.25} />
      {placed ? (
        <g>
          <circle
            cx={placed[0]}
            cy={placed[1]}
            r={placedR}
            fill="var(--primary)"
            fillOpacity={0.18}
            stroke="var(--primary)"
            strokeWidth={1}
          />
          <circle cx={placed[0]} cy={placed[1]} r={2.5} fill="var(--primary)" />
        </g>
      ) : null}
      {photos.map((photo) => {
        const [x, y] = p.toXY([photo.lng, photo.lat]);
        return (
          <rect
            key={photo.id}
            x={x - 3.5}
            y={y - 3.5}
            width={7}
            height={7}
            rx={1.5}
            fill="var(--surface)"
            stroke="var(--foreground)"
            strokeWidth={1.25}
          />
        );
      })}
      {dots.map(({ pin, x, y }) => {
        const chosen = pin.id === chosenPinId;
        const stroke = chosen ? 'var(--primary)' : 'var(--foreground-muted)';
        const fill = chosen ? 'var(--primary)' : 'var(--surface)';
        return (
          <g key={pin.id}>
            {pin.kind === 'parking' ? (
              <path
                d={`M ${x - 4} ${y - 4} h 8 v 8 h -8 Z`}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.25}
              />
            ) : (
              <circle
                cx={x}
                cy={y}
                r={chosen ? 6 : 4.5}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.25}
              />
            )}
            {pin.label ? (
              <text
                x={x + 9}
                y={y + 4}
                fontSize={10}
                fill={chosen ? 'var(--foreground)' : 'var(--foreground-muted)'}
                fontWeight={chosen ? 600 : 400}
              >
                {pin.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );

  // Interactive: a real button around the drawing, so it is focusable and announced. Activating it
  // from the keyboard cannot name a coordinate, and does not have to — every launch, bay and sector
  // this map can choose is also a chip beside it. The map is the pointer's shortcut, never the only
  // way to say where.
  return interactive ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="block w-full cursor-crosshair rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {svg}
    </button>
  ) : (
    svg
  );
}
