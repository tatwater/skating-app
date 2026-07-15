import { api } from '@skating/convex/api'
import type { BBox } from '@skating/core'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useTheme } from 'next-themes'
import { Protocol } from 'pmtiles'
import { useEffect, useRef, useState } from 'react'
import { env } from '../lib/env'
import {
  boundsToViewport,
  buildMapStyle,
  DEMO_PMTILES_URL,
  featureIdForBody,
  frameForCoord,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MAP_FLAVORS,
  NORTHEAST_MAX_BOUNDS,
  OSM_ATTRIBUTION,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from '../lib/waterMap'
import { useMapSelection } from './MapSelectionContext'

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
const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

interface QueryArgs {
  viewport: BBox
  zoom: number
}

export default function MapView({ geolocateOnMount }: { geolocateOnMount: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const navigate = useNavigate()
  const {
    highlightWaterBodyId,
    focus,
    photoPins,
    putInPin,
    pinDropMode,
    setPutInPin,
    setPinDropMode,
  } = useMapSelection()

  const [loaded, setLoaded] = useState(false)
  const [queryArgs, setQueryArgs] = useState<QueryArgs | null>(null)

  // Basemap flavor + icy water palette follow the app theme (D6/D34). The map re-creates on a theme
  // change (flavor is in the create-effect deps); `lastViewRef` preserves pan/zoom across that.
  const { resolvedTheme } = useTheme()
  const flavor = resolvedTheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light
  const water = WATER_PALETTE[flavor]
  const lastViewRef = useRef<{ center: [number, number]; zoom: number } | null>(null)

  // The map click handler is registered once (in the create effect) but must read the *current*
  // pin-drop mode + latest setters, so mirror them into refs that the handler closes over.
  const pinDropModeRef = useRef(pinDropMode)
  pinDropModeRef.current = pinDropMode
  const setPutInPinRef = useRef(setPutInPin)
  setPutInPinRef.current = setPutInPin
  const setPinDropModeRef = useRef(setPinDropMode)
  setPinDropModeRef.current = setPinDropMode

  const pmtilesUrl = env.pmtilesUrl || DEMO_PMTILES_URL

  // The viewport bbox + zoom are the query key; 'skip' until the map's first `load` sets them.
  const bodies = useQuery(api.waterBodies.listInViewport, queryArgs ?? 'skip')

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FEATURES)
  useEffect(() => {
    if (bodies !== undefined) setFeatures(waterBodiesToFeatureCollection(bodies))
  }, [bodies])

  // Refs so the highlight effect can read the latest features/selection without re-running setData.
  const featuresRef = useRef(features)
  const highlightedFeatureRef = useRef<number | null>(null)

  const applyHighlight = () => {
    const map = mapRef.current
    if (!map || !loaded) return
    if (highlightedFeatureRef.current !== null) {
      map.removeFeatureState({ source: 'water', id: highlightedFeatureRef.current }, 'selected')
      highlightedFeatureRef.current = null
    }
    if (!highlightWaterBodyId) return
    const featureId = featureIdForBody(featuresRef.current, highlightWaterBodyId)
    if (featureId !== undefined) {
      map.setFeatureState({ source: 'water', id: featureId }, { selected: true })
      highlightedFeatureRef.current = featureId
    }
  }

  // Create the map once. Register the pmtiles:// protocol so MapLibre can read the basemap.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)

    const map = new maplibregl.Map({
      container,
      style: buildMapStyle(pmtilesUrl, flavor),
      // Restore pan/zoom across a theme-driven re-create; else the initial Champlain framing.
      center: lastViewRef.current?.center ?? INITIAL_CENTER,
      zoom: lastViewRef.current?.zoom ?? INITIAL_ZOOM,
      maxBounds: NORTHEAST_MAX_BOUNDS,
      attributionControl: false, // replaced below with an always-visible (non-compact) control
    })
    mapRef.current = map
    map.addControl(new maplibregl.AttributionControl({ compact: false }))
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    const syncViewport = () => {
      const c = map.getCenter()
      lastViewRef.current = { center: [c.lng, c.lat], zoom: map.getZoom() }
      setQueryArgs({
        viewport: boundsToViewport(map.getBounds()),
        zoom: zoomForViewport(map.getZoom()),
      })
    }
    map.on('load', () => {
      map.addSource('water', {
        type: 'geojson',
        data: EMPTY_FEATURES,
        attribution: OSM_ATTRIBUTION,
      })
      map.addLayer({
        id: 'water-fill',
        type: 'fill',
        source: 'water',
        paint: {
          'fill-color': water.fill,
          // Selected body reads brighter (D47 tap highlight).
          'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.6, 0.35],
        },
      })
      map.addLayer({
        id: 'water-outline',
        type: 'line',
        source: 'water',
        paint: {
          'line-color': water.outline,
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 1],
        },
      })
      map.addSource('photo-pins', { type: 'geojson', data: EMPTY_FEATURES })
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
      })
      map.addSource('put-in-pin', { type: 'geojson', data: EMPTY_FEATURES })
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
      })
      setLoaded(true)
      syncViewport() // first query, framed on the initial view
    })
    map.on('moveend', syncViewport)

    // A single map-click handler: in pin-drop mode (§E) the next tap sets the put-in pin; otherwise
    // tapping a water body opens its drawer (D47). Reads pin-drop mode via ref (handler is bound once).
    map.on('click', (e) => {
      if (pinDropModeRef.current) {
        setPutInPinRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng })
        setPinDropModeRef.current(false)
        return
      }
      const id = map.queryRenderedFeatures(e.point, { layers: ['water-fill'] })[0]?.properties?._id
      if (typeof id === 'string') navigate({ to: '/water/$id', params: { id } })
    })
    map.on('mouseenter', 'water-fill', () => {
      if (!pinDropModeRef.current) map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'water-fill', () => {
      if (!pinDropModeRef.current) map.getCanvas().style.cursor = ''
    })

    return () => {
      setLoaded(false)
      map.remove()
      mapRef.current = null
      maplibregl.removeProtocol('pmtiles')
    }
    // `flavor`/`water` re-create the map on a theme change (viewport preserved via lastViewRef).
  }, [pmtilesUrl, navigate, flavor, water])

  // Push query results into the source once the style has loaded; re-apply the highlight after
  // (setData resets feature-state).
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyHighlight reads refs; run on data change.
  useEffect(() => {
    featuresRef.current = features
    const map = mapRef.current
    if (!map || !loaded) return
    const source = map.getSource('water') as maplibregl.GeoJSONSource | undefined
    source?.setData(features)
    applyHighlight()
  }, [features, loaded])

  // Re-apply the highlight when the selected body changes (deep-link or navigating between lakes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyHighlight reads refs; re-run on selection.
  useEffect(() => {
    applyHighlight()
  }, [highlightWaterBodyId, loaded])

  // Fly to a drawer's focus (a lake centroid / report put-in) when it changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded || !focus) return
    map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? map.getZoom() })
  }, [focus, loaded])

  // Report photo pins (D42) — only present when viewing a report whose photos opted into placeOnMap.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const source = map.getSource('photo-pins') as maplibregl.GeoJSONSource | undefined
    source?.setData({
      type: 'FeatureCollection',
      features: photoPins.map((pin) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pin.coord.lng, pin.coord.lat] },
        properties: { photoId: pin.photoId },
      })),
    })
  }, [photoPins, loaded])

  // The put-in pin the report form is placing (§E): render it, and show a crosshair while arming.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const source = map.getSource('put-in-pin') as maplibregl.GeoJSONSource | undefined
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
    })
  }, [putInPin, loaded])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    map.getCanvas().style.cursor = pinDropMode ? 'crosshair' : ''
  }, [pinDropMode, loaded])

  // Home/water framing on open via the browser Geolocation API (D12/D20): a fix inside the pilot
  // region recenters there; otherwise the default Vermont framing stands. Skipped on a deep-linked
  // drawer, which frames on its own target instead (see `geolocateOnMount`).
  useEffect(() => {
    if (!geolocateOnMount || typeof navigator === 'undefined' || !navigator.geolocation) return
    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const map = mapRef.current
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        if (!cancelled && map && frame) map.jumpTo({ center: frame.center, zoom: frame.zoom })
      },
      () => {}, // denied/unavailable ⇒ keep the default framing
      { timeout: 8000, maximumAge: 60_000 },
    )
    return () => {
      cancelled = true
    }
  }, [geolocateOnMount])

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[75vh] w-full overflow-hidden rounded-lg border border-border"
      />
      {pinDropMode ? (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 rounded-t-lg bg-primary px-4 py-2 text-primary-foreground text-sm shadow">
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
  )
}
