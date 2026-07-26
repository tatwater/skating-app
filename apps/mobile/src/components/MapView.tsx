import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map as MapGL,
  type PressEvent,
  type PressEventWithFeatures,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { applyDraftMapClick, type BBox } from '@skating/core';
import { useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import { StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';
import { cacheBody } from '../lib/bodyCache';
import { env } from '../lib/env';
import {
  bodyFeaturesToFeatureCollection,
  HAZARD_PALETTE,
  hazardColorExpression,
  hazardDraftToFeatureCollection,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
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
  } = useMapSelection();
  const { height: windowHeight } = useWindowDimensions();
  const hazardPalette = HAZARD_PALETTE[flavor];
  const trackColor = TRACK_PALETTE[flavor];
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

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  useEffect(() => {
    if (bodies !== undefined) setFeatures(waterBodiesToFeatureCollection(bodies));
  }, [bodies]);

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
  const hazards = useQuery(
    api.hazards.listForBody,
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
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
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
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
    // Hazard placement (Phase 9). A circle disarms on the tap that moves it; a polyline stays armed
    // and takes one vertex per tap, so tracing a ridge doesn't require re-arming between points.
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
        <Layer
          id="hazard-outline"
          type="line"
          paint={{
            'line-color': hazardColorExpression(hazardPalette) as never,
            'line-width': 1.5,
            // Dashed while provisional (one unverified report), solid once independently confirmed —
            // the same soft/hard distinction the on-ice banner makes (D54).
            'line-dasharray': [
              'case',
              ['get', 'provisional'],
              ['literal', [2, 2]],
              ['literal', [1, 0]],
            ] as never,
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
