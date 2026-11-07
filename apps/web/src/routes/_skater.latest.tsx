import { createFileRoute } from '@tanstack/react-router';
import { LatestCrash } from '../components/skater/latest/LatestCrash';
import { LatestPage } from '../components/skater/latest/LatestPage';
import { latestSearchSchema } from '../components/skater/latest/latestSearch';

/**
 * `/latest` — every lake's reports, newest first, under the saved filters (B03 §1.2, row 4). Only
 * the transient view rides the URL (D242): `?report=`, `?q=`, `?skater=`, `?view=map`. `/feed`
 * redirects here. A crash stays in the page: the shell keeps running (§4.3).
 */
export const Route = createFileRoute('/_skater/latest')({
  validateSearch: latestSearchSchema,
  component: LatestRoute,
  errorComponent: LatestCrash,
});

function LatestRoute() {
  return <LatestPage search={Route.useSearch()} />;
}
