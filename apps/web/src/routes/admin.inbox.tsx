import { createFileRoute } from '@tanstack/react-router';
import { InboxRoute } from '../components/admin/inbox/InboxRoute';
import { validateInboxSearch } from '../components/admin/inbox/inboxSearch';

/**
 * The console's Inbox (B01-5): the lanes, the list and the open item at `/admin/inbox`, the list's
 * place and the open item in a validated search string (`?lane=`, `?facet=`, a filter, `?item=`).
 * This file is only the route binding; the page lives in `components/admin/inbox/InboxRoute`.
 */
export const Route = createFileRoute('/admin/inbox')({
  validateSearch: validateInboxSearch,
  component: InboxRoute,
});
