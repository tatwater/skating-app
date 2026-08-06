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

import { convertFilter, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LngLatBounds } from '@maplibre/maplibre-react-native';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { type BBox, composeBasemapLayers, REGION_BOUNDS_CORNERS } from '@skating/core';
import { REGION_FILTER_JSON, REGION_MASK_JSON } from '../assets/regionMask';

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
 * The region's extent, re-exported from `@skating/core` so the two apps cannot hold different
 * numbers. **No longer a pan fence** — with a whole-planet overview under the map there is a world
 * to look at, and `ReturnToRegion` brings a wandering user back rather than a wall stopping them
 * leaving. It is still what decides whether a device fix is somewhere we know anything about.
 */
export const NORTHEAST_REGION_BOUNDS = REGION_BOUNDS_CORNERS;

/** The mask geometry, parsed once per session rather than per style rebuild (theme toggles). */
const REGION_MASK = JSON.parse(REGION_MASK_JSON) as GeoJSON.FeatureCollection;

/**
 * The outline the basemap's own labels are filtered against, so a name belonging to one of our
 * five states draws *over* the mask rather than under it. See `REGION_LABEL_FILTER_NOTE`.
 */
const REGION_FILTER = JSON.parse(REGION_FILTER_JSON) as GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Source ids. `protomaps` is the regional archive and keeps its original name; `world` is new. */
export const REGION_SOURCE = 'protomaps';
export const WORLD_SOURCE = 'world';
export const MASK_SOURCE = 'region-mask';

/**
 * A thousandth short of opaque, which is what puts the mask in the same render pass as the labels it
 * has to cover. See `maskLayers`. Shared with mobile — if it ever goes back to 1, the map silently
 * starts showing Québec again.
 */
const MASK_FILL_OPACITY = 0.999;

/**
 * The flat fills that make everywhere-but-here look like nowhere — the mobile mirror of web's.
 *
 * Three layers — **sea**, **land** over it, then the major **lakes** — so the whole neighbourhood is
 * covered rather than just its land, and coloured from the flavour itself so the mask is the same
 * white and pale grey the basemap already paints with.
 *
 * **`fill-opacity: 0.999` is load-bearing**, not a rounding artefact: MapLibre only sends a fill to
 * the opaque render pass at exactly opacity 1, and symbols render in the translucent pass afterwards
 * with depth testing off — so an opaque mask draws *under* the labels it is meant to hide, whatever
 * the layer order says. See web's `maskLayers` for the longer version.
 */
function maskLayers(flavor: MapFlavor): StyleSpecification['layers'] {
  const palette = namedFlavor(flavor) as unknown as Record<string, string>;
  const water = palette.water ?? '#dcdcdc';
  const fill = (id: string, kind: string, color: string) => ({
    id,
    type: 'fill' as const,
    source: MASK_SOURCE,
    filter: ['==', ['get', 'kind'], kind],
    paint: { 'fill-color': color, 'fill-opacity': MASK_FILL_OPACITY },
  });
  return [
    fill('region-mask-sea', 'sea', water),
    fill('region-mask-land', 'land', palette.earth ?? '#ffffff'),
    fill('region-mask-water', 'water', water),
  ] as StyleSpecification['layers'];
}

/**
 * A MapLibre style: **two** Protomaps vector archives (`pmtiles://` sources, read natively) plus the
 * region mask, themed by `flavor`. Our water layers are added declaratively as `<Layer>` children in
 * the component, so the style here is basemap-only.
 *
 * `regionUrl` is the archive clipped to the five states — detail, from z6 up. `worldUrl` is a
 * whole-planet z0–6 overview that gives the map oceans and continents at every zoom, everywhere;
 * without it the map ends in a straight line wherever the regional archive's bbox ended. It is
 * optional, and a build with no world archive degrades to the previous behaviour rather than to a
 * blank screen — which matters more here than on web, since `resolveBasemapSource` may hand back a
 * local `file://` archive with no overview beside it.
 *
 * `composeBasemapLayers` owns the ordering and zoom policy (`@skating/core/basemapLayers`), shared
 * with web so the two surfaces cannot drift.
 */
