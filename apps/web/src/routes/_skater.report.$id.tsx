import { createFileRoute } from '@tanstack/react-router';
import { LakeBehind } from '../components/skater/lake/LakeBehind';
import { PanelColumn } from '../components/skater/panels/InsetCard';
import { PanelCrash } from '../components/skater/panels/PanelCrash';
import { useReportLakeId } from '../components/skater/panels/panelLake';
import { ReportPanel } from '../components/skater/panels/ReportPanel';

/**
 * `/report/$id` — a report as an inset card over its lake's sidebar (B03 §1.1, boards 2.4/2.5). The
 * path is kept from before (notifications, emails and mobile's mirror link here, D242). A crash in
 * the card stays in the card: the map and the shell keep running (§4.3).
 */
export const Route = createFileRoute('/_skater/report/$id')({
  component: ReportRoute,
  errorComponent: PanelCrash,
});

function ReportRoute() {
  const { id } = Route.useParams();
  return (
    <PanelColumn behind={<LakeBehind waterBodyId={useReportLakeId(id)} />}>
      <ReportPanel key={id} reportId={id} />
    </PanelColumn>
  );
}
