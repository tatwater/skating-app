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

import { convertFilter } from '@maplibre/maplibre-gl-style-spec';
import { layers, namedFlavor } from '@protomaps/basemaps';
import {
  type BBox,
  composeBasemapLayers,
  REGION_BOUNDS_CORNERS,
  REVEAL_MARKER,
  summaryHasCard,
} from '@skating/core';
import type { StyleSpecification } from 'maplibre-gl';
import { REGION_FILTER_JSON, REGION_MASK_JSON } from '../assets/regionMask';

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
 * The flat fills that make everywhere-but-here look like nowhere.
 *
 * Three layers, drawn in this order: **sea**, then **land** on top of it, then the major **lakes**.
 * Together they tile the whole neighbourhood, which matters more than it sounds — see below.
 *
 * Coloured from the flavour itself — `earth` for land, `water` for sea and lakes — so the mask is not
 * a grey rectangle laid over a map but the same white and the same pale grey the basemap already
 * paints with. The seam where it meets the world overview's own earth is invisible by construction;
 * the only seam a user can see is where it meets *our* detail, which is the border, which is the point.
 *
 * **`fill-opacity: 0.999`, and it is not a rounding artefact.** MapLibre sends a fill to the *opaque*
 * render pass only at exactly opacity 1; everything else goes to the *translucent* pass. Symbols only
 * ever render in the translucent pass, and it runs after the opaque one with depth testing off — so an
 * opaque mask, however late in the layer order, was drawn *before* the labels beneath it and every
 * town in Québec and Connecticut rendered straight through it. A thousandth of transparency moves the
 * mask into the same pass as the labels, where being later in the list finally means being on top.
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
 * A MapLibre style: **two** Protomaps vector archives plus the region mask, themed by `flavor`
 * (D6/D34 — see `MAP_FLAVORS`), under our water layers (added imperatively in the component).
 *
 * `regionUrl` is the archive clipped to the five states — detail, from z6 up. `worldUrl` is a
 * whole-planet z0–6 overview that gives the map its oceans, its landmasses and its country lines at
 * every zoom, everywhere; without it the map ends in a straight line wherever the regional archive's
 * bbox ended, which is the bug this pair of sources exists to fix. It is optional, and a build with
 * no world archive configured degrades to what the map did before rather than to a blank screen.
 *
 * `composeBasemapLayers` owns the ordering and the zoom policy — see `@skating/core/basemapLayers`.
 * `attribution` on the sources is what the `AttributionControl` surfaces. The sprite matches the
 * flavour's light/dark icon set.
 */
export function buildMapStyle(input: {
  regionUrl: string;
  worldUrl?: string;
  flavor?: MapFlavor;
}): StyleSpecification {
  const { regionUrl, worldUrl, flavor = 'white' } = input;
  const themed = namedFlavor(flavor);
  const region = layers(REGION_SOURCE, themed, { lang: 'en' });
  // With no world archive there is nothing to compose against, so the regional set is used whole —
  // including its own background and boundaries, which the two-source path deliberately drops.
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
    // The cast bridges @protomaps/basemaps' LayerSpecification to maplibre-gl's identical type.
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
 * The minimal water-body shape the map consumes from `waterBodies.listInViewport`. `polygon` is
 * the stored GeoJSON geometry — typed as the full `Geometry` union (what the schema's `geoJson`
 * validator allows); water bodies are Polygon/MultiPolygon in practice and MapLibre renders any.
 */
export interface MappableBody {
  _id: string;
  name: string;
  type: string;
  polygon: GeoJSON.Geometry;
  /** A moderator's access ruling (N6f). `verdict: 'none'` draws the body dimmed. */
  publicAccess?: { verdict: string };
}

/**
 * Water bodies → a GeoJSON `FeatureCollection` for the map's `water` source. Each feature gets a
 * **numeric `id`** (its array index) — required for MapLibre feature-state, which drives the
 * tap/selection highlight (D47). The string `_id`/name/type ride along as feature properties (a
 * tap reads `_id` to navigate; `featureIdForBody` maps a selected `_id` back to the numeric id so
 * a deep-linked selection can be highlighted without a click).
 *
 * `selfFlaggedIds` are the bodies **this viewer** has reported as having no public access (N6f).
 * They draw dimmed for that person alone — an unconfirmed report must not change anyone else's map,
 * or one account could dim any lake in the corpus. It rides the properties bag rather than
 * feature-state (which is how favourites do it) so that the mobile client, whose binding has no
 * ergonomic `setFeatureState`, can share one expression instead of growing a parallel filtered layer.
 */
export function waterBodiesToFeatureCollection(
  bodies: readonly MappableBody[],
  selfFlaggedIds: ReadonlySet<string> = new Set(),
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: bodies.map((body, index) => ({
      type: 'Feature',
      id: index,
      geometry: body.polygon,
      properties: {
        _id: body._id,
        name: body.name,
        type: body.type,
        noPublicAccess: body.publicAccess?.verdict === 'none',
        selfFlagged: selfFlaggedIds.has(body._id),
      },
    })),
  };
}

