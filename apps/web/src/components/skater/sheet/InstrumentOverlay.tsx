import {
  type Projection,
  ringsToPath,
  type SilhouetteData,
  sectorHighlightPath,
  type Where,
} from '@skating/core';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { useEffect, useId, useState } from 'react';
import type { ConsoleMode } from './ConsoleMode';
import type { InstrumentPin } from './instrumentFeatures';
import { instrumentRing } from './instrumentPick';
import { mapProjection, type ProjectingMap } from './instrumentProjection';
import { patchWhere, SECTOR_LABELS } from './WherePicker';

/** What the overlay listens to on the map: the camera and the frame. */
export interface OverlayMap extends ProjectingMap {
  on(type: 'move' | 'resize', listener: () => void): unknown;
  off(type: 'move' | 'resize', listener: () => void): unknown;
  /** The camera, for the where mode's framing (absent on a map that can't move). */
  getZoom?(): number;
  jumpTo?(camera: { center: { lng: number; lat: number }; zoom: number }): unknown;
}

/** Room between the frame's edge and the lake in the where mode: the ring, its letters, a gap. */
export const RING_ROOM_PX = 48;

/**
 * The camera that puts the lake inside the ring (5.13): centered on its origin, zoomed so its
 * farthest shore sits `RING_ROOM_PX` inside the frame's shorter half — the board draws the lake
 * smaller in the where mode for exactly this. `null` when there is nothing to frame.
 */
export function ringCamera(
  projection: Projection,
  silhouette: SilhouetteData,
  zoom: number,
): { center: { lng: number; lat: number }; zoom: number } | null {
  const [ox, oy] = projection.toXY([silhouette.origin.lng, silhouette.origin.lat]);
  let far = 0;
  for (const ring of silhouette.rings) {
    for (const pt of ring) {
      const [x, y] = projection.toXY(pt);
      far = Math.max(far, Math.hypot(x - ox, y - oy));
    }
  }
  const target = Math.min(projection.width, projection.height) / 2 - RING_ROOM_PX;
  if (!(far > 0) || !(target > 0)) return null;
  return { center: silhouette.origin, zoom: zoom + Math.log2(target / far) };
}

/** While the where mode is open, the lake sits inside the ring; leaving, the camera comes back. */
function useRingFraming(map: OverlayMap | null, silhouette: SilhouetteData | null, on: boolean) {
  useEffect(() => {
    if (!on || map === null || silhouette === null || !map.getZoom || !map.jumpTo) return;
    const before = { center: map.getCenter(), zoom: map.getZoom() };
    const camera = ringCamera(mapProjection(map), silhouette, before.zoom);
    if (camera === null) return;
    map.jumpTo(camera);
    return () => {
      // The map may already be gone (the sheet closing, a stacked sheet taking the slot).
      try {
        map.jumpTo?.(before);
      } catch {
        // Nothing to put back on a removed map.
      }
    };
  }, [map, silhouette, on]);
}

/** The camera as a projection, rebuilt whenever the map moves or the pane resizes. */
export function useMapProjection(map: OverlayMap | null): Projection | null {
  const [projection, setProjection] = useState<Projection | null>(null);
  useEffect(() => {
    if (map === null) {
      setProjection(null);
      return;
    }
    const sync = () => setProjection(mapProjection(map));
    sync();
    map.on('move', sync);
    map.on('resize', sync);
    return () => {
      map.off('move', sync);
      map.off('resize', sync);
    };
  }, [map]);
  return projection;
}

/**
 * What the instrument draws over its map in a sub-mode (B03 §5, boards 5.13–5.15, and the hazard
 * draft of 5.10.1 / 3.2–3.6) — an SVG laid on the MapLibre canvas, in screen pixels from core's
 * silhouette helpers, so the ring, the wash and the shore read exactly as the old lake did:
 *
 * - **where**: the compass ring around the lake's origin, the chip's sector lit (several chips may
 *   light several); the sector washed on the water; the point the author placed, with its radius.
 *   The arcs take a click (the chips beside are the keyboard's way); the water passes through to
 *   the map, where a click is a point.
 * - **put-in**: every launch and lot lit, each named, the chosen one solid.
 * - **draft**: the hazard being drawn — its footprint and its corners.
 *
 * Nothing here is a verdict on the ice (D3): a lit sector is where the author looked.
 */
