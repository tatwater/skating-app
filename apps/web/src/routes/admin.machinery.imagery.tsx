import { createFileRoute } from '@tanstack/react-router';
import { ImageryRoute } from '../components/admin/machinery/imagery/ImageryRoute';
import { validateImagerySearch } from '../components/admin/machinery/imagerySearch';

/**
 * Machinery › Imagery (B01-8b-2, D344, D346): the season's live imagery — its state, the granules
 * and their attempts, and its three crons. Its search (`granule`, an `imageryGranules` id; `attempt`,
 * an attempt number; `runs`, `poll | pump | index`) is validated, never trusted. This file is only
 * the route binding; the page lives in `components/admin/machinery/imagery/ImageryRoute`.
 */
export const Route = createFileRoute('/admin/machinery/imagery')({
  validateSearch: validateImagerySearch,
  component: () => <ImageryRoute />,
});
