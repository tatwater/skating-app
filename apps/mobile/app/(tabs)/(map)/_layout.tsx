import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Slot, usePathname, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { AppState, View } from 'react-native';
import { BackToLakeButton } from '../../../src/components/BackToLakeButton';
import { HazardBanner } from '../../../src/components/HazardBanner';
import { HazardCapture } from '../../../src/components/HazardCapture';
import { LakeSearch } from '../../../src/components/LakeSearch';
import { DRAWER_NORMAL, DRAWER_PEEK, MapDrawer } from '../../../src/components/MapDrawer';
import { MapSelectionProvider, useMapSelection } from '../../../src/components/MapSelectionContext';
import MapView from '../../../src/components/MapView';
import { OnIceModeControl } from '../../../src/components/OnIceModeControl';
import { resolveCachedBody } from '../../../src/lib/bodyCache';
import { noteDwell } from '../../../src/lib/dwellTracker';
import { ensureForegroundPermission } from '../../../src/lib/location';
import { resolveOnIceBody, shouldAutoSelectOnIce } from '../../../src/lib/onIce';
// Imported for its side effects: registers the on-ice fix handler, the background-location TaskManager
// task (D54 Layer 2), and the notification handler — all of which must run at module load.
import { type HazardNotificationData, ingestOnIceFix } from '../../../src/lib/onIceMode';

/**
 * Persistent-map layout (§F, D47) — the mobile mirror of web's `_map` layout. Keeps ONE `<MapView>`
 * mounted beside a bottom-sheet `<Slot />` across the map routes — `/` (map), `/water/[id]`,
 * `/report/[id]` — so panning/zoom survive opening a detail drawer. The drawers render into the slot
 * as siblings of the map and push what to highlight/frame up through `MapSelectionContext`; this
 * layout owns the highlight-clear on navigation. The map stays behind the (non-modal, backdrop-less)
 * sheet, so it's tappable while a drawer is open — the put-in-pin flow (§E) depends on it.
 */
/**
 * Grid cell (degrees) the on-ice coord is snapped to before it keys the lake-resolve query. ~0.003° ≈
 * 330 m — coarser than the 300 m auto-select buffer, so snapping never changes which lake resolves but
 * collapses the every-20 m fixes into one stable query key while the skater stays on the same water.
 */
const RESOLVE_GRID_DEG = 0.003;

export default function MapLayout() {
  return (
    <MapSelectionProvider>
      <MapLayoutInner />
    </MapSelectionProvider>
  );
}

