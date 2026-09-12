import { api } from '@skating/convex/api';
import { describeNotification, formatRelativeTime, type NotificationView } from '@skating/core';
import { useConvexAuth, useMutation, usePaginatedQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import {
  cacheNotifications,
  clearPendingReads,
  loadCachedNotifications,
  loadPendingReads,
  recordPendingReads,
} from '../src/lib/notificationCache';
import { applyReadOverlay, settledOverlayIds } from '../src/lib/notificationCacheModel';
import { notificationRoute } from '../src/lib/notificationRoutes';

const PAGE_SIZE = 30;

/**
 * The inbox (N8/A3) — reached from the bell on the You tab, never a tab of its own (D28's five
 * stand). Mirrors the web route: newest first, infinite scroll, everything shown marks itself read
 * once it has actually been on screen, and a row whose target is gone renders degraded and
 * untappable rather than vanishing (N8 #5).
 *
 * **Offline (N8 PR 3):** the last page is cached on device, so on the ice with no signal the list
 * still reads back; opening it there marks the rows read locally and the mark is replayed the next
 * time the live query answers. A tap on a cached row navigates like normal — the lake screen does
 * everything it can from its own offline cache.
 */
export default function NotificationsScreen() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.list,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const markRead = useMutation(api.notifications.markRead);
  const { isAuthenticated } = useConvexAuth();
  const now = Date.now();

  // The offline copy and the local read overlay (see the module note). `live` flips the moment the
  // query answers, empty or not; until then, with a connection the spinner shows and without one
  // the cache does.
  const [cached] = useState(() => loadCachedNotifications());
  const [overlay, setOverlay] = useState(() => loadPendingReads());
  const live = status !== 'LoadingFirstPage' || results.length > 0;
  useEffect(() => {
    if (results.length > 0) cacheNotifications(results);
  }, [results]);

  // Mark what the screen opened on as read — once, when the first page has landed and the Convex
  // client is authenticated (same guard as the web, and the same reasons: latch regardless of
  // whether anything shown was unread, and no `before` so the server also stamps the rows the list
  // omits for blocked actors). Gated on auth rather than on rows being present, because an inbox
  // whose every row is a blocked actor's lists nothing and still counts on the bell — a rows guard
  // would never clear it. A notification arriving while the modal is up stays unread until the
  // next open.
  //
  // The rows the mark stamps are remembered for the visit (same as the web): the list is reactive,
  // so a dot drawn from `readAt` alone would vanish the moment the stamp landed. Seeded from the
  // page in hand before the mutation fires, then widened to everything the server stamped.
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

  // Offline: stamp the cached rows in the overlay once per open. Replayed below when live returns.
  const markedOffline = useRef(false);
  useEffect(() => {
    if (live || markedOffline.current || cached.length === 0) return;
    markedOffline.current = true;
    const unread = cached.filter((n) => n.readAt === undefined).map((n) => n.id);
    if (unread.length === 0) return;
    const at = Date.now();
    recordPendingReads(unread, at);
    setOverlay((prev) => {
      const next = new Map(prev);
      for (const id of unread) if (!next.has(id)) next.set(id, at);
      return next;
    });
  }, [live, cached]);

  // Replay: once the live list answers, whatever the server already shows read (or has purged)
  // drops out of the overlay; anything still unread server-side is marked now — bounded by the
  // newest live row, so a notification that arrived after the offline open stays unread.
  useEffect(() => {
    if (!live || overlay.size === 0) return;
    const settled = settledOverlayIds(overlay, results);
    const pending = [...overlay.keys()].filter((id) => !settled.includes(id));
    if (pending.length > 0) {
      const newestPending = Math.max(
        ...results.filter((r) => pending.includes(r.id)).map((r) => r.createdAt),
      );
      if (Number.isFinite(newestPending)) {
        void markRead({ before: newestPending }).catch(() => {});
      }
    }
    if (settled.length > 0) {
      clearPendingReads(settled);
      setOverlay((prev) => {
        const next = new Map(prev);
        for (const id of settled) next.delete(id);
        return next;
      });
    }
  }, [live, results, overlay, markRead]);

  const data = live ? results : applyReadOverlay(cached, overlay);

  return (
    <FlatList<NotificationView>
      data={data}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => (
        <NotificationRow
          view={item}
          now={now}
          unread={item.readAt === undefined || newThisVisit.has(item.id)}
        />
      )}
      onEndReached={() => {
        if (status === 'CanLoadMore') loadMore(PAGE_SIZE);
      }}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingBottom: 24 }}
      ListHeaderComponent={
        !live && cached.length > 0 ? (
          <Paragraph color="$foregroundMuted" fontSize={12} paddingHorizontal="$4" paddingTop="$3">
            Offline — showing what was here last time.
          </Paragraph>
        ) : null
      }
      ListEmptyComponent={
        status === 'LoadingFirstPage' ? (
          <YStack padding="$6" alignItems="center">
            <Spinner />
          </YStack>
        ) : (
          <YStack padding="$4" gap="$2">
            <Text color="$foreground" fontWeight="600">
              Nothing yet
            </Text>
            <Paragraph color="$foregroundMuted">
              When someone comments on your report, finds it helpful, or a lake you follow gets new
              ice, it shows up here. Which of those reach you is up to you under Notifications on
              the You tab.
            </Paragraph>
          </YStack>
        )
      }
      ListFooterComponent={
        status === 'LoadingMore' ? (
          <YStack padding="$4" alignItems="center">
            <Spinner />
          </YStack>
        ) : null
      }
    />
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
  const router = useRouter();
  const { title, detail, target } = describeNotification(view);
  const route = notificationRoute(target, view);
  return (
    <XStack
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
      borderBottomWidth={1}
      borderColor="$border"
      alignItems="flex-start"
      opacity={route ? 1 : 0.8}
      {...(route
        ? {
            pressStyle: { backgroundColor: '$surfaceMuted' },
            onPress: () => router.navigate(route),
            accessibilityRole: 'button' as const,
          }
        : {})}
    >
      {/* Fixed-width gutter so read and unread rows share a left edge. */}
      <YStack width={8} alignItems="center" paddingTop={7}>
        {unread ? (
          <YStack
            width={8}
            height={8}
            borderRadius={4}
            backgroundColor="$primary"
            accessibilityLabel="Unread"
          />
        ) : null}
      </YStack>
      <YStack flex={1} gap="$1">
        <Text color="$foreground" fontWeight={unread ? '600' : '400'}>
          {title}
        </Text>
        {detail ? (
          <Text color="$foregroundMuted" fontSize={12}>
            {detail}
          </Text>
        ) : null}
        <Text color="$foregroundMuted" fontSize={12}>
          {formatRelativeTime(view.createdAt, now)}
        </Text>
      </YStack>
    </XStack>
  );
}
