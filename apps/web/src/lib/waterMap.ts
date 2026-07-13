/**
 * Pure helpers for the read-only water-body map (Phase 1, D5/D6/D48). Kept out of the
 * imperative MapLibre component (`../components/WaterMap`) so the data transforms and the
 * basemap style are unit-testable without a DOM/WebGL context.
 *
 * The map confirms that the imported OSM polygons render; interactivity + tap-to-detail is
 * Phase 2. Basemap is Protomaps (D6) over hosted demo `.pmtiles` first, swapped to a
 * self-built Vermont extract later — the tile URL is injected so that swap is a config change.
 */

import { layers, namedFlavor } from '@protomaps/basemaps'
import type { BBox } from '@skating/core'
import type { StyleSpecification } from 'maplibre-gl'

/**
 * ODbL attribution for both the Protomaps basemap and our OSM-derived water data — a launch
 * gate (`04-integrations.md`), shown by the always-on `AttributionControl`. Treated like
 * "Powered by Strava": non-negotiable wherever the data appears.
 */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'

/**
 * Protomaps' hosted demo `.pmtiles` (whole-planet, for prototyping) + its static font/sprite
 * assets. Phase 1 renders against these to confirm the data; PR#5 swaps `DEMO_PMTILES_URL` for
 * a self-built Vermont extract (set `VITE_PMTILES_URL`). The asset URLs stay hosted.
 */
export const DEMO_PMTILES_URL = 'https://demo-bucket.protomaps.com/v4.pmtiles'
const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf'
const SPRITE_URL = 'https://protomaps.github.io/basemaps-assets/sprites/v4/light'

/** Initial framing — Vermont's Champlain shoreline (Burlington), the pilot's headline water. */
export const INITIAL_CENTER: [number, number] = [-73.15, 44.46]
export const INITIAL_ZOOM = 8.5
/** Bounds MapLibre won't let the user pan out of — roughly Vermont + a margin (the only data). */
export const VERMONT_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-74.5, 42.0],
  [-70.5, 45.9],
]

/**
 * A read-only MapLibre style: the Protomaps vector basemap (`pmtiles://` protocol, registered
 * in the component) under our water layers. `attribution` on the source is what the
 * `AttributionControl` surfaces. Layer theming comes from `@protomaps/basemaps` `layers()`.
 */
export function buildMapStyle(pmtilesUrl: string): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: SPRITE_URL,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: OSM_ATTRIBUTION,
      },
    },
    // `layers()` targets the source name ('protomaps') with the named flavor; cast bridges the
    // style-spec LayerSpecification from @protomaps/basemaps to maplibre-gl's identical type.
    layers: layers('protomaps', namedFlavor('light'), {
      lang: 'en',
    }) as StyleSpecification['layers'],
  }
}

/**
 * The minimal water-body shape the map consumes from `waterBodies.listInViewport`. `polygon` is
 * the stored GeoJSON geometry — typed as the full `Geometry` union (what the schema's `geoJson`
 * validator allows); water bodies are Polygon/MultiPolygon in practice and MapLibre renders any.
 */
export interface MappableBody {
  _id: string
  name: string
  type: string
  polygon: GeoJSON.Geometry
}

/**
 * Water bodies → a GeoJSON `FeatureCollection` for the map's `water` source. `_id`/name/type
 * ride along as feature properties (not the GeoJSON `id`, which must be numeric for feature
 * state and isn't needed for the non-interactive Phase-1 layer).
 */
export function waterBodiesToFeatureCollection(
  bodies: readonly MappableBody[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: bodies.map((body) => ({
      type: 'Feature',
      geometry: body.polygon,
      properties: { id: body._id, name: body.name, type: body.type },
    })),
  }
}

/** MapLibre `LngLatBounds` (structural) → our `{ minLat, … }` bbox, the `listInViewport` arg. */
export function boundsToViewport(bounds: {
  getWest(): number
  getSouth(): number
  getEast(): number
  getNorth(): number
}): BBox {
  return {
    minLng: bounds.getWest(),
    minLat: bounds.getSouth(),
    maxLng: bounds.getEast(),
    maxLat: bounds.getNorth(),
  }
}
