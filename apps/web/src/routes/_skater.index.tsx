import { createFileRoute } from '@tanstack/react-router';
import { ExplorePage } from '../components/skater/lake/ExplorePage';
import { exploreSearchSchema } from '../components/skater/lake/lakeSearch';

/** `/` — Explore with nothing chosen: the lakes in view beside the region map (B03 §1.1, 1.1). */
export const Route = createFileRoute('/_skater/')({
  validateSearch: exploreSearchSchema,
  component: ExploreRoute,
});

function ExploreRoute() {
  return <ExplorePage search={Route.useSearch()} />;
}
