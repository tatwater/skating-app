import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map as MapGL,
  type PressEvent,
  type PressEventWithFeatures,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native'
import { api } from '@skating/convex/api'
import type { BBox } from '@skating/core'
import { useQuery } from 'convex/react'
import * as Location from 'expo-location'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NativeSyntheticEvent } from 'react-native'
import { StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native'
import { env } from '../lib/env'
import {
  boundsToViewport,
  buildMapStyle,
  DEMO_PMTILES_URL,
  frameForCoord,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MAP_FLAVORS,
  NORTHEAST_MAX_BOUNDS,
  PHOTO_PIN_COLOR,
  PUT_IN_PIN_COLOR,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from '../lib/waterMap'
import { useMapSelection } from './MapSelectionContext'

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
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

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
}

export default function MapView({ geolocateOnMount }: { geolocateOnMount: boolean }) {
  const scheme = useColorScheme()
  const flavor = scheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light
  const water = WATER_PALETTE[flavor]
  const router = useRouter()
  const cameraRef = useRef<CameraRef>(null)
  const {
    highlightWaterBodyId,
    focus,
    photoPins,
    putInPin,
    pinDropMode,
    setPutInPin,
    setPinDropMode,
    drawerCoveredFraction,
  } = useMapSelection()
  const { height: windowHeight } = useWindowDimensions()

  // Basemap tiles: the demo archive is dated and Protomaps prunes old builds (it will 404), so it's
  // DEV-ONLY. A release build that omits EXPO_PUBLIC_PMTILES_URL must NOT silently fall back to it —
  // that ships a map destined to go blank. Instead we refuse to build a style (→ the blocking config
  // screen below), turning the misconfiguration into an immediate, obvious failure.
  const pmtilesUrl = env.pmtilesUrl || (__DEV__ ? DEMO_PMTILES_URL : '')
  const mapStyle = useMemo(
    () => (pmtilesUrl ? buildMapStyle(pmtilesUrl, flavor) : null),
    [pmtilesUrl, flavor],
  )

  // Viewport bbox + zoom are the query key; seeded to the region so data shows before the first
  // region event, then `onRegionDidChange` refines it.
  const [queryArgs, setQueryArgs] = useState<{ viewport: BBox; zoom: number }>(INITIAL_QUERY)
  const bodies = useQuery(api.waterBodies.listInViewport, queryArgs)

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FC)
  useEffect(() => {
    if (bodies !== undefined) setFeatures(waterBodiesToFeatureCollection(bodies))
  }, [bodies])

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
  )

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
  )

  // Frame a drawer's focus (a lake / report put-in) into the area the drawer does NOT cover, re-fitting
  // whenever the drawer settles at a new snap point. A lake with a `bounds` gets zoom-to-fit
  // (`fitBounds`); a bare point (report put-in) gets a fly at its zoom. The drawer's covered fraction
  // becomes bottom camera padding, so the target lands in the visible strip above the sheet — not
  // hidden behind it. Skipped when the sheet is near-full (little map visible) or closed.
  useEffect(() => {
    const cam = cameraRef.current
    if (!cam || !focus || drawerCoveredFraction <= 0 || drawerCoveredFraction >= 0.9) return
    const margin = 48
    const padding = {
      top: margin,
      right: margin,
      left: margin,
      bottom: margin + drawerCoveredFraction * windowHeight,
    }
    if (focus.bounds) {
      cam.fitBounds(
        [focus.bounds.minLng, focus.bounds.minLat, focus.bounds.maxLng, focus.bounds.maxLat],
        { padding, duration: 600 },
      )
    } else {
      cam.flyTo({
        center: [focus.lng, focus.lat],
        ...(focus.zoom !== undefined ? { zoom: focus.zoom } : {}),
        padding,
        duration: 600,
      })
    }
  }, [focus, drawerCoveredFraction, windowHeight])

  // Home/water framing on open via device geolocation (D12/D20): a fix inside the pilot region
  // recenters there; otherwise the default Vermont framing stands. Skipped on a deep-linked drawer,
  // which frames on its own target instead (see `geolocateOnMount`).
  useEffect(() => {
    if (!geolocateOnMount) return
    let cancelled = false
    ;(async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync()
        if (status !== 'granted') return // denied ⇒ keep the default framing
        const pos = await Location.getCurrentPositionAsync({})
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        if (!cancelled && frame) {
          cameraRef.current?.jumpTo({ center: frame.center, zoom: frame.zoom })
        }
      } catch {
        // Location unavailable ⇒ keep the default framing.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [geolocateOnMount])

  // In pin-drop mode (§E) the next map tap sets the put-in pin; otherwise a tap on a water body
  // (handled by the source's onPress below) opens its drawer. Handlers are recreated each render, so
  // they read the current `pinDropMode` directly (no ref needed, unlike web's once-bound handler).
  function onMapPress(e: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) {
    if (!pinDropMode) return
    const [lng, lat] = e.nativeEvent.lngLat
    setPutInPin({ lat, lng })
    setPinDropMode(false)
  }

  function onWaterPress(e: NativeSyntheticEvent<PressEventWithFeatures>) {
    if (pinDropMode) return // a tap while arming a pin is handled by onMapPress
    const id = e.nativeEvent.features?.[0]?.properties?._id
    if (typeof id === 'string') router.navigate({ pathname: '/water/[id]', params: { id } })
  }

  function onRegionDidChange(e: NativeSyntheticEvent<ViewStateChangeEvent>) {
    setQueryArgs({
      viewport: boundsToViewport(e.nativeEvent.bounds),
      zoom: zoomForViewport(e.nativeEvent.zoom),
    })
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
    )
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
    </MapGL>
  )
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
})
