import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SkaterRequestLakeHost } from '../components/skater/actions/RequestLakePane';
import { MapFrame } from '../components/skater/map/MapFrame';
import { SkaterShell } from '../components/skater/SkaterShell';
import { useHazardDraftOwnerBinding } from '../lib/hazardDraftOwner';
import { skaterRootSearchSchema } from '../lib/skaterSearch';

/**
 * The pathless skater layout (B03 §1.0, D242): validates the root search params (`?post=`,
 * `?postBody=`) so the report sheet can open over any skater page and over nothing else, and
 * mounts the skater shell around the map frame. The frame owns the one persistent region map
 * (§1.8), so moving between skater pages never remounts it; a page brings only its own column.
 * The layout also holds what belongs to no one page: the request-a-lake dialog the map's click
 * opens, and the hazard draft's owner binding (the signed-in Clerk user).
 */
export const Route = createFileRoute('/_skater')({
  validateSearch: skaterRootSearchSchema,
  component: SkaterLayout,
});

function SkaterLayout() {
  useHazardDraftOwnerBinding();
  return (
    <SkaterShell>
      <MapFrame>
        <Outlet />
      </MapFrame>
      <SkaterRequestLakeHost />
    </SkaterShell>
  );
}