function MapLayoutInner() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    setHighlightWaterBodyId,
    setPhotoPins,
    setFocus,
    pinDropMode,
    setDrawerCoveredFraction,
    hazardDropMode,
    onIceCoord,
    setOnIceWaterBodyId,
    setOnIceCoord,
  } = useMapSelection();

  // The live pathname, read from inside the long-lived GPS watcher callback without re-subscribing it
  // on every navigation — so auto-select can tell "still on the bare map" from "already browsing".
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // A detail route (`/water/…`, `/report/…`) opens the drawer; the bare map (`/`) closes it. While a
  // put-in pin is being placed the drawer drops to a peek so the map above is tappable (the report
  // form stays mounted behind it, D47/§E).
  const isDetail = pathname !== '/';
  const snapIndex = !isDetail ? -1 : pinDropMode || hazardDropMode ? DRAWER_PEEK : DRAWER_NORMAL;

  // Geolocation framing only when the app opened on the bare map — a deep-linked drawer frames on
  // its own target instead (captured once, from the entry pathname).
  const geolocateOnMount = useRef(pathname === '/').current;

  // On any navigation, clear the highlight, photo pins, and focus. The drawers re-set the highlight
  // from their *resolved* body id (merge-correct — `waterBodies.get` follows `mergedIntoId` to the
  // survivor, whose `_id` is what the map's features carry) and re-set focus/pins from their data.
  // Clearing focus here keeps the map from briefly fitting the *previous* lake while the next drawer
  // loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the intended re-run trigger.
  useEffect(() => {
    setHighlightWaterBodyId(null);
    setPhotoPins([]);
    setFocus(null);
  }, [pathname, setHighlightWaterBodyId, setPhotoPins, setFocus]);

  // The "on-ice" state (Phase 9 §Mobile), part 1: ONE GPS watcher, owned here, publishes each fix as
  // `onIceCoord`. The proximity banner reads that shared coord instead of running a second watcher
  // (two GPS subscriptions on a cold phone is the battery cost this feature can't afford). It seeds
  // from the last known fix so the affordances don't wait on a cold receiver, re-arms on return to
  // foreground (iOS suspends the subscription while backgrounded), and takes its permission through
  // the shared prompt so it can't race `MapView`'s framing request.
  useEffect(() => {
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    // Synchronous re-entrancy guard. `subscription` is only assigned *after* two awaits, so a bare
    // `if (subscription) return` doesn't stop a second `start()` (mount + an AppState 'active') from
    // sailing past it and creating a *second* watcher whose handle is then lost — the exact two-GPS
    // battery leak this single-watcher design exists to prevent. This flag is checked and set in the
    // same synchronous tick, so only one `start()` is ever in flight.
    let starting = false;

    const publish = (pos: Location.LocationObject) => {
      if (cancelled) return;
      setOnIceCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      // Feed the shared on-ice session (D54). Proximity always; the directional "hazard ahead"
      // projection only when on-ice mode is armed. Heading/speed are `-1` when the OS can't fill them
      // (stationary / cold receiver), which the projection reads as "no honest forward path".
      ingestOnIceFix({
        coord: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        headingDeg: pos.coords.heading ?? -1,
        speedMps: pos.coords.speed ?? -1,
      });
    };

    const start = async () => {
      if (subscription || starting) return;
      starting = true;
      try {
        const granted = await ensureForegroundPermission();
        if (!granted || cancelled) return;
        const last = await Location.getLastKnownPositionAsync();
        if (last) publish(last);
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 20 },
          publish,
        );
        if (cancelled) {
          sub.remove();
          return;
        }
        subscription = sub;
      } catch {
        // No fix ⇒ not on-ice as far as we know. Never an error state: the app is fully usable
        // without it, and "we can't tell" must not read as "you're not near a lake".
      } finally {
        // Cleared so a later foreground (e.g. permission granted in Settings, or the first attempt
        // bailed before creating a watcher) can retry — but only ever one attempt at a time.
        starting = false;
      }
    };

    void start();
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void start();
    });

    return () => {
      cancelled = true;
      subscription?.remove();
      appStateSub.remove();
    };
  }, [setOnIceCoord]);

  // Part 2: resolve the coord to a lake. The **server** resolver handles any listed lake — including
  // one the skater has never opened, which the offline body cache can't (that only holds
  // drawer-viewed bodies). It's read-cap-safe (a small rectangle around one point). Offline (or before
  // it answers) we fall back to the on-device cache so no-signal capture still resolves.
  //
  // The query key is the fix **snapped to a ~330 m grid**, not the raw coord: the watcher republishes
  // every 20 m of travel, but which lake you're on doesn't change fix-to-fix, so re-running the server
  // query every 20 m (a skater doing laps → forever) is waste. Snapping to a cell coarser than the
  // 300 m auto-select buffer means it only re-resolves when you actually cross into a new area.
  const resolveCoord = useMemo(() => {
    if (!onIceCoord) return null;
    return {
      lat: Math.round(onIceCoord.lat / RESOLVE_GRID_DEG) * RESOLVE_GRID_DEG,
      lng: Math.round(onIceCoord.lng / RESOLVE_GRID_DEG) * RESOLVE_GRID_DEG,
    };
  }, [onIceCoord]);
  const onlineBody = useQuery(
    api.waterBodies.resolveBodyForCoord,
    resolveCoord ? { coord: resolveCoord } : 'skip',
  );

  // Part 3: publish the resolved lake and, once per app-open, **auto-select** it — navigate to its
  // detail, which frames it into the space the drawer doesn't cover. Founder call (2026-07-21):
  // selecting is the right default; you still see the lake, can flick the drawer down for more, and
  // closing the sheet to pan away lets the hazards fall off naturally. Guarded so it only fires while
  // the skater is still on the bare map, never yanking them out of somewhere they navigated to.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (!onIceCoord) {
      setOnIceWaterBodyId(null);
      return;
    }
    const resolved = resolveOnIceBody(
      onlineBody !== undefined ? (onlineBody?.waterBodyId ?? null) : undefined,
      resolveCachedBody(onIceCoord)?.waterBodyId ?? null,
    );
    setOnIceWaterBodyId(resolved);
    // Record the dwell (Phase 9.5) so the report form can later prefill the skate window from when the
    // device was actually on this lake. On-device only (D12); best-effort while unarmed (foreground-only).
    // INVARIANT: `resolved` is the *survivor* body id — `resolveBodyForCoord` returns only listed bodies
    // and the offline cache stores the resolved `_id` — which is the exact id `WaterBodyDetail` hands the
    // report form as the dwell lookup key (`getSuggestedSkateWindow`). Keep both keyed on the survivor id
    // or the prefill silently no-ops.
    noteDwell(resolved);
    if (
      shouldAutoSelectOnIce({
        resolvedBodyId: resolved,
        alreadyAutoSelected: autoSelectedRef.current,
        openedOnBareMap: geolocateOnMount,
        onBareMapNow: pathnameRef.current === '/',
      })
    ) {
      autoSelectedRef.current = true;
      router.navigate({ pathname: '/water/[id]', params: { id: resolved as string } });
    }
  }, [onIceCoord, onlineBody, setOnIceWaterBodyId, router, geolocateOnMount]);

  // Tapping an on-ice notification (D54 Layer 2) lands on the hazard, pre-focused on the confirm
  // control — the whole reason the deep-link route + scheme were built in v1. The notification the
  // background task fired carries the hazard id and `action: 'confirm'`.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Partial<HazardNotificationData>;
      if (!data?.hazardId) return;
      router.navigate({
        pathname: '/hazard/[id]',
        params: { id: data.hazardId, action: data.action ?? 'confirm' },
      });
    });
    return () => sub.remove();
  }, [router]);

  return (
    <View style={{ flex: 1 }}>
      <MapView geolocateOnMount={geolocateOnMount} />
      <LakeSearch />
      <MapDrawer snapIndex={snapIndex} onCoveredFractionChange={setDrawerCoveredFraction}>
        <Slot />
      </MapDrawer>
      {/* All three sit above the drawer: a warning you can't see because a sheet is over it isn't a
          warning, and the flag button + on-ice control have to stay reachable while a drawer is open. */}
      <HazardCapture />
      <OnIceModeControl />
      <BackToLakeButton />
      <HazardBanner />
    </View>
  );
}
