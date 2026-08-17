import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useState } from 'react';
import { MapSelectionProvider, useMapSelection } from '../components/MapSelectionContext';
import { ViewportLakeList } from '../components/ViewportLakeList';
import { hasMapDrawer, parseMapSelection } from '../lib/mapSelection';

/**
 * Pathless layout (§D, D47) that keeps ONE `MapView` mounted under an `<Outlet />` across the map
 * routes — `/` (map), `/water/$id`, `/report/$id` — so panning/zoom survive opening a detail panel.
 * The panels render into the outlet as siblings of the map and push what to highlight/frame up
 * through `MapSelectionContext`. This layout owns the highlight-from-URL sync; the panels own the
 * data-derived focus + photo pins. Sibling routes (`/feed`, `/settings`, …) sit outside this layout,
 * so they don't carry the map.
 *
 * ## The map is the page
 *
 * The map used to be a `75vh` block on a scrolling page, with the detail drawer *floating over* its
 * right-hand third — so the map was never as big as the screen, and a third of what it did have was
 * covered whenever you looked at anything. Now the two are columns: the map takes every pixel the
 * shell doesn't need, and the sidebar sits beside it rather than on it, permanently open. Nothing
 * selected is a state the sidebar has content for (`ViewportLakeList`), not a state it disappears in.
 *
 * **Below `md` there is no room for two columns**, so the sidebar keeps its old behaviour: absent on
 * the bare map, covering the map when something is selected. Note it *covers* rather than *overlays*
 * — same pixels, but it's the same element in the same flow, so there is no dialog, no backdrop and
 * no focus trap. That's a CSS breakpoint rather than a measured viewport on purpose: a JS media
 * query would have to guess during SSR and correct itself on hydration, which is a layout flash on
 * the first paint of the app's main screen.
 */
export const Route = createFileRoute('/_map')({ component: MapLayout });

// WebGL/MapLibre needs the DOM, so the map is loaded client-only (a mounted gate keeps it out of the
// SSR pass and its module out of the server bundle) while matching the server's skeleton.
const MapView = lazy(() => import('../components/MapView'));

function MapLayout() {
  return (
    <MapSelectionProvider>
      <MapLayoutInner />
    </MapSelectionProvider>
  );
}

function MapLayoutInner() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setHighlightWaterBodyId, setPhotoPins, setContourBodyKey } = useMapSelection();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Geolocation framing only when the first route was the bare map — a deep-linked panel frames on
  // its own target instead (the initializer runs once, capturing the entry pathname).
  const [geolocateOnMount] = useState(() => parseMapSelection(pathname).kind === 'none');

  const drawerOpen = hasMapDrawer(pathname);

  // On any navigation, clear the map highlight + photo pins. The panels re-set the highlight from
  // their *resolved* body id (merge-correct: `waterBodies.get` follows `mergedIntoId` to the
  // survivor, whose `_id` — not the URL/stored id — is what the map's features carry), and the
  // report panel re-sets the pins. Clearing here avoids showing the previous lake's highlight while
  // the next panel loads, or leaving it stuck when a report resolves to not-found.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the intended re-run trigger.
  useEffect(() => {
    setHighlightWaterBodyId(null);
    setPhotoPins([]);
    // The contour layer unmounts with the panel it belongs to (N6b/D81). Cleared here rather than
    // in the panel's own unmount so navigating lake → lake tears the source down and rebuilds it
    // for the new body, instead of leaving one lake's isobaths filtered to another's id.
    setContourBodyKey(null);
  }, [pathname, setHighlightWaterBodyId, setPhotoPins, setContourBodyKey]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">
        {mounted ? (
          <Suspense fallback={<MapSkeleton />}>
            <MapView geolocateOnMount={geolocateOnMount} />
          </Suspense>
        ) : (
          <MapSkeleton />
        )}
      </div>
      <aside
        aria-label="Lake details"
        className={`absolute inset-0 z-20 flex-col overflow-hidden border-border border-l bg-surface md:static md:z-auto md:flex md:w-[26rem] md:shrink-0 ${
          drawerOpen ? 'flex' : 'hidden'
        }`}
      >
        {/* The outlet is the selected thing's panel; with nothing selected the index route renders
            nothing and the list takes the column. Both are rendered by the same element, so the
            sidebar's width and scroll behaviour are defined once. */}
        {drawerOpen ? null : <ViewportLakeList />}
        <Outlet />
      </aside>
    </div>
  );
}

function MapSkeleton() {
  // `inset-0` for the same reason the map itself uses it — it fills the positioned map cell without
  // depending on a percentage height resolving through the flex chain.
  return <div className="absolute inset-0 animate-pulse bg-surface-muted" />;
}