/**
 * Named sub-area outlines + labels (N2 / D60), a **second** source over the water layer.
 *
 * Deliberately not folded into the water source: a bay is drawn inside its parent, so the two
 * collections overlap by construction, and MapLibre resolves a tap by layer order. Keeping them
 * apart is what lets a tap on Malletts Bay still open Lake Champlain — the bay is a name on a lake,
 * not a thing you can select — while the label draws on top of the fill it sits in.
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
 * Sub-areas → the `sub-areas` source: one **polygon** feature per bay for the dashed outline, plus
 * one **point** feature at its representative centroid for the label.
 *
 * Two geometries rather than a `symbol` layer over the polygon, because MapLibre places a polygon
 * label at the shape's *pole of inaccessibility*, which for a crescent-shaped bay can land on the
 * far side of a headland. The stored centroid is already a guaranteed-on-water representative point
 * (D48's `pointOnFeature`), so using it puts the name on the ice it names.
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
  source: 'derived' | 'osm' | 'official';
  /** OSM's name for the launch (N6d/A3), where it has one — what makes a pin worth tapping. */
  name?: string;
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
      properties: { source: m.source, ...(m.name ? { name: m.name } : {}) },
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
  region: [[number, number], [number, number]] = NORTHEAST_REGION_BOUNDS,
  zoom: number = GEOLOCATION_FRAME_ZOOM,
): { center: [number, number]; zoom: number } | null {
  const [[minLng, minLat], [maxLng, maxLat]] = region;
  const inRegion =
    coord.lng >= minLng && coord.lng <= maxLng && coord.lat >= minLat && coord.lat <= maxLat;
  return inRegion ? { center: [coord.lng, coord.lat], zoom } : null;
}

/**
 * `maxBounds` for a lake editor: the body's bbox plus a margin (Decision 5).
 *
 * The margin is a fraction of the body's own extent rather than a fixed number of degrees, so a cove
 * and Champlain both get a usable amount of shoreline context instead of one being suffocated and the
 * other framed on nothing. Clamped to a small floor, because a zero-extent bbox (a degenerate row)
 * would otherwise produce bounds MapLibre rejects.
 */
export function boundsForBody(
  bbox: BBox,
  marginFraction = 0.15,
): [[number, number], [number, number]] {
  const latSpan = Math.max(bbox.maxLat - bbox.minLat, 0.002);
  const lngSpan = Math.max(bbox.maxLng - bbox.minLng, 0.002);
  const latPad = latSpan * marginFraction;
  const lngPad = lngSpan * marginFraction;
  return [
    [bbox.minLng - lngPad, bbox.minLat - latPad],
    [bbox.maxLng + lngPad, bbox.maxLat + latPad],
  ];
}

