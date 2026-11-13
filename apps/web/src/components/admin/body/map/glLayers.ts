import type { LayerSpecification } from 'maplibre-gl';
import { type BodyMapPalette, FIELD_DOT_RADIUS } from './bodyMapPalette';
import { LINE_ORDER, OUTLINE_ORDER } from './bodyScene';

/**
 * The console map's own MapLibre layers, from the palette — pure, so the order and the paint are
 * tested without a canvas. Two GeoJSON sources (the scene's outlines and its lines, `drawScene`'s
 * collections) and one layer per style, because a dash can't follow a feature's property:
 *
 * fills (the body's water, footprints) → the hazards' dot fields → outline lines in
 * `OUTLINE_ORDER` (bays under the shore) → lines in `LINE_ORDER` → the lit item's line, last, over
 * everything. A dot's opacity is its own (`hazardField.ts`: dimmed by freshness, never zero).
 */

export const OUTLINE_SOURCE = 'body-console-outlines';
export const LINE_SOURCE = 'body-console-lines';
export const DOT_SOURCE = 'body-console-dots';

/** Every layer id this module adds, in order — what a re-paint walks. */
export function glLayerIds(): string[] {
  return glLayers(null).map((l) => l.id);
}

const styleIs = (style: string) => ['==', ['get', 'style'], style];

/** The layers, painted from `palette` (or unpainted, for their ids alone). */
export function glLayers(palette: BodyMapPalette | null): LayerSpecification[] {
  const layers: LayerSpecification[] = [];
  for (const style of OUTLINE_ORDER) {
    const p = palette?.outline[style];
    if (style === 'body' || style === 'footprint') {
      layers.push({
        id: `body-console-fill-${style}`,
        type: 'fill',
        source: OUTLINE_SOURCE,
        filter: styleIs(style) as never,
        paint: p?.fill != null ? { 'fill-color': p.fill } : {},
      });
    }
  }
  layers.push({
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
  });
  for (const style of OUTLINE_ORDER) {
    const p = palette?.outline[style];
    layers.push({
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
    });
  }
  for (const style of LINE_ORDER) {
    const p = palette?.line[style];
    layers.push({
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
    });
  }
  const lit = palette?.lit;
  const litFilter = ['==', ['get', 'lit'], true] as never;
  layers.push({
    id: 'body-console-lit-fill',
    type: 'fill',
    source: OUTLINE_SOURCE,
    filter: litFilter,
    paint: lit?.fill != null ? { 'fill-color': lit.fill } : {},
  });
  layers.push({
    id: 'body-console-lit-outline',
    type: 'line',
    source: OUTLINE_SOURCE,
    filter: litFilter,
    paint: lit ? { 'line-color': lit.line, 'line-width': lit.width } : {},
  });
  layers.push({
    id: 'body-console-lit-line',
    type: 'line',
    source: LINE_SOURCE,
    filter: litFilter,
    paint: lit ? { 'line-color': lit.line, 'line-width': lit.width } : {},
  });
  return layers;
}
