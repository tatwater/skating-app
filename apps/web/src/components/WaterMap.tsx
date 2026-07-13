import { api } from '@skating/convex/api'
import type { BBox } from '@skating/core'
import { useQuery } from 'convex/react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import { useEffect, useRef, useState } from 'react'
import { env } from '../lib/env'
import {
  boundsToViewport,
  buildMapStyle,
  DEMO_PMTILES_URL,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  OSM_ATTRIBUTION,
  VERMONT_MAX_BOUNDS,
  waterBodiesToFeatureCollection,
} from '../lib/waterMap'

/**
 * Read-only MapLibre map confirming the imported Vermont water bodies render (Phase 1, D5/D6/D48).
 * Imperative (MapLibre owns its canvas), and rendered **client-only** (see `routes/index.tsx`) —
 * WebGL needs the DOM. All pure logic (style, feature/viewport transforms) lives in
 * `../lib/waterMap`; this file is the untestable WebGL shell, excluded from coverage.
 *
 * Data flow: the map's viewport bbox drives `waterBodies.listInViewport`; results are pushed into
 * a GeoJSON source as fill + outline. No tap-to-detail / report creation yet — that's Phase 2.
 */
const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export default function WaterMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const loadedRef = useRef(false)
  const [viewport, setViewport] = useState<BBox | null>(null)

  const pmtilesUrl = env.pmtilesUrl || DEMO_PMTILES_URL

  // The viewport bbox is the query key; 'skip' until the map's first `load` sets it.
  const bodies = useQuery(api.waterBodies.listInViewport, viewport ? { viewport } : 'skip')
  // Retain the last loaded features while the next viewport's query is in flight. Convex returns
  // `undefined` for each new viewport (a fresh query key) until it resolves ~2–3s later; feeding
  // that straight through would blink every body off the map between pans. Instead we only replace
  // the drawn set once new data actually arrives — stale (now off-screen) bodies get swapped out,
  // never blanked. (No `keepPreviousData` equivalent in Convex's useQuery, so we hold it here.)
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FEATURES)
  useEffect(() => {
    if (bodies !== undefined) setFeatures(waterBodiesToFeatureCollection(bodies))
  }, [bodies])

  // Create the map once. Register the pmtiles:// protocol so MapLibre can read the basemap.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)

    const map = new maplibregl.Map({
      container,
      style: buildMapStyle(pmtilesUrl),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      maxBounds: VERMONT_MAX_BOUNDS,
      attributionControl: false, // replaced below with an always-visible (non-compact) control
    })
    mapRef.current = map
    map.addControl(new maplibregl.AttributionControl({ compact: false }))
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    const syncViewport = () => setViewport(boundsToViewport(map.getBounds()))
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
        paint: { 'fill-color': '#3b82c4', 'fill-opacity': 0.35 },
      })
      map.addLayer({
        id: 'water-outline',
        type: 'line',
        source: 'water',
        paint: { 'line-color': '#1e5aa0', 'line-width': 1 },
      })
      loadedRef.current = true
      syncViewport() // first query, framed on the initial view
    })
    map.on('moveend', syncViewport)

    return () => {
      loadedRef.current = false
      map.remove()
      mapRef.current = null
      maplibregl.removeProtocol('pmtiles')
    }
  }, [pmtilesUrl])

  // Push query results into the source whenever they change (once the style has loaded).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const source = map.getSource('water') as maplibregl.GeoJSONSource | undefined
    source?.setData(features)
  }, [features])

  return (
    <div
      ref={containerRef}
      className="h-[75vh] w-full overflow-hidden rounded-lg border border-border"
    />
  )
}
