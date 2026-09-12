import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { describeNotification, formatRelativeTime, type NotificationView } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, usePaginatedQuery } from 'convex/react';
import { useEffect, useRef } from 'react';
import { Panel } from '../components/Panel';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { notificationHref } from '../lib/notificationTargets';

const PAGE_SIZE = 30;

/**
 * The inbox (N8/A3) — *what happened to you and your contributions*, as opposed to the newsfeed's
 * *what happened on the ice*. A route rather than a popover so it's linkable and testable.
 *
 * Opening the page marks everything it shows as read, bounded by the newest row on screen so a
 * notification that lands mid-visit stays unread until it's actually been seen. Rows are never
 * hidden for being stale: a target that's been removed renders degraded and untappable (N8 #5).
 */
export const Route = createFileRoute('/notifications')({ component: NotificationsPage });

function NotificationsPage() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.list,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const markRead = useMutation(api.notifications.markRead);
  const now = Date.now();

  // Mark-all-read once per distinct "newest unread" — not on every reactive re-render, and not
  // before the first page has actually arrived (an empty `results` during load would mark nothing
  // and then never fire again for the rows that turned up a moment later).
  const newestUnread = results.find((n) => n.readAt === undefined)?.createdAt;
  const marked = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (status === 'LoadingFirstPage' || newestUnread === undefined) return;
    if (marked.current === newestUnread) return;
    marked.current = newestUnread;
    void markRead({ before: newestUnread });
  }, [markRead, newestUnread, status]);

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
            <NotificationRow key={view.id} view={view} now={now} />
          ))}
        </ul>
      )}
      {loadMoreFooter}
    </div>
  );
}

function NotificationRow({ view, now }: { view: NotificationView; now: number }) {
  const { title, detail, target } = describeNotification(view);
  const href = notificationHref(target, view);
  const unread = view.readAt === undefined;
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
    <li data-notification-id={view.id as Id<'notifications'>}>
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
