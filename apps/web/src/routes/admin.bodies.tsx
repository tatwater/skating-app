import { createFileRoute } from '@tanstack/react-router';
import { BodiesRoute } from '../components/admin/bodies/BodiesRoute';
import { validateBodiesSearch } from '../components/admin/bodies/bodiesSearch';

/**
 * The console's Bodies library (B01): every water body by lane, its facets and search in a
 * validated search string, the open row's preview, and *Open in Body* to the Body console. This
 * file is only the route binding; the page lives in `components/admin/bodies/BodiesRoute`.
 */
export const Route = createFileRoute('/admin/bodies')({
  validateSearch: validateBodiesSearch,
  component: () => <BodiesRoute bodyPath={(id) => `/admin/body/${id}`} />,
});
