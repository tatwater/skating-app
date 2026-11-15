import { createFileRoute } from '@tanstack/react-router';
import { peopleListHref, queryOf } from '../components/admin/people/list/peopleSearch';
import { PersonPane } from '../components/admin/people/person/PersonPane';

/**
 * One person in the console's People mode (B01, boards 8.1, 8.2, 8.5, 8.6). A child of the People
 * list's layout (`admin.people.tsx`): the page draws in the list's third column, the list beside it
 * on the lane and search the URL holds (Everyone when none), and its way back returns to that same
 * list. This file is only the route binding; the page lives in
 * `components/admin/people/person/PersonPane`.
 */
export const Route = createFileRoute('/admin/people/$id')({ component: PersonRoute });

function PersonRoute() {
  const { id } = Route.useParams();
  // The list's lane and search, validated by the layout above this route.
  const search = Route.useSearch();
  return <PersonPane userId={id} returnTo={peopleListHref(queryOf(search))} className="h-full" />;
}
