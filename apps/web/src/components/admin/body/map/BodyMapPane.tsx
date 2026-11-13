import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  MapDock,
  MapHoverPlate,
  MapLayerRack,
  MapPane,
  MapScaleBar,
  MapZoom,
  metersPerPixel,
} from '@/components/kit/map-controls';
import { MARK_BOX } from '@/components/kit/map-marks';
import { SwitchRow } from '@/components/kit/switch';
import { cn } from '@/lib/utils';

import { BodyMapKey, PointFace } from './BodyMapMarks';
import type { DrawnScene } from './bodyScene';
import { graticuleLayout, type Rect } from './kit-candidates/graticule';
import { MapGraticule } from './kit-candidates/map-graticule';
import type { BodyMapLayer, MapLabel, MapPoint } from './mapDescriptors';
import type { MapSurface } from './mapSurface';

/**
 * The console map's chrome, drawn from props over whatever draws the map itself (`ground`: the
 * MapLibre canvas in the app, an SVG still in a story): the layer rack top left, the marks and
 * labels on their points, the graticule at the edges, the dock 56 px up at the right (the scale,
 * then the zoom pair), the key along the foot, and the one hover plate.
 *
 * - **A layer with nothing to draw is disabled** — dashed, no knob, inert — and keeps its place.
 * - **Hovering a mark fades every other mark** to .38; the lit one never steps back (Review 13 #2).
 * - **The graticule's labels keep clear of the chrome**: the rack, the dock and anything marked
 *   `data-map-ui` are measured as keep-outs, and the longitude row runs the map's full width over
 *   the key (Review 13 #5).
 */

export const LAYER_LABELS: Record<BodyMapLayer, string> = {
  outline: 'Outline',
  bays: 'Bays',
  marks: 'Marks',
  putIns: 'Put-ins',
  samples: 'Samples',
  hazards: 'Hazards',
  features: 'Features',
  tracks: 'Tracks',
  aerial: 'Aerial',
  bathy: 'Bathy',
};

/** The key's bar: the kit map key's `h-7.5` (30 px), which the longitude row sits over. */
const KEY_HEIGHT = 30;

export interface BodyMapPaneProps {
  /** The map's camera and projections; `null` while the map is not up yet. */
  surface: MapSurface | null;
  /** What draws the map: the live canvas, or a still. */
  ground: ReactNode;
  drawn: DrawnScene;
  rack: readonly { layer: BodyMapLayer; on: boolean; available: boolean }[];
  onLayerChange: (layer: BodyMapLayer, on: boolean) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  atMinZoom?: boolean;
  atMaxZoom?: boolean;
  /** Draw this mark's hover plate (a board's one hover state); otherwise the pointer decides. */
  hoverId?: string | null;
  className?: string;
}

export function BodyMapPane({
  surface,
  ground,
  drawn,
  rack,
  onLayerChange,
  onZoomIn,
  onZoomOut,
  atMinZoom = false,
  atMaxZoom = false,
  hoverId: forcedHover = null,
  className,
}: BodyMapPaneProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [pointerHover, setPointerHover] = useState<string | null>(null);
  const hoverId = pointerHover ?? forcedHover;
  const keepouts = useKeepouts(paneRef, surface?.width ?? 0, surface?.height ?? 0, rack.length);

  const footInset = drawn.keyKinds.length > 0 ? KEY_HEIGHT : 0;
  const graticule = useMemo(
    () =>
      surface === null
        ? null
        : graticuleLayout({
            width: surface.width,
            height: surface.height,
            project: surface.project,
            unproject: surface.unproject,
            // The boards' hundredths of a degree on a body: parallels at least 60 px apart.
            minSpacing: 60,
            footInset,
            keepouts,
          }),
    [surface, footInset, keepouts],
  );

  const hovered = drawn.points.find((p) => p.id === hoverId) ?? null;
  const hoverAt = hovered && surface ? surface.project(hovered.at) : null;

  return (
    <MapPane
      ref={paneRef}
      data-slot="body-map"
      aria-label="Map"
      className={cn('size-full', className)}
      style={{ '--map-ground': 'var(--map-earth)' } as CSSProperties}
    >
      {ground}
      {surface !== null && graticule !== null && (
        <MapGraticule layout={graticule} width={surface.width} height={surface.height} />
      )}
      {surface !== null && (
        <div data-slot="body-map-overlay" className="pointer-events-none absolute inset-0">
          {drawn.labels.map((l) => (
            <SceneLabel key={l.id} label={l} at={surface.project(l.at)} lit={l.id === drawn.lit} />
          ))}
          {drawn.points.map((p) => (
            <ScenePoint
              key={p.id}
              point={p}
              at={surface.project(p.at)}
              lit={p.id === drawn.lit}
              dim={hoverId !== null && hoverId !== p.id && p.id !== drawn.lit}
              hovered={hoverId === p.id}
              onHover={(on) => setPointerHover(on ? p.id : null)}
            />
          ))}
        </div>
      )}
      <MapLayerRack>
        {rack.map((row) => (
          <SwitchRow
            key={row.layer}
            data-layer={row.layer}
            label={LAYER_LABELS[row.layer]}
            checked={row.on}
            disabled={!row.available}
            onCheckedChange={(on) => onLayerChange(row.layer, on)}
          />
        ))}
      </MapLayerRack>
      <MapDock>
        {surface !== null && (
          <MapScaleBar metersPerPixel={metersPerPixel(surface.center.lat, surface.zoom)} />
        )}
        <MapZoom onZoomIn={onZoomIn} onZoomOut={onZoomOut} atMin={atMinZoom} atMax={atMaxZoom} />
      </MapDock>
      <BodyMapKey kinds={drawn.keyKinds} />
      {hovered !== null && hoverAt !== null && (
        <MapHoverPlate at={hoverAt} title={hovered.hoverKicker}>
          {hovered.name ?? ''}
        </MapHoverPlate>
      )}
    </MapPane>
  );
}

