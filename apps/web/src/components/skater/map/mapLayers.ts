/**
 * The skater map's GL sources and layers, re-skinned per the boards (rows 1–3).
 *
 * **Same ids as the old `MapView`.** The imagery reveal (`useImageryReveal`, agent J's to wire) and
 * the contour helpers in `@skating/core` name these layers — `water-fill`, `sub-area-outline`,
 * `hazard-fill`, `track-line`, … — so keeping them is what lets that code run on this map unchanged.
 *
 * What moved off the GL canvas: lake labels, put-ins and hazard *marks* are DOM (`MapMarksLayer`,
 * `LakeLabelLayer`), because a fixed 45° leader with a mirrored lockup, and a 16 px mark with a
 * ground-colored halo in token colors, aren't things a symbol layer draws. The hazard *footprints*
 * stay here: the shape on screen is the shape the proximity math measures against.
 *
 * Kept as data (`skaterLayers`) so the style-spec validator can check every layer in a test: an
 * invalid layer doesn't throw, it just never draws.
 */

import {
  APPROACH_LAYER_ID,
  APPROACH_SOURCE_ID,
  approachLinePaint,
  withAccessDim,
} from '@skating/core';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { IMAGERY_LOADING_LAYER_ID } from '@/components/useImageryReveal';
import {
  CONTOUR_FADE_MS,
  CONTOUR_LAYER_ID,
  CONTOUR_MIN_ZOOM,
  CONTOUR_SOURCE_ID,
  CONTOUR_SOURCE_LAYER,
  contourFilter,
  contourSourceSpec,
} from '@/lib/contourMap';
import {
  CONFIRMED_HAZARD_FILTER,
  hazardColorExpression,
  hazardFillOpacityExpression,
  PROVISIONAL_DASH_ARRAY,
  PROVISIONAL_HAZARD_FILTER,
} from '@/lib/hazardMap';
import { LANDMARK_SOURCE_ID, OSM_ATTRIBUTION } from '@/lib/waterMap';
import { contourColorByBand, contourWidthByBand, type MapPalette } from './mapPalette';
import type { MapOverlayName, SpecLayer } from './mapSpec';

export const EMPTY_FEATURES: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/** Every GeoJSON source the map feeds, by what it holds. */
export const SOURCES = {
  water: 'water',
  subAreas: 'sub-areas',
  landmarks: LANDMARK_SOURCE_ID,
  approach: APPROACH_SOURCE_ID,
  hazards: 'hazards',
  bodyFeatures: 'body-features',
  tracks: 'tracks',
  track: 'overlay-track',
  photos: 'photo-pins',
  draft: 'hazard-draft',
  samples: 'weather-samples',
} as const;

/** A view's overlays, by the source each one feeds. */
export const OVERLAY_SOURCES: Record<MapOverlayName, string> = {
  track: SOURCES.track,
  photos: SOURCES.photos,
  draft: SOURCES.draft,
  samples: SOURCES.samples,
};

export const WATER_FILL_LAYER = 'water-fill';
export const WATER_HOVER_LAYER = 'water-hover';
export const WATER_SELECTED_LAYER = 'water-selected';
export const SUB_AREA_SCRIM_LAYER = 'sub-area-scrim';
export const SUB_AREA_SELECTED_LAYER = 'sub-area-selected';
export const HAZARD_FILL_LAYER = 'hazard-fill';
export const PHOTO_PIN_COUNT_LAYER = 'photo-pin-count';
export const WALK_LABEL_LAYER = 'approach-label';
export const SAMPLE_RING_LAYER = 'weather-sample-ring';

/**
 * The GL layers behind each spec layer. Labels and favorites are DOM only, and the put-in marks are
 * DOM with the walk in from the car here. Hazards have no entry because nothing hides them.
 */
export const LAYER_GROUPS: Record<SpecLayer, readonly string[]> = {
  depth: [CONTOUR_LAYER_ID],
  places: ['sub-area-outline', 'sub-area-label', 'landmark-label'],
  putIns: [APPROACH_LAYER_ID, WALK_LABEL_LAYER],
  tracks: ['track-line'],
  labels: [],
  favorites: [],
};

/** A filter that matches no feature: a highlight layer's resting state. */
export const MATCH_NONE: unknown[] = ['==', ['get', '_id'], ''];

