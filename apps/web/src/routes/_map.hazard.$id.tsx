import { createFileRoute } from '@tanstack/react-router';
import { DetailSheet } from '../components/DetailSheet';
import { HazardDetail } from '../components/HazardDetail';

// `/hazard/$id` — a deep-linkable hazard drawer over the map (Phase 9, D51/D52).
// Also the landing target for the mobile `skating://hazard/<id>?action=confirm` deep link an
// on-ice notification tap uses (D54 Layer 2). `?action=confirm` scrolls the confirm control into
// view; TanStack drops un-validated search, so the param has to be parsed here to survive.
export const Route = createFileRoute('/_map/hazard/$id')({
  component: HazardRoute,
  validateSearch: (search: Record<string, unknown>): { action?: 'confirm' } => ({
    action: search.action === 'confirm' ? 'confirm' : undefined,
  }),
});

function HazardRoute() {
  const { id } = Route.useParams();
  const { action } = Route.useSearch();
  return (
    <DetailSheet>
      <HazardDetail hazardId={id} action={action} />
    </DetailSheet>
  );
}
