import { createFileRoute, redirect } from '@tanstack/react-router';
import { postRedirectSearch } from '../components/skater/sheet/sheetHostModel';

/**
 * `/post` — kept so the links the outside world already holds keep working (D242), and nothing
 * else: the New report sheet opens over Explore instead of on a page of its own.
 *
 * - `/post?edit=R` → `/?post=R` (edit that report)
 * - `/post?body=X` → `/?post=new&postBody=X` (a new report on that lake)
 * - `/post` → `/?post=new`
 *
 * The redirect replaces the history entry, so Back from the sheet never lands on a dead `/post`.
 */
export const Route = createFileRoute('/post')({
  // `name` is the lake's name some old links still carry; the sheet reads the lake's own.
  validateSearch: (
    search: Record<string, unknown>,
  ): { body?: string; name?: string; edit?: string } => ({
    ...(typeof search.body === 'string' && search.body.length > 0 ? { body: search.body } : {}),
    ...(typeof search.name === 'string' && search.name.length > 0 ? { name: search.name } : {}),
    ...(typeof search.edit === 'string' && search.edit.length > 0 ? { edit: search.edit } : {}),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/', search: postRedirectSearch(search), replace: true });
  },
});
