import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/admin/users/$id` → `/admin/people/$id` (B01): the old user page, kept for every link that already
 * points at it (a profile's moderator tools, the old audit feed). The person's page in People draws
 * everything the old one did — the levers, the role, the trust panel — and its history beside.
 */
export const Route = createFileRoute('/admin/users/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ href: `/admin/people/${encodeURIComponent(params.id)}`, replace: true });
  },
});
