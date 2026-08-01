import {
  Camera,
  type CameraRef,
  type FilterSpecification,
  GeoJSONSource,
  Layer,
  Map as MapGL,
  type PressEvent,
  type PressEventWithFeatures,
  VectorSource,
  type VectorSourceRef,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { applyDraftMapClick, type BBox, SUB_AREA_MIN_RENDER_ZOOM } from '@skating/core';
import { useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import { StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';
import { cacheBody } from '../lib/bodyCache';
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
import { ensureForegroundPermission } from '../lib/location';
import { ensureOfflineBasemap, resolveBasemapSource } from '../lib/offlineBasemap';
import {
  boundsToViewport,
  buildMapStyle,
  DEMO_PMTILES_URL,
  FAVORITE_OUTLINE_COLOR,
  frameForCoord,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MAP_FLAVORS,
  NORTHEAST_MAX_BOUNDS,
  PHOTO_PIN_COLOR,
  PUT_IN_MARKER_DERIVED_COLOR,
  PUT_IN_MARKER_OFFICIAL_COLOR,
  PUT_IN_PIN_COLOR,
  putInsToFeatureCollection,
  SUB_AREA_PALETTE,
  subAreasToFeatureCollection,
  TRACK_PALETTE,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from '../lib/waterMap';
import { useMapSelection } from './MapSelectionContext';

/**
 * Interactive native MapLibre map — the read side of the Phase 2 loop (§F, D5/D6/D47/D49), the
 * mobile mirror of web's `MapView`. This is the imperative native shell (excluded from unit tests
 * like web's WebGL shell); all pure logic (style, feature/viewport transforms, framing) lives in
 * `../lib/waterMap`. It stays mounted in the `(map)` layout beside a bottom-sheet `<Slot />`, so
 * panning/zoom survive opening a drawer.
 *
 * Data flow: the viewport bbox **and current zoom** (`onRegionDidChange`) drive `listInViewport` —
 * the zoom powers the D49 in-query prominence filter, so wide views return the few prominent bodies
 * instead of a read-capped slice. Tapping a body navigates to its `/water/[id]` drawer; the
 * highlight / fly-to focus / report photo pins come from `useMapSelection` (the drawers push them up
 * since they're siblings of this persistent map). RN has no `setFeatureState`, so the selection
 * highlight is a data-driven `filter` on dedicated layers rather than a feature-state flag.
 */
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** How long a hazard tap suppresses the water-body tap underneath it (one gesture's worth). */
const HAZARD_PRESS_PRECEDENCE_MS = 300;

// The initial query covers the whole pilot region at the state zoom, so the map shows the prominent
// bodies (Champlain, boosted Morey) immediately — before the first `onRegionDidChange` — then each
// pan/zoom refines it. Mirrors web's regional framing (Burlington, z6.5, Phase 2.5).
const INITIAL_QUERY: { viewport: BBox; zoom: number } = {
  viewport: {
    minLng: NORTHEAST_MAX_BOUNDS[0][0],
    minLat: NORTHEAST_MAX_BOUNDS[0][1],
    maxLng: NORTHEAST_MAX_BOUNDS[1][0],
    maxLat: NORTHEAST_MAX_BOUNDS[1][1],
  },
  zoom: Math.floor(INITIAL_ZOOM),
};

/**
 * Only seed the offline body cache once zoomed in to a browse level. Below this the viewport spans a
 * whole region and would cache dozens of bodies no one is looking at; at/above it the on-screen set is
 * small and is plausibly "lakes near where I am". A floor, not a guarantee — it just bounds the writes.
 */
const CACHE_SEED_MIN_ZOOM = 11;

export default function MapView({ geolocateOnMount }: { geolocateOnMount: boolean }) {
  const scheme = useColorScheme();
  const flavor = scheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light;
  const water = WATER_PALETTE[flavor];
  const subAreaPalette = SUB_AREA_PALETTE[flavor];
  const router = useRouter();
  const cameraRef = useRef<CameraRef>(null);
  const {
    highlightWaterBodyId,
    focus,
    photoPins,
    trackPath,
    putInPin,
    pinDropMode,
    setPutInPin,
    setPinDropMode,
    drawerCoveredFraction,
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
  } = useMapSelection();
  const { height: windowHeight } = useWindowDimensions();
  const hazardPalette = HAZARD_PALETTE[flavor];
  const trackColor = TRACK_PALETTE[flavor];
  const contourPalette = CONTOUR_PALETTE[flavor];
  /** When the hazard source last claimed a tap — see `onWaterPress` for why both sides check. */
  const hazardPressAtRef = useRef(0);

  // Basemap tiles: the demo archive is dated and Protomaps prunes old builds (it will 404), so it's
  // DEV-ONLY. A release build that omits EXPO_PUBLIC_PMTILES_URL must NOT silently fall back to it —
  // that ships a map destined to go blank. Instead we refuse to build a style (→ the blocking config
  // screen below), turning the misconfiguration into an immediate, obvious failure.
  const pmtilesUrl = env.pmtilesUrl || (__DEV__ ? DEMO_PMTILES_URL : '');

  // Layer-3 offline-basemap spike, route (1) (Phase 9.5) — flag-gated, off by default. When on, download
  // the regional archive once and render from the local `file://` copy so the map survives no signal.
  // Falls back to the remote URL on any failure, so this can never blank the map.
  const [localBasemapUri, setLocalBasemapUri] = useState<string | null>(null);
  useEffect(() => {
    if (!env.offlineBasemap || !pmtilesUrl) return;
    let active = true;
    void ensureOfflineBasemap(pmtilesUrl).then((uri) => {
      if (active) setLocalBasemapUri(uri);
    });
    return () => {
      active = false;
    };
  }, [pmtilesUrl]);

  const basemapSource = useMemo(
    () =>
      resolveBasemapSource({
        remoteUrl: pmtilesUrl,
        localUri: localBasemapUri,
        localReady: localBasemapUri !== null,
      }),
    [pmtilesUrl, localBasemapUri],
  );
  const mapStyle = useMemo(
    () => (basemapSource ? buildMapStyle(basemapSource, flavor) : null),
    [basemapSource, flavor],
  );

  // Viewport bbox + zoom are the query key; seeded to the region so data shows before the first
  // region event, then `onRegionDidChange` refines it.
  const [queryArgs, setQueryArgs] = useState<{ viewport: BBox; zoom: number }>(INITIAL_QUERY);
  const bodies = useQuery(api.waterBodies.listInViewport, queryArgs);
  // Named bays (N2/D60) — its own ladder-grid query. Rendering is not an operator affordance: mobile
  // draws the label, it just can't edit it (the Phase 7 rule).
  //
  // **Not subscribed below the zoom floor**: the server answers `[]` there, but that is still a
  // query execution and a subscription per viewport key, which on a phone is a round trip for an
  // answer known in advance. `SUB_AREA_MIN_RENDER_ZOOM` is shared with the server via `@skating/core`.
  const subAreaArgs = queryArgs.zoom >= SUB_AREA_MIN_RENDER_ZOOM ? queryArgs : ('skip' as const);
  const subAreas = useQuery(api.subAreas.listInViewport, subAreaArgs);

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  useEffect(() => {
    if (bodies !== undefined) setFeatures(waterBodiesToFeatureCollection(bodies));
  }, [bodies]);
  const [subAreaFeatures, setSubAreaFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  useEffect(() => {
    // Zooming back out clears the layer rather than leaving the last bays drawn over a regional view.
    if (subAreaArgs === 'skip') setSubAreaFeatures(EMPTY_FC);
    else if (subAreas !== undefined) setSubAreaFeatures(subAreasToFeatureCollection(subAreas));
  }, [subAreas, subAreaArgs]);

  // Seed the offline body cache from what's on screen when zoomed in (Phase 9 §Mobile). Until now the
  // cache filled only when a lake's *drawer* was opened, so on-ice detection missed a lake you were
  // standing on but had never tapped. Seeding here means simply looking at your lake caches it for
  // later no-signal capture. Online, the server resolver covers this already; this is the offline
  // safety net. Bounded: only past a browse-level zoom (so we don't cache a whole region at once) and
  // deduped per session so a stationary pan doesn't rewrite the same rows.
  const seededRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (bodies === undefined || queryArgs.zoom < CACHE_SEED_MIN_ZOOM) return;
    for (const body of bodies) {
      if (seededRef.current.has(body._id)) continue;
      seededRef.current.add(body._id);
      cacheBody({
        waterBodyId: body._id,
        name: body.name,
        states: body.states,
        polygon: body.polygon as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        centroid: body.centroid,
        surfaceAreaSqM: body.surfaceAreaSqM,
      });
    }
  }, [bodies, queryArgs.zoom]);

  const photoPinsFC = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: photoPins.map((pin) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pin.coord.lng, pin.coord.lat] },
        properties: { photoId: pin.photoId },
      })),
    }),
    [photoPins],
  );

  const putInPinFC = useMemo<GeoJSON.FeatureCollection>(
    () => ({
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
    }),
    [putInPin],
  );

  // The viewer's favorited bodies (Phase 4, decision #1) — the highlight is a data-driven `in` filter
  // on a dedicated outline layer (RN has no feature-state). Empty when signed out.
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {});
  const favoriteIds = useMemo(() => (favorites ?? []).map((f) => f.waterBodyId), [favorites]);

  // Put-in markers for the currently-focused lake (decision #7) — bounded to the open lake. `skip`
  // when nothing is selected.
  const putIns = useQuery(
    api.putIns.listForBody,
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const putInsFC = useMemo(() => putInsToFeatureCollection(putIns ?? []), [putIns]);

  // Hazards + known features for the focused lake (Phase 9, D54 Layer 0). Scoped to the open body,
  // not the viewport — hazards are only ever queried per body, which is what keeps this off the
  // path `listInViewport` needed two PRs to fix before N1 bounded it. A subscribed client gets new
  // hazards live; that reactive query *is* the sync layer.
  // `browseSeason` is how the sheet's season selector reaches the layers behind it (D63): the list
  // and the pins have to belong to the same winter. Put-ins above are exempt from the reset entirely,
  // and the on-ice banner deliberately never reads this — see `HazardBanner`.
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
  const hazardsFC = useMemo(() => hazardsToFeatureCollection(hazards ?? []), [hazards]);
  // The aggregate tracks layer (D58) for the open lake — scoped per body like hazards, never a
  // viewport scan. A single report's own path (sheet open) wins over the lake-wide aggregate: when
  // you're reading one report, that report's line is the subject, at full strength.
  const aggregateTracks = useQuery(
    api.gpsActivities.listTracksForBody,
    highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'>, ...seasonArg }
      : 'skip',
  );
  const tracksFC = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: trackPath
        ? [{ type: 'Feature', geometry: trackPath, properties: { opacity: 1 } }]
        : (aggregateTracks?.tracks ?? []).map((t) => ({
            type: 'Feature' as const,
            geometry: t.path,
            // Server-computed from the linked report's D59 freshness — never re-derived here.
            properties: { opacity: t.opacity },
          })),
    }),
    [trackPath, aggregateTracks],
  );
  const bodyFeaturesFC = useMemo(
    () => bodyFeaturesToFeatureCollection(bodyFeatures ?? []),
    [bodyFeatures],
  );
  const hazardDraftFC = useMemo(
    () => hazardDraftToFeatureCollection(hazardDraft, hazardDraftType),
    [hazardDraft, hazardDraftType],
  );

  // ── Bathymetric contours for the open lake (N6b / D81 / D82).
  //
  // **The one source in this file that is not always mounted**, and that is the decision rather than
  // an optimisation: contours are a property of the detail view, so the source exists while a lake's
  // sheet is open and not otherwise. No toggle, no persisted preference, no settings row — the
  // visibility is derived from something the app already knows, which body is selected.
  //
  // Blank `bathymetryPmtilesUrl` ⇒ never mounted, which is correct rather than degraded: under D82
  // contours make no claim, so an unconfigured build shows a flat lake exactly as it does for the
  // majority of bodies no agency ever surveyed.
  const contourSourceRef = useRef<VectorSourceRef>(null);
  const contourCreditRef = useRef<string | null>(null);
  // The deepest ring seen for *this* lake, which only ever grows — `querySourceFeatures` answers from
  // the tiles currently loaded, so panning the deep end off screen would otherwise re-scale the ramp
  // under the skater.
  const [contourMaxDepthFt, setContourMaxDepthFt] = useState(0);
  // Whether any of this lake's lines have been read back yet, which is what holds the layer
  // invisible until they have: it fades in once its own lines are on screen, so the fade covers the
  // tile fetch rather than racing it. Popping in reads as a bug; fading in reads as a detail
  // revealing itself.
  //
  // **Separate from the depth above, deliberately.** Folding the reveal into "deepest > 0" would
  // leave a lake whose deepest drawn ring reads 0 permanently invisible while its credit row
  // rendered — a flat lake with an attribution under it.
  const [contoursRevealed, setContoursRevealed] = useState(false);
  // One query in flight at a time. The pre-reveal probe below runs per rendered frame, and without
  // this a slow tile fetch would queue a bridge round-trip for every one of them.
  const contourQueryInFlight = useRef(false);
  const contourArchiveUrl = env.bathymetryPmtilesUrl;
  const contoursMounted = Boolean(contourArchiveUrl && contourBodyKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `contourBodyKey` is the intended trigger.
  useEffect(() => {
    // A new lake starts a new ramp, a new reveal and a new credit: the last lake's deepest ring says
    // nothing about this one, and the agency that surveyed it may not be this one's.
    setContourMaxDepthFt(0);
    setContoursRevealed(false);
    contourCreditRef.current = null;
    setContourCredit(null);
  }, [contourBodyKey, setContourCredit]);

  /**
   * Read the drawn contours back off the tile — the credit and the depth ramp both come from there.
   *
   * The tile is the authority on who surveyed this lake and at what interval (§5), so the drawer's
   * credit line is derived from the features actually on screen rather than from a table keyed by
   * state.
   *
   * **Called from two events, and needing both is the finding web's half paid for.** A single
   * "everything has settled" callback (`onDidFinishRenderingMapFully`, the native analogue of web's
   * `idle`) fires before the contour tiles are fetched and is not guaranteed to come round again —
   * on web that exact design left every lake flat, invisible, with no error anywhere. So the settled
   * callback keeps the ramp growing as the skater pans, and a per-frame probe covers the reveal, and
   * that probe is unmounted the instant the first read succeeds.
   */
  async function readDrawnContours() {
    const source = contourSourceRef.current;
    if (!source || !contourBodyKey || contourQueryInFlight.current) return;
    let features: GeoJSON.Feature[];
    contourQueryInFlight.current = true;
    try {
      features = await source.querySourceFeatures({
        sourceLayer: CONTOUR_SOURCE_LAYER,
        filter: contourFilter(contourBodyKey) as FilterSpecification,
      });
    } catch {
      // The sheet closed mid-query and the source went with it. Nothing to report and nothing wrong.
      return;
    } finally {
      contourQueryInFlight.current = false;
    }
    const properties = features.map((f) => f.properties as Partial<ContourFeatureProperties>);
    // No tiles in yet, or a lake nobody surveyed. Either way keep the last answer rather than
    // clearing a credit that is still true for the lines on screen.
    if (properties.length === 0) return;

    setContoursRevealed(true);
    const line = formatContourCredit(contourCredit(properties)) || null;
    if (line !== contourCreditRef.current) {
      contourCreditRef.current = line;
      setContourCredit(line);
    }
    const deepest = maxContourDepthFt(properties);
    if (deepest !== undefined) setContourMaxDepthFt((seen) => Math.max(seen, deepest));
  }

  // Frame a drawer's focus (a lake / report put-in) into the area the drawer does NOT cover, re-fitting
  // whenever the drawer settles at a new snap point. A lake with a `bounds` gets zoom-to-fit
  // (`fitBounds`); a bare point (report put-in) gets a fly at its zoom. The drawer's covered fraction
  // becomes bottom camera padding, so the target lands in the visible strip above the sheet — not
  // hidden behind it. Skipped when the sheet is near-full (little map visible) or closed.
  useEffect(() => {
    const cam = cameraRef.current;
    if (!cam || !focus || drawerCoveredFraction <= 0 || drawerCoveredFraction >= 0.9) return;
    const margin = 48;
    const padding = {
      top: margin,
      right: margin,
      left: margin,
      bottom: margin + drawerCoveredFraction * windowHeight,
    };
    if (focus.bounds) {
      cam.fitBounds(
        [focus.bounds.minLng, focus.bounds.minLat, focus.bounds.maxLng, focus.bounds.maxLat],
        { padding, duration: 600 },
      );
    } else {
      cam.flyTo({
        center: [focus.lng, focus.lat],
        ...(focus.zoom !== undefined ? { zoom: focus.zoom } : {}),
        padding,
        duration: 600,
      });
    }
  }, [focus, drawerCoveredFraction, windowHeight]);

  // Home/water framing on open via device geolocation (D12/D20): a fix inside the pilot region
  // recenters there; otherwise the default Vermont framing stands. Skipped on a deep-linked drawer,
  // which frames on its own target instead (see `geolocateOnMount`).
  useEffect(() => {
    if (!geolocateOnMount) return;
    let cancelled = false;
    (async () => {
      try {
        const granted = await ensureForegroundPermission();
        if (!granted) return; // denied ⇒ keep the default framing
        const pos = await Location.getCurrentPositionAsync({});
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (!cancelled && frame) {
          cameraRef.current?.jumpTo({ center: frame.center, zoom: frame.zoom });
        }
      } catch {
        // Location unavailable ⇒ keep the default framing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [geolocateOnMount]);

  // In pin-drop mode (§E) the next map tap sets the put-in pin; otherwise a tap on a water body
  // (handled by the source's onPress below) opens its drawer. Handlers are recreated each render, so
  // they read the current `pinDropMode` directly (no ref needed, unlike web's once-bound handler).
  function onMapPress(e: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) {
    const [lng, lat] = e.nativeEvent.lngLat;
    if (pinDropMode) {
      setPutInPin({ lat, lng });
      setPinDropMode(false);
      return;
    }
    // Snap-to-shoreline (N5b) takes the tap first: it's a two-tap affordance and the adjust bar
    // can't count them, so the map does. It never touches the draft — capture owns the body polygon
    // and turns the pair into geometry.
    //
    // **Gated on drop mode**, which web gets for free by only calling its hazard handler while armed.
    // The taps stay non-null after the band is derived (they're what the width and "Other way" controls
    // re-derive from), so without this any later tap on the map slid the pair along — dropping the
    // first end, keeping the second, and silently re-deriving the band from somewhere the skater
    // wasn't pointing at a shore.
    if (hazardDropMode && hazardShoreTaps !== null) {
      const next = [...hazardShoreTaps, { lat, lng }].slice(-2);
      setHazardShoreTaps(next);
      if (next.length === 2) setHazardDropMode(false);
      return;
    }
    // Hazard placement (Phase 9). A circle disarms on the tap that moves it; a polyline and an area
    // stay armed and take one vertex per tap, so tracing a ridge or walking the edge of a rotten
    // patch doesn't require re-arming between points.
    if (hazardDropMode && hazardDraft) {
      setHazardDraft(applyDraftMapClick(hazardDraft, { lat, lng }));
      if (hazardDraft.geometryKind === 'point_radius') setHazardDropMode(false);
    }
  }

  function onWaterPress(e: NativeSyntheticEvent<PressEventWithFeatures>) {
    if (pinDropMode || hazardDropMode) return; // a tap while placing is handled by onMapPress
    // A hazard footprint always lies *inside* a lake, so a tap on a pin hits both sources. The more
    // specific — and more safety-relevant — target has to win. Which handler RN fires first isn't
    // guaranteed, so precedence is enforced from both sides: if the hazard fired first this bails,
    // and if the water fired first the hazard's own navigate lands last and still wins.
    if (Date.now() - hazardPressAtRef.current < HAZARD_PRESS_PRECEDENCE_MS) return;
    const id = e.nativeEvent.features?.[0]?.properties?._id;
    if (typeof id === 'string') router.navigate({ pathname: '/water/[id]', params: { id } });
  }

  function onHazardPress(e: NativeSyntheticEvent<PressEventWithFeatures>) {
    if (pinDropMode || hazardDropMode) return;
    hazardPressAtRef.current = Date.now();
    const id = e.nativeEvent.features?.[0]?.properties?.hazardId;
    if (typeof id === 'string') router.navigate({ pathname: '/hazard/[id]', params: { id } });
  }

  function onRegionDidChange(e: NativeSyntheticEvent<ViewStateChangeEvent>) {
    setQueryArgs({
      viewport: boundsToViewport(e.nativeEvent.bounds),
      zoom: zoomForViewport(e.nativeEvent.zoom),
    });
  }

  // Release build with no basemap URL configured — block loudly rather than render a doomed map.
  if (!mapStyle) {
    return (
      <View style={styles.configError}>
        <Text style={styles.configErrorText}>
          Map unavailable — this build is missing its basemap configuration
          (EXPO_PUBLIC_PMTILES_URL).
        </Text>
      </View>
    );
  }

  return (
    <MapGL
      style={StyleSheet.absoluteFill}
      mapStyle={mapStyle}
      attribution
      logo={false}
      compass={false}
      onPress={onMapPress}
      onRegionDidChange={onRegionDidChange}
      // The settled read: the tiles for this view are in, so the ramp keeps up as the skater pans.
      onDidFinishRenderingMapFully={() => void readDrawnContours()}
      // And the reveal. Mounted only while a lake's contours are still unread, so it costs nothing
      // for the great majority of bodies-and-moments where there is nothing to wait for — see
      // `readDrawnContours` for why one settled callback is not enough to reveal a layer.
      {...(contoursMounted && !contoursRevealed
        ? { onDidFinishRenderingFrame: () => void readDrawnContours() }
        : {})}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{ center: INITIAL_CENTER, zoom: INITIAL_ZOOM }}
        maxBounds={[
          NORTHEAST_MAX_BOUNDS[0][0],
          NORTHEAST_MAX_BOUNDS[0][1],
          NORTHEAST_MAX_BOUNDS[1][0],
          NORTHEAST_MAX_BOUNDS[1][1],
        ]}
      />

      <GeoJSONSource id="water" data={features} onPress={onWaterPress}>
        <Layer
          id="water-fill"
          type="fill"
          paint={{ 'fill-color': water.fill, 'fill-opacity': 0.35 }}
        />
        <Layer
          id="water-fill-selected"
          type="fill"
          filter={['==', ['get', '_id'], highlightWaterBodyId ?? '']}
          paint={{ 'fill-color': water.fill, 'fill-opacity': 0.6 }}
        />
        <Layer
          id="water-outline"
          type="line"
          paint={{ 'line-color': water.outline, 'line-width': 1 }}
        />
        <Layer
          id="water-outline-selected"
          type="line"
          filter={['==', ['get', '_id'], highlightWaterBodyId ?? '']}
          paint={{ 'line-color': water.outline, 'line-width': 2.5 }}
        />
        {/* Favorited bodies read gold (Phase 4, decision #1) — a data-driven `in` filter over the
            viewer's favorite id set (matches nothing when empty / signed out). */}
        <Layer
          id="water-outline-favorite"
          type="line"
          filter={['in', ['get', '_id'], ['literal', favoriteIds]]}
          paint={{ 'line-color': FAVORITE_OUTLINE_COLOR, 'line-width': 2.5 }}
        />
      </GeoJSONSource>

      {/* Named bays, over the water fill and under every pin layer. Dashed, so it reads as a name
          for part of this lake rather than another lake's shoreline. No `onPress`: a tap falls
          through to the water source beneath and opens the parent, which is the right destination. */}
      <GeoJSONSource id="sub-areas" data={subAreaFeatures}>
        <Layer
          id="sub-area-outline"
          type="line"
          filter={['!=', ['get', 'label'], true]}
          paint={{
            'line-color': subAreaPalette.outline,
            'line-width': 1.25,
            'line-opacity': 0.8,
            'line-dasharray': [3, 2],
          }}
        />
        <Layer
          id="sub-area-label"
          type="symbol"
          filter={['==', ['get', 'label'], true]}
          layout={{
            'text-field': ['get', 'name'],
            'text-size': 12,
            // A bay name may never displace a hazard or put-in marker; if it doesn't fit, it doesn't draw.
            'text-allow-overlap': false,
            'text-optional': true,
          }}
          paint={{
            'text-color': subAreaPalette.label,
            'text-halo-color': subAreaPalette.halo,
            'text-halo-width': 1.2,
          }}
        />
      </GeoJSONSource>

      {/* ── Bathymetric contours for the open lake (N6b/D81), mounted only while its sheet is open.
          `beforeId` puts them under every pin, track and hazard that follows: contours are
          decoration and hazards are the product, so if the two ever compete for legibility the
          contour is the one that loses (D82). Hairline, and a single hue varying only in lightness —
          a green→yellow→red depth ramp would be far more legible, and that is exactly the problem. */}
      {contoursMounted ? (
        <VectorSource
          id={CONTOUR_SOURCE_ID}
          ref={contourSourceRef}
          url={contourSourceSpec(contourArchiveUrl).url}
        >
          <Layer
            id={CONTOUR_LAYER_ID}
            type="line"
            source-layer={CONTOUR_SOURCE_LAYER}
            beforeId={CONTOUR_BEFORE_LAYER_ID}
            // A guard rail, not the mechanism: a sheet can be open while the camera is zoomed out,
            // and a lake's isobaths at z6 are a smear that says nothing.
            minzoom={CONTOUR_MIN_ZOOM}
            filter={contourFilter(contourBodyKey) as FilterSpecification}
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{
              'line-color':
                contourMaxDepthFt > 0
                  ? (contourColorExpression(contourPalette, contourMaxDepthFt) as never)
                  : contourPalette.deep,
              'line-width': contourWidthExpression() as never,
              'line-opacity': contoursRevealed ? CONTOUR_OPACITY : 0,
              'line-opacity-transition': { duration: CONTOUR_FADE_MS, delay: 0 },
            }}
          />
        </VectorSource>
      ) : null}

      <GeoJSONSource id="photo-pins" data={photoPinsFC}>
        <Layer
          id="photo-pins"
          type="circle"
          paint={{
            'circle-radius': 6,
            'circle-color': PHOTO_PIN_COLOR,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          }}
        />
      </GeoJSONSource>

      <GeoJSONSource id="put-in-pin" data={putInPinFC}>
        <Layer
          id="put-in-pin"
          type="circle"
          paint={{
            'circle-radius': 7,
            'circle-color': PUT_IN_PIN_COLOR,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          }}
        />
      </GeoJSONSource>

      {/* Put-in markers for the focused lake (Phase 4, decision #7): official = accurate cyan,
          derived = approximate muted blue. Distinct from the amber report-photo pins. */}
      <GeoJSONSource id="put-in-markers" data={putInsFC}>
        <Layer
          id="put-in-markers"
          type="circle"
          paint={{
            'circle-radius': 6,
            'circle-color': [
              'case',
              ['==', ['get', 'source'], 'official'],
              PUT_IN_MARKER_OFFICIAL_COLOR,
              PUT_IN_MARKER_DERIVED_COLOR,
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          }}
        />
      </GeoJSONSource>

      {/* ── Recorded GPS tracks (Phase 8). The path someone actually skated, under the hazard layers
          so a warning is never hidden by a line. Display-only — a path can only come from a recorded
          track, so there is no draw interaction. Opacity is data-driven off the linked report's D59
          freshness, floored so an old path fades but never vanishes (a blank lake would read as
          "all clear", which we never assert). */}
      <GeoJSONSource id="tracks" data={tracksFC}>
        <Layer
          id="track-line"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{
            'line-color': trackColor,
            'line-width': 3,
            'line-opacity': ['coalesce', ['get', 'opacity'], 1] as never,
          }}
        />
      </GeoJSONSource>

      {/* ── Known seasonal body features (D53). Permanent, so no freshness ramp: a steady neutral,
          always visible, beneath the hazard pins that *do* decay. */}
      <GeoJSONSource id="body-features" data={bodyFeaturesFC}>
        <Layer
          id="body-feature-fill"
          type="fill"
          paint={{ 'fill-color': hazardPalette.feature, 'fill-opacity': 0.22 }}
        />
        <Layer
          id="body-feature-outline"
          type="line"
          paint={{
            'line-color': hazardPalette.feature,
            'line-width': 1.5,
            'line-dasharray': [4, 2],
          }}
        />
      </GeoJSONSource>

      {/* ── Hazards (Phase 9). Drawn as buffered *footprint* polygons, not markers, so the shape on
          screen is literally the shape the proximity evaluator measures against. Soft fill + a dashed
          outline while provisional: a hazard is "reported around here", never a surveyed boundary. */}
      <GeoJSONSource id="hazards" data={hazardsFC} onPress={onHazardPress}>
        <Layer
          id="hazard-fill"
          type="fill"
          paint={{
            'fill-color': hazardColorExpression(hazardPalette) as never,
            'fill-opacity': hazardFillOpacityExpression() as never,
          }}
        />
        {/* Dashed while provisional (one unverified report), solid once independently confirmed —
            the same soft/hard distinction the on-ice banner makes (D54). **Two layers, not one
            expression:** `line-dasharray` takes no data expression, and the native renderer says so
            out loud ("line-dasharray data expressions not supported") before dropping the property.
            The filters partition the source, so every hazard is still drawn exactly once. */}
        <Layer
          id="hazard-outline-provisional"
          type="line"
          filter={PROVISIONAL_HAZARD_FILTER as never}
          paint={{
            'line-color': hazardColorExpression(hazardPalette) as never,
            'line-width': 1.5,
            'line-dasharray': [...PROVISIONAL_DASH_ARRAY],
          }}
        />
        <Layer
          id="hazard-outline-confirmed"
          type="line"
          filter={CONFIRMED_HAZARD_FILTER as never}
          paint={{
            'line-color': hazardColorExpression(hazardPalette) as never,
            'line-width': 1.5,
          }}
        />
      </GeoJSONSource>

      {/* The hazard being captured — the real metric footprint, updated live as vertices land and
          the size changes, so what you see while placing is what gets stored. */}
      <GeoJSONSource id="hazard-draft" data={hazardDraftFC}>
        <Layer
          id="hazard-draft-fill"
          type="fill"
          paint={{
            'fill-color': hazardColorExpression(hazardPalette) as never,
            'fill-opacity': 0.35,
          }}
        />
        <Layer
          id="hazard-draft-outline"
          type="line"
          paint={{ 'line-color': hazardColorExpression(hazardPalette) as never, 'line-width': 2 }}
        />
        {/* The tapped vertices. A one-vertex line has no honest footprint yet, so without these the
            first tap of a trace would land with no feedback at all. */}
        <Layer
          id="hazard-draft-vertices"
          type="circle"
          filter={['==', ['get', 'role'], 'vertex']}
          paint={{
            'circle-radius': 6,
            'circle-color': hazardColorExpression(hazardPalette) as never,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          }}
        />
      </GeoJSONSource>
    </MapGL>
  );
}

const styles = StyleSheet.create({
  configError: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#1c1c1e',
  },
  configErrorText: { color: '#ffffff', textAlign: 'center', fontSize: 15, lineHeight: 22 },
});
