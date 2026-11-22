import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/admin/water/requests` → the Inbox's Requests lane (B01-5c): requests, places asked and drawn
 * bodies are decided in the Inbox now. Kept for every link that already points here (the old
 * sidebar's, a bookmark). The old queue stays on disk, unrouted (`components/admin/RequestQueue`).
 */
export const Route = createFileRoute('/admin/water/requests')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/inbox', search: { lane: 'requests' }, replace: true });
  },
});
