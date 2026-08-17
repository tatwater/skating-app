import { createFileRoute } from '@tanstack/react-router';
import { BountyDetail } from '../components/BountyDetail';
import { DetailPanel } from '../components/DetailPanel';

// `/bounty/$id` — a deep-linkable bounty detail drawer over the map (D47).
export const Route = createFileRoute('/_map/bounty/$id')({ component: BountyRoute });

function BountyRoute() {
  const { id } = Route.useParams();
  return (
    <DetailPanel>
      <BountyDetail bountyId={id} />
    </DetailPanel>
  );
}
