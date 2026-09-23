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

/** A live hazard on the body, drawn at its footprint's center (A10-6): the marks a skater passed. */
export interface LakeMapHazard {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** A passage marker (a pressure ridge crossing) draws as a cross; anything else as a triangle. */
  passage: boolean;
}

/** How many hazards get their name beside the mark before the rest are marks alone. */
const LABELED_HAZARDS = 4;

/**
 * The lake as the console's instrument (A10-5 §10.1, A10-6 / D206) — the same silhouette
 * `BodySilhouette` draws on a card, larger and **clickable**: the known put-ins as dots with their
 * names, the chosen one lit, the chips' sector as a wash, the recorded skate as a line, placed
 * photos as small squares, the live hazards as marks, and a click anywhere on the water coming
 * back as a coordinate.
 *
 * **The compass ring is drawn only when asked** (`ring`), which the console does in where-mode:
 * eight arcs from core's `compassRing`, cut on the wedges' own bearings, so a click on the N arc
 * and the N wedge it lights are one fact. A click on the water inside it is a point. The ring is
 * a cursor for a question, never a permanent control; the chips beside the map answer the same
 * question for a keyboard.
 *
 * It is still not a map (D203): no tiles, no zoom — a shape you point at. Mobile's `LakeMap` draws
 * the same paths from the same core helpers with `react-native-svg`.
 */
export function LakeMap({
  data,
  pins = [],
  chosenPinId,
  sector,
  point,
  path,
  photos = [],
  hazards = [],
  width = 420,
  height = 300,
  ring = false,
  litPins = false,
  onPick,
  onPickPin,
  onPickSector,
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
  hazards?: readonly LakeMapHazard[];
  width?: number;
  height?: number;
  /** Draw the compass ring (where-mode). */
  ring?: boolean;
  /** Light every launch (put-in mode), not only the chosen one. */
  litPins?: boolean;
  onPick?: (coord: { lat: number; lng: number }) => void;
  onPickPin?: (pin: LakeMapPin) => void;
  /** A click on the ring's arc (or the water under it, when the ring is up). */
  onPickSector?: (sector: CompassSector) => void;
  label?: string;
}) {
  const clipId = useId();
  const pad = ring ? 34 : 12;
  const p = silhouetteProjection(data.bbox, width, height, pad);
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
  const compass = ring ? compassRing(p, data.origin) : null;
  const interactive = onPick !== undefined || onPickPin !== undefined || onPickSector !== undefined;

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
    // The ring's arc names a sector; so does anything outside the ring, by its bearing.
    if (compass && onPickSector) {
      const d = Math.hypot(x - compass.cx, y - compass.cy);
      if (onRing(compass, [x, y]) || d > compass.r) {
        onPickSector(ringSectorAtXY(compass, [x, y]));
        return;
      }
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
      {compass ? (
        <g aria-hidden>
          {compass.segments.map((seg) => {
            const lit = seg.sector === sector;
            return (
              <g key={seg.sector}>
                <path
                  d={seg.d}
                  fill="none"
                  stroke={lit ? 'var(--primary)' : 'var(--border-strong)'}
                  strokeOpacity={lit ? 1 : 0.6}
                  strokeWidth={lit ? 3 : 1}
                  style={lit ? { filter: 'drop-shadow(0 0 5px var(--ring))' } : undefined}
                />
                <line
                  x1={seg.tick[0][0]}
                  y1={seg.tick[0][1]}
                  x2={seg.tick[1][0]}
                  y2={seg.tick[1][1]}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                />
                <text
                  x={seg.label[0]}
                  y={seg.label[1] + 3.5}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontFamily="ui-monospace, Menlo, monospace"
                  fontWeight={lit ? 700 : 400}
                  fill={lit ? 'var(--primary)' : 'var(--foreground-muted)'}
                >
                  {seg.sector}
                </text>
              </g>
            );
          })}
          <circle cx={compass.cx} cy={compass.cy} r={3} fill="none" stroke="var(--border-strong)" />
        </g>
      ) : null}
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
            strokeOpacity={0.85}
            strokeWidth={1.4}
            strokeDasharray="3 3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
      <path d={outline} fill="none" stroke="var(--foreground)" strokeWidth={1.3} />
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
      {hazards.map((h, i) => {
        const [x, y] = p.toXY([h.lng, h.lat]);
        return (
          <g key={h.id}>
            {h.passage ? (
              <>
                <line
                  x1={x - 6}
                  y1={y - 3}
                  x2={x + 6}
                  y2={y + 3}
                  stroke="var(--danger)"
                  strokeWidth={1.6}
                />
                <line
                  x1={x - 6}
                  y1={y + 3}
                  x2={x + 6}
                  y2={y - 3}
                  stroke="var(--danger)"
                  strokeWidth={1.6}
                  strokeOpacity={0.5}
                />
              </>
            ) : (
              <path
                d={`M ${x} ${y - 6} L ${x + 6} ${y + 5} L ${x - 6} ${y + 5} Z`}
                fill="var(--background)"
                stroke="var(--danger)"
                strokeWidth={1.4}
              />
            )}
            {i < LABELED_HAZARDS ? (
              <text x={x + 10} y={y + 4} fontSize={9.5} fill="var(--foreground-muted)">
                {h.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {photos.map((photo) => {
        const [x, y] = p.toXY([photo.lng, photo.lat]);
        return (
          <g key={photo.id}>
            <rect
              x={x - 4}
              y={y - 4}
              width={8}
              height={8}
              fill="var(--background)"
              stroke="var(--foreground)"
              strokeWidth={1.2}
            />
            <circle cx={x} cy={y} r={1.3} fill="var(--foreground)" />
          </g>
        );
      })}
      {dots.map(({ pin, x, y }) => {
        const chosen = pin.id === chosenPinId;
        const lit = chosen || litPins;
        const stroke = lit ? 'var(--primary)' : 'var(--foreground-muted)';
        const fill = chosen ? 'var(--primary)' : 'var(--background)';
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
                r={chosen ? 5 : litPins ? 6 : 4}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.25}
                style={lit ? { filter: 'drop-shadow(0 0 5px var(--ring))' } : undefined}
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
      className="block w-full cursor-crosshair rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {svg}
    </button>
  ) : (
    svg
  );
}
