import type { BBox } from '@skating/core'
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'

/**
 * Shared selection state for the persistent native map (Phase 2 §F), the mobile mirror of web's
 * `MapSelectionContext`. The `(map)` layout keeps one `<MapView>` mounted beside a bottom-sheet
 * `<Slot />`; the detail drawers rendered into that slot are *siblings* of the map, so they push
 * what the map should show — the highlighted body, where to fly, photo pins — up through this
 * context rather than remounting the map per navigation. The layout owns the highlight-clear on
 * route change; the drawers set focus/pins from the data they fetch (see `MapView`).
 */

/** A geotagged report photo (D42) to drop on the lake when viewing a report with `placeOnMap`. */
export interface PhotoPin {
  photoId: string
  coord: { lat: number; lng: number }
}

/**
 * Where the map should recenter. `bounds` (a lake's bbox) is preferred — the map fits it into the
 * area *not* covered by the drawer (zoom-to-fit); `lat`/`lng` + optional `zoom` are the point
 * fallback (e.g. a report put-in) when there's no area to fit.
 */
export interface MapFocus {
  lat: number
  lng: number
  zoom?: number
  bounds?: BBox
}

interface MapSelectionValue {
  highlightWaterBodyId: string | null
  setHighlightWaterBodyId: (id: string | null) => void
  focus: MapFocus | null
  setFocus: (focus: MapFocus | null) => void
  photoPins: PhotoPin[]
  setPhotoPins: (pins: PhotoPin[]) => void
  /** The put-in pin the report form is placing (§E) — the access point → `reports.point`. */
  putInPin: { lat: number; lng: number } | null
  setPutInPin: (pin: { lat: number; lng: number } | null) => void
  /** True while the report form has armed map-tap pin placement; the next map tap sets the pin. */
  pinDropMode: boolean
  setPinDropMode: (on: boolean) => void
  /**
   * Fraction of the screen the drawer currently covers (0 closed → ~0.94 near-full). The map fits
   * the selected lake into the *uncovered* area by padding its camera by this much at the bottom,
   * and re-fits when the drawer settles at a new snap point.
   */
  drawerCoveredFraction: number
  setDrawerCoveredFraction: (fraction: number) => void
}

const MapSelectionContext = createContext<MapSelectionValue | null>(null)

export function MapSelectionProvider({ children }: { children: ReactNode }) {
  const [highlightWaterBodyId, setHighlightWaterBodyId] = useState<string | null>(null)
  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [photoPins, setPhotoPins] = useState<PhotoPin[]>([])
  const [putInPin, setPutInPin] = useState<{ lat: number; lng: number } | null>(null)
  const [pinDropMode, setPinDropMode] = useState(false)
  const [drawerCoveredFraction, setDrawerCoveredFraction] = useState(0)

  const value = useMemo(
    () => ({
      highlightWaterBodyId,
      setHighlightWaterBodyId,
      focus,
      setFocus,
      photoPins,
      setPhotoPins,
      putInPin,
      setPutInPin,
      pinDropMode,
      setPinDropMode,
      drawerCoveredFraction,
      setDrawerCoveredFraction,
    }),
    [highlightWaterBodyId, focus, photoPins, putInPin, pinDropMode, drawerCoveredFraction],
  )

  return <MapSelectionContext.Provider value={value}>{children}</MapSelectionContext.Provider>
}

export function useMapSelection(): MapSelectionValue {
  const value = useContext(MapSelectionContext)
  if (!value) throw new Error('useMapSelection must be used within a MapSelectionProvider')
  return value
}