const HALF = MARK_BOX / 2;

function ScenePoint({
  point,
  at,
  lit,
  dim,
  hovered,
  onHover,
}: {
  point: MapPoint;
  at: { x: number; y: number };
  lit: boolean;
  dim: boolean;
  hovered: boolean;
  onHover: (on: boolean) => void;
}) {
  return (
    <div
      data-slot="body-map-point"
      data-id={point.id}
      data-mark={point.mark}
      data-lit={lit ? '' : undefined}
      // A mark answers a hover with its plate; the inspector's list is how a keyboard reaches it.
      className="pointer-events-auto absolute top-0 left-0"
      style={{ transform: `translate(${at.x - HALF}px, ${at.y - HALF}px)` }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <PointFace mark={point.mark} dim={dim} highlight={lit || hovered} />
    </div>
  );
}

const LABEL_CLASS: Record<MapLabel['style'], string> = {
  // The boards' 2 px at 9 px is the head tracking at the kicker step.
  bay: 'text-kick font-medium tracking-head uppercase text-fg3',
  town: 'text-kick font-medium tracking-label uppercase text-fg3',
  place: 'text-assist text-fg2',
};

function SceneLabel({
  label,
  at,
  lit,
}: {
  label: MapLabel;
  at: { x: number; y: number };
  lit: boolean;
}) {
  return (
    <span
      data-slot="body-map-label"
      data-id={label.id}
      data-style={label.style}
      className={cn(
        'absolute top-0 left-0 leading-none whitespace-nowrap',
        LABEL_CLASS[label.style],
        lit && 'text-fg',
      )}
      style={{
        transform: `translate(${at.x}px, ${at.y}px) translate(-50%, -50%) rotate(${label.angle ?? 0}deg)`,
      }}
    >
      {label.text}
    </span>
  );
}

/**
 * The chrome the graticule's labels keep clear of, in pane px: the rack, the dock, MapLibre's own
 * controls (the folded credits), and anything a tab marks `data-map-ui`. Measured after layout, again whenever the pane changes size.
 */
function useKeepouts(
  pane: React.RefObject<HTMLDivElement | null>,
  width: number,
  height: number,
  rows: number,
): readonly Rect[] {
  const [rects, setRects] = useState<readonly Rect[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the pane or the rack changes.
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const host = el.getBoundingClientRect();
    const found = [
      ...el.querySelectorAll<HTMLElement>(
        '[data-slot="map-layer-rack"], [data-slot="map-dock"], [data-map-ui], .maplibregl-ctrl',
      ),
    ].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left - host.left,
        top: r.top - host.top,
        right: r.right - host.left,
        bottom: r.bottom - host.top,
      };
    });
    setRects((prev) => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found));
  }, [width, height, rows]);
  return rects;
}
