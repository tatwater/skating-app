/**
 * Pure helpers for the water-body map (Phase 1 read-only; Phase 2 §D adds tap-to-detail +
 * geolocation framing). Kept out of the imperative MapLibre component (`../components/MapView`)
 * so the data transforms, feature-state lookup, basemap style, and framing math are unit-testable
 * without a DOM/WebGL context.
 *
 * Basemap is Protomaps (D6) over hosted demo `.pmtiles` first, swapped to a self-built regional
 * extract later (Vermont in Phase 1, the Northeast in Phase 2.5) — the tile URL is injected so that
 * swap is a config change.
 */

import { layers, namedFlavor } from '@protomaps/basemaps';
import type { BBox } from '@skating/core';
import type { StyleSpecification } from 'maplibre-gl';

/**
 * ODbL attribution for both the Protomaps basemap and our OSM-derived water data — a launch
 * gate (`04-integrations.md`), shown by the always-on `AttributionControl`. Treated like
 * "Powered by Strava": non-negotiable wherever the data appears.
 */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/**
 * A Protomaps hosted **build** `.pmtiles` (whole-planet, for prototyping) + its static font/sprite
 * assets. Phase 1 renders against these to confirm the data; PR#5 swaps `DEMO_PMTILES_URL` for a
 * self-built extract (set `VITE_PMTILES_URL`) — Vermont in Phase 1, the Northeast region in Phase
 * 2.5. The asset URLs stay hosted.
 *
 * NB: Protomaps prunes dated builds, so this URL rotates and will eventually 404 (the old
 * `demo-bucket.protomaps.com/v4.pmtiles` went 404). Bump the date if it does — the live builds are
 * listed at maps.protomaps.com/builds. Production uses `VITE_PMTILES_URL`, not this default.
 */
export const DEMO_PMTILES_URL = 'https://build.protomaps.com/20251215.pmtiles';
const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const SPRITE_BASE = 'https://protomaps.github.io/basemaps-assets/sprites/v4';

/**
 * Protomaps basemap flavor per app theme (D6/D34): `white` is the crisp, snowy light basemap — the
 * "wintery-but-functional" look — and `dark` is the evening map. Mapped from `next-themes`'
 * resolved theme in `MapView`. (Other Protomaps flavors: `light`, `grayscale`, `black`.)
 */
export const MAP_FLAVORS = { light: 'white', dark: 'dark' } as const;
export type MapFlavor = (typeof MAP_FLAVORS)[keyof typeof MAP_FLAVORS];

/**
 * Icy water fill/outline per theme, layered over the basemap. Pale ice-blue on the white basemap;
 * a deeper glacial blue on the dark one. `AttributionControl` still surfaces the ODbL credit.
 */
export const WATER_PALETTE = {
  white: { fill: '#8fbfe0', outline: '#2f6690' },
  dark: { fill: '#3a6ea5', outline: '#9ecae1' },
} as const;

/**
 * The recorded-GPS-track line (Phase 8). Deliberately a warm accent, not part of the water ramp and
 * not part of the hazard danger ramp: a skated path is neither water nor a warning, and it must stay
 * legible against both the ice fill and a hazard footprint drawn over it.
 */
export const TRACK_PALETTE = {
  white: '#b4531f',
  dark: '#f0a06a',
} as const;

/** Initial framing — Burlington sits near the center of the region; the fallback when no device
 *  fix is available (device geolocation reframes on open when in-region, D12/D20). */
export const INITIAL_CENTER: [number, number] = [-73.15, 44.46];
export const INITIAL_ZOOM = 6.5;
/**
 * Bounds MapLibre won't let the user pan out of — the Phase 2.5 Northeast skating region (NY north
 * of the NYC/Long Island metro + VT/NH/ME/MA). Kept in sync with the basemap `--bbox` and the NY
 * ETL downstate clip (see `plans/phase-2.5-regional-expansion.md`). A rectangle inevitably spans
 * some CT/RI/NJ/PA background land, which simply carries no water data.
 */
export const NORTHEAST_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-79.9, 41.2],
  [-66.8, 47.5],
];

/**
 * A MapLibre style: the Protomaps vector basemap (`pmtiles://` protocol, registered in the
 * component) themed by `flavor` (D6/D34 — see `MAP_FLAVORS`), under our water layers (added
 * imperatively in the component). `attribution` on the source is what the `AttributionControl`
 * surfaces. The sprite matches the flavor's light/dark icon set.
 */