/** Matches the one body (or, for a bay, the one sub-area) with this id. */
export function matchId(id: string | null | undefined, property = '_id'): unknown[] {
  return id ? ['==', ['get', property], id] : MATCH_NONE;
}

/**
 * The water's fill: the app's one color, gray when inactive, and the shallowest band's fill under
 * the focused lake while its contours are drawn — so the rings read as depth, not as lines on ice.
 */
export function waterFillColor(palette: MapPalette, depthGroundBodyId: string | null): unknown[] {
  return [
    'case',
    ['==', ['get', 'inactive'], true],
    palette.inactive.fill,
    ['==', ['get', '_id'], depthGroundBodyId ?? ''],
    palette.depth.fills[0],
    palette.water.fill,
  ];
}

export function waterFillOpacity(palette: MapPalette, depthGroundBodyId: string | null): unknown[] {
  return withAccessDim([
    'case',
    ['==', ['get', 'inactive'], true],
    0.18,
    ['==', ['get', '_id'], depthGroundBodyId ?? ''],
    1,
    palette.water.fillOpacity,
  ]);
}

/** The sources the map is created with. The contour archive only when the deployment has one. */
export function skaterSources(contourArchiveUrl: string): Record<string, SourceSpecification> {
  const geojson = (attribution?: string): SourceSpecification => ({
    type: 'geojson',
    data: EMPTY_FEATURES,
    ...(attribution ? { attribution } : {}),
  });
  return {
    [SOURCES.water]: geojson(OSM_ATTRIBUTION),
    ...(contourArchiveUrl ? { [CONTOUR_SOURCE_ID]: contourSourceSpec(contourArchiveUrl) } : {}),
    [SOURCES.subAreas]: geojson(),
    [SOURCES.landmarks]: geojson(),
    [SOURCES.approach]: geojson(),
    [SOURCES.tracks]: geojson(),
    [SOURCES.bodyFeatures]: geojson(),
    [SOURCES.hazards]: geojson(),
    [SOURCES.track]: geojson(),
    [SOURCES.photos]: geojson(),
    [SOURCES.draft]: geojson(),
    [SOURCES.samples]: geojson(),
  };
}

/**
 * The layers, bottom to top. The order is the safety argument as much as the look: depth is
 * decoration under everything (D82), then the lake's names, the walk, the tracks, and the hazard
 * footprints over all of them, with the hazard being drawn last.
 */
