import * as Location from 'expo-location'
import { Slot, usePathname } from 'expo-router'
import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { HazardBanner } from '../../../src/components/HazardBanner'
import { HazardCapture } from '../../../src/components/HazardCapture'
import { LakeSearch } from '../../../src/components/LakeSearch'
import { DRAWER_NORMAL, DRAWER_PEEK, MapDrawer } from '../../../src/components/MapDrawer'
import { MapSelectionProvider, useMapSelection } from '../../../src/components/MapSelectionContext'
import MapView from '../../../src/components/MapView'
import { resolveCachedBody } from '../../../src/lib/bodyCache'

/**
 * Persistent-map layout (§F, D47) — the mobile mirror of web's `_map` layout. Keeps ONE `<MapView>`
 * mounted beside a bottom-sheet `<Slot />` across the map routes — `/` (map), `/water/[id]`,
 * `/report/[id]` — so panning/zoom survive opening a detail drawer. The drawers render into the slot
 * as siblings of the map and push what to highlight/frame up through `MapSelectionContext`; this
 * layout owns the highlight-clear on navigation. The map stays behind the (non-modal, backdrop-less)
 * sheet, so it's tappable while a drawer is open — the put-in-pin flow (§E) depends on it.
 */
export default function MapLayout() {
  return (
    <MapSelectionProvider>
      <MapLayoutInner />
    </MapSelectionProvider>
  )
}

function MapLayoutInner() {
  const pathname = usePathname()
  const {
    setHighlightWaterBodyId,
    setPhotoPins,
    setFocus,
    pinDropMode,
    setDrawerCoveredFraction,
    hazardDropMode,
    setOnIceWaterBodyId,
  } = useMapSelection()

  // A detail route (`/water/…`, `/report/…`) opens the drawer; the bare map (`/`) closes it. While a
  // put-in pin is being placed the drawer drops to a peek so the map above is tappable (the report
  // form stays mounted behind it, D47/§E).
  const isDetail = pathname !== '/'
  const snapIndex = !isDetail ? -1 : pinDropMode || hazardDropMode ? DRAWER_PEEK : DRAWER_NORMAL

  // Geolocation framing only when the app opened on the bare map — a deep-linked drawer frames on
  // its own target instead (captured once, from the entry pathname).
  const geolocateOnMount = useRef(pathname === '/').current

  // On any navigation, clear the highlight, photo pins, and focus. The drawers re-set the highlight
  // from their *resolved* body id (merge-correct — `waterBodies.get` follows `mergedIntoId` to the
  // survivor, whose `_id` is what the map's features carry) and re-set focus/pins from their data.
  // Clearing focus here keeps the map from briefly fitting the *previous* lake while the next drawer
  // loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the intended re-run trigger.
  useEffect(() => {
    setHighlightWaterBodyId(null)
    setPhotoPins([])
    setFocus(null)
  }, [pathname, setHighlightWaterBodyId, setPhotoPins, setFocus])

  // The "on-ice" state (Phase 9 §Mobile): resolve the device fix against the *offline* body cache,
  // so standing on a lake with no signal still lights up the flag affordance and the proximity
  // watcher. Deliberately low-ceremony — no auto-opening sheets, no modal "you're on the ice!"
  // state. There should be nothing you can be confused about being *in*; the only thing that
  // changes is that flagging a hazard becomes one thumb-reachable tap away.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync()
        if (status !== 'granted') return
        const pos = await Location.getCurrentPositionAsync({})
        const match = resolveCachedBody({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        if (!cancelled) setOnIceWaterBodyId(match?.waterBodyId ?? null)
      } catch {
        // No fix ⇒ not on-ice as far as we know. Never an error state: the app is fully usable
        // without it, and "we can't tell" must not read as "you're not near a lake".
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setOnIceWaterBodyId])

  return (
    <View style={{ flex: 1 }}>
      <MapView geolocateOnMount={geolocateOnMount} />
      <LakeSearch />
      <MapDrawer snapIndex={snapIndex} onCoveredFractionChange={setDrawerCoveredFraction}>
        <Slot />
      </MapDrawer>
      {/* Both sit above the drawer: a warning you can't see because a sheet is over it isn't a
          warning, and the flag button has to stay reachable while a drawer is open. */}
      <HazardCapture />
      <HazardBanner />
    </View>
  )
}
