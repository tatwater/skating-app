import { createFileRoute } from '@tanstack/react-router';
import { OverviewRoute } from '../components/admin/overview/OverviewRoute';
import { validateOverviewSearch } from '../components/admin/overview/overviewSearch';

/**
 * The console's Overview (B01): Home and Metrics, the tab in a validated `?tab=` (Home is none).
 * The old dashboard that stood here moved to `/admin/dashboard`. This file is only the route
 * binding; the page lives in `components/admin/overview/OverviewRoute`, where it can be imported.
 */
export const Route = createFileRoute('/admin/')({
  validateSearch: validateOverviewSearch,
  component: OverviewRoute,
});
