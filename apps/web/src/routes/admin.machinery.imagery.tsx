import { createFileRoute } from '@tanstack/react-router';
import { validateImagerySearch } from '../components/admin/machinery/imagerySearch';

/**
 * Machinery › Imagery (B01-8b-2, D344): the season's live imagery — its state, the granules and
 * their attempts, and its three crons. Its search (`granule`, an `imageryGranules` id; `attempt`,
 * an attempt number; `runs`, `poll | pump | index`) is validated, never trusted. This file is only
 * the route binding; the page lives in `components/admin/machinery/imagery/ImageryRoute`.
 *
 * PLACEHOLDER (B01-8b-2's seams): the page isn't built yet, so the route draws nothing and no lane
 * or link leads here but the audit feed's (whose rows its writes don't yet make). W1 mounts
 * `ImageryRoute` here and adds the *Imagery* lane.
 */
export const Route = createFileRoute('/admin/machinery/imagery')({
  validateSearch: validateImagerySearch,
  component: () => null,
});