export function InstrumentOverlay({
  map,
  mode,
  silhouette,
  pins,
  chosenPinId,
  draft,
}: {
  map: OverlayMap | null;
  mode: ConsoleMode | null;
  silhouette: SilhouetteData | null;
  pins: readonly InstrumentPin[];
  chosenPinId?: string;
  draft?: FeatureCollection | null;
}) {
  const projection = useMapProjection(map);
  const clipId = useId();
  useRingFraming(map, silhouette, mode?.kind === 'where');
  if (projection === null) return null;
  const where = mode?.kind === 'where' ? mode : null;
  const showDraft = draft !== undefined && draft !== null && draft.features.length > 0;
  if (where === null && mode?.kind !== 'putIn' && !showDraft) return null;
  return (
    <svg
      data-slot="instrument-overlay"
      aria-hidden
      width={projection.width}
      height={projection.height}
      viewBox={`0 0 ${projection.width} ${projection.height}`}
      className="pointer-events-none absolute inset-0 z-(--z-plate) size-full overflow-visible"
    >
      {where && silhouette ? (
        <WhereLayer
          projection={projection}
          silhouette={silhouette}
          where={where.where}
          clipId={clipId}
          onSector={(sector) =>
            where.onChange(
              patchWhere(where.where, {
                sector: where.where?.sector === sector ? undefined : sector,
              }),
            )
          }
        />
      ) : null}
      {where?.where?.point ? <PlacedPoint projection={projection} where={where.where} /> : null}
      {mode?.kind === 'putIn' ? (
        <LitPins projection={projection} pins={pins} chosenPinId={chosenPinId} />
      ) : null}
      {showDraft ? <Draft projection={projection} draft={draft} /> : null}
    </svg>
  );
}

function WhereLayer({
  projection,
  silhouette,
  where,
  clipId,
  onSector,
}: {
  projection: Projection;
  silhouette: SilhouetteData;
  where: Where | undefined;
  clipId: string;
  onSector: (sector: NonNullable<Where['sector']>) => void;
}) {
  const ring = instrumentRing(projection, silhouette.origin);
  const outline = ringsToPath(silhouette.rings, projection);
  const sector = where?.sector;
  const wash = sector ? sectorHighlightPath(silhouette, sector, projection) : null;
  return (
    <g data-slot="instrument-where">
      <defs>
        <clipPath id={clipId}>
          <path d={outline} clipRule="evenodd" />
        </clipPath>
      </defs>
      {wash ? (
        <g clipPath={`url(#${clipId})`}>
          <path data-slot="instrument-wash" d={wash} fill="var(--acc-wash-strong)" />
        </g>
      ) : null}
      {ring ? (
        <g data-slot="instrument-ring">
          {ring.segments.map((seg) => {
            const lit = seg.sector === sector;
            return (
              <g key={seg.sector}>
                {/* A wide, invisible stroke under the arc: the arc itself is too thin to hit. */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: the ring is the pointer's shortcut (aria-hidden); the sector chips beside the map are the keyboard's way. */}
                <path
                  d={seg.d}
                  data-sector={seg.sector}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={18}
                  className="pointer-events-auto cursor-pointer"
                  onClick={() => onSector(seg.sector)}
                />
                <path
                  d={seg.d}
                  fill="none"
                  stroke={lit ? 'var(--acc)' : 'var(--acc-wash-strong)'}
                  strokeWidth={RING_BAND_PX}
                  style={lit ? { filter: 'drop-shadow(0 0 6px var(--acc-glow))' } : undefined}
                />
                <text
                  x={seg.label[0]}
                  y={seg.label[1] + 4}
                  textAnchor="middle"
                  fontFamily="var(--family-mono)"
                  fontSize={11}
                  fill={lit ? 'var(--acc)' : 'var(--fg3)'}
                >
                  {seg.sector}
                </text>
                {lit ? <SectorName ring={ring} sector={seg.sector} /> : null}
              </g>
            );
          })}
        </g>
      ) : null}
    </g>
  );
}

/** The ring's band, px: a band the pointer can find, as the board draws it. */
const RING_BAND_PX = 12;

/** The lit sector's name inside the ring, by its arc ("South end"), as the board writes it. */
function SectorName({
  ring,
  sector,
}: {
  ring: { cx: number; cy: number; r: number };
  sector: NonNullable<Where['sector']>;
}) {
  const bearing = COMPASS_BEARINGS[sector as keyof typeof COMPASS_BEARINGS];
  if (bearing === undefined) return null;
  const rad = (bearing * Math.PI) / 180;
  const r = ring.r - RING_BAND_PX - 10;
  const x = ring.cx + r * Math.sin(rad);
  const y = ring.cy - r * Math.cos(rad);
  const anchor = Math.sin(rad) > 0.3 ? 'end' : Math.sin(rad) < -0.3 ? 'start' : 'middle';
  return (
    <text
      data-slot="instrument-sector-name"
      x={x}
      y={y + (Math.cos(rad) < -0.3 ? 0 : Math.cos(rad) > 0.3 ? 10 : 4)}
      textAnchor={anchor}
      fontFamily="var(--family-sans)"
      fontSize={13}
      fontWeight={500}
      fill="var(--acc)"
      paintOrder="stroke"
      stroke="var(--bg)"
      strokeWidth={3}
    >
      {SECTOR_LABELS[sector]}
    </text>
  );
}

const COMPASS_BEARINGS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

