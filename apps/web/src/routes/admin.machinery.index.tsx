import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/admin/machinery` → `/admin/machinery/corpus` (D340): the mode opens on its first built page
 * until Health lands.
 */
export const Route = createFileRoute('/admin/machinery/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/machinery/corpus', replace: true });
  },
});