export function buildMapStyle(input: {
  regionUrl: string;
  worldUrl?: string;
  flavor?: MapFlavor;
}): StyleSpecification {
  const { regionUrl, worldUrl, flavor = 'white' } = input;
  const themed = namedFlavor(flavor);
  const region = layers(REGION_SOURCE, themed, { lang: 'en' });
  const world = worldUrl ? layers(WORLD_SOURCE, themed, { lang: 'en' }) : [];

  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: `${SPRITE_BASE}/${flavor === 'dark' ? 'dark' : 'light'}`,
    sources: {
      [REGION_SOURCE]: {
        type: 'vector',
        url: `pmtiles://${regionUrl}`,
        attribution: OSM_ATTRIBUTION,
      },
      ...(worldUrl
        ? {
            [WORLD_SOURCE]: {
              type: 'vector' as const,
              url: `pmtiles://${worldUrl}`,
              attribution: OSM_ATTRIBUTION,
            },
          }
        : {}),
      [MASK_SOURCE]: { type: 'geojson' as const, data: REGION_MASK },
    },
    layers: (worldUrl
      ? composeBasemapLayers({
          world,
          region,
          mask: maskLayers(flavor) as never[],
          regionFilter: {
            outline: REGION_FILTER,
            // The spec types `convertFilter` against its own `FilterSpecification`; core keeps the
            // signature loose so it need not depend on the style spec at all.
            convertFilter: convertFilter as (filter: unknown) => unknown,
          },
        })
      : [...region, ...(maskLayers(flavor) as never[])]) as StyleSpecification['layers'],
  };
}

/**
 * Named sub-area outlines + labels (N2 / D60) — a **second** source over the water layer.
 *
 * Deliberately not folded into the water source: a bay is drawn inside its parent, so the two
 * collections overlap by construction. Keeping them apart is what lets a tap on Malletts Bay still
 * open Lake Champlain — the bay is a name on a lake, not a thing you can select.
 */
export const SUB_AREA_PALETTE = {
  white: { outline: '#2f6690', label: '#1f4b6b', halo: '#ffffff' },
  dark: { outline: '#9ecae1', label: '#cfe6f5', halo: '#0b1622' },
} as const;

/** The minimal sub-area shape the map consumes from `subAreas.listInViewport`. */
export interface MappableSubArea {
  _id: string;
  waterBodyId: string;
  name: string;
  polygon: GeoJSON.Geometry;
  centroid: { lat: number; lng: number };
}

/**
 * Sub-areas → one **polygon** feature per bay for the dashed outline, plus one **point** feature at
 * its stored centroid for the label.
 *
 * Two geometries rather than a symbol layer over the polygon: MapLibre places a polygon label at the
 * pole of inaccessibility, which for a crescent-shaped bay can land past a headland. The stored
 * centroid is a guaranteed-on-water representative point (D48), so the name sits on the ice it names.
 */
export function subAreasToFeatureCollection(
  subAreas: readonly MappableSubArea[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: subAreas.flatMap((subArea) => [
      {
        type: 'Feature' as const,
        geometry: subArea.polygon,
        properties: { _id: subArea._id, waterBodyId: subArea.waterBodyId, name: subArea.name },
      },
      {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [subArea.centroid.lng, subArea.centroid.lat],
        },
        properties: {
          _id: subArea._id,
          waterBodyId: subArea.waterBodyId,
          name: subArea.name,
          label: true,
        },
      },
    ]),
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
  region: [[number, number], [number, number]] = NORTHEAST_REGION_BOUNDS,
  zoom: number = GEOLOCATION_FRAME_ZOOM,
): { center: [number, number]; zoom: number } | null {
  const [[minLng, minLat], [maxLng, maxLat]] = region;
  const inRegion =
    coord.lng >= minLng && coord.lng <= maxLng && coord.lat >= minLat && coord.lat <= maxLat;
  return inRegion ? { center: [coord.lng, coord.lat], zoom } : null;
}
