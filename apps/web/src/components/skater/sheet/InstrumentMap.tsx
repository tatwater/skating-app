import type { LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { lazy, type ReactNode, Suspense } from 'react';
import { MapPane } from '@/components/kit/map-controls';
import { useTheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { MAP_FLAVORS } from '@/lib/waterMap';
import { MAP_FOOT_ROOM, MapKey } from '../../kit/map-key';
import { mapMarkVars } from '../map/mapPalette';
import { type InstrumentInput, instrumentKeyKinds } from './instrumentFeatures';

const InstrumentMapCanvas = lazy(() => import('./InstrumentMapCanvas'));

/**
 * The instrument's map pane: light, so the sheet renders on the server; the canvas (MapLibre, WebGL)
 * loads once the sheet is open in a browser and is removed with the sheet. `ph-no-capture` (D240):
 * it shows where someone skated. The key along its foot names the kinds the input draws; the pane
 * carries the marks' ground (`mapMarkVars`), as the region map's does.
 */
export function InstrumentMap({
  input,
  onPick,
  onMap,
  suspended = false,
  keyDim = false,
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
  /** A sub-mode has the map: the key steps back. */
  keyDim?: boolean;
  label: string;
  className?: string;
  /** Drawn over the canvas (the sub-modes' overlay, a mode bar). */
  children?: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'light' ? MAP_FLAVORS.light : MAP_FLAVORS.dark;
  return (
    <MapPane
      data-slot="instrument-map"
      role="region"
      aria-label={label}
      className={cn('ph-no-capture relative size-full', MAP_FOOT_ROOM, className)}
      style={mapMarkVars(flavor)}
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
      {/* No canvas, no marks while the GL slot is lent out — so no key either. */}
      {suspended ? null : <MapKey kinds={instrumentKeyKinds(input)} dim={keyDim} />}
    </MapPane>
  );
}