export function buildMapStyle(pmtilesUrl: string, flavor: MapFlavor = 'white'): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: `${SPRITE_BASE}/${flavor === 'dark' ? 'dark' : 'light'}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: OSM_ATTRIBUTION,
      },
    },
    // `layers()` targets the source name ('protomaps') with the named flavor; cast bridges the
    // style-spec LayerSpecification from @protomaps/basemaps to maplibre-gl's identical type.
    layers: layers('protomaps', namedFlavor(flavor), {
      lang: 'en',
    }) as StyleSpecification['layers'],
  };
}

/**
 * The minimal water-body shape the map consumes from `waterBodies.listInViewport`. `polygon` is
 * the stored GeoJSON geometry — typed as the full `Geometry` union (what the schema's `geoJson`
 * validator allows); water bodies are Polygon/MultiPolygon in practice and MapLibre renders any.
 */
export interface MappableBody {
  _id: string;
  name: string;
  type: string;
  polygon: GeoJSON.Geometry;
}

/**
 * Water bodies → a GeoJSON `FeatureCollection` for the map's `water` source. Each feature gets a
 * **numeric `id`** (its array index) — required for MapLibre feature-state, which drives the
 * tap/selection highlight (D47). The string `_id`/name/type ride along as feature properties (a
 * tap reads `_id` to navigate; `featureIdForBody` maps a selected `_id` back to the numeric id so
 * a deep-linked selection can be highlighted without a click).
 */
export function waterBodiesToFeatureCollection(
  bodies: readonly MappableBody[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: bodies.map((body, index) => ({
      type: 'Feature',
      id: index,
      geometry: body.polygon,
      properties: { _id: body._id, name: body.name, type: body.type },
    })),
  };
}

/**
 * The numeric feature `id` (see `waterBodiesToFeatureCollection`) for a given water-body `_id`,
 * or `undefined` if that body isn't in the current collection — used to apply the selection
 * feature-state for a deep-linked `/water/$id` where there was no click to read the id from.
 */
export function featureIdForBody(
  fc: GeoJSON.FeatureCollection,
  waterBodyId: string,
): number | undefined {
  const feature = fc.features.find((f) => f.properties?._id === waterBodyId);
  return typeof feature?.id === 'number' ? feature.id : undefined;
}

/**
 * The numeric feature ids of every body in the current collection that the viewer has favorited
 * (Phase 4, decision #1) — used to paint the `favorite` feature-state so favorited lakes read with a
 * distinct outline on the map. Bodies not currently in view (not in `fc`) are simply skipped.
 */
export function favoriteFeatureIds(
  fc: GeoJSON.FeatureCollection,
  favoriteIds: ReadonlySet<string>,
): number[] {
  const ids: number[] = [];
  for (const f of fc.features) {
    const bodyId = f.properties?._id;
    if (typeof f.id === 'number' && typeof bodyId === 'string' && favoriteIds.has(bodyId)) {
      ids.push(f.id);
    }
  }
  return ids;
}

/** A put-in marker as `putIns.listForBody` returns it — a routable coord + its provenance. */
export interface MappablePutIn {
  coord: { lat: number; lng: number };
  source: 'derived' | 'official';
}

/**
 * Put-in markers → a GeoJSON `FeatureCollection` for the map's `put-in-markers` source (Phase 4,
 * decision #7). Each point carries its `source` so the layer can style `official` (accurate) markers
 * distinctly from `derived` (approximate) clusters.
 */
export function putInsToFeatureCollection(
  markers: readonly MappablePutIn[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: markers.map((m) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [m.coord.lng, m.coord.lat] },
      properties: { source: m.source },
    })),
  };
}

/** MapLibre `LngLatBounds` (structural) → our `{ minLat, … }` bbox, the `listInViewport` arg. */
export function boundsToViewport(bounds: {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}): BBox {
  return {
    minLng: bounds.getWest(),
    minLat: bounds.getSouth(),
    maxLng: bounds.getEast(),
    maxLat: bounds.getNorth(),
  };
}

/**
 * The integer zoom the D49 filter keys off (`listInViewport`'s `zoom` arg). `minVisibleZoom` is a
 * whole-number bucket and the server keeps bodies with `minVisibleZoom <= zoom`, so we floor the
 * map's fractional zoom: a body surfaces the moment the map reaches its bucket, never a level late.
 */
export function zoomForViewport(mapZoom: number): number {
  return Math.floor(mapZoom);
}

/** Zoom used when framing on the device location (D12/D20) — regional, not street-level. */
export const GEOLOCATION_FRAME_ZOOM = 11;

/**
 * Initial framing for a device geolocation fix (D12/D20). Returns `{ center, zoom }` when the fix
 * falls inside the pilot region (the only data we have), else `null` so the caller keeps the
 * default regional framing — a skater in California shouldn't be dropped onto empty ocean. Pure so
 * the "in region?" decision is tested without the browser Geolocation API (that stays in the shell).
 */
export function frameForCoord(
  coord: { lat: number; lng: number },
  maxBounds: [[number, number], [number, number]] = NORTHEAST_MAX_BOUNDS,
  zoom: number = GEOLOCATION_FRAME_ZOOM,
): { center: [number, number]; zoom: number } | null {
  const [[minLng, minLat], [maxLng, maxLat]] = maxBounds;
  const inRegion =
    coord.lng >= minLng && coord.lng <= maxLng && coord.lat >= minLat && coord.lat <= maxLat;
  return inRegion ? { center: [coord.lng, coord.lat], zoom } : null;
}
