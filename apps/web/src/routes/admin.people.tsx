import { createFileRoute } from '@tanstack/react-router';
import { PeopleListRoute } from '../components/admin/people/list/PeopleListRoute';
import { validatePeopleSearch } from '../components/admin/people/list/peopleSearch';

/**
 * The console's People (B01): the lanes and the list at `/admin/people`, the lane and the search in
 * a validated search string. A layout: the person open beside the list (`/admin/people/$id`, its
 * own route file) draws in the list's third column through the outlet, so the list stays where it
 * was while people open and close. This file is only the route binding; the page lives in
 * `components/admin/people/list/PeopleListRoute`.
 */
export const Route = createFileRoute('/admin/people')({
  validateSearch: validatePeopleSearch,
  component: PeopleListRoute,
});
