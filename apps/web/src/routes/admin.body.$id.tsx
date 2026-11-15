import { createFileRoute } from '@tanstack/react-router';
import { BodyConsoleRoute } from '../components/admin/body/frame/BodyConsoleRoute';
import { validateBodySearch } from '../components/admin/body/frame/bodySearch';

/**
 * The Body console (B01): one body, every lever — the left column, the map, and the inspector's
 * nine tabs, the tab, the lit item and the way back in a validated search string. This file is
 * only the route binding; the page lives in `components/admin/body/frame/BodyConsoleRoute`.
 */
export const Route = createFileRoute('/admin/body/$id')({
  validateSearch: validateBodySearch,
  component: () => <BodyConsoleRoute />,
});
