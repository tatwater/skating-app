import { createFileRoute } from '@tanstack/react-router';
import { PersonPane } from '../components/admin/people/person/PersonPane';

/**
 * One person in the console's People mode (B01, boards 8.1, 8.2, 8.5, 8.6): the person page,
 * standing alone. This file is only the route binding; the page lives in
 * `components/admin/people/person/PersonPane`, which the People list also places beside itself.
 */
export const Route = createFileRoute('/admin/people/$id')({ component: PersonRoute });

function PersonRoute() {
  const { id } = Route.useParams();
  return <PersonPane userId={id} returnTo="/admin/people" className="h-full" />;
}
