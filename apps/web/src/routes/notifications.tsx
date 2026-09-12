import { api } from '@skating/convex/api';
import { describeNotification, formatRelativeTime, type NotificationView } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useConvexAuth, useMutation, usePaginatedQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { Panel } from '../components/Panel';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { notificationHref } from '../lib/notificationTargets';

const PAGE_SIZE = 30;

/**
 * The inbox (N8/A3) — *what happened to you and your contributions*, as opposed to the newsfeed's
 * *what happened on the ice*. A route rather than a popover so it's linkable and testable.
 *
 * Opening the page marks everything that exists at that moment as read (the server bounds it by its
 * own clock), so a notification that lands mid-visit stays unread until it's actually been seen.
 * Rows are never hidden for being stale: a target that's been removed renders degraded and
 * untappable (N8 #5).
 */
export const Route = createFileRoute('/notifications')({ component: NotificationsPage });

function NotificationsPage() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.list,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const markRead = useMutation(api.notifications.markRead);
  const { isAuthenticated } = useConvexAuth();
  const now = Date.now();

  // Mark what the page opened on as read — **once**, when the first page has landed and the Convex
  // client holds its token. Not on every reactive re-render: a notification delivered while this
  // tab sits open in the background would otherwise stamp itself read the moment it arrived,
  // unseen. It stays unread until the next visit. The latch is set whether or not anything shown
  // was unread — latching only after a mark would leave a page opened on an all-read inbox free to
  // mark the next arrival on sight. The auth gate is `useConvexAuth`, not "rows are present": a
  // hard refresh runs the first page a frame before the token and `list` fails soft to an empty
  // page, so an empty page can't be trusted to mean an empty inbox — but neither can rows be
  // required, because an inbox whose every row is a blocked actor's lists nothing while the bell
  // still counts them, and a rows guard would leave it lit for good. No `before`: the server stamps
  // everything that exists now, including the rows the list omits for blocked actors, which is
  // what keeps the bell and the list agreeing.
  //
  // The rows it stamps are remembered for the visit: the list is reactive, so once the mark lands
  // every row re-renders with `readAt` set, and a dot drawn from `readAt` alone would vanish before
  // anyone saw which rows were new. `newThisVisit` is what the dot reads instead — seeded from the
  // page in hand before the mutation fires (the subscription reflects the stamp *before* the
  // mutation's promise resolves, so seeding afterwards would flicker), then widened to everything
  // the server stamped, which covers rows a later "Load more" brings in.
  const marked = useRef(false);
  const [newThisVisit, setNewThisVisit] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (marked.current || !isAuthenticated || status === 'LoadingFirstPage') return;
    marked.current = true;
    setNewThisVisit(new Set(results.filter((v) => v.readAt === undefined).map((v) => v.id)));
    markRead({})
      .then((stamped) => setNewThisVisit((prev) => new Set([...prev, ...stamped])))
      .catch(() => {});
  }, [markRead, isAuthenticated, status, results]);

  const loadMoreFooter =
    status === 'CanLoadMore' ? (
      <Button variant="outline" onClick={() => loadMore(PAGE_SIZE)} className="self-center">
        Load more
      </Button>
    ) : status === 'LoadingMore' ? (
      <Skeleton className="h-14 w-full" />
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="font-semibold text-foreground text-xl">Notifications</h1>
      {status === 'LoadingFirstPage' ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : results.length === 0 ? (
        <Panel title="Nothing yet">
          <p>
            When someone comments on your report, finds it helpful, or a lake you follow gets new
            ice, it shows up here. Which of those reach you is up to you in{' '}
            <Link to="/settings" className="text-primary hover:underline">
              Settings
            </Link>
            .
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
          {results.map((view) => (
            <NotificationRow
              key={view.id}
              view={view}
              now={now}
              unread={view.readAt === undefined || newThisVisit.has(view.id)}
            />
          ))}
        </ul>
      )}
      {loadMoreFooter}
    </div>
  );
}

function NotificationRow({
  view,
  now,
  unread,
}: {
  view: NotificationView;
  now: number;
  /** New since the last visit — still unread, or stamped read by this visit's open. */
  unread: boolean;
}) {
  const { title, detail, target } = describeNotification(view);
  const href = notificationHref(target, view);
  const body = (
    <div className="flex items-start gap-3 px-4 py-3">
      {/* The unread dot sits in a fixed-width gutter so read and unread rows keep the same left edge. */}
      <span className="mt-2 flex w-2 shrink-0 justify-center">
        {unread ? (
          <span className="size-2 rounded-full bg-primary" role="img" aria-label="Unread" />
        ) : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={`text-sm ${unread ? 'font-medium text-foreground' : 'text-foreground'}`}>
          {title}
        </p>
        {detail ? <p className="text-foreground-muted text-xs">{detail}</p> : null}
        <p className="text-foreground-muted text-xs">{formatRelativeTime(view.createdAt, now)}</p>
      </div>
    </div>
  );
  return (
    <li data-notification-id={view.id}>
      {href ? (
        <Link to={href.to} params={href.params} className="block hover:bg-surface-muted">
          {body}
        </Link>
      ) : (
        // Degraded (target gone) or a type with nowhere to go: shown, not a link (N8 #5).
        <div className="opacity-80">{body}</div>
      )}
    </li>
  );
}
