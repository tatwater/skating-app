import { fieldDots, fieldOpacity } from './hazardField';
import {
  BODY_MAP_LAYERS,
  type BodyMapLayer,
  type BodyMapScene,
  type MapItem,
  type MapLabel,
  type MapLine,
  type MapLineStyle,
  type MapOutline,
  type MapOutlineStyle,
  type MapPoint,
  type MapPointMark,
  type MapRaster,
} from './mapDescriptors';

/**
 * From scenes to what the map draws — pure, so the rules are tested without a map:
 *
 * - **Two scenes, one map.** The frame's own (the outline, the bays, the marks, the access points,
 *   the sample points) and the open tab's are merged; a tab's item with the same id as the frame's
 *   replaces it, so a tab can redraw a thing it owns without drawing it twice.
 * - **The rack decides what shows.** An item is drawn only while its layer is on; a layer no item
 *   belongs to is *disabled* — kept in the rack, faded, inert.
 * - **One lit item**, from the URL (`?lit=`), drawn bright whatever its layer's style.
 * - **A hazard's footprint is its dot field** (`field`), never a plate: dots in its tone, dimmed by
 *   freshness and never removed (`hazardField.ts`). A dimension line and its ticks are drawn over
 *   the map in screen pixels, so its ticks keep their length at every zoom. A raster (an imagery
 *   pass) goes under everything the console draws.
 */

export type LayerSwitches = Readonly<Record<BodyMapLayer, boolean>>;

/** The rack as an admin first finds it (5.4.1): the outline, the bays, the marks, the put-ins. */
export const DEFAULT_LAYERS: LayerSwitches = {
  outline: true,
  bays: true,
  marks: true,
  putIns: true,
  samples: false,
  hazards: false,
  features: false,
  tracks: false,
  aerial: false,
  bathy: false,
};

/** The frame's scene with the tab's laid over it: same id, the tab's wins; the tab's lit item wins. */
export function mergeScenes(base: BodyMapScene, tab: BodyMapScene | null): BodyMapScene {
  if (tab === null) return base;
  const ids = new Set(tab.items.map((i) => i.id));
  return {
    items: [...base.items.filter((i) => !ids.has(i.id)), ...tab.items],
    lit: tab.lit ?? base.lit ?? null,
    layers: { ...base.layers, ...tab.layers },
  };
}

/** The rack's switches for a tab: the defaults, the tab's own, then the operator's. */
export function layerSwitches(
  tabLayers: BodyMapScene['layers'],
  operator: Partial<Record<BodyMapLayer, boolean>> = {},
): LayerSwitches {
  return { ...DEFAULT_LAYERS, ...tabLayers, ...operator };
}

/** The layers something in the scene belongs to — every other layer is drawn disabled. */
export function layersInUse(items: readonly MapItem[]): ReadonlySet<BodyMapLayer> {
  return new Set(items.map((i) => i.layer));
}

/** One feature per outline or line, carrying its id and whether it is lit. */
type Props = { id: string; style: string; lit: boolean };

/** One dot of a hazard's field: its footprint's id, its tone and how strongly it draws. */
export type DotProps = { id: string; tone: 'hazard' | 'healing'; opacity: number; lit: boolean };

/** The outline style a field footprint is drawn under: no fill, no line — only its dots (and lit). */
export const FIELD_STYLE = 'field';

export interface DrawnScene {
  /** Outlines and lines for the map's own layers (MapLibre, or the still). */
  outlines: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, Props>;
  lines: GeoJSON.FeatureCollection<GeoJSON.LineString, Props>;
  /** The hazards' dot fields, every footprint's dots in one collection. */
  dots: GeoJSON.FeatureCollection<GeoJSON.Point, DotProps>;
  /** Dimension lines, drawn over the map in pixels with a tick across each end. */
  dimensions: readonly MapLine[];
  /** The imagery pass under everything, if the Aerial layer is on and a tab handed one. */
  raster: MapRaster | null;
  /** Marks and labels over the map, in the order they draw (later on top). */
  points: readonly MapPoint[];
  labels: readonly MapLabel[];
  /** The lit item's id, if it is in the scene and its layer is on. */
  lit: string | null;
  /** The kinds the key lists: every mark in view, once, in the order first seen. */
  keyKinds: readonly MapPointMark[];
}

/** Draw order for outlines: fills under lines, bays under the shore, so the shore wins. */
export const OUTLINE_ORDER: readonly MapOutlineStyle[] = ['bay', 'neighbor', 'footprint', 'body'];
export const LINE_ORDER: readonly MapLineStyle[] = [
  'townLine',
  'divider',
  'mouth',
  'approach',
  'track',
  'leader',
];

/** Lit points draw last, so nothing covers the one the operator asked for. */
function byLitLast<T extends { id: string }>(items: readonly T[], lit: string | null): T[] {
  return [...items].sort((a, b) => Number(a.id === lit) - Number(b.id === lit));
}

export function drawScene(scene: BodyMapScene, layers: LayerSwitches): DrawnScene {
  const shown = scene.items.filter((i) => layers[i.layer]);
  const lit =
    scene.lit != null && shown.some((i) => i.id === scene.lit) ? (scene.lit as string) : null;

  const outlines = shown.filter((i): i is MapOutline => i.kind === 'outline');
  const allLines = shown.filter((i): i is MapLine => i.kind === 'line' && i.path.length >= 2);
  const lines = allLines.filter((l) => l.style !== 'dimension');
  const dimensions = allLines.filter((l) => l.style === 'dimension');
  const raster = shown.find((i): i is MapRaster => i.kind === 'raster') ?? null;
  const points = shown.filter((i): i is MapPoint => i.kind === 'point');
  const labels = shown.filter((i): i is MapLabel => i.kind === 'label');

  const rank = (s: MapOutlineStyle) => OUTLINE_ORDER.indexOf(s);
  const keyKinds: MapPointMark[] = [];
  for (const p of points) if (!keyKinds.includes(p.mark)) keyKinds.push(p.mark);

  return {
    outlines: {
      type: 'FeatureCollection',
      features: [...outlines]
        .sort((a, b) => rank(a.style) - rank(b.style))
        .map((o) => ({
          type: 'Feature',
          geometry: o.geometry,
          properties: {
            id: o.id,
            style: o.field !== undefined ? FIELD_STYLE : o.style,
            lit: o.id === lit,
          },
        })),
    },
    dots: {
      type: 'FeatureCollection',
      features: outlines.flatMap((o) => {
        const field = o.field;
        if (field === undefined) return [];
        const opacity = fieldOpacity(field);
        return fieldDots(o.geometry).map((at) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [at[0], at[1]] },
          properties: { id: o.id, tone: field.tone, opacity, lit: o.id === lit },
        }));
      }),
    },
    dimensions,
    raster,
    lines: {
      type: 'FeatureCollection',
      features: lines.map((l) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: l.path.map(([x, y]) => [x, y]) },
        properties: { id: l.id, style: l.style, lit: l.id === lit },
      })),
    },
    points: byLitLast(points, lit),
    labels,
    lit,
    keyKinds,
  };
}

/** Every layer in the rack's order with whether it is on and whether anything belongs to it. */
export function rackRows(
  items: readonly MapItem[],
  layers: LayerSwitches,
): { layer: BodyMapLayer; on: boolean; available: boolean }[] {
  const inUse = layersInUse(items);
  return BODY_MAP_LAYERS.map((layer) => ({
    layer,
    on: layers[layer] && inUse.has(layer),
    available: inUse.has(layer),
  }));
}
