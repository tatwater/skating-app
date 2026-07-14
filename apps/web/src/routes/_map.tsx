import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useState } from 'react'
import { MapSelectionProvider, useMapSelection } from '../components/MapSelectionContext'
import { parseMapSelection } from '../lib/mapSelection'

/**
 * Pathless layout (§D, D47) that keeps ONE `MapView` mounted under an `<Outlet />` across the map
 * routes — `/` (map), `/water/$id`, `/report/$id` — so panning/zoom survive opening a detail drawer.
 * The drawers render into the outlet as siblings of the map and push what to highlight/frame up
 * through `MapSelectionContext`. This layout owns the highlight-from-URL sync; the drawers own the
 * data-derived focus + photo pins. Sibling routes (`/feed`, `/settings`, …) sit outside this layout,
 * so they don't carry the map.
 */
export const Route = createFileRoute('/_map')({ component: MapLayout })

// WebGL/MapLibre needs the DOM, so the map is loaded client-only (a mounted gate keeps it out of the
// SSR pass and its module out of the server bundle) while matching the server's skeleton.
const MapView = lazy(() => import('../components/MapView'))

function MapLayout() {
  return (
    <MapSelectionProvider>
      <MapLayoutInner />
    </MapSelectionProvider>
  )
}

function MapLayoutInner() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { setHighlightWaterBodyId, setPhotoPins } = useMapSelection()

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Geolocation framing only when the first route was the bare map — a deep-linked drawer frames on
  // its own target instead (the initializer runs once, capturing the entry pathname).
  const [geolocateOnMount] = useState(() => parseMapSelection(pathname).kind === 'none')

  // On any navigation, clear the map highlight + photo pins. The drawers re-set the highlight from
  // their *resolved* body id (merge-correct: `waterBodies.get` follows `mergedIntoId` to the
  // survivor, whose `_id` — not the URL/stored id — is what the map's features carry), and the
  // report drawer re-sets the pins. Clearing here avoids showing the previous lake's highlight while
  // the next drawer loads, or leaving it stuck when a report resolves to not-found.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the intended re-run trigger.
  useEffect(() => {
    setHighlightWaterBodyId(null)
    setPhotoPins([])
  }, [pathname, setHighlightWaterBodyId, setPhotoPins])

  return (
    <div className="flex flex-col gap-2">
      {mounted ? (
        <Suspense fallback={<MapSkeleton />}>
          <MapView geolocateOnMount={geolocateOnMount} />
        </Suspense>
      ) : (
        <MapSkeleton />
      )}
      <p className="text-foreground-muted text-xs">
        Tap a lake to read and post reports. Basemap and water data © OpenStreetMap contributors.
      </p>
      <Outlet />
    </div>
  )
}

function MapSkeleton() {
  return (
    <div className="h-[75vh] w-full animate-pulse rounded-lg border border-border bg-surface-muted" />
  )
}
