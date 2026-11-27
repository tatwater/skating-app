import { createFileRoute } from '@tanstack/react-router';

/**
 * Machinery › Corpus (B01-8a, D341): the corpus runs, newest first, and the open campaign or run
 * beside them. Its search (`campaign`, a campaign id; `run`, an `importRuns` id) is validated, never
 * trusted. This file is only the route binding; the page lives in
 * `components/admin/machinery/corpus/`.
 *
 * PLACEHOLDER (B01-8a T0): an empty page until the run list (`CorpusRunsRoute`) and its search
 * validator land.
 */
export const Route = createFileRoute('/admin/machinery/corpus')({
  component: () => null,
});
