import { api } from '@skating/convex/api';
import { useRouter } from '@tanstack/react-router';
import { useConvexAuth, useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';

import { bucketUnreadCount, useAnalytics } from '@/lib/analytics';

import { useChromeOverlay } from './chrome';
import { NotificationsMenuView } from './NotificationsMenuView';
import { notificationRows } from './notificationRows';
import { panelLinkState } from './panels/panelNavigation';

/**
 * The bell, wired (boards 3.21–3.23; replaces the old `/notifications` page). The unread count is
 * the shell's one always-on subscription — a capped indexed read. The list subscribes only while
 * the plate is open.
 *
 * **Opening marks what's there as read — once per opening**, with the inbox's rules (A08 §1.3):
 * after the first page has landed and the Convex client holds its token, with no `before` bound so
 * the server stamps everything that exists now (blocked actors' rows included, keeping the bell and
 * the list agreeing). The rows it stamped stay drawn as new until the plate closes, so nothing loses
 * its wash the moment the mark lands; one that arrives while the plate is open stays unread.
 */
const PAGE_SIZE = 20;

export function NotificationsMenu({ container }: { container?: HTMLElement | null } = {}) {
  const router = useRouter();
  const { capture } = useAnalytics();
  const { open, onOpenChange } = useChromeOverlay('notifications');
  const unread = useQuery(api.notifications.unreadCount, {}) ?? 0;

  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.list,
    open ? {} : 'skip',
    { initialNumItems: PAGE_SIZE },
  );
  const markRead = useMutation(api.notifications.markRead);
  const { isAuthenticated } = useConvexAuth();

  const marked = useRef(false);
  const [newThisVisit, setNewThisVisit] = useState<ReadonlySet<string>>(() => new Set());
  // A closed plate forgets the visit: the next opening marks afresh.
  useEffect(() => {
    if (open) return;
    marked.current = false;
    setNewThisVisit((prev) => (prev.size === 0 ? prev : new Set()));
  }, [open]);
  useEffect(() => {
    if (!open || marked.current || !isAuthenticated || status === 'LoadingFirstPage') return;
    marked.current = true;
    setNewThisVisit(new Set(results.filter((v) => v.readAt === undefined).map((v) => v.id)));
    markRead({})
      .then((stamped) => setNewThisVisit((prev) => new Set([...prev, ...stamped])))
      .catch(() => {});
  }, [open, markRead, isAuthenticated, status, results]);

  const rows =
    open && status !== 'LoadingFirstPage'
      ? notificationRows(results, newThisVisit, Date.now())
      : undefined;

  return (
    <NotificationsMenuView
      open={open}
      onOpenChange={(next) => {
        if (next && !open)
          capture('notifications_opened', { unread_bucket: bucketUnreadCount(unread) });
        onOpenChange(next);
      }}
      unreadCount={unread}
      rows={rows}
      canLoadMore={status === 'CanLoadMore'}
      loadingMore={status === 'LoadingMore'}
      onLoadMore={() => loadMore(PAGE_SIZE)}
      onOpenRow={(row) => {
        if (row.href === null) return;
        if (row.kind !== null) capture('notification_opened', { kind: row.kind });
        onOpenChange(false);
        // A row that opens a card says it came from the bell; any other page ignores the state.
        router.history.push(row.href, panelLinkState('notification'));
      }}
      onNavigate={(href) => router.history.push(href)}
      {...(container !== undefined ? { container } : {})}
    />
  );
}
