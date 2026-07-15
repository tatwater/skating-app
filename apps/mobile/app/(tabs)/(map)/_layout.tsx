import { Slot, usePathname } from 'expo-router'
import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { LakeSearch } from '../../../src/components/LakeSearch'
import { DRAWER_NORMAL, DRAWER_PEEK, MapDrawer } from '../../../src/components/MapDrawer'
import { MapSelectionProvider, useMapSelection } from '../../../src/components/MapSelectionContext'
import MapView from '../../../src/components/MapView'

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
  const { setHighlightWaterBodyId, setPhotoPins, setFocus, pinDropMode, setDrawerCoveredFraction } =
    useMapSelection()

  // A detail route (`/water/…`, `/report/…`) opens the drawer; the bare map (`/`) closes it. While a
  // put-in pin is being placed the drawer drops to a peek so the map above is tappable (the report
  // form stays mounted behind it, D47/§E).
  const isDetail = pathname !== '/'
  const snapIndex = !isDetail ? -1 : pinDropMode ? DRAWER_PEEK : DRAWER_NORMAL

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

  return (
    <View style={{ flex: 1 }}>
      <MapView geolocateOnMount={geolocateOnMount} />
      <LakeSearch />
      <MapDrawer snapIndex={snapIndex} onCoveredFractionChange={setDrawerCoveredFraction}>
        <Slot />
      </MapDrawer>
    </View>
  )
}
