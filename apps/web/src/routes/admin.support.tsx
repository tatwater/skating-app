import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * `/admin/support` → the Inbox's Support lane (B01-5f): tickets are answered there now — the thread,
 * notes, replies by email, Resolve (D284). Kept for every link that already points here (the old
 * sidebar's, a bookmark, an operator email sent before). The old page was deleted at the Inbox
 * wave's close. A viewer without support's read lands on the Inbox as it rules
 * for them: the lane isn't theirs, so they see All open.
 */
export const Route = createFileRoute('/admin/support')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/inbox', search: { lane: 'support' }, replace: true });
  },
});
