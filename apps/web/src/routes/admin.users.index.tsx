import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/admin/users` → `/admin/people` (B01): the old user search, kept for every link that already
 * points at it (the old sidebar's, a Clerk notification's deep link). People's search lane finds
 * any account the old page did, and its lanes list what the old page never could.
 */
export const Route = createFileRoute('/admin/users/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/people', replace: true });
  },
});
