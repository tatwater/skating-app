import type { LatLng } from '@skating/core';
import { lazy, Suspense } from 'react';
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
  label,
  className,
}: {
  input: InstrumentInput;
  onPick?: (coord: LatLng) => void;
  label: string;
  className?: string;
}) {
  return (
    <MapPane
      data-slot="instrument-map"
      role="region"
      aria-label={label}
      className={cn('ph-no-capture relative size-full', className)}
    >
      <Suspense fallback={null}>
        <InstrumentMapCanvas input={input} {...(onPick !== undefined ? { onPick } : {})} />
      </Suspense>
    </MapPane>
  );
}
