import { lazy, Suspense, useEffect, useState } from 'react';
import { MapPane } from '@/components/kit/map-controls';
import { useTheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { MAP_FLAVORS } from '@/lib/waterMap';
import { effectiveMapSpec, useSkaterMapStore } from '@/stores/skaterMapStore';
import { mapMarkVars } from './mapPalette';

/**
 * The skater layout's one region map (B03 §1.8). Mount it once, in the layout, where it can stay
 * mounted across `/`, `/water/$id`, the panels and Latest's `?view=map`; never portal it. Views
 * don't render it — they declare what they want of it with `useMapSpec`.
 *
 * This shell is light on purpose: it has no map library in it, so the layout can import it
 * statically and render it on the server. The canvas (MapLibre, WebGL) loads the first time a view
 * shows the map, and is never unmounted after; a page with no map hides the pane and holds no reads.
 *
 * The pane carries `ph-no-capture` (D240): its DOM labels name lakes.
 */

const SkaterMapCanvas = lazy(() => import('./SkaterMapCanvas'));

export function SkaterMap({ className }: { className?: string }) {
  const spec = useSkaterMapStore((s) => effectiveMapSpec(s.specs));
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'light' ? MAP_FLAVORS.light : MAP_FLAVORS.dark;

  // The canvas mounts the first time a view shows the map — after hydration, since WebGL needs the
  // DOM — and stays mounted from then on, hidden or not.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (spec.visible) setStarted(true);
  }, [spec.visible]);

  return (
    <MapPane
      data-slot="skater-map"
      data-map-spec={spec.id}
      data-visible={spec.visible ? '' : undefined}
      role="region"
      aria-label="Map"
      aria-hidden={spec.visible ? undefined : true}
      inert={!spec.visible}
      className={cn('ph-no-capture size-full', !spec.visible && 'invisible', className)}
      style={mapMarkVars(flavor)}
    >
      {started && (
        <Suspense fallback={null}>
          <SkaterMapCanvas />
        </Suspense>
      )}
    </MapPane>
  );
}

export default SkaterMap;
