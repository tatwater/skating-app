import type { LayerSpecification } from 'maplibre-gl';
import { type BodyMapPalette, FIELD_DOT_RADIUS } from './bodyMapPalette';
import { LINE_ORDER, OUTLINE_ORDER } from './bodyScene';

/**
 * The console map's own MapLibre layers, from the palette — pure, so the order and the paint are
 * tested without a canvas. Two GeoJSON sources (the scene's outlines and its lines, `drawScene`'s
 * collections) and one layer per style, because a dash can't follow a feature's property:
 *
 * the order is {@link MAP_BANDS}'s. A dot's opacity is its own (`hazardField.ts`: dimmed by
 * freshness, never zero).
 */

export const OUTLINE_SOURCE = 'body-console-outlines';
export const LINE_SOURCE = 'body-console-lines';
export const DOT_SOURCE = 'body-console-dots';

/**
 * **The console map's layer order, bottom to top — the one contract** between the frame (which adds
 * the layers) and every tab's scene (which only says what to draw). Each band's layers are added in
 * this order and nowhere else, so no call picks its own "before" id:
 *
 * 1. `basemap` — the style's own layers (water, roads, its labels): under everything of the console's.
 * 2. `fills` — the body's water and the footprints (the opaque raise the shoreline sits on).
 * 3. `raster` — an imagery pass (Imagery's lit pass, by the skater app's reveal), **above the body's
 *    fill and under every line**, as the Imagery board draws it: the photograph inside the shore,
 *    the shore drawn over it. Anchored before the first layer of the next band (`rasterAnchor`).
 * 4. `fields` — the hazards' dot fields, over a pass and the fills.
 * 5. `outlines` — outline lines in `OUTLINE_ORDER` (bays, the dimmed neighbors, footprints, the
 *    shore last).
 * 6. `lines` — lines in `LINE_ORDER` (town lines, dividers, mouths, approaches).
 * 7. `lit` — the lit item's fill and lines, over every other line.
 * 8. `marks` — not GL layers: the points, labels, dimensions and measures are drawn in the DOM over
 *    the canvas, so over every band.
 */
export const MAP_BANDS = [
  'basemap',
  'fills',
  'raster',
  'fields',
  'outlines',
  'lines',
  'lit',
  'marks',
] as const;
export type MapBand = (typeof MAP_BANDS)[number];

/** Every layer id this module adds, in order — what a re-paint walks. */
export function glLayerIds(): string[] {
  return glLayers(null).map((l) => l.id);
}

const styleIs = (style: string) => ['==', ['get', 'style'], style];

/** The GL layers of one band, painted from `palette` (or unpainted, for their ids alone). */
function bandLayers(band: MapBand, palette: BodyMapPalette | null): LayerSpecification[] {
  switch (band) {
    case 'fills':
      return OUTLINE_ORDER.filter((style) => style === 'body' || style === 'footprint').map(
        (style): LayerSpecification => {
          const p = palette?.outline[style];
          return {
            id: `body-console-fill-${style}`,
            type: 'fill',
            source: OUTLINE_SOURCE,
            filter: styleIs(style) as never,
            paint: p?.fill != null ? { 'fill-color': p.fill } : {},
          };
        },
      );
    case 'fields':
      return [
        {
          id: 'body-console-field-dots',
          type: 'circle',
          source: DOT_SOURCE,
          paint: palette
            ? {
                'circle-radius': FIELD_DOT_RADIUS,
                'circle-color': [
                  'match',
                  ['get', 'tone'],
                  'healing',
                  palette.field.healing,
                  palette.field.hazard,
                ] as never,
                'circle-opacity': ['get', 'opacity'] as never,
              }
            : {},
        },
      ];
    case 'outlines':
      return OUTLINE_ORDER.map((style): LayerSpecification => {
        const p = palette?.outline[style];
        return {
          id: `body-console-outline-${style}`,
          type: 'line',
          source: OUTLINE_SOURCE,
          filter: styleIs(style) as never,
          layout: { 'line-join': 'round' },
          paint: p
            ? {
                'line-color': p.line,
                'line-width': p.width,
                ...(p.dash ? { 'line-dasharray': [...p.dash] } : {}),
              }
            : {},
        };
      });
    case 'lines':
      return LINE_ORDER.map((style): LayerSpecification => {
        const p = palette?.line[style];
        return {
          id: `body-console-line-${style}`,
          type: 'line',
          source: LINE_SOURCE,
          filter: styleIs(style) as never,
          layout: { 'line-join': 'round' },
          paint: p
            ? {
                'line-color': p.line,
                'line-width': p.width,
                ...(p.dash ? { 'line-dasharray': [...p.dash] } : {}),
              }
            : {},
        };
      });
    case 'lit': {
      const lit = palette?.lit;
      const litFilter = ['==', ['get', 'lit'], true] as never;
      return [
        {
          id: 'body-console-lit-fill',
          type: 'fill',
          source: OUTLINE_SOURCE,
          filter: litFilter,
          paint: lit?.fill != null ? { 'fill-color': lit.fill } : {},
        },
        {
          id: 'body-console-lit-outline',
          type: 'line',
          source: OUTLINE_SOURCE,
          filter: litFilter,
          paint: lit ? { 'line-color': lit.line, 'line-width': lit.width } : {},
        },
        {
          id: 'body-console-lit-line',
          type: 'line',
          source: LINE_SOURCE,
          filter: litFilter,
          paint: lit ? { 'line-color': lit.line, 'line-width': lit.width } : {},
        },
      ];
    }
    // The style's own layers, a pass (added by the reveal), and the DOM's marks: no GL layer here.
    default:
      return [];
  }
}

/** The layers, every band in `MAP_BANDS` order, painted from `palette` (or unpainted). */
export function glLayers(palette: BodyMapPalette | null): LayerSpecification[] {
  return MAP_BANDS.flatMap((band) => bandLayers(band, palette));
}

/** The band a console layer belongs to; `null` for a layer that isn't the console's. */
export function bandOf(layerId: string): MapBand | null {
  for (const band of MAP_BANDS) {
    if (bandLayers(band, null).some((l) => l.id === layerId)) return band;
  }
  return null;
}

/**
 * Where an imagery pass is added: before the first console layer above the `raster` band that the
 * map holds — over the fills, under the fields and every line. `undefined` before the console's
 * layers are in (the reveal then falls back to its own anchor, under the basemap's roads).
 */
export function rasterAnchor(layerIds: readonly string[]): string | undefined {
  const above = MAP_BANDS.slice(MAP_BANDS.indexOf('raster') + 1).flatMap((band) =>
    bandLayers(band, null).map((l) => l.id),
  );
  return above.find((id) => layerIds.includes(id));
}
