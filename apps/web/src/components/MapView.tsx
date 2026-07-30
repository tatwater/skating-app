import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  applyDraftMapClick,
  type BBox,
  draftPlacementCount,
  isDraftSubmittable,
  type LatLng,
  polygonShape,
  SUB_AREA_MIN_RENDER_ZOOM,
  undoDraftPlacement,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useTheme } from 'next-themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { env } from '../lib/env';
import {
  bodyFeaturesToFeatureCollection,
  HAZARD_PALETTE,
  hazardColorExpression,
  hazardDraftToFeatureCollection,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
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
  NORTHEAST_MAX_BOUNDS,
  OSM_ATTRIBUTION,
  putInsToFeatureCollection,
  SUB_AREA_PALETTE,
  subAreasToFeatureCollection,
  TRACK_PALETTE,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
} from '../lib/waterMap';
import { useMapSelection } from './MapSelectionContext';

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
  } = useMapSelection();

  const [queryArgs, setQueryArgs] = useState<QueryArgs | null>(null);

  // Basemap flavor + icy water palette follow the app theme (D6/D34). The map re-creates on a theme
  // change (flavor is in the create-effect deps); `lastViewRef` preserves pan/zoom across that.
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light;
  const water = WATER_PALETTE[flavor];
  const subAreaPalette = SUB_AREA_PALETTE[flavor];
  const hazardPalette = HAZARD_PALETTE[flavor];
  const trackColor = TRACK_PALETTE[flavor];

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

  // The viewport bbox + zoom are the query key; 'skip' until the map's first `load` sets them.
  const bodies = useQuery(api.waterBodies.listInViewport, queryArgs ?? 'skip');

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FEATURES);
  useEffect(() => {
    if (bodies !== undefined) setFeatures(waterBodiesToFeatureCollection(bodies));
  }, [bodies]);

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
    flavor,
    maxBounds: NORTHEAST_MAX_BOUNDS,
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
          // Selected body reads brighter (D47 tap highlight).
          'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.6, 0.35],
        },
      });
      map.addLayer({
        id: 'water-outline',
        type: 'line',
        source: 'water',
        paint: {
          // Favorited bodies read gold (D#1); the selected/tapped body keeps the theme outline. A
          // favorited-and-selected body still shows gold — the favorite is the more persistent signal.
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'favorite'], false],
            '#eab308', // amber-500 — the favorite gold
            water.outline,
          ],
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
      // Put-in markers for the focused lake (Phase 4, decision #7): official markers read as a solid
      // teardrop-ish dot, derived clusters a lighter ring — both distinct from the report photo pins.
      map.addSource('put-in-markers', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'put-in-markers',
        type: 'circle',
        source: 'put-in-markers',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'case',
            ['==', ['get', 'source'], 'official'],
            '#0e7490', // cyan-700 — accurate, admin-set
            '#5b8fb0', // muted blue — approximate, derived
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
      map.addLayer({
        id: 'hazard-outline',
        type: 'line',
        source: 'hazards',
        paint: {
          'line-color': hazardColorExpression(hazardPalette) as maplibregl.ExpressionSpecification,
          'line-width': 1.5,
          // Dashed for provisional (one unverified report), solid once independently confirmed —
          // the same soft/hard distinction the on-ice alert makes (D54).
          'line-dasharray': [
            'case',
            ['get', 'provisional'],
            ['literal', [2, 2]],
            ['literal', [1, 0]],
          ],
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
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[75vh] w-full overflow-hidden rounded-lg border border-border"
      />
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
