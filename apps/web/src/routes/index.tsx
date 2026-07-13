import { createFileRoute } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useState } from 'react'

// Map is the default top-level page (D20/D28). Phase 1 ships a read-only MapLibre map that
// confirms the imported Vermont water bodies render; interactive tap-to-detail + report creation
// (D47) arrive with the full map in Phase 2.
export const Route = createFileRoute('/')({ component: MapPage })

// WebGL/MapLibre needs the DOM, so the map is loaded client-only — a mounted gate keeps it out of
// the SSR pass (and its module out of the server bundle) while matching the server's skeleton.
const WaterMap = lazy(() => import('../components/WaterMap'))

function MapPage() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div className="flex flex-col gap-2">
      {mounted ? (
        <Suspense fallback={<MapSkeleton />}>
          <WaterMap />
        </Suspense>
      ) : (
        <MapSkeleton />
      )}
      <p className="text-foreground-muted text-xs">
        Read-only preview of imported Vermont water bodies. Basemap and water data © OpenStreetMap
        contributors. Tap-to-detail and report creation arrive in Phase 2.
      </p>
    </div>
  )
}

function MapSkeleton() {
  return (
    <div className="h-[75vh] w-full animate-pulse rounded-lg border border-border bg-surface-muted" />
  )
}
