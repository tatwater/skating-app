import { createFileRoute } from '@tanstack/react-router';
import { DetailSheet } from '../components/DetailSheet';
import { WaterBodyDetail } from '../components/WaterBodyDetail';

// `/water/$id` — a deep-linkable water-body detail drawer over the map (D47).
export const Route = createFileRoute('/_map/water/$id')({
  // `?sub=<subAreaId>` — the named bay a search hit picked (N2/D60). A bay has no page of its own;
  // it opens its parent's, and this is what tells the map to frame the bay rather than the whole
  // lake. Searching Malletts Bay and landing 200 km out on Champlain would defeat naming it.
  validateSearch: (search: Record<string, unknown>): { sub?: string } =>
    typeof search.sub === 'string' && search.sub.length > 0 ? { sub: search.sub } : {},
  component: WaterRoute,
});

function WaterRoute() {
  const { id } = Route.useParams();
  const { sub } = Route.useSearch();
  return (
    <DetailSheet>
      <WaterBodyDetail waterBodyId={id} focusSubAreaId={sub} />
    </DetailSheet>
  );
}
