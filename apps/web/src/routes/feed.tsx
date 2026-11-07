import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/feed` → `/latest` (D242): the old Latest path, kept for every link that already points at it.
 * A report open in the old drawer (`?report=`) lands open in Latest's center column; anything else
 * on the old URL — the old page took nothing else — is dropped. The filters were never in the URL.
 */
export function feedRedirectSearch(search: Record<string, unknown>): { report?: string } {
  return typeof search.report === 'string' && search.report.length > 0
    ? { report: search.report }
    : {};
}

export const Route = createFileRoute('/feed')({
  validateSearch: feedRedirectSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/latest', search, replace: true });
  },
});
