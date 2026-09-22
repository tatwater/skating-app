import { createFileRoute } from '@tanstack/react-router';
import { DetailPanel } from '../components/DetailPanel';
import { WaterBodyDetail } from '../components/WaterBodyDetail';

// `/water/$id` — a deep-linkable water-body detail drawer over the map (D47).
export const Route = createFileRoute('/_map/water/$id')({
  // `?sub=<subAreaId>` — the named bay a search hit picked (A02/D60). A bay has no page of its own;
  // it opens its parent's, and this is what tells the map to frame the bay rather than the whole
  // lake. Searching Malletts Bay and landing 200 km out on Champlain would defeat naming it.
  // `?hazard` — open the hazard form on arrival. The report console hands off here for *mark one
  // here* (A10-5 §6): drawing a hazard needs the real map — the drag, the shore snap, the
  // duplicate nudge — which the console, a route beside the map rather than inside it, has not got.
  validateSearch: (search: Record<string, unknown>): { sub?: string; hazard?: true } => ({
    ...(typeof search.sub === 'string' && search.sub.length > 0 ? { sub: search.sub } : {}),
    ...(search.hazard === true || search.hazard === 'true' ? { hazard: true as const } : {}),
  }),
  component: WaterRoute,
});

function WaterRoute() {
  const { id } = Route.useParams();
  const { sub, hazard } = Route.useSearch();
  return (
    <DetailPanel>
      <WaterBodyDetail waterBodyId={id} focusSubAreaId={sub} openHazardForm={hazard === true} />
    </DetailPanel>
  );
}
