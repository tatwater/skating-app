import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { graticuleLayout, type Rect } from '@/components/kit/graticule';
import {
  MapDock,
  MapHoverPlate,
  MapLayerRack,
  MapModeBar,
  MapPane,
  MapScaleBar,
  MapZoom,
  metersPerPixel,
} from '@/components/kit/map-controls';
import { MapGraticule } from '@/components/kit/map-graticule';
import { MARK_BOX } from '@/components/kit/map-marks';
import { SwitchRow } from '@/components/kit/switch';
import type { MapSurface } from '@/lib/mapSurface';
import { cn } from '@/lib/utils';
import { formatDistance } from '../tabs/places/placesModel';
import { BodyMapKey, PointFace } from './BodyMapMarks';
import { LINE_STYLES, LIT_STYLE, tokenVar } from './bodyMapPalette';
import type { DrawnScene } from './bodyScene';
import { fieldOpacity } from './hazardField';
import type { BodyMapLayer, MapLabel, MapLineStyle, MapPoint } from './mapDescriptors';

/**
 * The console map's chrome, drawn from props over whatever draws the map itself (`ground`: the
 * MapLibre canvas in the app, an SVG still in a story): the layer rack top left, the marks and
 * labels on their points, the graticule at the edges, the dock 56 px up at the right (the scale,
 * then the zoom pair), the key along the foot, and the one hover plate.
 *
 * - **A layer with nothing to draw is disabled** — dashed, no knob, inert — and keeps its place.
 * - **A plate shows for the hovered mark, else for the lit one** (Links' interior point, a chosen
 *   landmark); while one shows, every other mark fades a step (`opacity-fade`, Review 13 #2) — the
 *   lit one never steps back, and a hazard never below half (the kit marks' floor, D3).
 * - **Dimension lines are drawn in pixels** over the map, a tick across each end, so a survey's
 *   ticks keep their length at every zoom.
 * - **The foot slot** (`foot`) holds what the open tab mounts at the map's foot (Imagery's dock),
 *   over the key and marked `data-map-ui`, so the graticule keeps clear of it.
 * - **The graticule's labels keep clear of the chrome**: the rack, the dock and anything marked
 *   `data-map-ui` are measured as keep-outs, and the longitude row runs the map's full width over
 *   the key (Review 13 #5).
 * - **An embed goes without the rack** (`rack={false}`, the Inbox's): no switches at all, and the
 *   `plate` slot (a legend, a caption) takes the rack's corner; beside a rack, a plate goes top right.
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
  /**
   * The rack's rows, or `false` for a map with no rack at all (an embed: the Inbox's). Each row is
   * a layer with whether it is on and whether anything belongs to it.
   */
  rack: readonly { layer: BodyMapLayer; on: boolean; available: boolean }[] | false;
  /** A rack switch flipped; a map without a rack never calls it. */
  onLayerChange?: (layer: BodyMapLayer, on: boolean) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  atMinZoom?: boolean;
  atMaxZoom?: boolean;
  /** Draw this mark's hover plate (a board's one hover state); otherwise the pointer decides. */
  hoverId?: string | null;
  /** What the open tab mounts at the map's foot (its dock), over the key. */
  foot?: ReactNode;
  /**
   * A plate over the map (a legend, a caption): in the rack's corner, top left, when there is no
   * rack; top right beside one. Marked `data-map-ui`, so the graticule's labels keep clear of it.
   */
  plate?: ReactNode;
  /**
   * The tool a tab holds on the map (B01-6): its mode bar across the top — the mode, what to do
   * next, where it stands — with the Esc cap that leaves it. The rack drops below it.
   */
  tool?: { mode: string; line?: string; step?: string; onExit: () => void } | null;
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
  foot,
  plate,
  tool = null,
  className,
}: BodyMapPaneProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [pointerHover, setPointerHover] = useState<string | null>(null);
  // A mark that leaves the scene under the pointer (its layer switched off) never hears the pointer
  // leave: forget it, or it comes back hovered with no pointer on it.
  const pointerHoverShown =
    pointerHover !== null && drawn.points.some((p) => p.id === pointerHover);
  useEffect(() => {
    if (pointerHover !== null && !pointerHoverShown) setPointerHover(null);
  }, [pointerHover, pointerHoverShown]);
  const hoverId = (pointerHoverShown ? pointerHover : null) ?? forcedHover;
  const rows = rack === false ? [] : rack;
  const keepouts = useKeepouts(
    paneRef,
    surface?.width ?? 0,
    surface?.height ?? 0,
    rows.length,
    plate != null,
  );

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

  // The plate: the hovered mark's, else the lit mark's when it has a name to show.
  const hovered =
    drawn.points.find((p) => p.id === hoverId) ??
    drawn.points.find((p) => p.id === drawn.lit && p.name !== undefined) ??
    null;
  const hoverAt = hovered && surface ? surface.project(hovered.at) : null;
  const plateId = hovered?.id ?? null;

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
          {drawn.dimensions.length > 0 && (
            <svg
              aria-hidden="true"
              data-slot="body-map-dimensions"
              width={surface.width}
              height={surface.height}
              className="absolute top-0 left-0 overflow-visible"
            >
              {drawn.dimensions.map((d) => (
                <DimensionLine
                  key={d.id}
                  id={d.id}
                  style={d.style}
                  path={d.path.map((p) => surface.project(p))}
                  lit={d.id === drawn.lit}
                />
              ))}
            </svg>
          )}
          {drawn.labels.map((l) => (
            <SceneLabel key={l.id} label={l} at={surface.project(l.at)} lit={l.id === drawn.lit} />
          ))}
          {drawn.points.map((p) => (
            <ScenePoint
              key={p.id}
              point={p}
              at={surface.project(p.at)}
              lit={p.id === drawn.lit}
              dim={plateId !== null && plateId !== p.id && p.id !== drawn.lit}
              hovered={hoverId === p.id}
              onHover={(on) => setPointerHover(on ? p.id : null)}
            />
          ))}
        </div>
      )}
      {tool !== null && (
        <MapModeBar
          data-map-ui=""
          mode={tool.mode}
          step={tool.step}
          onExit={tool.onExit}
          exitLabel={`Leave ${tool.mode.toLowerCase()}`}
        >
          {tool.line}
        </MapModeBar>
      )}
      {rack !== false && (
        <MapLayerRack>
          {rows.map((row) => (
            <SwitchRow
              key={row.layer}
              data-layer={row.layer}
              label={LAYER_LABELS[row.layer]}
              checked={row.on}
              disabled={!row.available}
              onCheckedChange={(on) => onLayerChange?.(row.layer, on)}
            />
          ))}
        </MapLayerRack>
      )}
      {plate != null && (
        <div
          data-slot="body-map-plate"
          data-map-ui=""
          className={cn(
            'absolute top-(--space-3) z-(--z-map-control) max-w-[calc(100%-2*var(--space-3))]',
            rack === false ? 'left-(--space-3)' : 'right-(--space-3)',
          )}
        >
          {plate}
        </div>
      )}
      <MapDock>
        {surface !== null && (
          <MapScaleBar
            metersPerPixel={metersPerPixel(surface.center.lat, surface.zoom)}
            format={formatDistance}
          />
        )}
        <MapZoom onZoomIn={onZoomIn} onZoomOut={onZoomOut} atMin={atMinZoom} atMax={atMaxZoom} />
      </MapDock>
      {foot != null && (
        <div
          data-slot="body-map-foot"
          data-map-ui=""
          className="absolute inset-x-0 z-(--z-map-control)"
          style={{ bottom: footInset }}
        >
          {foot}
        </div>
      )}
      <BodyMapKey kinds={drawn.keyKinds} />
      {hovered !== null && hoverAt !== null && (
        <MapHoverPlate at={hoverAt} title={hovered.hoverKicker} caption={hovered.caption}>
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
      style={{
        transform: `translate(${at.x - HALF}px, ${at.y - HALF}px)`,
        // A hazard's pin fades as its dot field would (`fieldOpacity`): confidence, never safety.
        ...(point.field === undefined ? {} : { opacity: fieldOpacity(point.field) }),
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      {/* A pin carrying its field is already at that field's fade, and a field never steps back for
          another mark's plate: stepping it back too would draw it fainter than its field (D3). */}
      <PointFace
        mark={point.mark}
        fade={dim && point.field === undefined}
        highlight={lit || hovered}
      />
    </div>
  );
}

const LABEL_CLASS: Record<MapLabel['style'], string> = {
  // The boards' 2 px at 9 px is the head tracking at the kicker step.
  bay: 'text-kick font-medium tracking-head uppercase text-fg3',
  town: 'text-kick font-medium tracking-label uppercase text-fg3',
  place: 'text-assist text-fg2',
  // A dimension's length, set into its line on the map's own ground so the line breaks for it.
  measure:
    'text-kick font-medium tracking-head uppercase text-fg3 bg-(--map-ground) px-(--space-1)',
};

/** A tick's half length across a dimension line's end, px (the board's 8 px tick). */
const TICK = 4;

/**
 * A survey's dimension line (or the Inbox's distance rule, `gap`): the run, and a tick across each
 * end at a right angle to it. A dashed style's ticks stay solid, so each end reads as an end.
 */
function DimensionLine({
  id,
  style = 'dimension',
  path,
  lit,
}: {
  id: string;
  style?: MapLineStyle;
  path: readonly { x: number; y: number }[];
  lit: boolean;
}) {
  const a = path[0];
  const b = path[path.length - 1];
  if (a === undefined || b === undefined) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // The unit normal: a tick runs across the line, whichever way the line runs.
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const tick = (p: { x: number; y: number }) =>
    `M${(p.x - nx * TICK).toFixed(1)} ${(p.y - ny * TICK).toFixed(1)} L${(p.x + nx * TICK).toFixed(1)} ${(p.y + ny * TICK).toFixed(1)}`;
  const run = path.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const spec = LINE_STYLES[style];
  const stroke = tokenVar(lit ? LIT_STYLE.line : spec.line);
  if (spec.dash === null)
    return (
      <path
        data-id={id}
        data-slot="body-map-dimension"
        d={`${run} ${tick(a)} ${tick(b)}`}
        fill="none"
        strokeWidth={spec.width}
        stroke={stroke}
      />
    );
  return (
    <g data-id={id} data-slot="body-map-dimension" data-style={style}>
      <path
        data-slot="body-map-dimension-run"
        d={run}
        fill="none"
        strokeWidth={spec.width}
        stroke={stroke}
        strokeDasharray={spec.dash.map((d) => d * spec.width).join(' ')}
      />
      <path
        data-slot="body-map-dimension-ticks"
        d={`${tick(a)} ${tick(b)}`}
        fill="none"
        strokeWidth={spec.width}
        stroke={stroke}
      />
    </g>
  );
}

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

const KEEPOUT_SELECTOR =
  '[data-slot="map-layer-rack"], [data-slot="map-dock"], [data-map-ui], .maplibregl-ctrl';

/**
 * The chrome the graticule's labels keep clear of, in pane px: the rack, the dock, MapLibre's own
 * controls (the folded credits), and anything a tab marks `data-map-ui`. Measured after layout,
 * again whenever the pane changes size, and whenever one of them does — the foot's notice arriving,
 * a tab's dock mounting in it. A box with no area takes no room (the foot holds its live region
 * mounted while it says nothing), so it keeps nothing out.
 */
function useKeepouts(
  pane: React.RefObject<HTMLDivElement | null>,
  width: number,
  height: number,
  rows: number,
  plated: boolean,
): readonly Rect[] {
  const [rects, setRects] = useState<readonly Rect[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the pane, the rack or the plate changes.
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => {
      const host = el.getBoundingClientRect();
      const found = [...el.querySelectorAll<HTMLElement>(KEEPOUT_SELECTOR)].flatMap((node) => {
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return [];
        return [
          {
            left: r.left - host.left,
            top: r.top - host.top,
            right: r.right - host.left,
            bottom: r.bottom - host.top,
          },
        ];
      });
      setRects((prev) => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const node of el.querySelectorAll<HTMLElement>(KEEPOUT_SELECTOR)) observer.observe(node);
    return () => observer.disconnect();
  }, [width, height, rows, plated]);
  return rects;
}
