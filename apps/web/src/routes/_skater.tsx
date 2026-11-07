import { createFileRoute, Outlet } from '@tanstack/react-router';
import { MapFrame } from '../components/skater/map/MapFrame';
import { SkaterShell } from '../components/skater/SkaterShell';
import { skaterRootSearchSchema } from '../lib/skaterSearch';

/**
 * The pathless skater layout (B03 §1.0, D242): validates the root search params (`?post=`,
 * `?postBody=`) so the report sheet can open over any skater page and over nothing else, and
 * mounts the skater shell around the map frame. The frame owns the one persistent region map
 * (§1.8), so moving between skater pages never remounts it; a page brings only its own column.
 */
export const Route = createFileRoute('/_skater')({
  validateSearch: skaterRootSearchSchema,
  component: SkaterLayout,
});

function SkaterLayout() {
  return (
    <SkaterShell>
      <MapFrame>
        <Outlet />
      </MapFrame>
    </SkaterShell>
  );
}
