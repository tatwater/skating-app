import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * The map's float slot (boards 3.14/3.15): a positioned layer over the canvas that a view can put a
 * plate into — the freeze-up timeline floats over the lake it paints. `MapFrame` owns the layer and
 * provides it; the layer passes presses through to the map, and only what a view floats takes them.
 */
export const MapFloatContext = createContext<HTMLElement | null>(null);

/**
 * Floats `children` over the map, at its lower left (its top on a phone, where the lake's drawer
 * holds the bottom). On a phone it also stops short of the dock's column at the top right — a plate
 * the full width of a 390 screen sat over the zoom and layer buttons. Nothing renders until the
 * frame's layer exists — and outside a frame, never.
 */
export function MapFloat({ children, className }: { children: ReactNode; className?: string }) {
  const slot = useContext(MapFloatContext);
  if (slot === null) return null;
  return createPortal(
    <div
      data-slot="map-float"
      className={cn(
        'pointer-events-auto absolute left-(--space-4) max-w-[calc(100%-2*var(--space-4))]',
        'bottom-[calc(var(--space-4)+var(--map-foot,0px))] max-md:top-(--space-4) max-md:bottom-auto',
        'max-md:max-w-[calc(100%-3*var(--space-4)-var(--spacing-btn))]',
        className,
      )}
    >
      {children}
    </div>,
    slot,
  );
}
