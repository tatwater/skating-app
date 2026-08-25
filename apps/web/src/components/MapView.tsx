import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  APPROACH_LAYER_ID,
  APPROACH_SOURCE_ID,
  aerialIdentifyUrl,
  applyDraftMapClick,
  approachesToFeatureCollection,
  approachLinePaint,
  type BBox,
  draftPlacementCount,
  formatAerialCaptureDate,
  isDraftSubmittable,
  isRegionOffscreen,
  type LatLng,
  parseAerialScene,
  polygonShape,
  profileRevealEnabled,
  representativePoint,
  SUB_AREA_MIN_RENDER_ZOOM,
  shapeSignature,
  undoDraftPlacement,
  withAccessDim,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import type { MultiPolygon, Polygon } from 'geojson';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useTheme } from 'next-themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTOUR_BEFORE_LAYER_ID,
  CONTOUR_FADE_MS,
  CONTOUR_LAYER_ID,
  CONTOUR_MIN_ZOOM,
  CONTOUR_OPACITY,
  CONTOUR_PALETTE,
  CONTOUR_SOURCE_ID,
  CONTOUR_SOURCE_LAYER,
  type ContourFeatureProperties,
  contourColorExpression,
  contourCredit,
  contourFilter,
  contourSourceSpec,
  contourWidthExpression,
  formatContourCredit,
  maxContourDepthFt,
} from '../lib/contourMap';
import { env } from '../lib/env';
import {
  bodyFeaturesToFeatureCollection,
  CONFIRMED_HAZARD_FILTER,
  HAZARD_PALETTE,
  hazardColorExpression,
  hazardDraftToFeatureCollection,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
  PROVISIONAL_DASH_ARRAY,
  PROVISIONAL_HAZARD_FILTER,
} from '../lib/hazardMap';
import { useMapCanvas } from '../lib/mapCanvas';
import { createPolygonDraw, type PolygonDrawControl } from '../lib/polygonDraw';
import {
  DEMO_PMTILES_URL,
  favoriteFeatureIds,
  featureIdForBody,
  frameForCoord,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MAP_FLAVORS,
  OSM_ATTRIBUTION,
  putInsToFeatureCollection,
  SUB_AREA_PALETTE,
  SUMMARY_CARD_PALETTE,
  subAreasToFeatureCollection,
  summaryCardLayer,
  summaryCardsToFeatureCollection,
  TRACK_PALETTE,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
  waterOutlineColor,
} from '../lib/waterMap';
import { FreezeUpScrubber } from './FreezeUpScrubber';
import { ImageryControl } from './ImageryControl';
import { useMapSelection } from './MapSelectionContext';
import { ReturnToRegion } from './ReturnToRegion';
import { useFreezeUpFrame } from './useFreezeUpFrame';
import { useFreezeUpSeam } from './useFreezeUpSeam';
import { useFreezeUpTimeline } from './useFreezeUpTimeline';
import {
  IMAGERY_HAZARD_LAYERS,
  IMAGERY_LOADING_LAYER_ID,
  IMAGERY_MIN_ZOOM,
  IMAGERY_PULSE_MAX,
  IMAGERY_PULSE_MIN,
  IMAGERY_PULSE_MS,
  IMAGERY_REPLACED_LAYERS,
  IMAGERY_REPLACED_WHOLE_LAYERS,
  type KeyedMask,
  setLayersHiddenForBodies,
  setLayersVisible,
  useImageryReveal,
} from './useImageryReveal';

/**
 * A stored geometry narrowed to the two shapes a lake is ever stored as.
 *
 * `waterBodies.polygon` is typed as the whole GeoJSON geometry union because the validator accepts
 * one, but a body is a `Polygon` or a `MultiPolygon` and nothing else. Returning `null` for anything
 * else keeps the seam from being computed against a point.
 */
function polygonOf(geometry: unknown): Polygon | MultiPolygon | null {
  const type = (geometry as { type?: string } | null)?.type;
  return type === 'Polygon' || type === 'MultiPolygon'
    ? (geometry as Polygon | MultiPolygon)
    : null;
}

/**
 * Interactive MapLibre map — the read side of the Phase 2 loop (§D, D5/D6/D47/D49). Imperative
 * (MapLibre owns its canvas), rendered **client-only** (see the `_map` layout) since WebGL needs
 * the DOM, and kept mounted across `/`, `/water/$id`, `/report/$id` so panning/zoom survive opening
 * a drawer. All pure logic (style, feature/viewport transforms, framing) lives in `../lib/waterMap`;
 * this file is the untestable WebGL shell, excluded from coverage.
 *
 * Data flow: the viewport bbox **and current zoom** drive `waterBodies.listInViewport` — the zoom
 * powers the D49 in-query prominence filter, so wide views return the few prominent bodies instead
 * of a read-capped slice. Tapping a body navigates to its `/water/$id` drawer and highlights it via
 * feature-state; the highlighted body / fly-to focus / report photo pins come from `useMapSelection`
 * (the drawers push them up, since they're siblings of this persistent map).
 */
const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
/** A stable identity for "nothing is painted", so the initial state cannot itself trigger a re-run. */
const EMPTY_IDS: readonly string[] = [];

/**
 * A terra-draw ring → the corners a `HazardDraft` holds.
 *
 * The closing position is dropped: a draft holds corners and `polygonShape` closes them again, so
 * carrying the duplicate through would make "undo the last corner" pop a position nobody placed.
 */
function polygonRingToVertices(polygon: GeoJSON.Polygon | null): LatLng[] {
  const ring = polygon?.coordinates[0] ?? [];
  return ring.slice(0, -1).map(([lng = 0, lat = 0]) => ({ lat, lng }));
}

/** Open bounties → a point per body centroid, carrying the `bountyId` for the tap → `/bounty/$id`. */
function bountiesToPins(
  bounties: { _id: string; centroid: { lat: number; lng: number } }[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: bounties.map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.centroid.lng, b.centroid.lat] },
      properties: { bountyId: b._id },
    })),
  };
}

interface QueryArgs {
  viewport: BBox;
  zoom: number;
}

