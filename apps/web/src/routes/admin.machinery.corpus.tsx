import { createFileRoute } from '@tanstack/react-router';
import { CorpusRunsRoute } from '../components/admin/machinery/corpus/CorpusRunsRoute';
import { validateMachinerySearch } from '../components/admin/machinery/machinerySearch';

/**
 * Machinery › Corpus (B01-8a, D341): the corpus runs, newest first, and the open campaign or run
 * beside them. Its search (`campaign`, a campaign id; `run`, an `importRuns` id) is validated, never
 * trusted. This file is only the route binding; the page lives in
 * `components/admin/machinery/corpus/CorpusRunsRoute`.
 */
export const Route = createFileRoute('/admin/machinery/corpus')({
  validateSearch: validateMachinerySearch,
  component: () => <CorpusRunsRoute />,
});
