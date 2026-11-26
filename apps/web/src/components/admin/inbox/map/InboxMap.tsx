import { type ReactNode, useMemo, useState } from 'react';
import { MapLegend, type MapLegendItem } from '@/components/kit/map-controls';
import { SwitchRow } from '@/components/kit/switch';
import { fitCamera, type Padding, stillSurface } from '@/lib/mapSurface';
import { cn } from '@/lib/utils';
import { BodyMapPane, LAYER_LABELS } from '../../body/map/BodyMapPane';
import { BodyMapStill } from '../../body/map/BodyMapStill';
import { floorZoom, MAX_ZOOM } from '../../body/map/bodyMapFraming';
import type { BodyMapMode } from '../../body/map/bodyMapPalette';
import { LINE_STYLES, OUTLINE_STYLES, tokenVar } from '../../body/map/bodyMapPalette';
import { type DrawnScene, drawScene, layerSwitches } from '../../body/map/bodyScene';
import { type AerialLoad, aerialCredit, useStillAerialLoad } from '../../body/map/consoleAerial';
import type { BodyMapLayer, BodyMapScene } from '../../body/map/mapDescriptors';
import { mapInkStyle } from '../../body/map/mapInks';
import { useBodyMapCanvas } from '../../body/map/useBodyMapCanvas';
import type { InboxLegendRow, InboxMapView } from './inboxMapScene';

/**
 * **The small map every Inbox handler embeds** — the Body console's map, not a second one: its
 * camera, fit and fence (`useBodyMapCanvas`), its chrome (`BodyMapPane`, here with no rack), its
 * scene and style tables (`mapDescriptors`, `bodyMapPalette`). A handler hands it an
 * {@link InboxMapView} from one of the scene builders (`inboxMapScene.ts`) and a height.
 *
 * - **Fixed height, full width**: the boards' embeds are a column's width at a set height, and on a
 *   phone (the console's narrow rule) the column is the page.
 * - **The zoom pair in its corner** and **pan and zoom fenced to the item's reach**: the console
 *   map's own fence — the frame plus one frame's size on each side, a step and a half out.
 * - **No rack, no key**: what an embed draws is the item, and a legend plate (2.3, 2.5) and a
 *   caption name it in a corner. **One switch, Aerial**, when the item hands a pass: the console
 *   rack's own row in the foot's corner, on by default — the body's archived pass under the outlines.
 * - **View only** (`viewOnly`, a phone's page): no zoom pair and the map takes no pointer, so a
 *   swipe scrolls the page instead of panning a map the thumb landed on.
 * - **The summer aerial** (`aerial`, the Corpus head map's): the console's unmasked NAIP under the
 *   outlines, its credit in the dock — no switch: the caller decides. **`maxZoom`** lets a caller
 *   frame closer than the console's ceiling (a five-acre pond over the aerial).
 *
 * `InboxMapStill` is a story's and a test's: the same chrome over an SVG still of the same scene
 * (the automated browser can't load the basemap's tiles).
 */

/** The room the embed's chrome takes when it frames: the zoom pair on the right, air elsewhere. */
export const EMBED_PADDING: Padding = { top: 28, right: 48, bottom: 28, left: 28 };

/** The boards' commonest embed height (2.2's), px. */
export const EMBED_HEIGHT = 300;

/**
 * The dock sits in the embed's corner (the boards' 10 px), not 56 px up over a longitude row; the
 * graticule keeps its lines and drops its labels, which an embed's few hundred pixels can't spare
 * (the boards' embeds draw the grid alone).
 */
const EMBED_PANE =
  '[&_[data-slot=map-dock]]:bottom-(--space-2_5) [&_[data-slot=map-graticule-label]]:hidden';
/** View only: no zoom pair, and the canvas takes no pointer. */
const VIEW_ONLY = '[&_[data-map-zoom]]:hidden [&_[data-slot=body-map-canvas]]:pointer-events-none';

/**
 * The scene drawn with every layer the builder switched on and no key along the foot; and, when it
 * holds a pass, the one switch an embed has — Aerial, on until the operator turns it off.
 */
function useEmbedDrawn(scene: BodyMapScene) {
  const hasAerial = scene.items.some((i) => i.kind === 'raster');
  const [aerialOn, setAerialOn] = useState(true);
  const drawn: DrawnScene = useMemo(() => {
    const d = drawScene(scene, layerSwitches({ ...scene.layers, aerial: hasAerial && aerialOn }));
    return { ...d, keyKinds: [] };
  }, [scene, hasAerial, aerialOn]);
  // The rack's own row for the one layer an embed switches, in the foot's left corner — the legend
  // keeps the top left, as the boards draw it, and the zoom pair the bottom right.
  const foot = hasAerial ? (
    <div className="pointer-events-none flex px-(--space-2_5) pb-(--space-2_5)">
      <SwitchRow
        data-layer={'aerial' satisfies BodyMapLayer}
        className="pointer-events-auto w-max"
        label={LAYER_LABELS.aerial}
        checked={aerialOn}
        onCheckedChange={setAerialOn}
      />
    </div>
  ) : undefined;
  return { drawn, foot };
}

/** A legend row's swatch, from the very style table the map paints from. */
export function legendItem(row: InboxLegendRow): MapLegendItem {
  const spec =
    row.stroke.kind === 'outline'
      ? OUTLINE_STYLES[row.stroke.style]
      : LINE_STYLES[row.stroke.style];
  return {
    label: row.label,
    ink: tokenVar(spec.line),
    width: spec.width,
    dash: spec.dash ? spec.dash.map((d) => d * spec.width) : null,
  };
}

