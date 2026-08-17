import { createFileRoute } from '@tanstack/react-router';
import { DetailPanel } from '../components/DetailPanel';
import { ReportDetail } from '../components/ReportDetail';

// `/report/$id` — a deep-linkable report detail drawer over the map (D42/D47).
export const Route = createFileRoute('/_map/report/$id')({ component: ReportRoute });

function ReportRoute() {
  const { id } = Route.useParams();
  return (
    <DetailPanel>
      <ReportDetail reportId={id} />
    </DetailPanel>
  );
}
