import { createFileRoute } from '@tanstack/react-router';
import { LakeBehind } from '../components/skater/lake/LakeBehind';
import { HazardPanel } from '../components/skater/panels/HazardPanel';
import { hazardSearchSchema } from '../components/skater/panels/hazardSearch';
import { PanelColumn } from '../components/skater/panels/InsetCard';
import { PanelCrash } from '../components/skater/panels/PanelCrash';
import { useHazardLakeId } from '../components/skater/panels/panelLake';

/**
 * `/hazard/$id` — a hazard as an inset card (B03 §1.1, boards 2.1–2.3). `?action=confirm` (kept from
 * before, D242) opens it on the verdicts.
 */
export const Route = createFileRoute('/_skater/hazard/$id')({
  validateSearch: hazardSearchSchema,
  component: HazardRoute,
  errorComponent: PanelCrash,
});

function HazardRoute() {
  const { id } = Route.useParams();
  const { action } = Route.useSearch();
  return (
    <PanelColumn behind={<LakeBehind waterBodyId={useHazardLakeId(id)} />}>
      <HazardPanel key={id} hazardId={id} {...(action !== undefined ? { action } : {})} />
    </PanelColumn>
  );
}
