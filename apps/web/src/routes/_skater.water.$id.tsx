import { createFileRoute } from '@tanstack/react-router';
import { LakePage } from '../components/skater/lake/LakePage';
import { lakeSearchSchema } from '../components/skater/lake/lakeSearch';

/**
 * `/water/$id` — a lake chosen (B03 §1.1, boards 1.2–1.14). A path the outside world links to
 * (notifications, email, mobile's mirror), kept as it was; its views are search params (D242).
 */
export const Route = createFileRoute('/_skater/water/$id')({
  validateSearch: lakeSearchSchema,
  component: WaterRoute,
});

function WaterRoute() {
  const { id } = Route.useParams();
  return <LakePage id={id} search={Route.useSearch()} />;
}
