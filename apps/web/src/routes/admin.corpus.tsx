import { createFileRoute } from '@tanstack/react-router';
import { BodiesRoute } from '../components/admin/bodies/BodiesRoute';
import { validateBodiesSearch } from '../components/admin/bodies/bodiesSearch';

/**
 * The console's Corpus (B01, D293): every water body by lane, its facets and search in a validated
 * search string, and the open row's preview, whose action opens the body's console. Built as
 * "Bodies" and renamed; the old `/admin/bodies` is not redirected. This file is only the route
 * binding; the page lives in `components/admin/bodies/BodiesRoute`.
 */
export const Route = createFileRoute('/admin/corpus')({
  validateSearch: validateBodiesSearch,
  component: () => <BodiesRoute />,
});
