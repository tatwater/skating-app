/**
 * Pure helpers for the native water-body map (Phase 2 §F) — the mobile mirror of web's
 * `apps/web/src/lib/waterMap.ts`. Kept out of the imperative `<MapView>` component so the basemap
 * style, feature transform, viewport math, and geolocation framing are unit-testable without a
 * native map context. Reuses the same Protomaps basemap + icy palette + regional framing as web so
 * the two surfaces render the same map (the constants/flavors are intentionally identical; if they
 * ever need to change, change both).
 *
 * MapLibre Native reads Protomaps `.pmtiles` directly via the `pmtiles://` scheme (no JS protocol,
 * unlike web) — so the style object here works as-is when handed to `<Map mapStyle={…} />`.
 */

import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LngLatBounds } from '@maplibre/maplibre-react-native';
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { BBox } from '@skating/core';

/** ODbL attribution for the Protomaps basemap + our OSM-derived water data — a launch gate. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/**
 * A Protomaps hosted **build** `.pmtiles` (whole-planet) + static font/sprite assets, for dev only
 * (same as web). Protomaps prunes dated builds, so this URL rotates and will eventually 404 — the
 * real basemap is the self-built regional extract set via `EXPO_PUBLIC_PMTILES_URL` (see `env.ts`);
 * this default just gives the dev map a basemap. Bump the date if it 404s: see maps.protomaps.com/builds.
 */
export const DEMO_PMTILES_URL = 'https://build.protomaps.com/20251215.pmtiles';
const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const SPRITE_BASE = 'https://protomaps.github.io/basemaps-assets/sprites/v4';

/** Protomaps basemap flavor per app theme (D6/D34): `white` = snowy light, `dark` = evening map. */
export const MAP_FLAVORS = { light: 'white', dark: 'dark' } as const;
export type MapFlavor = (typeof MAP_FLAVORS)[keyof typeof MAP_FLAVORS];

/** Icy water fill/outline per theme, layered over the basemap (matches web). */
export const WATER_PALETTE = {
  white: { fill: '#8fbfe0', outline: '#2f6690' },
  dark: { fill: '#3a6ea5', outline: '#9ecae1' },
} as const;

/**
 * The recorded-GPS-track line (Phase 8) — mirrors web's `TRACK_PALETTE`. A warm accent, deliberately
 * outside both the water ramp and the hazard danger ramp: a skated path is neither water nor a
 * warning, and it must stay legible drawn over ice fill and under a hazard footprint.
 */
export const TRACK_PALETTE = {
  white: '#b4531f',
  dark: '#f0a06a',
} as const;

/** Access-point (put-in) + report-photo pin colors (§E/D42) — success green + amber, as on web. */
export const PUT_IN_PIN_COLOR = '#137138';
export const PHOTO_PIN_COLOR = '#f59e0b';

/** Favorited-body outline gold (Phase 4, decision #1) — matches web's amber-500 favorite signal. */
export const FAVORITE_OUTLINE_COLOR = '#eab308';
/** Put-in marker colors (Phase 4, decision #7): accurate admin `official` vs. approximate `derived`. */
export const PUT_IN_MARKER_OFFICIAL_COLOR = '#0e7490';
export const PUT_IN_MARKER_DERIVED_COLOR = '#5b8fb0';

/** Initial framing — Burlington sits near the center of the region; the fallback when no device
 *  fix is available (device geolocation reframes on open when in-region, D12/D20). */
export const INITIAL_CENTER: [number, number] = [-73.15, 44.46];
export const INITIAL_ZOOM = 6.5;
/**
 * Bounds the region's data lives in — the Phase 2.5 Northeast skating region (NY north of the
 * NYC/Long Island metro + VT/NH/ME/MA). Kept in sync with the web bounds, the basemap `--bbox`,
 * and the NY ETL downstate clip (see `plans/phase-2.5-regional-expansion.md`).
 */
export const NORTHEAST_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-79.9, 41.2],
  [-66.8, 47.5],
];

/**
 * A MapLibre style: the Protomaps vector basemap (`pmtiles://` source, read natively) themed by
 * `flavor`. Our water layers are added declaratively as `<Layer>` children in the component, so the
 * style here is basemap-only. `attribution` on the source surfaces the ODbL credit.
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
    layers: layers('protomaps', namedFlavor(flavor), {
      lang: 'en',
    }) as StyleSpecification['layers'],
  };
}

/**
 * The minimal water-body shape the map consumes from `waterBodies.listInViewport`. `polygon` is the
 * stored GeoJSON geometry; water bodies are Polygon/MultiPolygon in practice.
 */
export interface MappableBody {
  _id: string;
  name: string;
  type: string;
  polygon: GeoJSON.Geometry;
}

/**
 * Water bodies → a GeoJSON `FeatureCollection` for the map's `water` source. The string `_id`/name/
 * type ride along as feature properties: a tap reads `_id` to navigate, and the selection-highlight
 * layer filters on `_id` (RN has no `setFeatureState`, so the highlight is a data-driven filter, not
 * a feature-state flag as on web).
 */
export function waterBodiesToFeatureCollection(
  bodies: readonly MappableBody[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: bodies.map((body) => ({
      type: 'Feature',
      geometry: body.polygon,
      properties: { _id: body._id, name: body.name, type: body.type },
    })),
  };
}

/** A put-in marker as `putIns.listForBody` returns it — a routable coord + its provenance. */
export interface MappablePutIn {
  coord: { lat: number; lng: number };
  source: 'derived' | 'official';
}

/**
 * Put-in markers → a GeoJSON `FeatureCollection` for the map's `put-in-markers` source (Phase 4,
 * decision #7). Each point carries its `source` so the layer styles `official` (accurate) markers
 * distinctly from `derived` (approximate) clusters. Mirrors web's helper.
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

/** MapLibre Native `LngLatBounds` (`[west, south, east, north]`) → our bbox, the query arg. */
export function boundsToViewport(bounds: LngLatBounds): BBox {
  const [west, south, east, north] = bounds;
  return { minLng: west, minLat: south, maxLng: east, maxLat: north };
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
 * falls inside the pilot region (the only data we have), else `null` so the caller keeps the default
 * regional framing — a skater in California shouldn't be dropped onto empty ocean. Pure so the
 * "in region?" decision is tested without the device Geolocation API.
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
