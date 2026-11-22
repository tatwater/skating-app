import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/admin/flags` → the Inbox's Safety lane (B01-5e): every flag — a photo's too, the last kind the
 * old page alone decided — is decided in the Inbox now. Kept for every link that already points here
 * (the old sidebar's, a bookmark, an operator's mail sent before the change). The old page stays on
 * disk, unrouted (`components/admin/FlagQueue`).
 */
export const Route = createFileRoute('/admin/flags')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/inbox', search: { lane: 'safety' }, replace: true });
  },
});
