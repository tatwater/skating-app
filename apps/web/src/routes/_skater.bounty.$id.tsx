import { createFileRoute } from '@tanstack/react-router';
import { LakeBehind } from '../components/skater/lake/LakeBehind';
import { BountyPanel } from '../components/skater/panels/BountyPanel';
import { PanelColumn } from '../components/skater/panels/InsetCard';
import { PanelCrash } from '../components/skater/panels/PanelCrash';
import { useBountyLakeId } from '../components/skater/panels/panelLake';

/** `/bounty/$id` — a bounty as an inset card (B03 §1.1, boards 2.6/2.7). The path is kept (D242). */
export const Route = createFileRoute('/_skater/bounty/$id')({
  component: BountyRoute,
  errorComponent: PanelCrash,
});

function BountyRoute() {
  const { id } = Route.useParams();
  return (
    <PanelColumn behind={<LakeBehind waterBodyId={useBountyLakeId(id)} />}>
      <BountyPanel key={id} bountyId={id} />
    </PanelColumn>
  );
}