/**
 * What sits in the corner: the legend plate, then the caption under it; nothing with neither. The
 * legend is chrome on its own plate, in the page's theme; the caption is words on the map, so over
 * the summer aerial it takes the map's inks (`mapInks`) — the page's light-theme ink would be dark
 * on the photograph's dark ground.
 */
function embedPlate(view: InboxMapView, overAerial: boolean): ReactNode {
  if (view.legend.length === 0 && view.caption === null) return null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-(--space-2)">
      {view.legend.length > 0 && <MapLegend items={view.legend.map(legendItem)} />}
      {view.caption !== null && (
        <span
          data-slot="inbox-map-caption"
          style={mapInkStyle(overAerial)}
          className="block max-w-full truncate text-kick leading-none font-medium tracking-kick text-fg2 uppercase"
        >
          {view.caption}
        </span>
      )}
    </div>
  );
}

type Common = {
  view: InboxMapView;
  /** The embed's height, px: the board's. */
  height?: number;
  /** A phone's page: no zoom pair, no pointer on the map. */
  viewOnly?: boolean;
  /** The summer aerial under the outlines. */
  aerial?: boolean;
  /** The camera's ceiling, if closer than the console's. */
  maxZoom?: number;
  className?: string;
};

function Frame({
  height,
  viewOnly,
  className,
  children,
}: {
  height: number;
  viewOnly: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="inbox-map"
      data-view-only={viewOnly ? '' : undefined}
      className={cn('relative w-full min-w-0 overflow-hidden', className)}
      style={{ height }}
    >
      {children}
    </div>
  );
}

export function InboxMap({
  view,
  mode,
  height = EMBED_HEIGHT,
  viewOnly = false,
  aerial = false,
  maxZoom = MAX_ZOOM,
  className,
}: Common & { mode: BodyMapMode }) {
  const { drawn, foot } = useEmbedDrawn(view.scene);
  const canvas = useBodyMapCanvas({
    bbox: view.frame,
    mode,
    drawn,
    padding: EMBED_PADDING,
    reach: view.reach,
    aerial,
    maxZoom,
  });
  return (
    <Frame height={height} viewOnly={viewOnly} className={className}>
      <BodyMapPane
        className={cn(EMBED_PANE, viewOnly && VIEW_ONLY)}
        surface={canvas.surface}
        ground={canvas.ground}
        drawn={drawn}
        rack={false}
        foot={foot}
        plate={embedPlate(view, aerial)}
        overAerial={aerial}
        credit={canvas.aerialCredit}
        aerialLoad={canvas.aerialLoad}
        onZoomIn={canvas.zoomIn}
        onZoomOut={canvas.zoomOut}
        atMinZoom={canvas.atMinZoom}
        atMaxZoom={canvas.atMaxZoom}
      />
    </Frame>
  );
}

/** The framing for a still, capped where the live map caps it, and the floor it may zoom out to. */
function stillCamera(view: InboxMapView, width: number, height: number, maxZoom: number) {
  const camera = fitCamera(view.frame, width, height, EMBED_PADDING);
  const reachZoom =
    view.reach === null ? null : fitCamera(view.reach, width, height, EMBED_PADDING).zoom;
  return {
    ...camera,
    zoom: Math.min(maxZoom, camera.zoom),
    floor: floorZoom(camera.zoom, reachZoom),
  };
}

/** The same embed over a still, at a fixed width: what a story and a test render. */
export function InboxMapStill({
  view,
  width,
  height = EMBED_HEIGHT,
  viewOnly = false,
  aerial = false,
  maxZoom = MAX_ZOOM,
  aerialCapturedAt = null,
  aerialLoad,
  hoverId,
  className,
}: Common & {
  width: number;
  hoverId?: string | null;
  /** When the story's photograph was flown, for its credit. */
  aerialCapturedAt?: number | null;
  /** Where the story's photograph stands: in, unless said. */
  aerialLoad?: AerialLoad;
}) {
  const { drawn, foot } = useEmbedDrawn(view.scene);
  const load = useStillAerialLoad(aerialLoad);
  const [zoomStep, setZoomStep] = useState(0);
  const framed = useMemo(
    () => stillCamera(view, width, height, maxZoom),
    [view, width, height, maxZoom],
  );
  const surface = useMemo(
    () => stillSurface(width, height, { center: framed.center, zoom: framed.zoom + zoomStep }),
    [framed, width, height, zoomStep],
  );
  return (
    <Frame height={height} viewOnly={viewOnly} className={className}>
      <BodyMapPane
        className={cn(EMBED_PANE, viewOnly && VIEW_ONLY)}
        surface={surface}
        ground={<BodyMapStill surface={surface} drawn={drawn} aerial={aerial} />}
        drawn={drawn}
        rack={false}
        foot={foot}
        plate={embedPlate(view, aerial)}
        overAerial={aerial}
        credit={aerial ? aerialCredit(aerialCapturedAt) : null}
        aerialLoad={load}
        onZoomIn={() => setZoomStep((z) => z + 1)}
        onZoomOut={() => setZoomStep((z) => z - 1)}
        // The live map's floor and ceiling: a step and a half out from the framing (or far enough
        // to see a wider reach whole), the street in.
        atMinZoom={framed.zoom + zoomStep - 1 < framed.floor}
        atMaxZoom={framed.zoom + zoomStep + 1 > maxZoom}
        hoverId={hoverId ?? null}
      />
    </Frame>
  );
}
