import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { effectiveMapSpec, useSkaterMapStore } from '@/stores/skaterMapStore';

import { SkaterMap } from './SkaterMap';

/**
 * The skater layout's page area (B03 §1.1, §1.8): the view on the left and the one region map
 * beside it. The map is mounted here, once, so it stays mounted across `/`, `/water/$id` and every
 * other skater page — a view only declares what it wants of it (`useMapSpec`).
 *
 * While a view shows the map, the view takes the fixed 27.5 rem sidebar column and the map the
 * rest. A view with no map takes the whole width; the hidden map steps out of the grid (still
 * mounted, still sized, so showing it again costs nothing). Below `md` the view always takes the
 * width and the map stands down; the phone's own frame (row 9) replaces this there.
 */
export function MapFrame({ children }: { children: ReactNode }) {
  const shown = useSkaterMapStore((s) => effectiveMapSpec(s.specs).visible);
  return (
    <div
      data-slot="map-frame"
      data-map-shown={shown ? '' : undefined}
      className="relative grid h-full min-h-0 grid-cols-1 md:grid-cols-[27.5rem_minmax(0,1fr)]"
    >
      <div
        data-slot="map-frame-view"
        className={cn('h-full min-h-0 min-w-0', !shown && 'md:col-span-2')}
      >
        {children}
      </div>
      <div
        data-slot="map-frame-map"
        className={cn(
          'relative h-full min-h-0 min-w-0 max-md:hidden',
          !shown && 'pointer-events-none absolute inset-0',
        )}
      >
        <SkaterMap />
      </div>
    </div>
  );
}
