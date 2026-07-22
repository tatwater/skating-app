import { createFileRoute } from '@tanstack/react-router';
import { DetailSheet } from '../components/DetailSheet';
import { HazardDetail } from '../components/HazardDetail';

// `/hazard/$id` — a deep-linkable hazard drawer over the map (Phase 9, D51/D52).
// Also the landing target for the mobile `skating://hazard/<id>?action=confirm` deep link that a
// future on-ice notification tap will use (D54 Layer 2).
export const Route = createFileRoute('/_map/hazard/$id')({ component: HazardRoute });

function HazardRoute() {
  const { id } = Route.useParams();
  return (
    <DetailSheet>
      <HazardDetail hazardId={id} />
    </DetailSheet>
  );
}
