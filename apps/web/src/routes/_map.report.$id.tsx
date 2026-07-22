import { createFileRoute } from '@tanstack/react-router';
import { DetailSheet } from '../components/DetailSheet';
import { ReportDetail } from '../components/ReportDetail';

// `/report/$id` — a deep-linkable report detail drawer over the map (D42/D47).
export const Route = createFileRoute('/_map/report/$id')({ component: ReportRoute });

function ReportRoute() {
  const { id } = Route.useParams();
  return (
    <DetailSheet>
      <ReportDetail reportId={id} />
    </DetailSheet>
  );
}