export function skaterLayers(palette: MapPalette, withContours: boolean): LayerSpecification[] {
  const hazardColor = hazardColorExpression(palette.hazard) as never;
  const layers: LayerSpecification[] = [
    {
      id: WATER_FILL_LAYER,
      type: 'fill',
      source: SOURCES.water,
      paint: {
        'fill-color': waterFillColor(palette, null) as never,
        'fill-opacity': waterFillOpacity(palette, null) as never,
      },
    },
    // The imagery reveal's loading wash (A06e): its own layer, animated alone.
    {
      id: IMAGERY_LOADING_LAYER_ID,
      type: 'fill',
      source: SOURCES.water,
      filter: MATCH_NONE as never,
      paint: { 'fill-color': palette.water.outline, 'fill-opacity': 0 },
    },
  ];
  if (withContours) {
    layers.push({
      id: CONTOUR_LAYER_ID,
      type: 'line',
      source: CONTOUR_SOURCE_ID,
      'source-layer': CONTOUR_SOURCE_LAYER,
      minzoom: CONTOUR_MIN_ZOOM,
      filter: contourFilter(null) as never,
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: {
        'line-color': contourColorByBand(palette.depth) as never,
        'line-width': contourWidthByBand() as never,
        'line-opacity': 0,
        'line-opacity-transition': { duration: CONTOUR_FADE_MS, delay: 0 },
      },
    });
  }
  layers.push(
    {
      id: 'water-outline',
      type: 'line',
      source: SOURCES.water,
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'inactive'], true],
          palette.inactive.outline,
          palette.water.outline,
        ] as never,
        'line-opacity': withAccessDim(1) as never,
        'line-width': 1,
      },
    },
    {
      id: WATER_HOVER_LAYER,
      type: 'line',
      source: SOURCES.water,
      filter: MATCH_NONE as never,
      paint: { 'line-color': palette.hovered, 'line-width': 1.4 },
    },
    {
      id: WATER_SELECTED_LAYER,
      type: 'line',
      source: SOURCES.water,
      filter: MATCH_NONE as never,
      paint: { 'line-color': palette.selected, 'line-width': 1.6 },
    },
    // A framed bay (board 1.10): the rest of its lake recedes under the scrim, the bay's own edge is
    // drawn solid. The bays partition their lake, so "every other bay of this lake" is "the rest".
    {
      id: SUB_AREA_SCRIM_LAYER,
      type: 'fill',
      source: SOURCES.subAreas,
      filter: MATCH_NONE as never,
      paint: { 'fill-color': palette.scrim, 'fill-opacity': 0.75 },
    },
    {
      id: 'sub-area-outline',
      type: 'line',
      source: SOURCES.subAreas,
      filter: ['!=', ['get', 'label'], true],
      paint: {
        'line-color': palette.places.outline,
        'line-width': 1,
        'line-opacity': 0.7,
        'line-dasharray': [4, 3],
      },
    },
    {
      id: SUB_AREA_SELECTED_LAYER,
      type: 'line',
      source: SOURCES.subAreas,
      filter: MATCH_NONE as never,
      paint: { 'line-color': palette.selected, 'line-width': 2 },
    },
    // Landmarks under the bay names, so a bay wins a crowded spot (D202).
    {
      id: 'landmark-label',
      type: 'symbol',
      source: SOURCES.landmarks,
      filter: ['<=', ['get', 'minZoom'], ['zoom']],
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-font': ['Noto Sans Regular'],
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'sortKey'],
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': palette.places.label,
        'text-halo-color': palette.places.halo,
        'text-halo-width': 1.4,
      },
    },
    // Bay names in caps, spaced and turned along their bay (mock `mascomaOverlay`'s bay names).
    {
      id: 'sub-area-label',
      type: 'symbol',
      source: SOURCES.subAreas,
      filter: ['==', ['get', 'label'], true],
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-font': ['Noto Sans Medium'],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.27,
        'text-rotate': ['coalesce', ['get', 'angle'], 0],
        'text-rotation-alignment': 'viewport',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': palette.places.label,
        'text-halo-color': palette.places.halo,
        'text-halo-width': 1.5,
      },
    },
    {
      id: APPROACH_LAYER_ID,
      type: 'line',
      source: SOURCES.approach,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: approachLinePaint(palette.hazard.healing) as never,
    },
    // The walk's length beside it, "0.3 mi on foot" (board 1.5), in the line's own color.
    {
      id: WALK_LABEL_LAYER,
      type: 'symbol',
      source: SOURCES.approach,
      filter: ['has', 'walkLabel'],
      layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'walkLabel'],
        'text-size': 12,
        'text-font': ['Noto Sans Medium'],
        'text-offset': [0, -1],
        'text-optional': true,
      },
      paint: {
        'text-color': palette.hazard.healing,
        'text-halo-color': palette.places.halo,
        'text-halo-width': 2,
      },
    },
    {
      id: 'track-line',
      type: 'line',
      source: SOURCES.tracks,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.track,
        'line-width': 2,
        // The server's D59 freshness, floored so a path never disappears into an "all clear".
        'line-opacity': ['coalesce', ['get', 'opacity'], 1] as never,
      },
    },
    {
      id: 'overlay-track',
      type: 'line',
      source: SOURCES.track,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': palette.track, 'line-width': 3 },
    },
    {
      id: 'body-feature-fill',
      type: 'fill',
      source: SOURCES.bodyFeatures,
      paint: { 'fill-color': palette.hazard.feature, 'fill-opacity': 0.22 },
    },
    {
      id: 'body-feature-outline',
      type: 'line',
      source: SOURCES.bodyFeatures,
      paint: {
        'line-color': palette.hazard.feature,
        'line-width': 1.4,
        'line-dasharray': [4, 2],
      },
    },
    // Hazard footprints: approximate by design, dashed while provisional (D54), fading with age but
    // floored — a stale hazard never reads as an all-clear (D3).
    {
      id: HAZARD_FILL_LAYER,
      type: 'fill',
      source: SOURCES.hazards,
      paint: {
        'fill-color': hazardColor,
        'fill-opacity': hazardFillOpacityExpression() as never,
      },
    },
    {
      id: 'hazard-outline-provisional',
      type: 'line',
      source: SOURCES.hazards,
      filter: PROVISIONAL_HAZARD_FILTER as never,
      paint: {
        'line-color': hazardColor,
        'line-width': 1.4,
        'line-dasharray': [...PROVISIONAL_DASH_ARRAY],
      },
    },
    {
      id: 'hazard-outline-confirmed',
      type: 'line',
      source: SOURCES.hazards,
      filter: CONFIRMED_HAZARD_FILTER as never,
      paint: { 'line-color': hazardColor, 'line-width': 1.4 },
    },
    // A report's placed photos, numbered as the card numbers them (`properties.n`): the pin wide
    // enough to carry its digit, the digit in the ground color over the track's.
    {
      id: 'photo-pins',
      type: 'circle',
      source: SOURCES.photos,
      paint: {
        'circle-radius': 8,
        'circle-color': palette.track,
        'circle-stroke-color': palette.ground,
        'circle-stroke-width': 2,
      },
    },
    {
      id: PHOTO_PIN_COUNT_LAYER,
      type: 'symbol',
      source: SOURCES.photos,
      filter: ['has', 'n'],
      layout: {
        'text-field': ['to-string', ['get', 'n']],
        'text-size': 10,
        'text-font': ['Noto Sans Medium'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': palette.ground },
    },
    // The Weather tab's sample points (board 1.7): a ring on a ground halo, the one being read lit
    // with a center dot, each named in the bay-name register.
    {
      id: 'weather-sample-halo',
      type: 'circle',
      source: SOURCES.samples,
      paint: { 'circle-radius': 7, 'circle-color': palette.ground },
    },
    {
      id: SAMPLE_RING_LAYER,
      type: 'circle',
      source: SOURCES.samples,
      paint: {
        'circle-radius': 5,
        'circle-opacity': 0,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': [
          'case',
          ['==', ['get', 'lit'], true],
          palette.selected,
          palette.places.label,
        ] as never,
      },
    },
    {
      id: 'weather-sample-dot',
      type: 'circle',
      source: SOURCES.samples,
      filter: ['==', ['get', 'lit'], true],
      paint: { 'circle-radius': 2, 'circle-color': palette.selected },
    },
    {
      id: 'weather-sample-label',
      type: 'symbol',
      source: SOURCES.samples,
      layout: {
        'text-field': ['upcase', ['get', 'name']],
        'text-size': 10,
        'text-font': ['Noto Sans Medium'],
        'text-letter-spacing': 0.2,
        'text-anchor': 'left',
        'text-offset': [1.2, 0],
        'text-optional': true,
      },
      paint: {
        'text-color': palette.places.label,
        'text-halo-color': palette.places.halo,
        'text-halo-width': 1.5,
      },
    },
    {
      id: 'hazard-draft-fill',
      type: 'fill',
      source: SOURCES.draft,
      paint: { 'fill-color': hazardColor, 'fill-opacity': 0.3 },
    },
    {
      id: 'hazard-draft-outline',
      type: 'line',
      source: SOURCES.draft,
      paint: { 'line-color': hazardColor, 'line-width': 2 },
    },
    {
      id: 'hazard-draft-vertices',
      type: 'circle',
      source: SOURCES.draft,
      filter: ['==', ['get', 'role'], 'vertex'],
      paint: {
        'circle-radius': 5,
        'circle-color': hazardColor,
        'circle-stroke-color': palette.ground,
        'circle-stroke-width': 2,
      },
    },
  );
  return layers;
}

/** What `addSkaterLayers` needs of a map: enough to fake in a test. */
export interface LayerHost {
  addSource(id: string, spec: SourceSpecification): unknown;
  addLayer(spec: LayerSpecification): unknown;
}

/** Adds every source and layer, in order. Called once per map instance, inside `load`. */
export function addSkaterLayers(map: LayerHost, palette: MapPalette, contourArchiveUrl: string) {
  for (const [id, spec] of Object.entries(skaterSources(contourArchiveUrl))) {
    map.addSource(id, spec);
  }
  for (const layer of skaterLayers(palette, contourArchiveUrl !== '')) map.addLayer(layer);
}
