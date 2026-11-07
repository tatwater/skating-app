import type { LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { lazy, type ReactNode, Suspense } from 'react';
import { MapPane } from '@/components/kit/map-controls';
import { cn } from '@/lib/utils';
import type { InstrumentInput } from './instrumentFeatures';

const InstrumentMapCanvas = lazy(() => import('./InstrumentMapCanvas'));

/**
 * The instrument's map pane: light, so the sheet renders on the server; the canvas (MapLibre, WebGL)
 * loads once the sheet is open in a browser and is removed with the sheet. `ph-no-capture` (D240):
 * it shows where someone skated.
 */
export function InstrumentMap({
  input,
  onPick,
  onMap,
  suspended = false,
  label,
  className,
  children,
}: {
  input: InstrumentInput;
  onPick?: (coord: LatLng) => void;
  /** The live map, for what draws over it (the sub-modes' overlay). */
  onMap?: (map: maplibregl.Map | null) => void;
  /** A stacked sheet holds the GL slot (`instrumentLease`): no canvas until it gives it back. */
  suspended?: boolean;
  label: string;
  className?: string;
  /** Drawn over the canvas (the sub-modes' overlay, a mode bar). */
  children?: ReactNode;
}) {
  return (
    <MapPane
      data-slot="instrument-map"
      role="region"
      aria-label={label}
      className={cn('ph-no-capture relative size-full', className)}
    >
      {suspended ? null : (
        <Suspense fallback={null}>
          <InstrumentMapCanvas
            input={input}
            {...(onPick !== undefined ? { onPick } : {})}
            {...(onMap !== undefined ? { onMap } : {})}
          />
        </Suspense>
      )}
      {children}
    </MapPane>
  );
}
