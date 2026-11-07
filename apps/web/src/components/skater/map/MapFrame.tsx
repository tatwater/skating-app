import { type ReactNode, useState } from 'react';

import { cn } from '@/lib/utils';
import { effectiveMapSpec, useSkaterMapStore } from '@/stores/skaterMapStore';

import { MapFloatContext } from './MapFloat';
import { MAP_FOOT_ROOM } from './MapKey';
import { SkaterMap } from './SkaterMap';

/**
 * The skater layout's page area (B03 §1.1, §1.8): the view on the left and the one region map
 * beside it. The map is mounted here, once, so it stays mounted across `/`, `/water/$id` and every
 * other skater page — a view only declares what it wants of it (`useMapSpec`).
 *
 * While a view shows the map, the view takes the fixed sidebar column (`--size-sidebar`) and the map the
 * rest. A view with no map takes the whole width; the hidden map steps out of the grid (still
 * mounted, still sized, so showing it again costs nothing). Below `md` (row 9) the map fills the
 * page area and the view lies over it: Explore shows the bare map, a lake its drawer.
 *
 * Over the map sits its float slot (`MapFloat`): a layer that passes presses through, which a view
 * can float a plate into — the imagery timeline (boards 3.14/3.15). The map's key runs along its
 * foot; while it does, what sits on the bottom edge rises clear of it (`MAP_FOOT_ROOM`).
 */
export function MapFrame({ children }: { children: ReactNode }) {
  const shown = useSkaterMapStore((s) => effectiveMapSpec(s.specs).visible);
  const [floatSlot, setFloatSlot] = useState<HTMLElement | null>(null);
  return (
    <MapFloatContext.Provider value={floatSlot}>
      <div
        data-slot="map-frame"
        data-map-shown={shown ? '' : undefined}
        className="relative grid h-full min-h-0 grid-cols-1 md:grid-cols-[var(--size-sidebar)_minmax(0,1fr)]"
      >
        <div
          data-slot="map-frame-view"
          className={cn(
            'h-full min-h-0 min-w-0',
            !shown && 'md:col-span-2',
            // Phone (row 9): over the map, passing presses through where the view draws nothing.
            shown &&
              'max-md:pointer-events-none max-md:relative max-md:z-(--z-raised) max-md:*:pointer-events-auto',
          )}
        >
          {children}
        </div>
        <div
          data-slot="map-frame-map"
          className={cn(
            'relative h-full min-h-0 min-w-0',
            MAP_FOOT_ROOM,
            // Phone (row 9): the map fills the page area under the view; hidden when not shown.
            shown ? 'max-md:absolute max-md:inset-0' : 'max-md:hidden',
            !shown && 'pointer-events-none absolute inset-0',
          )}
        >
          <SkaterMap />
          <div
            ref={setFloatSlot}
            data-slot="map-float-slot"
            className={cn(
              'pointer-events-none absolute inset-0 z-(--z-plate) overflow-hidden',
              !shown && 'hidden',
            )}
          />
        </div>
      </div>
    </MapFloatContext.Provider>
  );
}