/**
 * Per-body summary cards (N6c Workstream E).
 *
 * **A MapLibre `symbol` layer, not HTML overlays.** Symbol layers keep the cards inside the style,
 * so they scale to a viewport full of bodies, and — the load-bearing reason — MapLibre's own collision
 * detection hides a card that would overlap another rather than stacking illegible text. An overlay
 * would need that written by hand. The cost is that a card is text and an icon, so the D86 mark is
 * drawn with filled and hollow dot characters rather than styled elements; if that turns out to be
 * too little, the escape hatch is HTML overlays for the *selected* body only.
 */
export const SUMMARY_CARD_PALETTE = {
  white: { label: '#12303f', halo: '#ffffff' },
  dark: { label: '#e6f2f8', halo: '#0b1622' },
} as const;

/** The minimal shape a card needs. Structural, so a `Doc<'waterBodies'>` satisfies it. */
export interface MappableSummaryBody {
  _id: string;
  name?: string;
  minVisibleZoom?: number;
  representativePoint?: { lat: number; lng: number };
  interiorPoint?: { lat: number; lng: number };
  centroid: { lat: number; lng: number };
  summary?: {
    recentReportCount: number;
    topHazardTypes: string[];
    qualityDots?: number;
    qualityCount?: number;
  };
  /**
   * The easiest known way onto this body (N6d / D144), denormalized onto the row by the access join.
   *
   * Read off `listInViewport`'s own rows — **no extra query**, the same property that makes the cards
   * affordable at all. It is deliberately *not* inside `summary`: that object is activity-scoped, and
   * access is a static property of the place.
   */
  accessKind?: string;
}

/** Filled/hollow dots for the D86 mark, e.g. 3 of 4 → "●●●○". */
export function qualityDotString(dots: number, total = 4): string {
  return '●'.repeat(Math.max(0, dots)) + '○'.repeat(Math.max(0, total - dots));
}

/**
 * The card's text block, or `null` when there is nothing to say (E3).
 *
 * Two or three short lines: the title, the activity, and the hazards. Kept this terse because a card
 * is read at a glance from a moving map — anything longer and MapLibre's collision detection starts
 * hiding cards that would otherwise fit.
 */