export default function MapView({ geolocateOnMount }: { geolocateOnMount: boolean }) {
  const navigate = useNavigate();
  const {
    highlightWaterBodyId,
    focus,
    photoPins,
    trackPath,
    putInPin,
    pinDropMode,
    setPutInPin,
    setPinDropMode,
    hazardDraft,
    setHazardDraft,
    hazardDraftType,
    hazardDropMode,
    setHazardDropMode,
    hazardShoreTaps,
    setHazardShoreTaps,
    browseSeason,
    contourBodyKey,
    setContourCredit,
    setViewportLakes,
    imageryOn,
    setImageryOn,
    hazardsOverImagery,
    setHazardsOverImagery,
    aerialCaptureLabel,
    setAerialCaptureLabel,
  } = useMapSelection();

  const [queryArgs, setQueryArgs] = useState<QueryArgs | null>(null);

  // Basemap flavor + icy water palette follow the app theme (D6/D34). The map re-creates on a theme
  // change (flavor is in the create-effect deps); `lastViewRef` preserves pan/zoom across that.
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light;
  const water = WATER_PALETTE[flavor];
  const subAreaPalette = SUB_AREA_PALETTE[flavor];
  const summaryCardPalette = SUMMARY_CARD_PALETTE[flavor];
  const hazardPalette = HAZARD_PALETTE[flavor];
  const trackColor = TRACK_PALETTE[flavor];
  const contourPalette = CONTOUR_PALETTE[flavor];

  // The map click handler is registered once (in the create effect) but must read the *current*
  // pin-drop mode + latest setters, so mirror them into refs that the handler closes over.
  const pinDropModeRef = useRef(pinDropMode);
  pinDropModeRef.current = pinDropMode;
  const setPutInPinRef = useRef(setPutInPin);
  setPutInPinRef.current = setPutInPin;
  const setPinDropModeRef = useRef(setPinDropMode);
  setPinDropModeRef.current = setPinDropMode;
  const hazardDropModeRef = useRef(hazardDropMode);
  hazardDropModeRef.current = hazardDropMode;
  // The polygon draw control is created once per arming and lives across every vertex drag, so it
  // reads the draft and its setter through refs — a dependency on either would tear the engine down
  // and rebuild it on the change it just emitted.
  const hazardDraftRef = useRef(hazardDraft);
  hazardDraftRef.current = hazardDraft;
  const setHazardDraftRef = useRef(setHazardDraft);
  setHazardDraftRef.current = setHazardDraft;
  // A map click in hazard-drop mode. The two primitives differ only in what happens *after*: a
  // circle is placed by one click and disarms, a polyline takes one vertex per click and stays armed
  // until Done — so the map keeps the click and the form isn't in the way for the whole draw.
  // All the state math is `@skating/core`'s, shared with mobile; this only wires it to the canvas.
  const handleHazardClickRef = useRef((_coord: { lat: number; lng: number }) => {});
  handleHazardClickRef.current = (coord) => {
    // Snap-to-shoreline (N5b) takes the click first: it's a two-tap affordance, and the form is
    // hidden for both taps, so the map is the only thing that can count them. It never touches the
    // draft — the form owns the body polygon and turns the pair into geometry.
    if (hazardShoreTaps !== null) {
      const next = [...hazardShoreTaps, coord].slice(-2);
      setHazardShoreTaps(next);
      if (next.length === 2) setHazardDropMode(false);
      return;
    }
    if (!hazardDraft) return;
    // A polygon is drawn by terra-draw, not collected a tap at a time — the map click would add a
    // vertex behind the draw engine's back and the two would disagree about the ring.
    if (hazardDraft.geometryKind === 'polygon') return;
    setHazardDraft(applyDraftMapClick(hazardDraft, coord));
    if (hazardDraft.geometryKind === 'point_radius') setHazardDropMode(false);
  };

  const pmtilesUrl = env.pmtilesUrl || DEMO_PMTILES_URL;
  // No demo fallback for the overview: the Protomaps demo build IS a whole planet, so falling back
  // to it would mean rendering the same archive twice. Blank simply means no overview.
  const worldPmtilesUrl = env.worldPmtilesUrl;

  // The viewport bbox + zoom are the query key; 'skip' until the map's first `load` sets them.
  // Skipped outright once the region is off screen. Panning to Kansas cannot turn up a lake we
  // hold, so the query would be a subscription per viewport for an answer known in advance — the
  // same reasoning `subAreaArgs` applies below its zoom floor.
  const regionOffscreen = queryArgs ? isRegionOffscreen(queryArgs.viewport) : false;
  const bodies = useQuery(
    api.waterBodies.listInViewport,
    queryArgs && !regionOffscreen ? queryArgs : 'skip',
  );

  // The lakes *this viewer* has reported as having no public access (N6f) — they draw dimmed for
  // them alone. One small query for the whole session rather than per body: a person reports a
  // handful of lakes in their life, and an unconfirmed report reaches nobody else's map.
  const selfFlagged = useQuery(api.contentFlags.myAccessFlags, {});

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FEATURES);
  useEffect(() => {
    if (bodies !== undefined) {
      setFeatures(waterBodiesToFeatureCollection(bodies, new Set(selfFlagged ?? [])));
    }
  }, [bodies, selfFlagged]);

  // The same rows, handed to the sidebar's "lakes in view" list (see `MapSelectionContext`). No
  // extra query, by the same argument the summary cards make below — and one that matters more
  // here, because a list is a per-pan re-render and this read path is the one that has been fixed
  // for cost twice. Reset to `null` (not `[]`) whenever the query isn't running, so the list can
  // tell "nothing here" from "haven't looked yet".
  useEffect(() => {
    if (queryArgs === null || regionOffscreen) setViewportLakes(null);
    else if (bodies !== undefined) setViewportLakes(bodies);
  }, [bodies, queryArgs, regionOffscreen, setViewportLakes]);
  // The map unmounts when you leave the map routes; the sidebar must not keep listing the lakes
  // that were in view three pages ago if it ever renders before the map answers again.
  useEffect(() => () => setViewportLakes(null), [setViewportLakes]);

  // Per-body summary cards (N6c/E). **No extra query** — the cards are derived from the same
  // `listInViewport` rows the water source already has, because `summary` is denormalized onto the
  // body. That is the whole argument for denormalizing it: a card costs no read at all.
  const [summaryFeatures, setSummaryFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FEATURES);
  // The N6c-2 reveal flag: on dev it draws a card for every body carrying a summary, so a
  // walk-through can see where cards land and how they collide on a corpus with almost no reports.
  // Forced off against the production deployment regardless of the constant — see `profileReveal`.
  const reveal = profileRevealEnabled(env.convexUrl);
  useEffect(() => {
    if (bodies !== undefined) setSummaryFeatures(summaryCardsToFeatureCollection(bodies, reveal));
  }, [bodies, reveal]);

  // Named sub-areas in view (N2/D60) — a second layer on its own ladder-grid query.
  //
  // **Not subscribed below the zoom floor at all.** The server answers `[]` there, but "returns
  // nothing" is still a query execution and a live subscription per viewport key, and a skater
  // panning a regional view generates a lot of those for an answer that is known in advance. Both
  // ends read `SUB_AREA_MIN_RENDER_ZOOM` from `@skating/core` so they can't drift apart.
  const subAreaArgs =
    queryArgs && queryArgs.zoom >= SUB_AREA_MIN_RENDER_ZOOM ? queryArgs : ('skip' as const);
  const subAreas = useQuery(api.subAreas.listInViewport, subAreaArgs);
  const [subAreaFeatures, setSubAreaFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FEATURES);
  useEffect(() => {
    // Zooming back out clears the layer rather than leaving the last bays drawn over a regional view.
    if (subAreaArgs === 'skip') setSubAreaFeatures(EMPTY_FEATURES);
    else if (subAreas !== undefined) setSubAreaFeatures(subAreasToFeatureCollection(subAreas));
  }, [subAreas, subAreaArgs]);

  // The viewer's favorited bodies (Phase 4, decision #1) — painted with a distinct outline. Empty
  // when signed out. The id set is stable-memoized so the paint effect only re-runs on a real change.
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {});
  const favoriteKey = favorites?.map((f) => f.waterBodyId).join(',') ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: favoriteKey is the stable content signature.
  const favoriteIds = useMemo(
    () => new Set((favorites ?? []).map((f) => f.waterBodyId)),
    [favoriteKey],
  );

  // Put-in markers for the currently-focused lake (Phase 4, decision #7) — bounded to the open lake
  // rather than every body in view. `skip` when no lake is selected.
  const putIns = useQuery(
    api.putIns.listForBody,
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
  );

  // Hazards + known features for the focused lake (Phase 9). Deliberately scoped to the open body,
  // not the viewport: hazards are only ever queried per body, which is what keeps this off the
  // path `listInViewport` had to be fixed for twice (PRs #10/#11) before N1 made it bounded.
  // `browseSeason` is what makes the season selector govern the *lake*, not just its report list:
  // the selector lives in the drawer, these two layers are drawn here, and they have to agree or the
  // screen shows two winters at once. Put-ins above are deliberately left out of it (D63).
  const seasonArg = browseSeason === null ? {} : { season: browseSeason };
  const hazards = useQuery(
    api.hazards.listForBody,
    highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'>, ...seasonArg }
      : 'skip',
  );
  const bodyFeatures = useQuery(
    api.bodyFeatures.listForBody,
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
  );
  // The aggregate tracks layer (D58) — where people actually skated on the open lake. Scoped per
  // body like hazards, deliberately NOT a viewport scan — per-body is the Phase 9 design call.
  const aggregateTracks = useQuery(
    api.gpsActivities.listTracksForBody,
    highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'>, ...seasonArg }
      : 'skip',
  );

  // Open bounties across the viewport (D10/D17 browse). Unlike hazards, this is safe to query per
  // viewport: the open-bounty set is small + bounded, so `bounties.listOpen` scans a plain index and
  // filters to the rect in JS — it never needed the spatial index at all. A pin per bounty; tap
  // opens `/bounty/$id`.
  const openBounties = useQuery(
    api.bounties.listOpen,
    queryArgs ? { viewport: queryArgs.viewport } : 'skip',
  );

  // Refs so the highlight effect can read the latest features/selection without re-running setData.
  const featuresRef = useRef(features);
  const highlightedFeatureRef = useRef<number | null>(null);
  const favoriteFeaturesRef = useRef<number[]>([]);

  const applyHighlight = () => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (highlightedFeatureRef.current !== null) {
      map.removeFeatureState({ source: 'water', id: highlightedFeatureRef.current }, 'selected');
      highlightedFeatureRef.current = null;
    }
    if (!highlightWaterBodyId) return;
    const featureId = featureIdForBody(featuresRef.current, highlightWaterBodyId);
    if (featureId !== undefined) {
      map.setFeatureState({ source: 'water', id: featureId }, { selected: true });
      highlightedFeatureRef.current = featureId;
    }
  };

  // Paint the `favorite` feature-state on every in-view favorited body (Phase 4, decision #1). Clears
  // the prior set first (a body pans out / gets un-favorited) so stale gold outlines never linger.
  const applyFavorites = () => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const id of favoriteFeaturesRef.current) {
      map.removeFeatureState({ source: 'water', id }, 'favorite');
    }
    const ids = favoriteFeatureIds(featuresRef.current, favoriteIds);
    for (const id of ids) {
      map.setFeatureState({ source: 'water', id }, { favorite: true });
    }
    favoriteFeaturesRef.current = ids;
  };

  // The canvas itself — creation, theme, bounds, controls, viewport reporting and teardown — is the
  // shared shell (Decision 12). What stays here is the skater map: its sources, its layers, and the
  // drawer navigation a tap resolves to.
  const { containerRef, mapRef, loaded } = useMapCanvas({
    pmtilesUrl,
    worldPmtilesUrl,
    flavor,
    // No `maxBounds`: the world overview means there is a whole planet worth looking at, and
    // `ReturnToRegion` is what brings a wandering user home. See `REGION_BOUNDS` in core.
    initialCenter: INITIAL_CENTER,
    initialZoom: INITIAL_ZOOM,
    onViewport: setQueryArgs,
    onLoad: (map) => {
      map.addSource('water', {
        type: 'geojson',
        data: EMPTY_FEATURES,
        attribution: OSM_ATTRIBUTION,
      });
      map.addLayer({
        id: 'water-fill',
        type: 'fill',
        source: 'water',
        paint: {
          'fill-color': water.fill,
          // Selected body reads brighter (D47 tap highlight); a body with no public access reads
          // half-strength (N6f). The dim is a *multiplier* so it composes with the selection rather
          // than flattening it — a dimmed lake you tap still brightens, relative to itself.
          'fill-opacity': withAccessDim([
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.6,
            0.35,
          ]) as maplibregl.DataDrivenPropertyValueSpecification<number>,
        },
      });
      // The reveal's loading skeleton (N6e). Its own layer on the existing water source rather than
      // a borrowed `water-fill`, because that layer's opacity is a data-driven expression carrying
      // the D47 selection and the N6f access dim — animating a scalar over it would flatten both and
      // then have to reconstruct them. A separate layer animates one number and owns nothing else.
      map.addLayer({
        id: IMAGERY_LOADING_LAYER_ID,
        type: 'fill',
        source: 'water',
        filter: ['==', ['get', '_id'], ''],
        paint: {
          'fill-color': water.outline,
          'fill-opacity': 0,
          'fill-opacity-transition': { duration: IMAGERY_PULSE_MS, delay: 0 },
        },
      });
      map.addLayer({
        id: 'water-outline',
        type: 'line',
        source: 'water',
        paint: {
          // Favorited gold, else the theme outline — and plain white while imagery is revealed.
          // See `waterOutlineColor`; the reveal effect below re-sets this when the toggle flips.
          'line-color': waterOutlineColor(
            flavor,
          ) as maplibregl.DataDrivenPropertyValueSpecification<string>,
          // The outline dims with the fill (N6f). A full-strength outline around a ghost fill reads
          // as a rendering bug rather than as a statement about the lake.
          'line-opacity': withAccessDim(
            1,
          ) as maplibregl.DataDrivenPropertyValueSpecification<number>,
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'favorite'], false],
            2.5,
            ['boolean', ['feature-state', 'selected'], false],
            2.5,
            1,
          ],
        },
      });
      // Named bays (N2/D60), over the water fill and under every pin layer. Dashed, so it reads as
      // a *name for part of this lake* rather than as another lake's shoreline — the distinction the
      // whole sub-area model exists to make. No click handler: tapping a bay falls through to
      // `water-fill` beneath it and opens the parent lake, which is the correct destination.
      map.addSource('sub-areas', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'sub-area-outline',
        type: 'line',
        source: 'sub-areas',
        filter: ['!=', ['get', 'label'], true],
        paint: {
          'line-color': subAreaPalette.outline,
          'line-width': 1.25,
          'line-opacity': 0.8,
          'line-dasharray': [3, 2],
        },
      });
      map.addLayer({
        id: 'sub-area-label',
        type: 'symbol',
        source: 'sub-areas',
        filter: ['==', ['get', 'label'], true],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
          'text-font': ['Noto Sans Italic'],
          // A bay name may not displace a hazard or put-in marker; if it doesn't fit, it doesn't draw.
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': subAreaPalette.label,
          'text-halo-color': subAreaPalette.halo,
          'text-halo-width': 1.2,
        },
      });
      // Per-body summary cards (N6c/E). Added HERE — after the bay labels and before the hazard,
      // put-in and bounty pins — so it inherits the same collision posture the bay label documents:
      // a card may not displace a marker a skater needs to see, and if it doesn't fit it doesn't
      // draw. `text-optional` plus `text-allow-overlap: false` is what makes that true.
      map.addSource('summary-cards', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer(summaryCardLayer(summaryCardPalette));

      map.addSource('photo-pins', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'photo-pins',
        type: 'circle',
        source: 'photo-pins',
        paint: {
          'circle-radius': 6,
          'circle-color': '#f59e0b',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addSource('put-in-pin', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'put-in-pin',
        type: 'circle',
        source: 'put-in-pin',
        paint: {
          'circle-radius': 7,
          'circle-color': '#137138', // success green — the access point (§E put-in pin)
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      // The walk from the car to the ice (N6e Workstream 0), under the pins at its two ends: a
      // hike-in lake's whole problem is that the way in is not obvious, and N6d could say "1.1 km on
      // foot" without being able to say *where*. Added before the markers so the route never covers
      // the launch it leads to.
      map.addSource(APPROACH_SOURCE_ID, { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: APPROACH_LAYER_ID,
        type: 'line',
        source: APPROACH_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // Amber-700: warm against the cool put-in blues, and not the danger red the hazard layer
        // owns — a long walk is a thing to plan for, not a thing to avoid.
        paint: approachLinePaint('#b45309') as never,
      });
      // Put-in markers for the focused lake (Phase 4, decision #7): official markers read as a solid
      // teardrop-ish dot, derived clusters a lighter ring — both distinct from the report photo pins.
      map.addSource('put-in-markers', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'put-in-markers',
        type: 'circle',
        source: 'put-in-markers',
        paint: {
          'circle-radius': 6,
          // Three rungs, three colours — `PUTIN_SOURCES` on screen (N6d/D143). An OSM slipway is
          // better evidence than a cluster of report points and worse than an operator's pin, and
          // rendering it in the `derived` blue said the opposite. The `case` already had a fallback,
          // so the 3,588 imported launches drew — just in the wrong rung's colour.
          'circle-color': [
            'case',
            ['==', ['get', 'source'], 'official'],
            '#0e7490', // cyan-700 — accurate, admin-set
            ['==', ['get', 'source'], 'osm'],
            '#3d7ea6', // between the two — mapped by someone, but not vouched for by us
            '#5b8fb0', // muted blue — approximate, derived from report points
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      // ── Open bounties (D10/D17 browse). A distinct violet pin per lake with an open bounty; tapping
      // it opens the bounty detail. Small point layer fed per-viewport by `bounties.listOpen`.
      map.addSource('bounty-pins', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'bounty-pins',
        type: 'circle',
        source: 'bounty-pins',
        paint: {
          'circle-radius': 7,
          'circle-color': '#7c3aed', // violet-600 — a bounty "wanted: fresh eyes" pin
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      // ── Hazards (Phase 9). Drawn as buffered *footprint* polygons, not markers, so the shape on
      // screen is literally the shape the proximity evaluator measures against. Soft fill + a dashed
      // outline: a hazard is "reported around here", never a surveyed boundary (D3/D51).
      map.addSource('hazards', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'hazard-fill',
        type: 'fill',
        source: 'hazards',
        paint: {
          'fill-color': hazardColorExpression(hazardPalette) as maplibregl.ExpressionSpecification,
          'fill-opacity': hazardFillOpacityExpression() as maplibregl.ExpressionSpecification,
        },
      });
      // Dashed for provisional (one unverified report), solid once independently confirmed — the same
      // soft/hard distinction the on-ice alert makes (D54). **Two layers, not one expression:**
      // `line-dasharray` takes no data expression on either renderer, so the filters carry the
      // distinction instead (see `PROVISIONAL_DASH_ARRAY` in core). The filters partition the source,
      // so every hazard is still drawn exactly once.
      map.addLayer({
        id: 'hazard-outline-provisional',
        type: 'line',
        source: 'hazards',
        filter: PROVISIONAL_HAZARD_FILTER as maplibregl.FilterSpecification,
        paint: {
          'line-color': hazardColorExpression(hazardPalette) as maplibregl.ExpressionSpecification,
          'line-width': 1.5,
          'line-dasharray': [...PROVISIONAL_DASH_ARRAY],
        },
      });
      map.addLayer({
        id: 'hazard-outline-confirmed',
        type: 'line',
        source: 'hazards',
        filter: CONFIRMED_HAZARD_FILTER as maplibregl.FilterSpecification,
        paint: {
          'line-color': hazardColorExpression(hazardPalette) as maplibregl.ExpressionSpecification,
          'line-width': 1.5,
        },
      });
      // ── Recorded GPS tracks (Phase 8). The path someone actually skated, drawn under the hazard
      // layers so a warning is never hidden by a line. Display-only: a path can only ever come from
      // a recorded track, so there is no draw interaction here or anywhere else.
      //
      // `line-opacity` is data-driven off each feature's `opacity`, which the server computes from
      // the linked report's D59 freshness — so a path fades exactly as its report ages, floored so
      // it never disappears (an empty lake would read as "all clear", which we never assert).
      map.addSource('tracks', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'track-line',
        type: 'line',
        source: 'tracks',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': trackColor,
          'line-width': 3,
          'line-opacity': ['coalesce', ['get', 'opacity'], 1] as maplibregl.ExpressionSpecification,
        },
      });
      // ── Known seasonal body features (D53). No freshness, no decay — they're permanent, so they
      // render in a steady neutral rather than the danger ramp, and they are always visible.
      map.addSource('body-features', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'body-feature-fill',
        type: 'fill',
        source: 'body-features',
        paint: { 'fill-color': hazardPalette.feature, 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'body-feature-outline',
        type: 'line',
        source: 'body-features',
        paint: {
          'line-color': hazardPalette.feature,
          'line-width': 1.5,
          'line-dasharray': [4, 2],
        },
      });
      // The hazard being authored — rendered as the real metric footprint (circle or buffered band)
      // so the skater sizes it against the lake, not against a fixed-pixel dot. Colour runs through
      // the same expression as saved hazards, so a `ridge_crossing` previews green rather than red.
      map.addSource('hazard-draft', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'hazard-draft-fill',
        type: 'fill',
        source: 'hazard-draft',
        paint: {
          'fill-color': hazardColorExpression(hazardPalette) as maplibregl.ExpressionSpecification,
          'fill-opacity': 0.35,
        },
      });
      map.addLayer({
        id: 'hazard-draft-outline',
        type: 'line',
        source: 'hazard-draft',
        paint: {
          'line-color': hazardColorExpression(hazardPalette) as maplibregl.ExpressionSpecification,
          'line-width': 2,
        },
      });
      // The clicked vertices themselves. A polyline's first click produces no band yet (one point
      // isn't a line), so without these dots the draw would begin with no feedback at all.
      map.addLayer({
        id: 'hazard-draft-vertices',
        type: 'circle',
        source: 'hazard-draft',
        filter: ['==', ['get', 'role'], 'vertex'],
        paint: {
          'circle-radius': 5,
          'circle-color': hazardColorExpression(
            hazardPalette,
          ) as maplibregl.ExpressionSpecification,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });

      // A single map-click handler: in pin-drop mode (§E) the next tap sets the put-in pin; otherwise
      // tapping a water body opens its drawer (D47). Reads pin-drop mode via ref (handler is bound once).
      map.on('click', (e) => {
        if (pinDropModeRef.current) {
          setPutInPinRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
          setPinDropModeRef.current(false);
          return;
        }
        if (hazardDropModeRef.current) {
          handleHazardClickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
          return;
        }
        // Hazards sit above water bodies in hit-testing: a hazard footprint always lies *inside* a
        // lake, so if a click hits both, the more specific (and more safety-relevant) target wins.
        const hazardId = map.queryRenderedFeatures(e.point, { layers: ['hazard-fill'] })[0]
          ?.properties?.hazardId;
        if (typeof hazardId === 'string') {
          navigate({ to: '/hazard/$id', params: { id: hazardId } });
          return;
        }
        // A bounty pin sits on a lake centroid — a tap on the pin opens the bounty, not the lake.
        const bountyId = map.queryRenderedFeatures(e.point, { layers: ['bounty-pins'] })[0]
          ?.properties?.bountyId;
        if (typeof bountyId === 'string') {
          navigate({ to: '/bounty/$id', params: { id: bountyId } });
          return;
        }
        const id = map.queryRenderedFeatures(e.point, { layers: ['water-fill'] })[0]?.properties
          ?._id;
        if (typeof id === 'string') navigate({ to: '/water/$id', params: { id } });
      });
      map.on('mouseenter', 'water-fill', () => {
        if (!pinDropModeRef.current) map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'water-fill', () => {
        if (!pinDropModeRef.current) map.getCanvas().style.cursor = '';
      });
    },
  });

  // Push query results into the source once the style has loaded, then re-apply both paints.
  //
  // `setData` does **not** clear feature-state — MapLibre keeps it on the source cache, keyed by id,
  // and our ids are array indices (`waterBodiesToFeatureCollection`). So a pan silently rebinds every
  // painted id to whatever lake now sits at that index: favorite one lake, pan twice, and unrelated
  // bodies come back gold while their sheets correctly say they aren't favorited. MapLibre documents
  // this exact hazard for index-based ids ("you may need to re-apply state taking into account
  // updated `id` values").
  //
  // Clearing the whole source is what makes that safe. Removing only the ids we remember to track is
  // the narrower fix, but it re-introduces the same bug the moment a third paint is added and its
  // bookkeeping drifts — and stale state here is invisible until someone reports gold on the wrong lake.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyHighlight/applyFavorites read refs; run on data change.
  useEffect(() => {
    featuresRef.current = features;
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('water') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(features);
    map.removeFeatureState({ source: 'water' });
    highlightedFeatureRef.current = null;
    favoriteFeaturesRef.current = [];
    applyHighlight();
    applyFavorites();
  }, [features, loaded]);

  // Push the bay layer whenever it changes. Its own source, so a pan that changes one collection and
  // not the other doesn't redraw both.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource('sub-areas') as maplibregl.GeoJSONSource | undefined)?.setData(subAreaFeatures);
  }, [subAreaFeatures, loaded, mapRef.current]);

  // Push the summary cards. Its own source for the same reason the bays have one: a pan that changes
  // which lakes have news should not redraw the water fill.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource('summary-cards') as maplibregl.GeoJSONSource | undefined)?.setData(
      summaryFeatures,
    );
  }, [summaryFeatures, loaded, mapRef.current]);

  // Re-apply the highlight when the selected body changes (deep-link or navigating between lakes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyHighlight reads refs; re-run on selection.
  useEffect(() => {
    applyHighlight();
  }, [highlightWaterBodyId, loaded]);

  // Re-paint favorites when the viewer's favorite set changes (toggling a heart).
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyFavorites reads refs; re-run on set change.
  useEffect(() => {
    applyFavorites();
  }, [favoriteIds, loaded]);

  // Put-in markers for the focused lake (Phase 4, decision #7) — cleared when no lake is selected.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('put-in-markers') as maplibregl.GeoJSONSource | undefined;
    source?.setData(putInsToFeatureCollection(putIns ?? []));
    // The approach lines ride the same query and the same effect, deliberately: they are drawn from
    // the markers themselves, so a launch and its walk can never disagree about whether it is there.
    const approaches = map.getSource(APPROACH_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    approaches?.setData(approachesToFeatureCollection(putIns ?? []));
  }, [putIns, loaded, mapRef.current]);

  // The recorded path behind the open report (Phase 8) — cleared when the drawer closes. The drawer
  // pushes it up rather than the map fetching it, matching how photo pins already work: the map is
  // persistent across navigations and shouldn't know which report is open.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('tracks') as maplibregl.GeoJSONSource | undefined;
    // A single report's own path (drawer open) takes precedence over the lake-wide aggregate: when
    // you're reading one report, that report's line is the subject, at full strength.
    if (trackPath) {
      source?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: trackPath, properties: { opacity: 1 } }],
      });
      return;
    }
    source?.setData({
      type: 'FeatureCollection',
      features: (aggregateTracks?.tracks ?? []).map((t) => ({
        type: 'Feature' as const,
        geometry: t.path,
        // Server-computed from the linked report's D59 freshness — the map never re-derives decay.
        properties: { opacity: t.opacity },
      })),
    });
  }, [trackPath, aggregateTracks, loaded, mapRef.current]);

  // Hazard footprints for the focused lake (Phase 9) — cleared when no lake is selected.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('hazards') as maplibregl.GeoJSONSource | undefined;
    source?.setData(hazardsToFeatureCollection(hazards ?? []));
  }, [hazards, loaded, mapRef.current]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('body-features') as maplibregl.GeoJSONSource | undefined;
    source?.setData(bodyFeaturesToFeatureCollection(bodyFeatures ?? []));
  }, [bodyFeatures, loaded, mapRef.current]);

  // ── Bathymetric contours for the open lake (N6b / D81 / D82).
  //
  // **The one layer in this file that is not added at map init**, and that is the decision rather
  // than an optimisation: contours are a property of the detail view, so the source is added when a
  // lake's drawer opens and removed when it closes. The browse map's tile budget is exactly what it
  // was before this phase, and there is no toggle, no persisted preference and no settings row —
  // the visibility is derived from something the app already knows, which body is selected.
  //
  // Three things it must not do, in the order they would go wrong:
  //
  // 1. **Draw over a hazard.** Contours are decoration and hazards are the product, so the layer is
  //    inserted *beneath* the first bay layer — under every pin, track and hazard added after it.
  // 2. **Pop in.** *"Fading in on open reads as a detail revealing itself; popping in reads as a
  //    bug."* It mounts invisible and fades only once its own lines are on screen, so the fade also
  //    covers the tile fetch rather than racing it.
  // 3. **Draw with no credit.** The tile is the authority on who surveyed this lake, so the drawn
  //    features are read back and the drawer's credit line comes from them (§5).
  //
  // Blank `bathymetryPmtilesUrl` ⇒ this never runs, which is correct rather than degraded: under
  // D82 contours make no claim, so an unconfigured deployment shows a flat lake exactly as it does
  // for the majority of bodies no agency ever surveyed.
  const contourCreditRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    const archiveUrl = env.bathymetryPmtilesUrl;
    if (!map || !loaded || !archiveUrl || !contourBodyKey) return;

    const filter = contourFilter(contourBodyKey) as maplibregl.FilterSpecification;
    map.addSource(CONTOUR_SOURCE_ID, contourSourceSpec(archiveUrl));
    map.addLayer(
      {
        id: CONTOUR_LAYER_ID,
        type: 'line',
        source: CONTOUR_SOURCE_ID,
        'source-layer': CONTOUR_SOURCE_LAYER,
        // A guard rail, not the mechanism (D81 already keeps contours off the browse map): a drawer
        // can be open while the camera is zoomed out, and a lake's isobaths at z6 are a smear.
        minzoom: CONTOUR_MIN_ZOOM,
        filter,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          // Replaced by the real ramp before anything is visible — see `readDrawnContours`.
          'line-color': contourPalette.deep,
          'line-width': contourWidthExpression() as maplibregl.ExpressionSpecification,
          'line-opacity': 0,
          'line-opacity-transition': { duration: CONTOUR_FADE_MS, delay: 0 },
        },
      },
      map.getLayer(CONTOUR_BEFORE_LAYER_ID) ? CONTOUR_BEFORE_LAYER_ID : undefined,
    );

    // The deepest ring seen for *this* lake, which only ever grows. `querySourceFeatures` answers
    // from the tiles currently loaded, so panning the deep end off screen would otherwise re-scale
    // the ramp under the skater and repaint a lake they are looking at but not touching.
    let deepestFt = 0;
    let faded = false;
    const readDrawnContours = () => {
      if (!map.getLayer(CONTOUR_LAYER_ID)) return;
      const properties = map
        .querySourceFeatures(CONTOUR_SOURCE_ID, { sourceLayer: CONTOUR_SOURCE_LAYER, filter })
        .map((feature) => feature.properties as Partial<ContourFeatureProperties>);
      // No tiles in yet, or a lake nobody surveyed. Either way keep the last answer rather than
      // clearing a credit that is still true for the lines on screen.
      if (properties.length === 0) return;

      const line = formatContourCredit(contourCredit(properties)) || null;
      if (line !== contourCreditRef.current) {
        contourCreditRef.current = line;
        setContourCredit(line);
      }

      // The reveal is its own decision, taken the moment ANY of this lake's lines are readable.
      // Deliberately not folded into the ramp update below: a lake whose deepest drawn ring reads
      // 0 would otherwise never pass `deepest > deepestFt` and would stay permanently invisible
      // while its credit row rendered — a flat lake with an attribution under it.
      if (!faded) {
        faded = true;
        map.setPaintProperty(CONTOUR_LAYER_ID, 'line-opacity', CONTOUR_OPACITY);
      }

      const deepest = maxContourDepthFt(properties);
      if (deepest === undefined || deepest <= deepestFt) return;
      deepestFt = deepest;
      map.setPaintProperty(
        CONTOUR_LAYER_ID,
        'line-color',
        contourColorExpression(contourPalette, deepestFt) as maplibregl.ExpressionSpecification,
      );
    };
    // **`sourcedata` for this source, and NOT `idle`** — the one thing in the render half that a
    // render had to find. `idle` reads correctly ("the tiles for the settled view are in") and is
    // simply never delivered: a source added *after* `load` leaves the map in a state where
    // MapLibre stops emitting `idle` entirely, so the only read that ever ran was the synchronous
    // one below — before a single tile existed. It returned nothing, the layer never left
    // `line-opacity: 0`, and every lake rendered flat with no credit and no error anywhere.
    //
    // `sourcedata` also keeps the ramp honest while panning, which `idle` was chosen for: a tile
    // arriving with a deeper ring is exactly a `sourcedata` event.
    //
    // **Every event for this source, with no further filter.** Narrowing to `event.tile` or
    // `event.isSourceLoaded` is the tidy-looking version and it drops the only event that matters —
    // the one delivering tile content arrives as `sourceDataType: 'content'` carrying neither.
    // Measured rather than reasoned, because reasoning about this is what produced the bug above.
    // `readDrawnContours` is its own guard: it returns on an empty read, which is every event before
    // the data is there.
    const onContourSourceData = (event: maplibregl.MapSourceDataEvent) => {
      if (event.sourceId !== CONTOUR_SOURCE_ID) return;
      readDrawnContours();
    };
    map.on('sourcedata', onContourSourceData);
    readDrawnContours();

    return () => {
      map.off('sourcedata', onContourSourceData);
      contourCreditRef.current = null;
      setContourCredit(null);
      try {
        if (map.getLayer(CONTOUR_LAYER_ID)) map.removeLayer(CONTOUR_LAYER_ID);
        if (map.getSource(CONTOUR_SOURCE_ID)) map.removeSource(CONTOUR_SOURCE_ID);
      } catch {
        // The shell's own cleanup runs first on unmount, so by here the map may already be gone and
        // MapLibre throws rather than no-opping. Nothing is leaked — the map took the style with it.
      }
    };
  }, [contourBodyKey, contourPalette, loaded, mapRef.current, setContourCredit]);

  // ── The aerial reveal for the open lake (N6e / D146).
  //
  // The mask is a union of the water, the walk and the parking, so it is rebuilt only when one of
  // those three changes — a memo and not an effect, because a new object identity here tears the
  // raster down and re-adds it, which against a dynamic renderer we don't own means re-rendering
  // every tile. `null` whenever the reveal is off, which is also how "no lake open" arrives.
  //
  // **Identity is cached against a key, and that is the fix for a visible bug rather than a
  // micro-optimisation.** `features` is replaced every time the viewport subscription re-emits, and
  // a Convex subscription re-emits on its own schedule — so a plain memo over `features` handed back
  // a new object roughly once a second, tearing the raster down and re-adding it each time. On
  // screen that was a steady flicker of the road map showing through the photograph. Keying on what
  // the mask is actually *made of* means a re-emit carrying identical geometry returns the identical
  // object, and the reveal effect never runs again.
  // Each replaced layer's filter as the style defined it, captured the first time we compose over it
  // — so the reveal's "not these bodies" clause can be removed without taking the layer's own rule
  // with it. `sub-area-label` filters on `label`, and losing that draws every outline as a label.
  const baseFiltersRef = useRef(new Map<string, unknown>());
  const revealMasksRef = useRef<{ key: string; masks: KeyedMask[] } | null>(null);
  const revealMasks = useMemo(() => {
    // **Gated on the zoom the reveal itself is gated on.** The hook declines to fetch below
    // `IMAGERY_MIN_ZOOM`, and the cartography has to agree with it: a reveal set the photograph never
    // arrives for still filters `water-fill` off every body on screen, whites their outlines and
    // hides the hazard layers — so zooming out used to turn the whole viewport into empty outlines
    // with nothing drawn in their place.
    if (!imageryOn || (queryArgs?.zoom ?? 0) < IMAGERY_MIN_ZOOM) return null;
    const launches = putIns ?? [];
    // The open lake's access is part of *its* reveal and nothing else's: `putIns` is a per-body
    // query, so the other bodies on screen have water and no walk. That is the correct asymmetry
    // rather than a gap — a lake you have not opened has no approach drawn over it either.
    const accessKey = launches
      .map((p) => `${p.coord.lat},${p.coord.lng},${p.approachPath?.length ?? 0}`)
      .join(';');

    const entries: KeyedMask[] = [];
    for (const feature of features.features) {
      const id = feature.properties?._id;
      const polygon = feature.geometry;
      if (typeof id !== 'string') continue;
      if (polygon?.type !== 'Polygon' && polygon?.type !== 'MultiPolygon') continue;
      const open = id === highlightWaterBodyId;
      entries.push({
        id,
        // The key is what caches the buffered shape in the hook, so it has to change exactly when
        // the geometry or the access does — hence the signature rather than object identity, and
        // hence the access half only on the body that has any.
        key: `${id}|${shapeSignature(polygon)}|${open ? accessKey : ''}`,
        mask: {
          polygon,
          // Only routed hike-in legs carry a path, which is the correct set — a drive-up ramp's
          // walk is already inside the water's own buffer. See `approachLayer`'s module note.
          approachPaths: open
            ? launches.flatMap((p) => (p.approachPath ? [p.approachPath] : []))
            : undefined,
          markerCoords: open ? launches.map((p) => p.coord) : undefined,
        },
      });
    }
    if (entries.length === 0) return null;

    // Identity is cached against the joined keys, and that is a fix for a visible bug rather than a
    // micro-optimisation. `features` is replaced every time the viewport subscription re-emits, and
    // a Convex subscription re-emits on its own schedule — so a plain memo handed back a new array
    // roughly once a second, tearing the reveal down and re-adding it each time. On screen that was
    // a steady flicker of the road map through the photograph.
    const key = entries.map((entry) => entry.key).join('~');
    if (revealMasksRef.current?.key === key) return revealMasksRef.current.masks;
    revealMasksRef.current = { key, masks: entries };
    return entries;
  }, [imageryOn, highlightWaterBodyId, features, putIns, queryArgs?.zoom]);

  /** The ids with a photograph under them — what the cartography has to agree with. */
  const revealedIds = useMemo(() => (revealMasks ?? []).map((entry) => entry.id), [revealMasks]);

  const [imageryLoading, setImageryLoading] = useState(false);
  // **What actually has a photograph on it**, as opposed to what is queued for one. The cartography
  // keys off this and the loading pulse keys off `revealedIds` — see `onPaintedChange`. Held in
  // state rather than a ref because three effects read it and all three have to re-run when it moves.
  const [paintedIds, setPaintedIds] = useState<readonly string[]>(EMPTY_IDS);
  useImageryReveal({
    map: mapRef.current,
    loaded,
    masks: revealMasks,
    onLoadingChange: setImageryLoading,
    onPaintedChange: setPaintedIds,
  });

  // ## Tier 2 — the freeze-up timeline (N6e §C, D148)
  //
  // Rides the same switch as the aerial rather than getting its own. D146's rule is one control per
  // lake, and the founder's open question — whether these ever want separate affordances — is
  // explicitly a "look at it first" call, so this is the version that can be looked at.
  //
  // The archived frame sits **above** the aerial canvas, so scrubbing to a date replaces the
  // photograph inside the mask and closing the scrubber reveals it again. Both are clipped to the
  // same shapes, so nothing outside the lake changes hands.
  const [freezeUpBand, setFreezeUpBand] = useState('visual');
  const [freezeUpStop, setFreezeUpStop] = useState<number | null>(null);
  const timelineBody = useQuery(
    api.waterBodies.get,
    imageryOn && highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> }
      : 'skip',
  );
  const {
    timeline: freezeUpTimeline,
    loading: freezeUpLoading,
    season: freezeUpSeason,
    index: freezeUpIndex,
    error: freezeUpError,
  } = useFreezeUpTimeline({
    // ⚠ `available: false` is a delisting — a takedown or a moderator's rejection — and it must reach
    // here as "no lake" rather than as an empty one. `imageryMasks` already refuses to bake a mask
    // for a delisted body, so the archive has no pixels to offer; passing the absent case through
    // keeps the two ends agreeing instead of asking for frames that were never cut.
    body: timelineBody?.available ? timelineBody.body : null,
    band: freezeUpBand,
    enabled: Boolean(imageryOn && highlightWaterBodyId),
  });

  // A new lake is a new timeline, and a stop index into the old one means nothing against the new
  // stops. Clearing lets the scrubber's own effect re-open on the most recent usable pass.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting *because* the lake or band changed is the point.
  useEffect(() => {
    setFreezeUpStop(null);
  }, [highlightWaterBodyId, freezeUpBand]);

  const freezeUpSelected =
    freezeUpStop !== null ? (freezeUpTimeline?.stops[freezeUpStop] ?? null) : null;
  useFreezeUpFrame({
    mapRef,
    loaded,
    frame: freezeUpSelected?.frame ?? null,
    season: freezeUpSeason,
  });
  // The other half of a bisected lake (§C4's seam). Its own slot, so scrubbing to a date with no
  // companion tears down exactly this one and leaves the primary alone. Both are alpha-masked to the
  // same corpus shapes, so they abut along the granule edge that split them rather than overlapping.
  useFreezeUpFrame({
    mapRef,
    loaded,
    frame: freezeUpSelected?.companion?.frame ?? null,
    season: freezeUpSeason,
    slot: 'companion',
  });
  // The hairline where the two meet. Derived from the *primary* footprint, because that is the frame
  // drawn on top and therefore the one whose edge is the visible join — clipped to the lake, since
  // the same granule edge also runs a hundred kilometres across land nobody is looking at.
  useFreezeUpSeam({
    mapRef,
    loaded,
    footprint: freezeUpSelected?.companion ? (freezeUpSelected.frame.footprint ?? null) : null,
    body: polygonOf(timelineBody?.available ? timelineBody.body.polygon : null),
  });

  // The wash belongs on the bodies still **waiting** for a photograph — the reveal set minus whatever
  // is already on screen. Pulsing a lake that is already showing its imagery says the wrong thing
  // twice: that something is coming for it, and that what is there is not it.
  //
  // **Unless nothing is waiting and we are still loading**, which is the *fidelity* refresh — zoom in
  // on a revealed lake and a sharper level is fetched while the coarser one stays up. Every body is
  // painted, so the difference is empty, and taking that literally would remove the wash from the
  // exact case `onLoadingChange`'s docstring calls the subtle one: nothing appears broken and nothing
  // appears to be happening either. A refresh with nothing outstanding is a refresh of all of it.
  const pendingIds = useMemo(() => {
    const waiting = revealedIds.filter((id) => !paintedIds.includes(id));
    return waiting.length > 0 ? waiting : revealedIds;
  }, [revealedIds, paintedIds]);

  // Layers step aside for the photograph, except the ones the skater decides about.
  //
  // Two effects rather than one, and deliberately: the replaced set is ours (the A3 table) and the
  // hazard set is the skater's. Folding them together would put a safety layer's visibility inside a
  // code path that also owns cartography.
  //
  // **Per feature where the feature can be asked, per layer where it cannot** (v3). A `visibility`
  // flip is all-or-nothing, so revealing one pond stripped the fill, the sub-area labels and the
  // tracks from every lake on screen — and now that the reveal covers the viewport, the set that
  // keeps its cartography is exactly the set that did not get pixels. `setLayersHiddenForBodies`
  // composes with each layer's own filter rather than replacing it, which `sub-area-label` depends
  // on. Tracks and contours are drawn only for the open lake and carry no body id to filter on, so
  // they keep the wholesale flip — see `IMAGERY_REPLACED_WHOLE_LAYERS`.
  //
  // **`contourBodyKey` is in the deps and is not decoration.** This started as a callback fired once
  // when the reveal mounted, which is wrong for any layer that can be re-added underneath it — and
  // the contour layer is exactly that: its own effect adds it on drawer-open and would hand back a
  // visible isobath set over the photograph. Re-running whenever either changes is what makes the
  // suppression a *state* rather than an event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contourBodyKey is a re-run trigger, not a read — the contour effect re-adds its layer on drawer-open and this has to re-hide it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    setLayersHiddenForBodies(map, IMAGERY_REPLACED_LAYERS, paintedIds, baseFiltersRef.current);
    setLayersVisible(map, IMAGERY_REPLACED_WHOLE_LAYERS, paintedIds.length === 0);
    // The shoreline survives the reveal and changes job while it does — status colour off the vector
    // map, edge-of-the-photograph on it. Set here rather than in the reveal hook because the layer
    // belongs to the map's own init, and the hook owns only what it added.
    if (map.getLayer('water-outline')) {
      map.setPaintProperty(
        'water-outline',
        'line-color',
        waterOutlineColor(flavor, paintedIds) as never,
      );
    }
  }, [paintedIds, loaded, contourBodyKey, flavor, mapRef.current]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    // Hazards are visible unless the skater has *chosen* to hide them while looking at imagery —
    // never merely because imagery is on (D81's safety line, and the founder's toggle answering it).
    setLayersVisible(map, IMAGERY_HAZARD_LAYERS, paintedIds.length === 0 || hazardsOverImagery);
  }, [paintedIds, hazardsOverImagery, loaded, mapRef.current]);

  // The gentle wash over the lake while its photograph is on the way (N6e).
  //
  // **Two states look identical without it**, which is why a spinner alone would not have been
  // enough: a first fetch on a big lake takes seconds, and a *fidelity* refresh on zoom-in leaves a
  // usable coarser image on screen the whole time. The pulse says "something is arriving" in both,
  // on the lake it is arriving for.
  //
  // Driven by an interval rather than a CSS animation because the thing being animated is a MapLibre
  // paint property; the transition does the easing, so this only has to flip a target twice a cycle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !map.getLayer(IMAGERY_LOADING_LAYER_ID)) return;
    if (!imageryLoading || pendingIds.length === 0) {
      map.setPaintProperty(IMAGERY_LOADING_LAYER_ID, 'fill-opacity', 0);
      return;
    }
    // Every body awaiting pixels, not just the open one — with the reveal covering the viewport, a
    // pulse on one lake while five others sit blank would say the wrong thing about which is loading.
    map.setFilter(IMAGERY_LOADING_LAYER_ID, ['in', ['get', '_id'], ['literal', [...pendingIds]]]);
    let bright = true;
    map.setPaintProperty(IMAGERY_LOADING_LAYER_ID, 'fill-opacity', IMAGERY_PULSE_MAX);
    const timer = setInterval(() => {
      bright = !bright;
      map.setPaintProperty(
        IMAGERY_LOADING_LAYER_ID,
        'fill-opacity',
        bright ? IMAGERY_PULSE_MAX : IMAGERY_PULSE_MIN,
      );
    }, IMAGERY_PULSE_MS);
    return () => {
      clearInterval(timer);
      if (map.getLayer(IMAGERY_LOADING_LAYER_ID)) {
        map.setPaintProperty(IMAGERY_LOADING_LAYER_ID, 'fill-opacity', 0);
      }
    };
  }, [imageryLoading, pendingIds, loaded, mapRef.current]);

  // When was this lake last photographed? (N6e B2.)
  //
  // One `identify` per reveal, straight from the client — the service is keyless and CORS-open, so a
  // round trip through Convex would buy nothing but a hop. **Deliberately not a stored field yet:**
  // the answer changes about once every 2–3 years per state, so caching it belongs in an ETL pass
  // keyed on the service's `Year`, not in a schema column written by whoever opened the drawer first.
  //
  // A failure is silence, never a guess. `null` renders as no date at all, which is the correct
  // output for a body outside NAIP coverage and for a service having a bad afternoon alike — the one
  // unacceptable answer here is a plausible year we made up (D147).
  useEffect(() => {
    // The caption is about **the open lake**, not the viewport: it sits in that lake's drawer, and a
    // date averaged over whatever else happens to be on screen would be a claim about nothing. Read
    // off the reveal set rather than off `features` so it is stable across a subscription re-emit.
    const open = revealMasks?.find((entry) => entry.key.startsWith(`${highlightWaterBodyId}|`));
    if (!imageryOn || !open) return;
    // `representativePoint` lands *on* the shoreline (it is Turf's `pointOnFeature`), and here that
    // is fine: NAIP photographs land and water alike, and a quarter-quad scene is far larger than
    // the error. It is emphatically **not** fine for Workstream D's Copernicus link, which opens a
    // browser centred on the point — hence the stored `interiorPoint` there and this one here.
    const centre = representativePoint(open.mask.polygon);
    const controller = new AbortController();
    fetch(aerialIdentifyUrl(centre), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const scene = parseAerialScene(body);
        setAerialCaptureLabel(scene ? formatAerialCaptureDate(scene.capturedAt) : null);
      })
      .catch(() => {
        // Includes the abort on drawer-close, which is not a failure worth reporting.
      });
    return () => controller.abort();
  }, [imageryOn, revealMasks, highlightWaterBodyId, setAerialCaptureLabel]);

  // Open-bounty pins across the viewport (D10/D17) — refreshed as the map pans + as bounties change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('bounty-pins') as maplibregl.GeoJSONSource | undefined;
    source?.setData(bountiesToPins(openBounties ?? []));
  }, [openBounties, loaded, mapRef.current]);

  // The hazard being authored — a real metric footprint, updated live as vertices land and the size
  // changes, so what you see while drawing is what gets stored.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('hazard-draft') as maplibregl.GeoJSONSource | undefined;
    source?.setData(hazardDraftToFeatureCollection(hazardDraft, hazardDraftType));
  }, [hazardDraft, hazardDraftType, loaded, mapRef.current]);

  // Freeform polygon authoring (N5b) — the one skater-facing surface that loads terra-draw.
  //
  // It arms only while a *polygon* draft is in drop mode, so the ~218 kB chunk is fetched by the
  // person who asked for the tool and nobody else. Everything it produces goes back through the same
  // `@skating/core` draft the other two primitives use, which is what keeps the preview, the stored
  // row and the proximity footprint one shape whichever way the ring was made.
  //
  // Never while shore clicks are being collected. Re-picking a stretch leaves the *previous* band as
  // the draft, so without that condition "Pick a different stretch" would arm this editor on the old
  // ring at the same moment the banner asks for a shore click — two tools live on one canvas, each
  // claiming the next click, over a shape the skater is in the middle of replacing.
  const polygonArmed =
    hazardDropMode && hazardDraft?.geometryKind === 'polygon' && hazardShoreTaps === null;
  const polygonDrawRef = useRef<PolygonDrawControl | null>(null);
  const [drawUnavailable, setDrawUnavailable] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !polygonArmed) return;
    let cancelled = false;
    setDrawUnavailable(false);
    void (async () => {
      try {
        const control = await createPolygonDraw(map, {
          onChange: (polygon) => {
            const draft = hazardDraftRef.current;
            if (draft?.geometryKind !== 'polygon') return;
            setHazardDraftRef.current({ ...draft, vertices: polygonRingToVertices(polygon) });
          },
          // Straight from drawing into vertex editing: the ring is closed, and the next thing anyone
          // wants is to nudge a corner that landed in the wrong place.
          onFinish: () => polygonDrawRef.current?.startEditing(),
        });
        if (cancelled) {
          control.destroy();
          return;
        }
        polygonDrawRef.current = control;
        // A band that arrived by snapping is an ordinary polygon draft (N5b Decision 3) — hand it to
        // the editor rather than making the skater redraw it to adjust one corner.
        const existing = hazardDraftRef.current;
        const seed =
          existing?.geometryKind === 'polygon' && existing.vertices.length >= 3
            ? (polygonShape(existing.vertices, existing.bufferMeters).geometry as GeoJSON.Polygon)
            : null;
        if (seed) {
          control.setPolygon(seed);
          control.startEditing();
        } else {
          control.startDrawing();
        }
      } catch {
        // The chunk didn't load. Say so rather than leaving a dead "draw" mode on screen — the other
        // two primitives still work, and for a safety report that beats nothing being postable.
        if (!cancelled) setDrawUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
      polygonDrawRef.current?.destroy();
      polygonDrawRef.current = null;
    };
  }, [polygonArmed, loaded, mapRef.current]);

  // Fly to a drawer's focus (a lake centroid / report put-in) when it changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focus) return;
    // Bounds win when given: a bay's extent decides its own zoom, where one number can't (N2).
    if (focus.bounds) {
      map.fitBounds(
        [
          [focus.bounds.minLng, focus.bounds.minLat],
          [focus.bounds.maxLng, focus.bounds.maxLat],
        ],
        { padding: 48 },
      );
      return;
    }
    map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? map.getZoom() });
  }, [focus, loaded, mapRef.current]);

  // Report photo pins (D42) — only present when viewing a report whose photos opted into placeOnMap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('photo-pins') as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: photoPins.map((pin) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pin.coord.lng, pin.coord.lat] },
        properties: { photoId: pin.photoId },
      })),
    });
  }, [photoPins, loaded, mapRef.current]);

  // The put-in pin the report form is placing (§E): render it, and show a crosshair while arming.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource('put-in-pin') as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: putInPin
        ? [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [putInPin.lng, putInPin.lat] },
              properties: {},
            },
          ]
        : [],
    });
  }, [putInPin, loaded, mapRef.current]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.getCanvas().style.cursor = pinDropMode || hazardDropMode ? 'crosshair' : '';
  }, [pinDropMode, hazardDropMode, loaded, mapRef.current]);

  // Home/water framing on open via the browser Geolocation API (D12/D20): a fix inside the pilot
  // region recenters there; otherwise the default Northeast framing stands. Skipped on a deep-linked
  // drawer, which frames on its own target instead (see `geolocateOnMount`).
  useEffect(() => {
    if (!geolocateOnMount || typeof navigator === 'undefined' || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const map = mapRef.current;
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (!cancelled && map && frame) map.jumpTo({ center: frame.center, zoom: frame.zoom });
      },
      () => {}, // denied/unavailable ⇒ keep the default framing
      { timeout: 8000, maximumAge: 60_000 },
    );
    return () => {
      cancelled = true;
    };
  }, [geolocateOnMount, mapRef.current]);

  return (
    // The map fills its column. Two elements, and the split between them is load-bearing:
    //
    // The **wrapper** is `absolute inset-0`, which takes its size from the layout's positioned map
    // cell without a percentage height having to resolve down a chain of stretched flex items.
    //
    // The **container** — the element MapLibre is handed — must NOT be positioned by us, because
    // MapLibre adds its own `.maplibregl-map` class the moment it takes ownership, and that class
    // declares `position: relative`. Tailwind's `.absolute` is the same specificity and loses on
    // source order, so an `absolute inset-0` container silently flips to `relative` with auto
    // height, collapses to zero (every child it has is absolutely positioned), and the map vanishes
    // — after MapLibre has already measured 300px for its canvas, since it measures *after* adding
    // the class. `h-full` against an absolutely-sized wrapper is immune: it's a height, not a
    // position, so there's nothing for MapLibre's stylesheet to override.
    //
    // No fixed height (it was `75vh`, from when the map was a block on a scrolling page) and no
    // rounding or border: it is the surface now, not a card on one.
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      <ReturnToRegion
        visible={regionOffscreen}
        onReturn={() =>
          mapRef.current?.flyTo({ center: INITIAL_CENTER, zoom: INITIAL_ZOOM, duration: 900 })
        }
      />
      {/* Only where a lake is open (D146). Hidden while the hazard author has the map, because two
          overlapping "click the map" affordances is one too many. */}
      <ImageryControl
        visible={Boolean(highlightWaterBodyId) && !hazardDropMode && !pinDropMode}
        imageryOn={imageryOn}
        onToggleImagery={setImageryOn}
        hazardsOn={hazardsOverImagery}
        onToggleHazards={setHazardsOverImagery}
        captureLabel={aerialCaptureLabel}
        loading={imageryLoading}
        hasHazards={(hazards?.length ?? 0) > 0}
      />
      {/* **Over the map, not in the drawer** (founder, 2026-08-25). The scrubber is a control for
          what the map is showing, so it belongs on the thing it changes — and on mobile D146 already
          settled the same question the same way, where the sheet collapses to reveal it. Bottom-left
          keeps it clear of the imagery toggle at top-right and of MapLibre's attribution ⓘ at
          bottom-right, which is the affordance carrying the ODbL obligation and must stay reachable. */}
      {/* `imageryArchiveUrl` gates the panel itself: with no archive configured there is nothing to
          scrub and nothing true to say about why, so the correct render is none at all — the same
          call the bathymetry layer makes when its own URL is blank. */}
      {env.imageryArchiveUrl &&
      imageryOn &&
      highlightWaterBodyId &&
      !hazardDropMode &&
      !pinDropMode ? (
        <div className="absolute bottom-4 left-4 z-10 max-w-[min(28rem,calc(100%-2rem))] rounded-md bg-background/95 p-3 shadow-lg">
          <FreezeUpScrubber
            timeline={freezeUpTimeline}
            index={freezeUpIndex}
            band={freezeUpBand}
            onBandChange={setFreezeUpBand}
            selected={freezeUpStop}
            onSelect={setFreezeUpStop}
            loading={freezeUpLoading}
            error={freezeUpError}
          />
        </div>
      ) : null}
      {/* The drawing bar. A circle needs one click and no controls, so it just says so; a polyline
          is a multi-click session and gets its own Undo/Done, kept on the map rather than in the
          form because the form is hidden for the whole draw.
          It's a live region because arming placement mode is otherwise *entirely* silent: the dialog
          vanishes and the only feedback is a colour bar. The polyline running point count announces
          through the same region, which is the only progress signal a non-visual trace has. */}
      {hazardDropMode ? (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-center gap-3 rounded-t-lg bg-destructive px-4 py-2 text-destructive-foreground text-sm shadow"
        >
          {hazardShoreTaps !== null ? (
            <>
              <span>
                {hazardShoreTaps.length === 0
                  ? 'Click one end of the affected shore.'
                  : 'Now click the other end.'}{' '}
                The band follows the lake’s own shoreline between them.
              </span>
              <button
                type="button"
                className="rounded-md bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30"
                onClick={() => {
                  setHazardShoreTaps(null);
                  setHazardDropMode(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : hazardDraft?.geometryKind === 'polygon' ? (
            <>
              <span>
                {/* The instruction stands until there are three corners, not just at zero: switching
                    a placed circle to an area carries its centre over as a lone corner, and terra-draw
                    starts a fresh ring regardless — so "1 corners, drag any of them" would be both
                    ungrammatical and a lie about what the next click does. */}
                {drawUnavailable
                  ? 'The area tool couldn’t load. Mark it as a spot or a line instead — both work fine.'
                  : draftPlacementCount(hazardDraft) < 3
                    ? 'Click each corner of the area, then click the first one again to close it.'
                    : `${draftPlacementCount(hazardDraft)} corners — drag any of them to adjust.`}
              </span>
              <button
                type="button"
                className="rounded-md bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30"
                onClick={() => setHazardDropMode(false)}
              >
                Done
              </button>
            </>
          ) : hazardDraft?.geometryKind === 'line' ? (
            <>
              <span>
                Click along the hazard to trace it. {draftPlacementCount(hazardDraft)}{' '}
                {draftPlacementCount(hazardDraft) === 1 ? 'point' : 'points'} —{' '}
                {isDraftSubmittable(hazardDraft)
                  ? 'looking good'
                  : 'at least two are needed for a line'}
                .
              </span>
              <button
                type="button"
                className="rounded-md bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30 disabled:opacity-50"
                disabled={draftPlacementCount(hazardDraft) === 0}
                onClick={() => setHazardDraft(undoDraftPlacement(hazardDraft))}
              >
                Undo point
              </button>
              <button
                type="button"
                className="rounded-md bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30"
                onClick={() => setHazardDropMode(false)}
              >
                Done
              </button>
            </>
          ) : (
            <>
              <span>Click the map where the hazard is.</span>
              <button
                type="button"
                className="rounded-md bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30"
                onClick={() => setHazardDropMode(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      ) : null}
      {pinDropMode ? (
        // Same reasoning as the hazard bar above: arming pin-drop hides the form, so this bar is the
        // only announcement that anything happened.
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 rounded-t-lg bg-primary px-4 py-2 text-primary-foreground text-sm shadow"
        >
          <span>Tap the map to set the access point.</span>
          <button
            type="button"
            className="rounded-md bg-primary-foreground/20 px-2 py-0.5 font-medium hover:bg-primary-foreground/30"
            onClick={() => setPinDropMode(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
