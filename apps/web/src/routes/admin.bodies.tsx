import { createFileRoute } from '@tanstack/react-router';
import { BodiesRoute } from '../components/admin/bodies/BodiesRoute';
import { validateBodiesSearch } from '../components/admin/bodies/bodiesSearch';

/**
 * The console's Bodies library (B01): every water body by lane, its facets and search in a
 * validated search string, and the open row's preview, whose action opens the body in the old
 * editor until the Body console lands. This file is only the route binding; the page lives in
 * `components/admin/bodies/BodiesRoute`.
 */
export const Route = createFileRoute('/admin/bodies')({
  validateSearch: validateBodiesSearch,
  component: () => <BodiesRoute />,
});