export function summaryCardText(body: MappableSummaryBody, reveal = false): string | null {
  const summary = body.summary;
  if (!summary) return null;
  // **E3's rule, via `summaryHasCard` rather than restated here.** It was inlined at first, which
  // left the rule implemented in two places that agreed — the shape that drifts silently, and the
  // one this codebase has already been bitten by (a hand-copied area floor became *more* permissive
  // than the import it mirrored). One definition, in core, where both clients can reach it.
  if (!summaryHasCard(summary, reveal)) return null;

  const lines: string[] = [];
  // A name is not a reason to draw a card, but it is always on one when there is a card.
  if (body.name) lines.push(body.name);

  const activity: string[] = [];
  if (summary.recentReportCount > 0) {
    activity.push(
      `${summary.recentReportCount} report${summary.recentReportCount === 1 ? '' : 's'}`,
    );
  } else if (reveal) {
    activity.push('0 reports');
  }
  // The mark renders only above quorum — `qualityDots` is absent below it, never zero (D86).
  //
  // **Under the reveal it draws an EMPTY mark, never a computed one.** The stored summary is
  // quorum-respecting by construction and the raw per-report qualities are not shipped to the map,
  // so there is nothing here to widen even if we wanted to — which is the right answer anyway. An
  // empty mark shows the slot, its size and where it collides; a fabricated one would be the exact
  // claim D86's quorum exists to prevent, wearing a dev label nobody reads at a glance.
  if (summary.qualityDots !== undefined) activity.push(qualityDotString(summary.qualityDots));
  else if (reveal) activity.push(`${qualityDotString(0)} ${REVEAL_MARKER}`);
  if (activity.length > 0) lines.push(activity.join('  '));

  if (summary.topHazardTypes.length > 0) {
    lines.push(summary.topHazardTypes.map((type) => type.replaceAll('_', ' ')).join(', '));
  } else if (reveal) {
    lines.push(`no hazards ${REVEAL_MARKER}`);
  }

  // The Hike-In chip (D87), on the browse surface because the whole point is that a skater should
  // learn this *before* committing rather than at the trailhead.
  //
  // **Only `hike_in` prints.** `drive_up` and `short_walk` are the unremarkable cases, and a card
  // that announced them would spend its two legible lines saying nothing — the same reasoning that
  // keeps `describeApproach` silent for a pull-off. E3 still governs whether there is a card at all:
  // a hike-in pond nobody has reported draws nothing, which is correct, and the body's own drawer
  // carries the chip regardless.
  if (body.accessKind === 'hike_in') lines.push('Hike-in');
  else if (reveal && body.accessKind === undefined) lines.push(`no access data ${REVEAL_MARKER}`);

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Summary cards → the `summary-cards` source: one point feature per body that has something to say.
 *
 * Placed at the body's **interior point**, not its `centroid` — `centroid` is Turf `pointOnFeature`
 * and lands on the shoreline for any curved lake, which would hang the card off the edge of the
 * water it describes (the same measurement that moved the fetch profile and the reference links).
 *
 * `minVisibleZoom` rides along as a property so the layer can filter on it: E4 requires that a card
 * never reintroduce a body the prominence scoring suppressed at this zoom. `listInViewport` already
 * applies that filter server-side, so this is a second belt on the same trousers — cheap, and the
 * failure it prevents (a quiet lake acquiring prominence by having been skated once) is exactly the
 * kind that would be reported as "the map is broken" rather than diagnosed.
 */
export function summaryCardsToFeatureCollection(
  bodies: readonly MappableSummaryBody[],
  /** The N6c-2 reveal flag — draws a card for every body carrying a summary, empty ones included. */
  reveal = false,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const body of bodies) {
    const text = summaryCardText(body, reveal);
    if (text === null) continue;
    const point = body.interiorPoint ?? body.representativePoint ?? body.centroid;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
      properties: {
        _id: body._id,
        text,
        minVisibleZoom: body.minVisibleZoom ?? 0,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The `summary-card` symbol layer (N6c/E).
 *
 * Lives here rather than inline in `MapView` so it can be run through the style-spec validator in a
 * test — which is the point, because **an invalid layer fails silently**: MapLibre logs and declines
 * to draw, so the symptom is "the cards never appeared", indistinguishable from "no body had
 * anything to say", which is E3's *correct* behaviour on this corpus. There is no louder failure
 * available, so the check has to happen before the browser sees it.
 *
 * `['zoom']` inside a filter is the specific thing worth pinning: it is legal in MapLibre but
 * restricted in nearby contexts (in layout/paint it may only feed a top-level `step`/`interpolate`),
 * so it is easy to write a version that validates in one place and not the other.
 */
export function summaryCardLayer(
  palette: (typeof SUMMARY_CARD_PALETTE)[keyof typeof SUMMARY_CARD_PALETTE],
): StyleSpecification['layers'][number] {
  return {
    id: 'summary-card',
    type: 'symbol',
    source: 'summary-cards',
    // E4: a card must never reintroduce a body the prominence scoring suppressed at this zoom.
    // `listInViewport` already applies this server-side; restated here where the drawing happens,
    // because the failure it prevents would be read as "the map is broken" rather than diagnosed.
    filter: ['<=', ['get', 'minVisibleZoom'], ['zoom']],
    layout: {
      'text-field': ['get', 'text'],
      'text-size': 11,
      'text-font': ['Noto Sans Regular'],
      'text-line-height': 1.2,
      'text-anchor': 'top',
      'text-offset': [0, 0.6],
      // A card may not displace a hazard or put-in marker; if it doesn't fit, it doesn't draw.
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: {
      'text-color': palette.label,
      'text-halo-color': palette.halo,
      'text-halo-width': 1.4,
    },
  } as StyleSpecification['layers'][number];
}