function PlacedPoint({ projection, where }: { projection: Projection; where: Where }) {
  const point = where.point;
  if (!point) return null;
  const [x, y] = projection.toXY([point.coord.lng, point.coord.lat]);
  const r =
    point.radiusMeters !== undefined ? Math.max(6, point.radiusMeters * projection.pxPerMeter) : 6;
  return (
    <g data-slot="instrument-point">
      <circle cx={x} cy={y} r={r} fill="var(--acc-wash)" stroke="var(--acc)" strokeWidth={1} />
      <circle cx={x} cy={y} r={3} fill="var(--acc)" />
      {point.name ? (
        <text
          x={x + r + 6}
          y={y + 4}
          fontFamily="var(--family-sans)"
          fontSize={12}
          fontWeight={600}
          fill="var(--fg)"
          paintOrder="stroke"
          stroke="var(--bg)"
          strokeWidth={3}
        >
          {point.name}
        </text>
      ) : null}
    </g>
  );
}

/** Put-in mode: every launch lit, the chosen one solid and named. Lots are squares. */
function LitPins({
  projection,
  pins,
  chosenPinId,
}: {
  projection: Projection;
  pins: readonly InstrumentPin[];
  chosenPinId: string | undefined;
}) {
  return (
    <g data-slot="instrument-lit">
      {pins.map((pin) => {
        const [x, y] = projection.toXY([pin.coord.lng, pin.coord.lat]);
        const chosen = pin.id === chosenPinId;
        return (
          <g key={pin.id} data-pin={pin.id} data-chosen={chosen ? '' : undefined}>
            {pin.kind === 'parking' ? (
              <rect
                x={x - 6}
                y={y - 6}
                width={12}
                height={12}
                fill={chosen ? 'var(--acc)' : 'var(--bg)'}
                stroke="var(--acc)"
                strokeWidth={1.5}
              />
            ) : (
              <circle
                cx={x}
                cy={y}
                r={7}
                fill={chosen ? 'var(--acc)' : 'var(--bg)'}
                stroke="var(--acc)"
                strokeWidth={1.5}
                style={{ filter: 'drop-shadow(0 0 5px var(--acc-glow))' }}
              />
            )}
            {chosen ? (
              // The chosen launch carries the lockup (5.15); the others are named by the chips
              // beside the map — launches sit close enough that every name would collide.
              <text
                x={x + 12}
                y={y - 4}
                fontFamily="var(--family-sans)"
                paintOrder="stroke"
                stroke="var(--bg)"
                strokeWidth={3}
              >
                <tspan fontSize={10} fontWeight={600} letterSpacing="0.12em" fill="var(--acc)">
                  {pin.kind === 'parking' ? 'PARKED · YOURS' : 'PUT-IN · YOURS'}
                </tspan>
                <tspan x={x + 12} dy={15} fontSize={12} fontWeight={600} fill="var(--fg)">
                  {pin.name}
                </tspan>
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function ringPath(ring: readonly Position[], projection: Projection): string {
  return `${ring
    .map(([lng = 0, lat = 0], i) => {
      const [x, y] = projection.toXY([lng, lat]);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ')} Z`;
}

/** One draft feature's path: a footprint's rings, or a line. Points draw as dots instead. */
export function geometryPath(geometry: Geometry, projection: Projection): string | null {
  if (geometry.type === 'Polygon')
    return geometry.coordinates.map((r) => ringPath(r, projection)).join(' ');
  if (geometry.type === 'MultiPolygon')
    return geometry.coordinates
      .flatMap((poly) => poly.map((r) => ringPath(r, projection)))
      .join(' ');
  if (geometry.type === 'LineString')
    return geometry.coordinates
      .map(([lng = 0, lat = 0], i) => {
        const [x, y] = projection.toXY([lng, lat]);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  return null;
}

/** The hazard draft (`hazardDraftToFeatureCollection`): a passage in ice, anything else in red. */
function Draft({ projection, draft }: { projection: Projection; draft: FeatureCollection }) {
  return (
    <g data-slot="instrument-draft">
      {draft.features.map((f: Feature, i) => {
        const passage = f.properties?.passage === true;
        const color = passage ? 'var(--acc)' : 'var(--bad)';
        if (f.geometry.type === 'Point') {
          const [lng = 0, lat = 0] = f.geometry.coordinates;
          const [x, y] = projection.toXY([lng, lat]);
          return (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: a draft's features have no ids; their order is the drawing's.
              key={i}
              cx={x}
              cy={y}
              r={5}
              fill={color}
              stroke="var(--bg)"
              strokeWidth={2}
            />
          );
        }
        const d = geometryPath(f.geometry, projection);
        if (d === null) return null;
        const line = f.geometry.type === 'LineString';
        return (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: as above.
            key={i}
            d={d}
            fill={line ? 'none' : color}
            fillOpacity={line ? undefined : 0.3}
            fillRule="evenodd"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
    </g>
  );
}
